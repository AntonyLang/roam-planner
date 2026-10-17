import asyncio,json,sys
from pathlib import Path
import httpx,pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.providers.web_search import WebSearchQuery,query
from app.providers.errors import UpstreamError

@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setenv('WEB_SEARCH_PROVIDERS','brave,tavily,searxng')
    for key in ('BRAVE_SEARCH_API_KEY','TAVILY_API_KEY','SEARXNG_URL'):
        monkeypatch.delenv(key,raising=False)

@pytest.mark.parametrize('provider,key,url,body',[
    ('brave','BRAVE_SEARCH_API_KEY','https://api.search.brave.com/res/v1/web/search',{'web':{'results':[{'title':'公告','url':'https://example.org/a','description':'时段已调整'}]}}),
    ('tavily','TAVILY_API_KEY','https://api.tavily.com/search',{'results':[{'title':'公告','url':'https://example.org/a','content':'时段已调整'}]}),
    ('searxng','SEARXNG_URL','https://search.example.org/search',{'results':[{'title':'公告','url':'https://example.org/a','content':'时段已调整'}]}),
])
def test_adapter_credentials_wire_and_shared_results(monkeypatch,provider,key,url,body):
    monkeypatch.setenv(key,'https://search.example.org' if provider=='searxng' else 'fixture-key')
    def handle(request):
        assert str(request.url).split('?')[0]==url
        if provider=='brave':
            assert request.headers['x-subscription-token']=='fixture-key'
            assert request.url.params['freshness']=='pw'
        elif provider=='tavily':
            assert request.headers['authorization']=='Bearer fixture-key'
            wire=json.loads(request.content)
            assert wire['time_range']=='week' and wire['search_depth']=='basic' and not wire['auto_parameters']
        else:
            assert request.url.params['format']=='json' and 'time_range' not in request.url.params
        return httpx.Response(200,json=body)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result=await query(client,WebSearchQuery(query='青岛 公告',provider=provider,limit=3,freshness='oneWeek'))
            item=result['result']['items'][0]
            assert item['title']=='公告' and item['summary']=='时段已调整'
            assert item['provider']==provider and item['content_scope']=='search_summary'
            assert result['raw_response']==body and len(result['attempts'])==1
            assert 'fixture-key' not in json.dumps(result)
            if provider=='searxng':assert '一周' in result['limitations'][-1]
    asyncio.run(scenario())

def test_failure_switches_once_but_success_with_no_results_does_not(monkeypatch):
    monkeypatch.setenv('BRAVE_SEARCH_API_KEY','b');monkeypatch.setenv('TAVILY_API_KEY','c')
    calls=[]
    def handle(request):
        calls.append(request.url.host)
        if request.url.host=='api.search.brave.com':return httpx.Response(503)
        return httpx.Response(200,json={'results':[]})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result=await query(client,WebSearchQuery(query='青岛'))
            assert calls==['api.search.brave.com','api.tavily.com'] and result['result']['items']==[]
            assert [a['success'] for a in result['attempts']]==[False,True]
        calls.clear()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:(calls.append(r.url.host) or httpx.Response(200,json={'web':{'results':[]}})))) as client:
            result=await query(client,WebSearchQuery(query='青岛'))
            assert len(calls)==1 and result['missing']
        calls.clear()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:(calls.append(r.url.host) or httpx.Response(429)))) as client:
            with pytest.raises(UpstreamError) as failure:await query(client,WebSearchQuery(query='青岛'))
            assert len(calls)==2 and len(failure.value.attempts)==2
            assert failure.value.code=='UPSTREAM_RATE_LIMITED'
    asyncio.run(scenario())

def test_explicit_unconfigured_source_does_not_call_a_different_provider(monkeypatch):
    monkeypatch.setenv('TAVILY_API_KEY','fixture')
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:pytest.fail('Unexpected request'))) as client:
            with pytest.raises(UpstreamError) as failure:await query(client,WebSearchQuery(query='青岛',provider='brave'))
            assert failure.value.code=='SOURCE_NOT_CONFIGURED'
    asyncio.run(scenario())

@pytest.mark.parametrize('sse',[False,True])
def test_keyless_exa_source_and_mcp_result_formats(monkeypatch,sse):
    monkeypatch.setenv('WEB_SEARCH_PROVIDERS','exa')
    def handle(request):
        assert str(request.url)=='https://mcp.exa.ai/mcp?tools=web_search_exa'
        assert 'authorization' not in request.headers
        assert json.loads(request.content)['params']=={'name':'web_search_exa','arguments':{'query':'青岛 公告','numResults':3}}
        body={'jsonrpc':'2.0','id':1,'result':{'content':[{'type':'text','text':'Title: 公告\nURL: https://example.org/a\nPublished Date: 2026-10-13\nText: 时段已调整'}]}}
        return httpx.Response(200,text='event: message\ndata: '+json.dumps(body)+'\n\n',headers={'content-type':'text/event-stream'}) if sse else httpx.Response(200,json=body)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result=await query(client,WebSearchQuery(query='青岛 公告',limit=3))
            assert result['source']['provider']=='exa'
            assert result['result']['items'][0]['summary']=='时段已调整'
    asyncio.run(run())
