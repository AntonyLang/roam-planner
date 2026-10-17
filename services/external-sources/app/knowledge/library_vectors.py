"""Bounded-memory vector cache and resumable embedding for a prepared library."""
from array import array
import asyncio
from datetime import datetime, timezone
import hashlib
from itertools import islice
import json
import math
from pathlib import Path
import sqlite3
import sys
import time
import uuid

import httpx

from .corpus import fingerprint

MEMBERSHIP_BATCH_SIZE = 500
SQLITE_CACHE_SIZE_KIB = 64 * 1024
RETRYABLE_HTTP_STATUS_CODES = frozenset((429, 500, 502, 503, 504))
RETRYABLE_TRANSPORT_ERRORS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.ReadTimeout,
    httpx.RemoteProtocolError,
)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def encode_vector(values, dimensions):
    if len(values) != dimensions or any(isinstance(x, bool) or not isinstance(x, (int, float))
                                        or not math.isfinite(x) for x in values):
        raise ValueError('Embedding vector has invalid dimensions or values')
    result = array('f', values)
    if any(not math.isfinite(x) for x in result):
        raise ValueError('Embedding vector cannot be represented as float32')
    if sys.byteorder != 'little':
        result.byteswap()
    return result.tobytes()


def decode_vector(value):
    result = array('f')
    result.frombytes(value)
    if sys.byteorder != 'little':
        result.byteswap()
    return result.tolist()


def maximum_attempted_inputs(baseline_attempts, new_inputs, max_retries):
    if min(baseline_attempts, new_inputs, max_retries) < 0:
        raise ValueError('Attempt counts and retry count must be nonnegative')
    return baseline_attempts + new_inputs * (max_retries + 1)


