import asyncio

from app.knowledge.library import LibraryStore
from app.knowledge.library_search import LibrarySearch, article_scope, library_blocks
from test_library import fixture_library, build


def test_scope_keeps_exact_revision_iri_and_document_destination_intersection(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    with LibraryStore(database, root) as store:
        rows = list(store.connection.execute('SELECT uri,title,source_url FROM articles'))
        chinese = next(row for row in rows if row['title'] == '测试 𠮷')
        from urllib.parse import unquote
        assert article_scope(store, [unquote(chinese['uri'])]) == [chinese['uri']]
        assert article_scope(store, [chinese['source_url']], '测试') == [chinese['uri']]
        assert article_scope(store, [chinese['uri']], 'Test') == []
        assert article_scope(store, [chinese['uri'].rsplit('/', 1)[0] + '/wrong']) == []
        assert article_scope(store, []) == []
        assert article_scope(store) is None


def test_blocks_preserve_unicode_and_duplicate_section_identity_under_body_budget(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    with LibraryStore(database, root) as store:
        passages = list(store.iter_passages())
        ranking = [{'id': p['id'], 'score': 1} for p in passages]
        result = library_blocks(store, ranking, chars=7)
        assert sum(len(b['text']) for b in result) == 7
        for block in result:
            article = store.get_article(block['uri'])
            raw = (root / article['relative_file']).read_bytes().decode('utf-8')
            assert raw[slice(*block['range'])] == block['text']
            assert 0 < block['section_coverage'] <= 1


def test_search_applies_scope_before_embedding_and_recall(tmp_path):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    calls = []
    with LibraryStore(database, root) as store:
        passages = list(store.iter_passages())
        target = next(p for p in passages if p['language'] == 'zh')

    async def embed(query):
        calls.append(('embed', query))
        return [0.5]

    class Recall:
        async def search(self, vector, **kwargs):
            calls.append(('recall', kwargs))
            return [{'id': p['id'], 'score': 1} for p in passages
                    if kwargs['document_uris'] is None or p['uri'] in kwargs['document_uris']]

    search = LibrarySearch(database, root, qdrant=Recall(), collection='test', embed_query=embed)

    async def run():
        assert (await search.search('query', document_ids=[]))['blocks'] == []
        assert calls == []
        result = await search.search('query', document_ids=[target['uri']])
        assert [c[0] for c in calls] == ['embed', 'recall']
        assert calls[1][1]['document_uris'] == [target['uri']]
        assert all(b['uri'] == target['uri'] for b in result['blocks'])
        assert result['retrieval']['candidate_count'] == 1

    asyncio.run(run())
