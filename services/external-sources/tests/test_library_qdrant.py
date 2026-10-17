import asyncio
import json
import sqlite3

import httpx
import pytest

from app.knowledge.library_qdrant import (
    CANONICAL_VECTOR_SIZE,
    DIMENSION_CHOICES,
    LibraryQdrant,
    METADATA_KEY,
)
from app.knowledge.library_vectors import LibraryVectorCache
from tools.build_library_qdrant import collection_for, parse_args
from tools.build_library_qdrant import plan as build_plan


COLLECTION = 'wikivoyage_full_' + 'a' * 32
VECTOR = [3.0, 4.0] + [0.0] * (CANONICAL_VECTOR_SIZE - 2)


class Store:
    def __init__(self, passages, *, created_at='2026-10-01T00:00:00+00:00'):
        self.passages = passages
        self.manifest = {
            'corpus_id': 'test-wikivoyage-en-zh',
            'counts': {'passages': len(passages)},
            'chunking': {'size': 1200, 'overlap': 120},
            'embedding': {'model': 'Qwen/Qwen3-Embedding-8B'},
            'created_at': created_at,
        }
        self.after_first_batch = None

    def iter_passages(self, *, batch_size):
        for index, passage in enumerate(self.passages):
            if index == batch_size and self.after_first_batch:
                self.after_first_batch()
            yield passage


