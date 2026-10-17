import asyncio
import hashlib
import json
import sqlite3

import pytest

from app.knowledge.library import LibraryStore
from app.knowledge.library_lexical import build_library_lexical
from app.knowledge.library_qdrant import LibraryQdrant as RealLibraryQdrant
from app.knowledge.library_runtime import LibraryRuntime
from test_library import build, fixture_library


COLLECTION = 'wikivoyage_full_' + 'a' * 32
INSTRUCTION = 'Given a travel planning question, retrieve relevant guide passages.'


def manifest_sha(database, root):
    with LibraryStore(database, root) as store:
        raw = store.connection.execute("SELECT value_json FROM manifest WHERE key='manifest'").fetchone()[0]
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def write_release(tmp_path, database, root, *, mode='dense', lexical_database=None,
                  filename='release.json', **overrides):
    payload = {
        'schema_version': 1,
        'library': database.name,
        'library_manifest_sha256': manifest_sha(database, root),
        'collection': COLLECTION,
        'mode': mode,
        'lexical_database': lexical_database.name if lexical_database else None,
        'candidates': 20,
        'context_chars': 6000,
        'exact': False,
        'hnsw_ef': 128,
        'query_instruction': INSTRUCTION,
        'publication': 'evaluation',
    }
    payload.update(overrides)
    release_path = tmp_path / filename
    release_path.write_text(json.dumps(payload), encoding='utf-8')
    return release_path


def test_dense_runtime_injects_instruction_and_model_and_closes_per_search_qdrant(tmp_path, monkeypatch):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    with LibraryStore(database, root) as store:
        target = next(row for row in store.iter_passages() if row['language'] == 'zh')
    release_path = write_release(
        tmp_path, database, root, candidates=7, context_chars=64, exact=True, hnsw_ef=96,
    )
    embed_calls = []
    qdrant_calls = []

    async def embed(text, model, dimensions):
        embed_calls.append((text, model, dimensions))
        return [0.5] * 4096

    class FakeQdrant:
        collection_identity = staticmethod(RealLibraryQdrant.collection_identity)

        def __init__(self, url, *, dimensions, request_model):
            self.url = url
            self.dimensions = dimensions
            self.request_model = request_model
            self.closed = False
            self.validation_args = None
            qdrant_calls.append(self)

        async def validate_collection(self, collection, identity, *, require_ann):
            self.validation_args = (collection, identity, require_ann)
            return {
                'exact_points_count': identity['passage_count'],
                'status': 'green', 'optimizer_status': 'ok',
                'optimization_pending': False, 'indexed_vectors_count': 1,
            }

        async def search(self, vector, **kwargs):
            assert vector == [0.5] * 4096
            self.search_args = kwargs
            return [{'id': target['id'], 'score': 0.9}]

        async def aclose(self):
            self.closed = True

    monkeypatch.setattr('app.knowledge.library_runtime.LibraryQdrant', FakeQdrant)
    runtime = LibraryRuntime(release_path, root, embed, 'http://qdrant.test')
    assert runtime.status()['dense_validation']['status'] == 'not_checked'

    async def run():
        empty = await runtime.search('question', document_ids=[])
        assert empty['blocks'] == []
        assert embed_calls == []
        assert qdrant_calls == []

        result = await runtime.search('question', document_ids=[target['uri']])
        assert len(result['blocks']) == 1
        assert result['blocks'][0]['uri'] == target['uri']
        assert embed_calls == [(
            f'Instruct: {INSTRUCTION}\nQuery: question',
            'test-embed-v1',
            4096,
        )]
        assert len(qdrant_calls) == 2
        assert qdrant_calls[0].validation_args[0] == COLLECTION
        assert qdrant_calls[0].validation_args[2] is False
        assert qdrant_calls[0].closed is True
        assert qdrant_calls[1].dimensions == 4096
        assert qdrant_calls[1].request_model == 'test-embed-v1'
        assert qdrant_calls[1].closed is True
        assert qdrant_calls[1].search_args['document_uris'] == [target['uri']]
        assert qdrant_calls[1].search_args['limit'] == 7
        assert qdrant_calls[1].search_args['exact'] is True
        assert qdrant_calls[1].search_args['hnsw_ef'] == 96

        await runtime.search('question two', document_ids=[target['uri']])
        assert sum(client.validation_args is not None for client in qdrant_calls) == 1
        assert runtime.status()['dense_validation']['status'] == 'validated'

    asyncio.run(run())
    status = runtime.status()
    assert status['publication'] == 'evaluation'
    assert status['evaluation'] is True
    assert runtime.model == 'test-embed-v1'
    assert runtime.embedding_base_url == 'https://embedding.example/v1'
    assert status['candidates'] == 7
    assert status['context_chars'] == 64
    assert status['exact'] is True
    assert status['hnsw_ef'] == 96
    assert status['dimensions'] == 4096
    assert status['canonical_query_dimensions'] == 4096
    assert status['vector_representation'] == {
        'method': 'mrl-prefix', 'normalization': 'l2', 'version': 1,
    }
    assert status['index_version'] == runtime.index_version
    assert status['dense_validation']['status'] == 'validated'
    assert str(database) not in json.dumps(status)
    assert 'qdrant.test' not in json.dumps(status)