class LibraryVectorCache:
    """Float32 BLOBs and attempt receipts commit together; no per-vector JSON."""
    def __init__(self, path, *, model, dimensions=4096):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute('PRAGMA foreign_keys=ON')
        self.connection.execute('PRAGMA journal_mode=WAL')
        self.connection.execute('PRAGMA synchronous=FULL')
        self.connection.execute(f'PRAGMA cache_size=-{SQLITE_CACHE_SIZE_KIB}')
        self.connection.executescript('''
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS vectors (
                input_key TEXT PRIMARY KEY, vector BLOB NOT NULL, call_id TEXT);
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, input_keys TEXT NOT NULL,
                input_count INTEGER NOT NULL, input_characters INTEGER NOT NULL,
                started_at TEXT NOT NULL, finished_at TEXT, usage TEXT,
                error_type TEXT, elapsed_seconds REAL);
            CREATE TABLE IF NOT EXISTS http_receipts (
                call_id TEXT PRIMARY KEY, status_code INTEGER NOT NULL,
                provider_request_id TEXT, provider_error_code TEXT);
            CREATE TABLE IF NOT EXISTS http_errors (
                call_id TEXT PRIMARY KEY REFERENCES requests(id), message TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS request_resolutions (
                id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
                action TEXT NOT NULL CHECK(action='retry_missing'),
                source TEXT NOT NULL CHECK(source IN ('manual','automatic_retry')),
                reason TEXT NOT NULL, resolved_at TEXT NOT NULL);
        ''')
        identity = {'model': model, 'dimensions': dimensions, 'dtype': 'float32-le'}
        previous = self.connection.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
        if previous and json.loads(previous[0]) != identity:
            self.connection.close()
            raise ValueError('Vector cache model/dimensions differ from the requested library build')
        with self.connection:
            self.connection.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)',
                                    ('identity', json.dumps(identity, sort_keys=True)))
        self.model, self.dimensions = model, dimensions

    def close(self):
        self.connection.close()

    def contains(self, key):
        return self.connection.execute('SELECT 1 FROM vectors WHERE input_key=?', (key,)).fetchone() is not None

    def existing_keys(self, keys):
        if len(keys) > MEMBERSHIP_BATCH_SIZE:
            raise ValueError(f'Cache membership batches are limited to {MEMBERSHIP_BATCH_SIZE} keys')
        if not keys:
            return set()
        placeholders = ','.join('?' for _ in keys)
        return {row[0] for row in self.connection.execute(
            f'SELECT input_key FROM vectors WHERE input_key IN ({placeholders})', keys
        )}

    def get(self, key):
        row = self.connection.execute('SELECT vector FROM vectors WHERE input_key=?', (key,)).fetchone()
        return decode_vector(row[0]) if row else None

    def put_legacy(self, key, values):
        with self.connection:
            self.connection.execute('INSERT OR IGNORE INTO vectors VALUES (?,?,NULL)',
                                    (key, encode_vector(values, self.dimensions)))

    def attempted_inputs(self):
        return self.connection.execute('SELECT COALESCE(SUM(input_count),0) FROM requests').fetchone()[0]

    def unresolved_requests(self):
        return [dict(zip(('id', 'status', 'input_count'), row)) for row in self.connection.execute(
            '''SELECT request.id,request.status,request.input_count FROM requests AS request
               WHERE request.status='started'
                  OR (request.status='failed' AND NOT EXISTS (
                      SELECT 1 FROM request_resolutions AS resolution
                      WHERE resolution.request_id=request.id AND resolution.action='retry_missing'
                  ))
               ORDER BY request.started_at''')]

    def resolve_failed_requests(self, request_ids, reason, *, source='manual'):
        request_ids = list(request_ids)
        reason = reason.strip()
        if not request_ids or len(set(request_ids)) != len(request_ids):
            raise ValueError('Request resolution needs distinct failed request IDs')
        if not reason:
            raise ValueError('Request resolution reason is required')
        if source not in ('manual', 'automatic_retry'):
            raise ValueError('Invalid request resolution source')

        with self.connection:
            for request_id in request_ids:
                row = self.connection.execute('SELECT status FROM requests WHERE id=?', (request_id,)).fetchone()
                if row is None:
                    raise ValueError(f'Request {request_id} does not exist')
                if row[0] != 'failed':
                    raise ValueError(f'Request {request_id} is not failed; started requests remain unresolved')
                exists = self.connection.execute(
                    'SELECT 1 FROM request_resolutions WHERE request_id=?', (request_id,)
                ).fetchone()
                if exists:
                    raise ValueError(f'Request {request_id} already has a resolution')
            now = utcnow()
            self.connection.executemany(
                'INSERT INTO request_resolutions VALUES (?,?,?,?,?,?)',
                [(uuid.uuid4().hex, request_id, 'retry_missing', source, reason, now)
                 for request_id in request_ids],
            )

    def resolve_failed_request(self, request_id, reason, *, source='manual'):
        self.resolve_failed_requests([request_id], reason, source=source)

    def begin_request(self, batch, maximum_inputs):
        if self.attempted_inputs() + len(batch) > maximum_inputs:
            raise ValueError('Frozen input attempt plan exhausted; no HTTP request sent')
        call_id = uuid.uuid4().hex
        with self.connection:
            self.connection.execute('''INSERT INTO requests
                (id,status,input_keys,input_count,input_characters,started_at)
                VALUES (?,?,?,?,?,?)''', (call_id, 'started', json.dumps([r['key'] for r in batch]),
                                         len(batch), sum(len(r['text']) for r in batch), utcnow()))
        return call_id

    def _save_http_receipt(self, call_id, receipt):
        if receipt is not None:
            self.connection.execute('INSERT INTO http_receipts VALUES (?,?,?,?)',
                (call_id, receipt['status_code'], receipt.get('provider_request_id'),
                 receipt.get('provider_error_code')))

    def succeed(self, call_id, batch, vectors, usage, elapsed, receipt=None):
        encoded = [(row['key'], encode_vector(vector, self.dimensions), call_id)
                   for row, vector in zip(batch, vectors, strict=True)]
        with self.connection:
            self._save_http_receipt(call_id, receipt)
            self.connection.executemany('INSERT INTO vectors VALUES (?,?,?)', encoded)
            self.connection.execute('''UPDATE requests SET status='succeeded',finished_at=?,usage=?,
                elapsed_seconds=? WHERE id=?''', (utcnow(), json.dumps(usage) if usage is not None else None,
                                                 elapsed, call_id))

    def fail(self, call_id, error, elapsed, usage=None, receipt=None, error_message=None, secret=None):
        if error_message is not None:
            if secret:
                error_message = error_message.replace(secret, '[redacted]')
            error_message = error_message[:2048]
        with self.connection:
            self._save_http_receipt(call_id, receipt)
            if error_message is not None:
                self.connection.execute('INSERT INTO http_errors VALUES (?,?)', (call_id, error_message))
            self.connection.execute('''UPDATE requests SET status='failed',finished_at=?,usage=?,
                error_type=?,elapsed_seconds=? WHERE id=?''',
                (utcnow(), json.dumps(usage) if usage is not None else None,
                 type(error).__name__, elapsed, call_id))

    def summary(self):
        counts = dict(self.connection.execute('SELECT status,COUNT(*) FROM requests GROUP BY status'))
        resolutions_by_source = dict(self.connection.execute(
            'SELECT source,COUNT(*) FROM request_resolutions WHERE action=\'retry_missing\' GROUP BY source'
        ))
        totals, unknown = {}, 0
        for (raw,) in self.connection.execute('SELECT usage FROM requests'):
            usage = json.loads(raw) if raw else None
            if not usage:
                unknown += 1
            else:
                for name in ('prompt_tokens', 'total_tokens'):
                    if isinstance(usage.get(name), (int, float)):
                        totals[name] = totals.get(name, 0) + usage[name]
        return {'cached_vectors': self.connection.execute('SELECT COUNT(*) FROM vectors').fetchone()[0],
                'attempted_inputs': self.attempted_inputs(), 'requests_by_status': counts,
                'request_resolution_count': sum(resolutions_by_source.values()),
                'request_resolutions_by_source': resolutions_by_source,
                'reported_token_sums': totals, 'requests_with_unknown_usage': unknown,
                'dtype': 'float32-le', 'model': self.model, 'dimensions': self.dimensions,
                'http_status_counts': dict(self.connection.execute(
                    'SELECT status_code,COUNT(*) FROM http_receipts GROUP BY status_code'))}


