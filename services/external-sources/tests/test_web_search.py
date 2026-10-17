import asyncio,json,sys
from pathlib import Path
import httpx,pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.providers.web_search import WebSearchQuery,query
from app.providers.errors import UpstreamError
from app.main import app

def test_mcp_discovers_public_search_and_preserves_source_scope(monkeypatch):
    monkeypatch.setenv('WEB_SEARCH_PROVIDERS','exa')
    def handle(request):
        assert 'authorization' not in request.headers
        assert json.loads(request.content)['params']['name']=='web_search_exa'
        return httpx.Response(200,json={'jsonrpc':'2.0','id':1,'result':{'content':[{'type':'text',
            'text':'Title: 市场官方公告\nURL: https://example.test/notice\nPublished Date: 2026-10-01\nText: 每天6点开放\nTitle: invalid\nURL: javascript:bad\nText: ignore'}]}})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            app.state.http=client
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as api:
                listing=(await api.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/list'})).json()
                assert any(t['name']=='web_search' for t in listing['result']['tools'])
                result=(await api.post('/mcp',json={'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'web_search','arguments':{'query':'青岛 市场 官方'}}})).json()['result']
                items=result['structuredContent']['result']['items']
                assert len(items)==1 and items[0]['content_scope']=='search_summary'
                assert items[0]['published_at']=='2026-10-01' and 'private-fixture' not in json.dumps(result)
    asyncio.run(scenario())

@pytest.mark.parametrize('body',[{'error':{'code':401}}, {'result':{'isError':True,'content':[]}}, {'result':{'content':[{'type':'text','text':'broken'}]}}])
def test_malformed_or_failed_search_is_not_an_empty_success(monkeypatch,body):
    monkeypatch.setenv('WEB_SEARCH_PROVIDERS','exa')
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,json=body))) as client:
            with pytest.raises(UpstreamError):await query(client,WebSearchQuery(query='青岛'))
    asyncio.run(scenario())