def test_lexical_runtime_does_not_create_qdrant_or_call_embedder(tmp_path, monkeypatch):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    lexical_database = tmp_path / 'lexical.sqlite3'
    with LibraryStore(database, root) as store:
        build_library_lexical(store, lexical_database)
        target = next(row for row in store.iter_passages() if row['language'] == 'zh')
    release_path = write_release(
        tmp_path, database, root, mode='lexical', lexical_database=lexical_database,
    )

    def qdrant_must_not_be_constructed(*args, **kwargs):
        raise AssertionError('lexical runtime created Qdrant')

    monkeypatch.setattr('app.knowledge.library_runtime.LibraryQdrant', qdrant_must_not_be_constructed)
    runtime = LibraryRuntime(release_path, root, None, None)

    async def run():
        result = await runtime.search('你好', document_ids=[target['uri']])
        assert result['blocks']
        assert all(block['uri'] == target['uri'] for block in result['blocks'])

    asyncio.run(run())
    assert runtime.status()['lexical_algorithm'] == 'fts5-bm25(k1=1.2,b=.75)'


def test_mrl_release_keeps_query_at_canonical_width_and_pins_qdrant_dimension(tmp_path, monkeypatch):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    with LibraryStore(database, root) as store:
        target = next(row for row in store.iter_passages() if row['language'] == 'zh')
    embed_calls = []
    qdrant_calls = []

    async def embed(text, model, dimensions):
        embed_calls.append((text, model, dimensions))
        return [0.25] * 4096

    class FakeQdrant:
        collection_identity = staticmethod(RealLibraryQdrant.collection_identity)

        def __init__(self, url, *, dimensions, request_model):
            self.url = url
            self.dimensions = dimensions
            self.request_model = request_model
            self.validation_args = None
            qdrant_calls.append(self)

        async def validate_collection(self, collection, identity, *, require_ann):
            self.validation_args = (collection, identity, require_ann)
            return {
                'exact_points_count': identity['passage_count'],
                'status': 'green', 'optimizer_status': 'ok',
                'optimization_pending': False, 'indexed_vectors_count': 1,
            }

        async def search(self, vector, **kwargs):
            assert len(vector) == 4096
            return [{'id': target['id'], 'score': 0.9}]

        async def aclose(self):
            pass

    monkeypatch.setattr('app.knowledge.library_runtime.LibraryQdrant', FakeQdrant)
    release_512 = write_release(
        tmp_path, database, root, filename='release-512.json', dimensions=512,
    )
    runtime_512 = LibraryRuntime(release_512, root, embed, 'http://qdrant.test')
    result = asyncio.run(runtime_512.search('question'))
    assert result['blocks']
    assert result['index_version'] == runtime_512.index_version
    assert qdrant_calls[-1].dimensions == 512
    assert embed_calls[-1][1:] == ('test-embed-v1', 4096)
    assert runtime_512.status()['dimensions'] == 512

    release_4096 = write_release(
        tmp_path, database, root, filename='release-4096.json', dimensions=4096,
    )
    runtime_4096 = LibraryRuntime(release_4096, root, embed, 'http://qdrant.test')
    assert runtime_4096.index_version != runtime_512.index_version