def plan_library_vectors(store, cache, *, base_url, legacy_cache=None):
    """Scan bounded input blocks and import only exact-key legacy cache matches."""
    counts = {'unique_inputs': 0, 'cached_inputs': 0, 'legacy_imported': 0,
              'new_inputs': 0, 'new_input_characters': 0, 'maximum_input_characters': 0}
    digest = hashlib.sha256()
    legacy_files = {path.stem: path for path in Path(legacy_cache).glob('*.json')} if legacy_cache else {}
    rows = iter(store.iter_embedding_inputs())
    while block := list(islice(rows, MEMBERSHIP_BATCH_SIZE)):
        for row in block:
            expected = fingerprint({'url': base_url, 'model': cache.model, 'text': row['text']})
            if row['key'] != expected:
                raise ValueError('Library embedding identity differs from the requested endpoint/model')
            digest.update((row['key'] + '\n').encode('ascii'))
            counts['unique_inputs'] += 1
            counts['maximum_input_characters'] = max(counts['maximum_input_characters'], len(row['text']))

        cached_keys = cache.existing_keys([row['key'] for row in block])
        for row in block:
            key = row['key']
            if key not in cached_keys:
                old = legacy_files.get(key)
                if old is not None:
                    saved = json.loads(old.read_text(encoding='utf-8'))
                    if saved['model'] != cache.model:
                        raise ValueError('Legacy vector cache has a different model')
                    cache.put_legacy(key, saved['vector'])
                    cached_keys.add(key)
                    counts['legacy_imported'] += 1
            if key in cached_keys:
                counts['cached_inputs'] += 1
            else:
                counts['new_inputs'] += 1
                counts['new_input_characters'] += len(row['text'])
    return {**counts, 'embedding_input_keys_sha256': digest.hexdigest(),
            'embedding_input_iteration_order': 'library-insertion-rowid-v1',
            'float32_vector_payload_bytes': counts['unique_inputs'] * cache.dimensions * 4,
            'provider_calls': 0, 'library_manifest_sha256': fingerprint(store.manifest),
            'model': cache.model, 'dimensions': cache.dimensions, 'base_url': base_url,
            'price_verified': False}


def _response_error_message(response):
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get('error') if isinstance(body, dict) else None
    message = error.get('message') if isinstance(error, dict) else error if isinstance(error, str) else None
    if not isinstance(message, str) or not message:
        message = response.text
    return message


class RequestRate:
    def __init__(self, rpm):
        self.interval = 60 / rpm
        self.last = 0
        self.lock = asyncio.Lock()

    async def acquire(self):
        async with self.lock:
            delay = self.interval - (time.monotonic() - self.last)
            if delay > 0:
                await asyncio.sleep(delay)
            self.last = time.monotonic()