class Cache:
    def __init__(self):
        self.connection = sqlite3.connect(':memory:')
        self.connection.execute('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        self.model = 'Qwen/Qwen3-Embedding-8B'
        self.dimensions = CANONICAL_VECTOR_SIZE
        self.vector = VECTOR

    def get(self, key):
        return self.vector

    def close(self):
        self.connection.close()


def passages(count):
    return [
        {
            'id': f'chunk-{index}',
            'embedding_key': f'vector-{index}',
            'uri': f'guide:wikivoyage/en/Article-{index}/v1',
            'language': 'en',
            'title': f'Article {index}',
            'section_id': f'section-{index}',
            'range': [index * 100, (index + 1) * 100],
        }
        for index in range(count)
    ]


class FakeQdrant:
    def __init__(self):
        self.collections = {}
        self.calls = []
        self.upsert_attempts = 0
        self.fail_upsert_at = None
        self.count_offset = 0
        self.query_points = []

    def _info(self, state):
        return {
            'config': {
                'params': {
                    'vectors': state['vectors'],
                    'payload': state['payload'],
                },
                'metadata': state['metadata'],
                'optimizer_config': {'indexing_threshold': state['threshold']},
            },
            'payload_schema': state['payload_schema'],
            'status': state.get('status', 'green'),
            'optimizer_status': state.get('optimizer_status', 'ok'),
            'points_count': len(state['points']),
            'indexed_vectors_count': state.get('indexed_vectors_count', 0),
            'update_queue': {'length': state.get('queue_length', 0)},
        }

    async def handle(self, request):
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        parts = path.strip('/').split('/')
        if len(parts) >= 2 and parts[0] == 'collections':
            name = parts[1]
        else:
            return httpx.Response(404)

        if request.method == 'GET' and len(parts) == 2:
            state = self.collections.get(name)
            if state is None:
                return httpx.Response(404)
            return httpx.Response(200, json={'result': self._info(state)})

        if request.method == 'PUT' and len(parts) == 2:
            self.collections[name] = {
                'vectors': body['vectors'],
                'payload': body['payload'],
                'metadata': body['metadata'],
                'threshold': body['optimizers_config']['indexing_threshold'],
                'payload_schema': {},
                'points': {},
            }
            return httpx.Response(200, json={'result': True})

        if request.method == 'POST' and parts[2:] == ['points', 'query']:
            return httpx.Response(200, json={'result': {'points': self.query_points}})

        state = self.collections[name]
        if request.method == 'PUT' and parts[2:] == ['index']:
            assert request.url.params.get('wait') == 'true'
            state['payload_schema'][body['field_name']] = {'data_type': body['field_schema']}
            return httpx.Response(200, json={'result': True})

        if request.method == 'PATCH' and len(parts) == 2:
            state['threshold'] = body['optimizers_config']['indexing_threshold']
            return httpx.Response(200, json={'result': True})

        if request.method == 'PUT' and parts[2:] == ['points']:
            self.upsert_attempts += 1
            if self.fail_upsert_at == self.upsert_attempts:
                return httpx.Response(503, json={'status': 'temporary failure'})
            for point in body['points']:
                state['points'][point['id']] = point
            return httpx.Response(200, json={'result': True})

        if request.method == 'POST' and parts[2:] == ['points', 'count']:
            return httpx.Response(200, json={
                'result': {'count': len(state['points']) + self.count_offset},
            })

        return httpx.Response(404)


def make_client(fake):
    return httpx.AsyncClient(transport=httpx.MockTransport(fake.handle))


def test_upload_streams_named_cold_collection_in_batches_and_reports_readiness():
    fake = FakeQdrant()
    client = make_client(fake)
    store = Store(passages(5))
    cache = Cache()
    store.after_first_batch = lambda: (
        None if fake.upsert_attempts == 1 else pytest.fail(
            'the next passage should not be read until the first batch is upserted'))

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client)
        result = await adapter.upload(store, cache, collection=COLLECTION, batch_size=2)
        create = next(call for call in fake.calls if call[0:2] == ('PUT', f'/collections/{COLLECTION}'))
        assert create[2]['vectors'] == {
            'dense': {'size': 4096, 'distance': 'Cosine', 'memory': 'cold'},
        }
        assert create[2]['payload'] == {'memory': 'cold'}
        assert create[2]['optimizers_config'] == {'indexing_threshold': 0}
        assert create[2]['metadata'][METADATA_KEY]['passage_count'] == 5
        assert create[2]['metadata'][METADATA_KEY]['actual_embedding_model'] == cache.model
        assert create[2]['metadata'][METADATA_KEY]['request_model'] == cache.model
        assert create[2]['metadata'][METADATA_KEY]['dimensions'] == CANONICAL_VECTOR_SIZE
        assert create[2]['metadata'][METADATA_KEY]['representation']['normalization'] == 'l2'
        index_position = next(i for i, call in enumerate(fake.calls)
                              if call[0:2] == ('PUT', f'/collections/{COLLECTION}/index'))
        upsert_positions = [i for i, call in enumerate(fake.calls)
                            if call[0:2] == ('PUT', f'/collections/{COLLECTION}/points')]
        assert index_position < upsert_positions[0]
        assert [len(fake.calls[i][2]['points']) for i in upsert_positions] == [2, 2, 1]
        assert all(set(point['vector']) == {'dense'}
                   for i in upsert_positions for point in fake.calls[i][2]['points'])
        assert all(len(point['vector']['dense']) == CANONICAL_VECTOR_SIZE
                   for i in upsert_positions for point in fake.calls[i][2]['points'])
        assert all(sum(value * value for value in point['vector']['dense']) == pytest.approx(1.0)
                   for i in upsert_positions for point in fake.calls[i][2]['points'])
        assert all('/scroll' not in path for _, path, _ in fake.calls)
        assert not any(path.endswith('/points') and method == 'GET'
                       for method, path, _ in fake.calls)
        assert fake.collections[COLLECTION]['threshold'] == 10000
        assert result['upload_status'] == 'uploaded'
        assert result['upload_complete'] is True
        assert (result['expected_passage_count'], result['exact_points_count'], result['points_upserted_this_run']) == (5, 5, 5)
        assert result['has_ann_index'] is False
        assert result['optimization_pending'] is False
        assert result['indexed_vectors_count'] == 0
        readiness = await adapter.readiness(COLLECTION)
        assert readiness['upload_complete'] is True
        assert readiness['has_ann_index'] is False
        assert readiness['optimization_pending'] is False
        assert readiness['status'] == 'green'
        assert readiness['points_count'] == 5

        state = fake.collections[COLLECTION]
        state['indexed_vectors_count'] = len(state['points'])
        assert (await adapter.readiness(COLLECTION))['has_ann_index'] is True
        await client.aclose()
        cache.close()

    asyncio.run(run())


