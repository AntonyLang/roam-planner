"""Streaming Qdrant adapter for the immutable full Wikivoyage library."""
import json
import math
import re
import uuid

import httpx

from .corpus import fingerprint


CANONICAL_VECTOR_SIZE = 4096
DIMENSION_CHOICES = (512, 1024, 2048, CANONICAL_VECTOR_SIZE)
VECTOR_SIZE = CANONICAL_VECTOR_SIZE
DISTANCE = 'Cosine'
COLLECTION_PATTERN = re.compile(r'^wikivoyage_full_[0-9a-f]{32}$')
METADATA_KEY = 'wikivoyage_full_library'
REPRESENTATION = {
    'method': 'mrl-prefix',
    'normalization': 'l2',
    'version': 1,
}


class LibraryQdrant:
    def __init__(self, url, client=None, *, dimensions=CANONICAL_VECTOR_SIZE, request_model=None):
        if dimensions not in DIMENSION_CHOICES:
            raise ValueError(f'dimensions must be one of {DIMENSION_CHOICES}')
        self.url = url.rstrip('/')
        self.dimensions = dimensions
        self.request_model = request_model
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            base_url=self.url,
            timeout=120,
            trust_env=False,
        )

    async def aclose(self):
        if self._owns_client:
            await self.client.aclose()

    def _url(self, path):
        return f'{self.url}{path}'

    @staticmethod
    def _collection_name(collection):
        if not COLLECTION_PATTERN.fullmatch(collection):
            raise ValueError('Library collection must use wikivoyage_full_<32 lowercase hex> namespace')
        return collection

    async def _request(self, method, path, *, params=None, body=None):
        response = await self.client.request(method, self._url(path), params=params, json=body)
        response.raise_for_status()
        return response.json()

    async def _collection_info(self, collection):
        path = f'/collections/{collection}'
        response = await self.client.request('GET', self._url(path))
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()['result']

    @staticmethod
    def collection_identity(manifest, *, actual_embedding_model, request_model, dimensions):
        if dimensions not in DIMENSION_CHOICES:
            raise ValueError(f'dimensions must be one of {DIMENSION_CHOICES}')
        return {
            'schema_version': 1,
            'source_manifest_sha256': fingerprint(manifest),
            'corpus_id': manifest['corpus_id'],
            'passage_count': manifest['counts']['passages'],
            'actual_embedding_model': actual_embedding_model,
            'request_model': request_model,
            'canonical_dimensions': CANONICAL_VECTOR_SIZE,
            'dimensions': dimensions,
            'representation': REPRESENTATION,
            'metric': DISTANCE,
            'distance': DISTANCE,
            'vector_memory': 'cold',
            'payload_memory': 'cold',
            'payload_indexes': {'article_uri': 'keyword'},
        }

    @staticmethod
    def _identity(store, vector_cache, request_model=None, dimensions=CANONICAL_VECTOR_SIZE):
        manifest = store.manifest
        embedding = manifest['embedding']
        actual_model = getattr(vector_cache, 'model', embedding['model'])
        cache_dimensions = getattr(vector_cache, 'dimensions', CANONICAL_VECTOR_SIZE)
        if actual_model != embedding['model']:
            raise ValueError('Vector cache model differs from the source library embedding model')
        if cache_dimensions != CANONICAL_VECTOR_SIZE:
            raise ValueError(f'Vector cache must retain {CANONICAL_VECTOR_SIZE}-dimensional canonical vectors')
        request_model = request_model or embedding.get('request_model') or embedding['model']
        return LibraryQdrant.collection_identity(
            manifest,
            actual_embedding_model=actual_model,
            request_model=request_model,
            dimensions=dimensions,
        )

    def _prepare_vector(self, vector):
        if len(vector) != CANONICAL_VECTOR_SIZE:
            raise ValueError(f'Canonical vector must have {CANONICAL_VECTOR_SIZE} dimensions')
        prefix = [float(value) for value in vector[:self.dimensions]]
        norm = math.sqrt(math.fsum(value * value for value in prefix))
        if not math.isfinite(norm) or norm == 0:
            raise ValueError('Vector prefix must have a finite nonzero L2 norm')
        return [value / norm for value in prefix]

    @staticmethod
    def _progress_key(collection, identity):
        return f"qdrant-upload:{collection}:{fingerprint(identity)}"

    @staticmethod
    def _load_progress(vector_cache, key, expected_count):
        row = vector_cache.connection.execute(
            'SELECT value FROM metadata WHERE key=?', (key,),
        ).fetchone()
        if row is None:
            return 0
        progress = json.loads(row[0])
        offset = progress['uploaded_passages']
        if (progress.get('schema_version') != 1
                or progress.get('passage_count') != expected_count
                or not isinstance(offset, int)
                or offset < 0
                or offset > expected_count):
            raise ValueError('Qdrant upload progress metadata is incompatible with this library')
        return offset

    @staticmethod
    def _save_progress(vector_cache, key, expected_count, uploaded_passages):
        progress = json.dumps({
            'schema_version': 1,
            'passage_count': expected_count,
            'uploaded_passages': uploaded_passages,
        }, sort_keys=True, separators=(',', ':'))
        with vector_cache.connection:
            vector_cache.connection.execute(
                'INSERT INTO metadata(key,value) VALUES(?,?) '
                'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                (key, progress),
            )

    @staticmethod
    def _validate_collection(info, identity):
        config = info['config']
        params = config['params']
        vectors = params['vectors']
        dense = vectors.get('dense') if isinstance(vectors, dict) else None
        if (set(vectors) != {'dense'}
                or not isinstance(dense, dict)
                or dense.get('size') != identity['dimensions']
                or dense.get('distance') != DISTANCE
                or dense.get('memory') != 'cold'):
            raise ValueError('Existing library collection has incompatible vector parameters')
        if params.get('payload', {}).get('memory') != 'cold':
            raise ValueError('Existing library collection has incompatible payload memory settings')
        if config.get('metadata', {}).get(METADATA_KEY) != identity:
            raise ValueError('Existing library collection metadata differs from this library/configuration')
        threshold = config['optimizer_config']['indexing_threshold']
        if threshold not in (0, 10000):
            raise ValueError('Existing library collection has incompatible indexing threshold')
        payload_index = info.get('payload_schema', {}).get('article_uri')
        if payload_index is not None and payload_index.get('data_type') != 'keyword':
            raise ValueError('Existing article_uri payload index is not keyword')
        return threshold, payload_index is not None

    async def _create_collection(self, collection, identity):
        await self._request('PUT', f'/collections/{collection}', body={
            'vectors': {
                'dense': {
                    'size': self.dimensions,
                    'distance': DISTANCE,
                    'memory': 'cold',
                },
            },
            'payload': {'memory': 'cold'},
            'optimizers_config': {'indexing_threshold': 0},
            'metadata': {METADATA_KEY: identity},
        })

    async def _create_article_uri_index(self, collection):
        await self._request(
            'PUT', f'/collections/{collection}/index',
            params={'wait': 'true'},
            body={'field_name': 'article_uri', 'field_schema': 'keyword'},
        )

    async def _set_indexing_threshold(self, collection, threshold):
        await self._request('PATCH', f'/collections/{collection}', body={
            'optimizers_config': {'indexing_threshold': threshold},
        })

    async def _upsert(self, collection, points):
        await self._request(
            'PUT', f'/collections/{collection}/points',
            params={'wait': 'true'},
            body={'points': points},
        )

    async def _exact_count(self, collection):
        response = await self._request(
            'POST', f'/collections/{collection}/points/count',
            body={'exact': True},
        )
        return response['result']['count']

    @staticmethod
    def _index_state(info):
        indexed = info.get('indexed_vectors_count')
        queue = info.get('update_queue')
        queue_length = queue.get('length') if isinstance(queue, dict) else None
        optimizer_status = info.get('optimizer_status')
        return {
            'has_ann_index': None if indexed is None else indexed > 0,
            'optimization_pending': None if queue_length is None else queue_length > 0,
            'status': info.get('status'),
            'optimizer_status': optimizer_status,
            'points_count': info.get('points_count'),
            'indexed_vectors_count': indexed,
            'update_queue': queue,
        }

    async def validate_collection(self, collection, identity, *, require_ann=False):
        """Bind one collection to a library identity and its exact passage count."""
        collection = self._collection_name(collection)
        info = await self._collection_info(collection)
        if info is None:
            raise ValueError('Qdrant collection is missing')
        self._validate_collection(info, identity)
        count = await self._exact_count(collection)
        if count != identity['passage_count']:
            raise ValueError('Qdrant point count differs from this library passage count')

        state = self._index_state(info)
        if require_ann and (
            state['status'] != 'green'
            or state['optimizer_status'] != 'ok'
            or state['optimization_pending'] is not False
            or not isinstance(state['indexed_vectors_count'], int)
            or state['indexed_vectors_count'] <= 0
        ):
            raise ValueError('ANN retrieval requires a complete, optimized Qdrant index')
        return {
            'collection': collection,
            'identity': identity,
            'exact_points_count': count,
            'indexed_vectors_count_is_approximate': True,
            'indexed_vector_coverage_estimate': state['indexed_vectors_count'] / count if count else None,
            **state,
        }

    async def upload(self, store, vector_cache, *, collection, batch_size=128):
        collection = self._collection_name(collection)
        if batch_size < 1:
            raise ValueError('batch_size must be positive')
        expected_count = store.manifest['counts']['passages']
        identity = self._identity(store, vector_cache, self.request_model, self.dimensions)
        progress_key = self._progress_key(collection, identity)
        uploaded_passages = self._load_progress(vector_cache, progress_key, expected_count)
        info = await self._collection_info(collection)
        if info is None:
            if uploaded_passages:
                raise ValueError(
                    'Qdrant upload progress exists but its collection is missing; choose a new collection name')
            await self._create_collection(collection, identity)
            info = await self._collection_info(collection)

        threshold, payload_index_exists = self._validate_collection(info, identity)
        if threshold != 0:
            await self._set_indexing_threshold(collection, 0)

        uploaded_in_this_run = 0
        seen_passages = 0
        try:
            if not payload_index_exists:
                await self._create_article_uri_index(collection)

            batch = []
            for passage in store.iter_passages(batch_size=batch_size):
                if seen_passages < uploaded_passages:
                    seen_passages += 1
                    continue
                if seen_passages >= expected_count:
                    raise ValueError(f'Library passage count exceeds manifest count {expected_count}')
                vector = vector_cache.get(passage['embedding_key'])
                if vector is None:
                    raise ValueError(f"Missing cached vector for {passage['embedding_key']}")
                if len(vector) != CANONICAL_VECTOR_SIZE:
                    raise ValueError(
                        f"Cached vector for {passage['embedding_key']} is not {CANONICAL_VECTOR_SIZE}-dimensional")
                chunk_id = passage['id']
                point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'{collection}:{chunk_id}'))
                batch.append({
                    'id': point_id,
                    'vector': {'dense': self._prepare_vector(vector)},
                    'payload': {
                        'chunk_id': chunk_id,
                        'article_uri': passage['uri'],
                        'language': passage['language'],
                        'title': passage['title'],
                        'section_id': passage['section_id'],
                    },
                })
                seen_passages += 1
                if len(batch) == batch_size:
                    await self._upsert(collection, batch)
                    uploaded_in_this_run += len(batch)
                    uploaded_passages = seen_passages
                    self._save_progress(vector_cache, progress_key, expected_count, uploaded_passages)
                    batch = []
            if batch:
                await self._upsert(collection, batch)
                uploaded_in_this_run += len(batch)
                uploaded_passages = seen_passages
                self._save_progress(vector_cache, progress_key, expected_count, uploaded_passages)

            if seen_passages != expected_count:
                raise ValueError(
                    f'Library passage count mismatch: expected {expected_count}, found {seen_passages}')

            actual_count = await self._exact_count(collection)
            if actual_count != expected_count:
                raise ValueError(f'Qdrant point count mismatch: expected {expected_count}, found {actual_count}')
        finally:
            await self._set_indexing_threshold(collection, 10000)

        info = await self._collection_info(collection)
        return {
            'collection': collection,
            'upload_status': 'uploaded',
            'upload_complete': True,
            'actual_embedding_model': identity['actual_embedding_model'],
            'request_model': identity['request_model'],
            'source_manifest_sha256': identity['source_manifest_sha256'],
            'canonical_dimensions': CANONICAL_VECTOR_SIZE,
            'dimensions': self.dimensions,
            'representation': identity['representation'],
            'metric': identity['metric'],
            'expected_passage_count': expected_count,
            'exact_points_count': actual_count,
            'points_upserted_this_run': uploaded_in_this_run,
            **self._index_state(info),
        }

    async def readiness(self, collection):
        collection = self._collection_name(collection)
        info = await self._collection_info(collection)
        if info is None:
            return {'collection': collection, 'status': 'not_found', 'upload_complete': None}
        metadata = info.get('config', {}).get('metadata', {}).get(METADATA_KEY)
        expected_count = metadata.get('passage_count') if isinstance(metadata, dict) else None
        exact_points_count = await self._exact_count(collection)
        return {
            'collection': collection,
            'upload_complete': None if expected_count is None else exact_points_count == expected_count,
            'expected_passage_count': expected_count,
            'exact_points_count': exact_points_count,
            **self._index_state(info),
        }

    async def search(self, vector, *, collection, limit=20, exact=False, hnsw_ef=128, document_uris=None):
        collection = self._collection_name(collection)
        if document_uris is not None and not document_uris:
            return []
        prepared_vector = self._prepare_vector(vector)
        if limit < 1 or hnsw_ef < 1:
            raise ValueError('limit and hnsw_ef must be positive')
        body = {
            'query': prepared_vector,
            'using': 'dense',
            'limit': limit,
            'with_payload': ['chunk_id'],
            'with_vector': False,
            'params': {'exact': exact, 'hnsw_ef': hnsw_ef},
        }
        if document_uris is not None:
            body['filter'] = {
                'must': [{
                    'key': 'article_uri',
                    'match': {'any': list(document_uris)},
                }],
            }
        response = await self._request('POST', f'/collections/{collection}/points/query', body=body)
        return [
            {'id': point['payload']['chunk_id'], 'score': point['score']}
            for point in response['result']['points']
        ]