@pytest.mark.parametrize('failure', ['point-count', 'ann-readiness'])
def test_dense_runtime_rejects_unready_collection_before_embedding(tmp_path, monkeypatch, failure):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    release_path = write_release(
        tmp_path, database, root, exact=False,
        filename=f'release-{failure}.json',
    )
    embed_calls = []

    async def embed(*args):
        embed_calls.append(args)
        return [0.25] * 4096

    class FakeQdrant:
        collection_identity = staticmethod(RealLibraryQdrant.collection_identity)

        def __init__(self, url, *, dimensions, request_model):
            pass

        async def validate_collection(self, collection, identity, *, require_ann):
            assert identity['dimensions'] == 4096
            if failure == 'point-count':
                raise ValueError('Qdrant point count differs from this library passage count')
            assert require_ann is True
            raise ValueError('ANN retrieval requires a complete, optimized Qdrant index')

        async def search(self, *_args, **_kwargs):
            pytest.fail('Search ran before readiness validation')

        async def aclose(self):
            pass

    monkeypatch.setattr('app.knowledge.library_runtime.LibraryQdrant', FakeQdrant)
    runtime = LibraryRuntime(release_path, root, embed, 'http://qdrant.test')
    with pytest.raises(ValueError, match='point count|ANN retrieval'):
        asyncio.run(runtime.search('question'))
    assert embed_calls == []
    assert runtime.status()['dense_validation']['status'] == 'failed'


def test_query_instruction_and_lexical_manifest_change_runtime_version(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    lexical_database = tmp_path / 'lexical.sqlite3'
    with LibraryStore(database, root) as store:
        build_library_lexical(store, lexical_database)
    lexical_release = write_release(
        tmp_path, database, root, mode='lexical', lexical_database=lexical_database,
        filename='lexical-release.json',
    )
    original = LibraryRuntime(lexical_release, root, None, None)

    with sqlite3.connect(lexical_database) as connection:
        manifest = json.loads(connection.execute(
            "SELECT value_json FROM manifest WHERE key='manifest'",
        ).fetchone()[0])
        manifest['created_at'] = '2026-10-02T00:00:00+00:00'
        connection.execute(
            "UPDATE manifest SET value_json=? WHERE key='manifest'",
            (json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')) ,),
        )
    changed_lexical = LibraryRuntime(lexical_release, root, None, None)
    assert changed_lexical.index_version != original.index_version

    dense_a = write_release(
        tmp_path, database, root, filename='dense-instruction-a.json',
        query_instruction='retrieve travel evidence',
    )
    dense_b = write_release(
        tmp_path, database, root, filename='dense-instruction-b.json',
        query_instruction='retrieve transport evidence',
    )
    runtime_a = LibraryRuntime(dense_a, root, lambda *_: None, 'http://qdrant.test')
    runtime_b = LibraryRuntime(dense_b, root, lambda *_: None, 'http://qdrant.test')
    assert runtime_a.index_version != runtime_b.index_version


def test_runtime_rejects_library_sha_and_lexical_manifest_mismatch(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    wrong_release = write_release(
        tmp_path, database, root, library_manifest_sha256='0' * 64,
    )
    async def unused_embed(_text, _model):
        raise AssertionError('release validation called the embedder')

    with pytest.raises(ValueError, match='manifest SHA256'):
        LibraryRuntime(wrong_release, root, unused_embed, 'http://qdrant.test')

    lexical_database = tmp_path / 'lexical.sqlite3'
    with LibraryStore(database, root) as store:
        build_library_lexical(store, lexical_database)
    with sqlite3.connect(lexical_database) as connection:
        raw = json.loads(connection.execute(
            "SELECT value_json FROM manifest WHERE key='manifest'",
        ).fetchone()[0])
        raw['library_manifest_sha256'] = 'f' * 64
        connection.execute(
            "UPDATE manifest SET value_json=? WHERE key='manifest'",
            (json.dumps(raw, sort_keys=True, separators=(',', ':')) ,),
        )
    lexical_release = write_release(
        tmp_path, database, root, mode='lexical', lexical_database=lexical_database,
    )
    with pytest.raises(ValueError, match='different library manifest'):
        LibraryRuntime(lexical_release, root, None, None)