def test_failed_upload_is_not_retried_and_explicit_resume_upserts_same_ids():
    fake = FakeQdrant()
    fake.fail_upsert_at = 2
    client = make_client(fake)
    store = Store(passages(4))
    cache = Cache()

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client)
        with pytest.raises(httpx.HTTPStatusError):
            await adapter.upload(store, cache, collection=COLLECTION, batch_size=2)
        assert fake.upsert_attempts == 2
        assert len(fake.collections[COLLECTION]['points']) == 2
        upserts = [call for call in fake.calls
                   if call[0:2] == ('PUT', f'/collections/{COLLECTION}/points')]
        failed_batch_ids = [point['id'] for point in upserts[1][2]['points']]
        progress = json.loads(cache.connection.execute(
            "SELECT value FROM metadata WHERE key LIKE 'qdrant-upload:%'",
        ).fetchone()[0])
        assert progress['uploaded_passages'] == 2
        assert fake.collections[COLLECTION]['threshold'] == 10000

        fake.fail_upsert_at = None
        result = await adapter.upload(store, cache, collection=COLLECTION, batch_size=2)
        assert fake.upsert_attempts == 3
        upserts = [call for call in fake.calls
                   if call[0:2] == ('PUT', f'/collections/{COLLECTION}/points')]
        resumed_ids = [point['id'] for point in upserts[2][2]['points']]
        assert resumed_ids == failed_batch_ids
        assert len(fake.collections[COLLECTION]['points']) == 4
        assert result['exact_points_count'] == 4
        assert result['points_upserted_this_run'] == 2
        assert not any(method == 'DELETE' for method, _, _ in fake.calls)

        del fake.collections[COLLECTION]
        before = len(fake.calls)
        with pytest.raises(ValueError, match='progress exists but its collection is missing'):
            await adapter.upload(store, cache, collection=COLLECTION, batch_size=2)
        assert not any(call[0:2] == ('PUT', f'/collections/{COLLECTION}')
                       for call in fake.calls[before:])
        await client.aclose()
        cache.close()

    asyncio.run(run())


def test_collection_namespace_and_existing_identity_are_checked_before_upload():
    fake = FakeQdrant()
    client = make_client(fake)

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client)
        with pytest.raises(ValueError, match='wikivoyage_full_'):
            await adapter.upload(Store(passages(1)), Cache(), collection='travel_release')
        assert fake.calls == []

        state = {
            'vectors': {'dense': {'size': 4096, 'distance': 'Cosine', 'memory': 'cold'}},
            'payload': {'memory': 'cold'},
            'metadata': {METADATA_KEY: {'wrong': 'source'}},
            'threshold': 10000,
            'payload_schema': {'article_uri': {'data_type': 'keyword'}},
            'points': {},
        }
        fake.collections[COLLECTION] = state
        with pytest.raises(ValueError, match='metadata differs'):
            await adapter.upload(Store(passages(1)), Cache(), collection=COLLECTION)
        assert fake.upsert_attempts == 0
        await client.aclose()

    asyncio.run(run())


def test_exact_count_mismatch_fails_and_restores_indexing_threshold():
    fake = FakeQdrant()
    fake.count_offset = 1
    client = make_client(fake)

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client)
        with pytest.raises(ValueError, match='point count mismatch'):
            await adapter.upload(Store(passages(1)), Cache(), collection=COLLECTION)
        assert fake.collections[COLLECTION]['threshold'] == 10000
        await client.aclose()

    asyncio.run(run())


def test_collection_validation_binds_model_exact_count_and_ann_readiness():
    fake = FakeQdrant()
    client = make_client(fake)
    store = Store(passages(2))
    cache = Cache()

    async def run():
        adapter = LibraryQdrant(
            'http://qdrant.test', client=client, dimensions=512,
            request_model='Qwen/Qwen3-Embedding-8B',
        )
        await adapter.upload(store, cache, collection=COLLECTION, batch_size=2)
        identity = LibraryQdrant.collection_identity(
            store.manifest,
            actual_embedding_model=cache.model,
            request_model='Qwen/Qwen3-Embedding-8B',
            dimensions=512,
        )
        ready = await adapter.validate_collection(COLLECTION, identity, require_ann=False)
        assert ready['exact_points_count'] == 2
        assert ready['has_ann_index'] is False

        same_width_old_model = LibraryQdrant.collection_identity(
            store.manifest,
            actual_embedding_model='old/Qwen-embedding-model',
            request_model='old/Qwen-embedding-model',
            dimensions=512,
        )
        assert same_width_old_model['dimensions'] == identity['dimensions']
        with pytest.raises(ValueError, match='metadata differs'):
            await adapter.validate_collection(COLLECTION, same_width_old_model)

        fake.count_offset = 1
        with pytest.raises(ValueError, match='point count differs'):
            await adapter.validate_collection(COLLECTION, identity)
        fake.count_offset = 0

        with pytest.raises(ValueError, match='ANN retrieval requires'):
            await adapter.validate_collection(COLLECTION, identity, require_ann=True)

        fake.collections[COLLECTION]['indexed_vectors_count'] = 2
        ann_ready = await adapter.validate_collection(COLLECTION, identity, require_ann=True)
        assert ann_ready['has_ann_index'] is True
        await client.aclose()
        cache.close()

    asyncio.run(run())


