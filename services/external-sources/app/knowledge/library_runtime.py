"""Release-bound runtime for optional full-library Sources MCP wiring."""
import asyncio
import hashlib
import json
import re
from pathlib import Path

from .library import LibraryStore
from .library_archive import LibraryArchive
from .library_lexical import LibraryLexical
from .library_qdrant import (
    CANONICAL_VECTOR_SIZE,
    DIMENSION_CHOICES,
    REPRESENTATION,
    LibraryQdrant,
)
from .library_search import LibrarySearch
from .corpus import fingerprint

COLLECTION_PATTERN = re.compile(r'^wikivoyage_full_[0-9a-f]{32}$')


def _release_path(value, release_parent):
    path = Path(value)
    return (path if path.is_absolute() else release_parent / path).resolve()


class _PerSearchQdrant:
    def __init__(self, url, *, dimensions=CANONICAL_VECTOR_SIZE, request_model=None):
        self.url = url
        self.dimensions = dimensions
        self.request_model = request_model

    async def search(self, *args, **kwargs):
        client = LibraryQdrant(
            self.url, dimensions=self.dimensions, request_model=self.request_model,
        )
        try:
            return await client.search(*args, **kwargs)
        finally:
            await client.aclose()

    async def validate_collection(self, collection, identity, *, require_ann=False):
        client = LibraryQdrant(
            self.url, dimensions=self.dimensions, request_model=self.request_model,
        )
        try:
            return await client.validate_collection(
                collection, identity, require_ann=require_ann,
            )
        finally:
            await client.aclose()


