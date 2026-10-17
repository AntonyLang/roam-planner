import asyncio,socket,sys,time
from pathlib import Path
import httpx,pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.providers import web_fetch
from app.providers.errors import UpstreamError
from app.mcp_contracts import model_projection
from app.main import app

@pytest.fixture(autouse=True)
def isolate(monkeypatch):
    monkeypatch.setattr(web_fetch,'PAGES',web_fetch.OrderedDict())

def test_readable_body_keeps_title_paragraphs_links_and_raw_version(monkeypatch):
    async def public(url):return httpx.URL(url),'93.184.216.34'
    monkeypatch.setattr(web_fetch,'resolve_public',public)
    html='<html><head><title>青岛公告</title><script>secret</script></head><body><nav>菜单</nav><svg><title>切换主题</title></svg><main><h1>开放时间</h1><p>每天九点开放。</p><p><a href="/notice">查看公告</a></p><br><p>'+('详细说明。'*600)+'</p><img hidden src="a"><p>尾段</p></main><footer>版权</footer></body></html>'
    requests=[]
    def handle(request):
        requests.append(request)
        assert request.url.host=='93.184.216.34'
        assert request.headers['host']=='example.org' and request.extensions['sni_hostname']=='example.org'
        return httpx.Response(200,text=html,headers={'Content-Type':'text/html; charset=utf-8'})
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            first=await web_fetch.query(client,web_fetch.FetchQuery(url='https://example.org/a',max_chars=1000))
            r=first['result'];assert r['title']=='青岛公告' and r['next_offset']==1000
            assert '# 开放时间\n\n每天九点开放。' in r['content']
            assert '查看公告 (https://example.org/notice)' in r['content']
            assert not any(s in r['content'] for s in ('secret','菜单','版权','<p>'))
            next_page=await web_fetch.query(client,web_fetch.FetchQuery(url='https://example.org/a',content_id=r['content_id'],offset=1000,max_chars=1000))
            assert next_page['cache']['hit'] and len(requests)==1
            assert next_page['result']['content']==first['raw_response']['readable_text'][1000:2000]
            raw=await web_fetch.query(client,web_fetch.FetchQuery(url='https://example.org/a',format='raw',max_chars=30000))
            assert raw['result']['content']==html and '尾段' in first['raw_response']['readable_text']
            assert 'raw_response' not in model_projection('web_fetch',first)
            assert first['raw_response']['body']==html
            web_fetch.PAGES['https://example.org/a']=(time.monotonic()-301,web_fetch.PAGES['https://example.org/a'][1])
            with pytest.raises(UpstreamError) as failure:
                await web_fetch.query(client,web_fetch.FetchQuery(url='https://example.org/a',content_id=r['content_id'],offset=2000))
            assert failure.value.code=='FETCH_PAGE_EXPIRED' and len(requests)==1
    asyncio.run(scenario())

@pytest.mark.parametrize('ip',['127.0.0.1','10.0.0.1','169.254.169.254','::1','fd00::1'])
def test_private_dns_targets_are_rejected(monkeypatch,ip):
    async def scenario():
        async def lookup(*args,**kwargs):return [(socket.AF_INET,socket.SOCK_STREAM,0,'',(ip,443))]
        monkeypatch.setattr(asyncio.get_running_loop(),'getaddrinfo',lookup)
        with pytest.raises(UpstreamError) as failure:await web_fetch.resolve_public('https://example.org/a')
        assert failure.value.code=='FETCH_URL_BLOCKED'
    asyncio.run(scenario())

def test_redirects_revalidate_destination_before_second_request(monkeypatch):
    visited=[]
    async def public(url):
        visited.append(url)
        if '127.0.0.1' in url:raise UpstreamError('FETCH_URL_BLOCKED','private')
        return httpx.URL(url),'93.184.216.34'
    monkeypatch.setattr(web_fetch,'resolve_public',public)
    requests=[]
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:(requests.append(r) or httpx.Response(302,headers={'location':'http://127.0.0.1/internal'})))) as client:
            with pytest.raises(UpstreamError) as failure:await web_fetch.query(client,web_fetch.FetchQuery(url='https://example.org/a'))
            assert failure.value.code=='FETCH_URL_BLOCKED' and len(requests)==1
            assert visited[-1]=='http://127.0.0.1/internal'
    asyncio.run(scenario())

@pytest.mark.parametrize('content_type,content,code',[('application/pdf',b'%PDF','FETCH_UNSUPPORTED_CONTENT'),('text/plain',b'a'*2_000_001,'FETCH_TOO_LARGE')],ids=['pdf','oversized-text'])
def test_unsupported_or_oversized_payload_is_explicit_failure(monkeypatch,content_type,content,code):
    async def public(url):return httpx.URL(url),'93.184.216.34'
    monkeypatch.setattr(web_fetch,'resolve_public',public)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=content,headers={'content-type':content_type}))) as client:
            with pytest.raises(UpstreamError) as failure:await web_fetch.query(client,web_fetch.FetchQuery(url='https://example.org/a'))
            assert failure.value.code==code and not web_fetch.PAGES
    asyncio.run(scenario())

def test_mcp_exposes_readable_slice_and_keeps_raw_in_metadata(monkeypatch):
    async def public(url):return httpx.URL(url),'93.184.216.34'
    monkeypatch.setattr(web_fetch,'resolve_public',public)
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,text='<p>可读正文</p>',headers={'content-type':'text/html'}))) as client:
            app.state.http=client
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as api:
                listing=(await api.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/list'})).json()['result']['tools']
                assert next(t for t in listing if t['name']=='web_fetch')['inputSchema']['properties']['content_id']
                result=(await api.post('/mcp',json={'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'web_fetch','arguments':{'url':'https://example.org/a'}}})).json()['result']
                assert result['structuredContent']['result']['content']=='可读正文'
                assert 'raw_response' not in result['structuredContent']
                assert result['_meta']['io.liketrek.agent/original']['raw_response']['body']=='<p>可读正文</p>'
    asyncio.run(scenario())