def test_search_filters_before_retrieval_and_empty_scope_does_not_call_qdrant():
    fake = FakeQdrant()
    fake.query_points = [
        {'payload': {'chunk_id': 'chunk-hit'}, 'score': 0.91},
        {'payload': {'chunk_id': 'chunk-next'}, 'score': 0.82},
    ]
    client = make_client(fake)

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client, dimensions=512)
        assert await adapter.search(VECTOR, collection=COLLECTION, document_uris=[]) == []
        assert fake.calls == []

        matches = await adapter.search(
            VECTOR,
            collection=COLLECTION,
            limit=10,
            exact=True,
            hnsw_ef=64,
            document_uris=['guide:wikivoyage/en/Jinan/v1', 'guide:wikivoyage/zh/%E6%B5%8E%E5%8D%97/v1'],
        )
        assert matches == [{'id': 'chunk-hit', 'score': 0.91}, {'id': 'chunk-next', 'score': 0.82}]
        method, path, body = fake.calls[-1]
        assert (method, path) == ('POST', f'/collections/{COLLECTION}/points/query')
        assert body['using'] == 'dense'
        assert len(body['query']) == 512
        assert sum(value * value for value in body['query']) == pytest.approx(1.0)
        assert body['limit'] == 10
        assert body['params'] == {'exact': True, 'hnsw_ef': 64}
        assert body['filter'] == {'must': [{
            'key': 'article_uri',
            'match': {'any': ['guide:wikivoyage/en/Jinan/v1', 'guide:wikivoyage/zh/%E6%B5%8E%E5%8D%97/v1']},
        }]}

        await adapter.search(VECTOR, collection=COLLECTION)
        assert 'filter' not in fake.calls[-1][2]
        await client.aclose()

    asyncio.run(run())


@pytest.mark.parametrize('dimensions', DIMENSION_CHOICES)
def test_mrl_projection_slices_before_l2_normalizing(dimensions):
    adapter = LibraryQdrant('http://qdrant.test', dimensions=dimensions)
    raw = [1.0] * dimensions + [100.0] * (CANONICAL_VECTOR_SIZE - dimensions)
    projected = adapter._prepare_vector(raw)
    expected = 1 / (dimensions ** 0.5)
    assert len(projected) == dimensions
    assert projected[0] == pytest.approx(expected)
    assert projected[-1] == pytest.approx(expected)
    assert sum(value * value for value in projected) == pytest.approx(1.0)
    assert raw[0] == 1.0 and raw[-1] == (1.0 if dimensions == CANONICAL_VECTOR_SIZE else 100.0)


def test_upload_projects_canonical_cache_vectors_without_mutating_them():
    fake = FakeQdrant()
    client = make_client(fake)
    store = Store(passages(2))
    cache = Cache()
    original = list(cache.vector)

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client, dimensions=512)
        result = await adapter.upload(store, cache, collection=COLLECTION, batch_size=2)
        upsert = next(call for call in fake.calls if call[0:2] == ('PUT', f'/collections/{COLLECTION}/points'))
        projected = upsert[2]['points'][0]['vector']['dense']
        assert result['dimensions'] == 512
        create = next(call for call in fake.calls if call[0:2] == ('PUT', f'/collections/{COLLECTION}'))
        assert create[2]['vectors']['dense']['size'] == 512
        assert len(cache.get('vector-0')) == CANONICAL_VECTOR_SIZE
        assert cache.vector == original
        assert len(projected) == 512
        assert sum(value * value for value in projected) == pytest.approx(1.0)
        await client.aclose()
        cache.close()

    asyncio.run(run())


