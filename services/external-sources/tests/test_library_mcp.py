import asyncio
import json

import httpx

from app.knowledge.corpus import fingerprint
from app.knowledge.library import LibraryStore
from app.knowledge.library_lexical import build_library_lexical
from app.knowledge.library_runtime import LibraryRuntime
from test_library import fixture_library, build


def test_mcp_serves_only_a_published_library_and_has_no_management_api(tmp_path, monkeypatch):
    root, _ = fixture_library(tmp_path)
    database = build(tmp_path, root)
    lexical = tmp_path / 'lexical.sqlite'
    with LibraryStore(database, root) as store:
        build_library_lexical(store, lexical)
        manifest_sha = fingerprint(store.manifest)
    release = tmp_path / 'release.json'
    release.write_text(json.dumps({'schema_version': 1, 'library': str(database),
        'library_manifest_sha256': manifest_sha, 'collection': 'wikivoyage_full_' + '0' * 32,
        'mode': 'lexical', 'lexical_database': str(lexical), 'candidates': 20,
        'context_chars': 6000, 'exact': False, 'hnsw_ef': 128,
        'query_instruction': 'Retrieve archived travel evidence.', 'publication': 'published'}), encoding='utf-8')
    runtime = LibraryRuntime(release, root, None, None)
    monkeypatch.delenv('KNOWLEDGE_LIBRARY_RELEASE', raising=False)
    monkeypatch.setenv('SOURCES_GUIDES_ENABLED', 'true')
    from app import mcp
    from app.knowledge import mcp_runtime
    monkeypatch.setattr(mcp_runtime, 'library_runtime', None)
    assert not mcp.guides_enabled()
    monkeypatch.setattr(mcp_runtime, 'library_runtime', runtime)
    monkeypatch.setattr(mcp_runtime, 'archive', runtime.archive)
    monkeypatch.setattr(mcp, 'archive', runtime.archive)
    from app.main import app

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
            async def rpc(method, params):
                response = await client.post('/mcp', json={
                    'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
                return response.json()['result']

            tools = await rpc('tools/list', {})
            assert {tool['name'] for tool in tools['tools']} >= {'search_guides', 'read_guide'}
            result = await rpc('tools/call', {'name': 'search_guides', 'arguments': {'query': '你好'}})
            block = result['structuredContent']['blocks'][0]
            assert '你好' in block['text']
            read = await rpc('tools/call', {'name': 'read_guide', 'arguments': {
                'uri': block['uri'], 'start': block['range'][0], 'length': len(block['text'])}})
            assert read['structuredContent']['text'] == block['text']
            toc = await rpc('resources/read', {'uri': block['uri'] + '/toc'})
            assert json.loads(toc['contents'][0]['text'])['sections']
            catalog = await rpc('resources/list', {})
            assert catalog['resources'][0]['uri'] == 'guide://catalog'
            assert (await client.get('/v1/retrieval')).status_code == 404
            assert (await client.get('/v1/retrieval/articles')).status_code == 404

            mcp_runtime.library_runtime = None
            tools_without_release = await rpc('tools/list', {})
            assert 'search_guides' not in {tool['name'] for tool in tools_without_release['tools']}

    asyncio.run(run())