async def embed_library(store, cache, *, base_url, api_key, approved_new_inputs,
                        batch_size=64, concurrency=8, rpm=240, client=None, on_progress=None,
                        progress_every=100, max_retries=0, retry_backoff_seconds=1.0,
                        proxy=None):
    """Retry only known transient failures, while preserving every attempt and its receipt."""
    if cache.unresolved_requests():
        raise ValueError('Unresolved provider attempts require inspection before resuming')
    if not (1 <= rpm <= 240 and batch_size > 0 and concurrency > 0
            and max_retries >= 0 and retry_backoff_seconds >= 0):
        raise ValueError('Invalid embedding batch/concurrency/rate settings')
    if client is not None and proxy is not None:
        raise ValueError('Proxy is only applied when embed_library creates its HTTP client')
    inputs = iter(store.iter_embedding_inputs())
    missing_rows = iter(())
    rate, stopped, errors = RequestRate(rpm), asyncio.Event(), []
    completed_requests = 0
    owned_client = client is None
    if owned_client:
        client_options = {'timeout': 120, 'trust_env': False}
        if proxy is not None:
            client_options['proxy'] = proxy
        client = httpx.AsyncClient(**client_options)

    def next_batch():
        nonlocal missing_rows
        batch = []
        while len(batch) < batch_size:
            row = next(missing_rows, None)
            if row is None:
                block = list(islice(inputs, MEMBERSHIP_BATCH_SIZE))
                if not block:
                    break
                cached_keys = cache.existing_keys([item['key'] for item in block])
                missing_rows = iter(item for item in block if item['key'] not in cached_keys)
                continue
            batch.append(row)
        return batch

    async def worker():
        nonlocal completed_requests
        while not stopped.is_set():
            batch = next_batch()
            if not batch:
                return
            for retry_index in range(max_retries + 1):
                if stopped.is_set():
                    return
                await rate.acquire()
                if stopped.is_set():
                    return
                call_id, started, usage, committed, receipt, error_message = (
                    None, time.monotonic(), None, False, None, None,
                )
                try:
                    call_id = cache.begin_request(batch, approved_new_inputs)
                    response = await client.post(base_url.rstrip('/') + '/embeddings',
                        headers={'Authorization': 'Bearer ' + api_key},
                        json={'model': cache.model, 'dimensions': cache.dimensions,
                              'input': [row['text'] for row in batch]})
                    retry_after_header = response.headers.get('retry-after')
                    try:
                        retry_after_seconds = float(retry_after_header) if retry_after_header is not None else None
                    except ValueError:
                        retry_after_seconds = None
                    if retry_after_seconds is not None and (
                        not math.isfinite(retry_after_seconds) or retry_after_seconds < 0
                    ):
                        retry_after_seconds = None
                    receipt = {'status_code': response.status_code,
                               'provider_request_id': response.headers.get('x-request-id'),
                               'retry_after_seconds': retry_after_seconds}
                    if response.is_error:
                        error_message = _response_error_message(response)
                        try:
                            error_body = response.json().get('error', {})
                            if isinstance(error_body, dict):
                                receipt['provider_error_code'] = error_body.get('code')
                        except ValueError:
                            pass
                    response.raise_for_status()
                    payload = response.json()
                    usage = payload.get('usage')
                    rows = payload.get('data', [])
                    if len(rows) != len(batch) or {r.get('index') for r in rows} != set(range(len(batch))):
                        raise ValueError('Embedding response count/index mismatch')
                    if payload.get('model') and payload['model'] != cache.model:
                        raise ValueError('Embedding response model mismatch')
                    vectors = [r['embedding'] for r in sorted(rows, key=lambda r: r['index'])]
                    cache.succeed(call_id, batch, vectors, usage, time.monotonic() - started, receipt)
                    committed = True
                    completed_requests += 1
                    if on_progress and completed_requests % progress_every == 0:
                        await on_progress(cache.summary())
                    break
                except Exception as error:
                    if call_id is not None and not committed:
                        cache.fail(
                            call_id, error, time.monotonic() - started, usage, receipt,
                            error_message=error_message, secret=api_key,
                        )
                    status_code = receipt.get('status_code') if receipt else None
                    transient_transport = isinstance(error, RETRYABLE_TRANSPORT_ERRORS)
                    transient_status = status_code in RETRYABLE_HTTP_STATUS_CODES
                    if (not committed and call_id is not None and retry_index < max_retries
                            and (transient_transport or transient_status)):
                        failure = f'HTTP {status_code}' if status_code else type(error).__name__
                        backoff = retry_backoff_seconds * (2 ** retry_index)
                        retry_after = receipt.get('retry_after_seconds') if receipt else None
                        if status_code in (429, 503) and retry_after is not None:
                            backoff = max(backoff, retry_after)
                        retry_after_note = f'; Retry-After={retry_after:g}s' if retry_after is not None else ''
                        cache.resolve_failed_request(
                            call_id,
                            f'{failure}; automatic retry {retry_index + 2} of {max_retries + 1}; '
                            f'backoff {backoff:g}s{retry_after_note}',
                            source='automatic_retry',
                        )
                        await asyncio.sleep(backoff)
                        continue
                    errors.append(error)
                    stopped.set()
                    return

    try:
        await asyncio.gather(*(worker() for _ in range(concurrency)))
        if errors:
            raise errors[0]
        return cache.summary()
    finally:
        if owned_client:
            await client.aclose()