class LibraryRuntime:
    def __init__(self, release_path, knowledge_root, query_embedder, qdrant_url):
        self.release_path = Path(release_path).resolve()
        self.release = json.loads(self.release_path.read_text(encoding='utf-8'))
        self.knowledge_root = Path(knowledge_root).resolve()
        self.library_path = _release_path(self.release['library'], self.release_path.parent)
        self.lexical_path = (
            _release_path(self.release['lexical_database'], self.release_path.parent)
            if self.release.get('lexical_database') else None
        )

        if self.release.get('schema_version') != 1:
            raise ValueError('Unsupported library release schema_version')
        if not COLLECTION_PATTERN.fullmatch(self.release.get('collection', '')):
            raise ValueError('Library collection must use wikivoyage_full_<32 lowercase hex> namespace')
        if self.release.get('mode') not in ('dense', 'lexical', 'hybrid'):
            raise ValueError('Unknown library retrieval mode')
        self.dimensions = self.release.get('dimensions', CANONICAL_VECTOR_SIZE)
        if self.dimensions not in DIMENSION_CHOICES:
            raise ValueError(f'Library release dimensions must be one of {DIMENSION_CHOICES}')
        if not isinstance(self.release.get('candidates'), int) or self.release['candidates'] < 1:
            raise ValueError('Library release candidates must be positive')
        if not isinstance(self.release.get('context_chars'), int) or self.release['context_chars'] < 1:
            raise ValueError('Library release context_chars must be positive')
        if not isinstance(self.release.get('hnsw_ef'), int) or self.release['hnsw_ef'] < 1:
            raise ValueError('Library release hnsw_ef must be positive')
        if not isinstance(self.release.get('exact'), bool):
            raise ValueError('Library release exact must be boolean')
        if self.release.get('publication') not in ('evaluation', 'published'):
            raise ValueError('Library release publication must be evaluation or published')
        if not isinstance(self.release.get('query_instruction'), str) or not self.release['query_instruction']:
            raise ValueError('Library release query_instruction is required')
        mode = self.release['mode']
        if mode in ('dense', 'hybrid') and (not qdrant_url or query_embedder is None):
            raise ValueError('Dense retrieval requires a Qdrant URL and injected query embedder')
        if mode in ('lexical', 'hybrid') and self.lexical_path is None:
            raise ValueError('Lexical retrieval requires a lexical database')

        with LibraryStore(self.library_path, self.knowledge_root) as store:
            row = store.connection.execute(
                "SELECT value_json FROM manifest WHERE key='manifest'",
            ).fetchone()
            library_manifest_sha256 = hashlib.sha256(row[0].encode('utf-8')).hexdigest()
            self.library_manifest = store.manifest
        if library_manifest_sha256 != self.release.get('library_manifest_sha256'):
            raise ValueError('Release library manifest SHA256 does not match the library')
        if (self.library_manifest.get('source') != 'wikivoyage'
                or set(self.library_manifest.get('languages', [])) != {'en', 'zh'}):
            raise ValueError('Release library must contain Wikivoyage en/zh')

        self.lexical = LibraryLexical(self.lexical_path) if mode in ('lexical', 'hybrid') else None
        if (self.lexical is not None
                and self.lexical.manifest.get('library_manifest_sha256') != library_manifest_sha256):
            raise ValueError('Lexical index is bound to a different library manifest')
        self.lexical_manifest_identity = (
            fingerprint(self.lexical.manifest) if self.lexical is not None else None
        )

        self.archive = LibraryArchive(self.knowledge_root, self.library_path)
        self.query_embedder = query_embedder
        self.model = self.library_manifest['embedding']['model']
        self.request_model = self.library_manifest['embedding'].get('request_model') or self.model
        self.embedding_base_url = self.library_manifest['embedding']['base_url']
        self.qdrant_url = qdrant_url
        self.dense_identity = (
            {
                'actual_embedding_model': self.model,
                'request_model': self.request_model,
                'canonical_dimensions': CANONICAL_VECTOR_SIZE,
                'dimensions': self.dimensions,
                'representation': REPRESENTATION,
            }
            if mode in ('dense', 'hybrid') else None
        )
        self.collection_identity = (
            LibraryQdrant.collection_identity(
                self.library_manifest,
                actual_embedding_model=self.model,
                request_model=self.request_model,
                dimensions=self.dimensions,
            )
            if mode in ('dense', 'hybrid') else None
        )
        self.qdrant = (
            _PerSearchQdrant(
                qdrant_url, dimensions=self.dimensions,
                request_model=self.request_model,
            )
            if mode in ('dense', 'hybrid') else None
        )
        self.mode = mode
        self._dense_validation = {'status': 'not_checked'} if self.qdrant is not None else None
        self._dense_validation_lock = asyncio.Lock() if self.qdrant is not None else None
        self.searcher = LibrarySearch(
            self.library_path,
            self.knowledge_root,
            collection=self.release['collection'],
            qdrant=self.qdrant,
            embed_query=self._embed_query if mode in ('dense', 'hybrid') else None,
            lexical=self.lexical,
            mode=mode,
            candidates=self.release['candidates'],
            context_chars=self.release['context_chars'],
            exact=self.release['exact'],
            hnsw_ef=self.release['hnsw_ef'],
        )
        self.index_version = fingerprint({
            'library_search_version': self.searcher.version,
            'dimensions': self.dimensions,
            'canonical_query_dimensions': CANONICAL_VECTOR_SIZE,
            'vector_representation': REPRESENTATION if self.dense_identity else None,
            'dense_identity': self.dense_identity,
            'query_instruction': self.release['query_instruction'] if self.dense_identity else None,
            'lexical_manifest_identity': self.lexical_manifest_identity,
        })[:32]

    async def _validate_dense_collection(self):
        if self._dense_validation['status'] == 'validated':
            return
        async with self._dense_validation_lock:
            if self._dense_validation['status'] == 'validated':
                return
            try:
                readiness = await self.qdrant.validate_collection(
                    self.release['collection'], self.collection_identity,
                    require_ann=not self.release['exact'],
                )
            except Exception:
                self._dense_validation = {'status': 'failed'}
                raise
            self._dense_validation = {
                'status': 'validated',
                'exact_points_count': readiness['exact_points_count'],
                'expected_points_count': self.collection_identity['passage_count'],
                'ann_required': not self.release['exact'],
                'ann_ready': (
                    readiness['status'] == 'green'
                    and readiness['optimizer_status'] == 'ok'
                    and readiness['optimization_pending'] is False
                    and isinstance(readiness['indexed_vectors_count'], int)
                    and readiness['indexed_vectors_count'] > 0
                ),
            }

    async def _embed_query(self, query):
        await self._validate_dense_collection()
        text = f"Instruct: {self.release['query_instruction']}\nQuery: {query}"
        return await self.query_embedder(text, self.request_model, CANONICAL_VECTOR_SIZE)

    async def search(self, query, limit=5, document_ids=None, destination=None):
        result = await self.searcher.search(
            query, limit=limit, document_ids=document_ids, destination=destination,
        )
        result['index_version'] = self.index_version
        return result

    def status(self):
        return {
            'schema_version': self.release['schema_version'],
            'publication': self.release['publication'],
            'evaluation': self.release['publication'] == 'evaluation',
            'library': {
                'source': self.library_manifest['source'],
                'snapshot': self.library_manifest['snapshot'],
                'languages': self.library_manifest['languages'],
                'corpus_id': self.library_manifest['corpus_id'],
                'manifest_sha256': self.release['library_manifest_sha256'],
                'catalog_sha256': self.library_manifest['catalog_sha256'],
                'passages': self.library_manifest['counts']['passages'],
            },
            'collection': self.release['collection'],
            'index_version': self.index_version,
            'mode': self.mode,
            'dimensions': self.dimensions,
            'canonical_query_dimensions': CANONICAL_VECTOR_SIZE,
            'vector_representation': REPRESENTATION if self.dense_identity else None,
            'embedding_model': self.model,
            'embedding_request_model': self.request_model,
            'candidates': self.release['candidates'],
            'context_chars': self.release['context_chars'],
            'exact': self.release['exact'],
            'hnsw_ef': self.release['hnsw_ef'],
            'query_instruction': self.release['query_instruction'],
            'dense_validation': self._dense_validation,
            'lexical_algorithm': self.lexical.manifest['algorithm'] if self.lexical else None,
            'lexical_manifest_identity': self.lexical_manifest_identity,
        }