def test_collection_identity_pins_models_dimension_and_mrl_representation():
    manifest = Store(passages(1)).manifest
    identity_512 = LibraryQdrant.collection_identity(
        manifest,
        actual_embedding_model='Qwen/Qwen3-Embedding-8B',
        request_model='Qwen/Qwen3-Embedding-8B',
        dimensions=512,
    )
    identity_1024 = LibraryQdrant.collection_identity(
        manifest,
        actual_embedding_model='Qwen/Qwen3-Embedding-8B',
        request_model='Qwen/Qwen3-Embedding-8B',
        dimensions=1024,
    )
    identity_alias = LibraryQdrant.collection_identity(
        manifest,
        actual_embedding_model='Qwen/Qwen3-Embedding-8B',
        request_model='nebius/Qwen/Qwen3-Embedding-8B',
        dimensions=512,
    )
    assert identity_512['dimensions'] == 512
    assert identity_512['canonical_dimensions'] == 4096
    assert identity_512['representation'] == {'method': 'mrl-prefix', 'normalization': 'l2', 'version': 1}
    assert identity_512 != identity_1024
    assert identity_512 != identity_alias


def test_only_supported_mrl_dimensions_are_accepted():
    with pytest.raises(ValueError, match='dimensions must be one of'):
        LibraryQdrant('http://qdrant.test', dimensions=768)


def test_upload_rejects_noncanonical_cache_before_qdrant_calls():
    fake = FakeQdrant()
    client = make_client(fake)
    cache = Cache()
    cache.dimensions = 512

    async def run():
        adapter = LibraryQdrant('http://qdrant.test', client=client, dimensions=512)
        with pytest.raises(ValueError, match='must retain 4096-dimensional canonical vectors'):
            await adapter.upload(Store(passages(1)), cache, collection=COLLECTION)
        assert fake.calls == []
        await client.aclose()
        cache.close()

    asyncio.run(run())


def test_cli_defaults_to_4096_and_uses_independent_collection_per_identity():
    assert parse_args([]).dimensions == CANONICAL_VECTOR_SIZE
    manifest = Store(passages(1)).manifest
    names = {
        collection_for(manifest, 'Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3-Embedding-8B', dimension)
        for dimension in DIMENSION_CHOICES
    }
    assert len(names) == len(DIMENSION_CHOICES)
    assert collection_for(manifest, 'Qwen/Qwen3-Embedding-8B', 'old-alias', 512) != (
        collection_for(manifest, 'Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3-Embedding-8B', 512))


def test_cli_plan_reads_real_sqlite_library_and_vector_cache_without_qdrant(tmp_path):
    model = 'Qwen/Qwen3-Embedding-8B'
    knowledge_root = tmp_path / 'knowledge'
    knowledge_root.mkdir()
    library_path = tmp_path / 'library.sqlite'
    manifest = {
        'status': 'ready',
        'corpus_id': 'plan-fixture-library',
        'snapshot': '20261001',
        'counts': {'passages': 7, 'unique_embedding_inputs': 3},
        'embedding': {'base_url': 'https://embedding.example.test/v1', 'model': model},
    }
    with sqlite3.connect(library_path) as connection:
        connection.execute('CREATE TABLE manifest (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)')
        connection.execute(
            'INSERT INTO manifest(key,value_json) VALUES(?,?)',
            ('manifest', json.dumps(manifest, ensure_ascii=False, sort_keys=True)),
        )

    vector_cache_path = tmp_path / 'vectors.sqlite'
    cache = LibraryVectorCache(vector_cache_path, model=model, dimensions=CANONICAL_VECTOR_SIZE)
    for index in range(3):
        cache.put_legacy(f'vector-key-{index}', VECTOR)
    cache.close()

    output = tmp_path / 'plan-512.json'
    args = parse_args([
        '--library', str(library_path),
        '--knowledge-root', str(knowledge_root),
        '--vector-cache', str(vector_cache_path),
        '--dimensions', '512',
        '--request-model', 'Qwen/Qwen3-Embedding-8B',
        '--output', str(output),
    ])
    result = build_plan(args)
    saved = json.loads(output.read_text(encoding='utf-8'))
    assert result == saved
    assert result['status'] == 'planned_no_qdrant_calls'
    assert result['qdrant_calls'] == 0
    assert result['expected_passage_count'] == 7
    assert result['vector_cache']['cached_vectors'] == 3
    assert result['vector_cache']['dimensions'] == CANONICAL_VECTOR_SIZE
    assert result['dimensions'] == 512
    assert result['canonical_dimensions'] == CANONICAL_VECTOR_SIZE
    assert result['collection'] == collection_for(manifest, model, model, 512)
    assert result['collection'] != collection_for(manifest, model, model, CANONICAL_VECTOR_SIZE)
    assert result['collection_identity']['representation']['normalization'] == 'l2'
    with pytest.raises(FileExistsError):
        build_plan(args)
