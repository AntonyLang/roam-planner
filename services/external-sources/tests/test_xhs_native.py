import asyncio
import json
from types import SimpleNamespace
import httpx
import pytest
from app.main import app
from app.providers import xhs
from app.providers.errors import UpstreamError

def session(tmp_path,monkeypatch):
    folder=tmp_path/'session';folder.mkdir()
    (folder/'session.json').write_text(json.dumps({'cookie':'web_session=private-cookie','user_agent':'fixture-browser'}))
    (folder/'active-profile.json').write_text('{"directory":"fixture"}')
    monkeypatch.setenv('XHS_SESSION_FILE',str(folder/'session.json'))
    monkeypatch.setenv('XHS_ACCESS_DB',str(tmp_path/'access.sqlite'))
    monkeypatch.setattr(xhs,'_last_call',0)
    monkeypatch.setattr('xhshow.Xhshow',lambda:SimpleNamespace(sign_headers_post=lambda **kwargs:{'x-s':'fixture-signature'}))

def test_search_then_detail_use_direct_api_and_private_access_record(tmp_path,monkeypatch):
    session(tmp_path,monkeypatch)
    ident='a'*24;calls=[]
    def handle(request):
        assert request.url.host=='edith.xiaohongshu.com'
        assert request.headers['cookie']=='web_session=private-cookie'
        assert request.headers['x-s']=='fixture-signature'
        body=json.loads(request.content);calls.append(body)
        if request.url.path.endswith('/search/notes'):
            assert body['keyword']=='青岛 旅行' and body['sort']=='time_descending'
            data={'items':[{'id':ident,'xsec_token':'private-note-token','note_card':{'display_title':'路线'}}]}
        else:
            assert body['source_note_id']==ident and body['xsec_token']=='private-note-token'
            data={'items':[{'note_card':{'note_id':ident,'title':'路线','desc':'完整正文'}}]}
        return httpx.Response(200,json={'success':True,'code':0,'data':data})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            cards=await xhs.query(client,xhs.SearchQuery(keywords='旅行',destination='青岛',sort='latest'))
            assert cards['result']['items'][0]['detail_available']
            monkeypatch.setattr(xhs,'_last_call',0)
            note=await xhs.query(client,xhs.NoteQuery(note_id=ident))
            assert note['result']['note']['content']=='完整正文'
            assert 'private-' not in json.dumps([cards,note])
    asyncio.run(run())
    assert len(calls)==2

def test_missing_login_and_platform_rejection_are_explicit(tmp_path,monkeypatch):
    monkeypatch.setenv('XHS_SESSION_FILE',str(tmp_path/'missing.json'))
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(403))) as client:
            with pytest.raises(UpstreamError,match='尚未导出'):await xhs.query(client,xhs.SearchQuery(keywords='旅行',destination='青岛'))
            session(tmp_path,monkeypatch)
            with pytest.raises(UpstreamError) as error:await xhs.query(client,xhs.SearchQuery(keywords='旅行',destination='青岛'))
            assert error.value.code=='XHS_USER_ACTION_REQUIRED'
    asyncio.run(run())

def test_disabled_guides_are_absent_from_mcp_tools_and_resources(monkeypatch):
    monkeypatch.setenv('SOURCES_GUIDES_ENABLED','false')
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
            async def rpc(method,params={}):return (await client.post('/mcp',json={'jsonrpc':'2.0','id':1,'method':method,'params':params})).json()
            init=await rpc('initialize',{'protocolVersion':'2025-11-25'})
            assert 'resources' not in init['result']['capabilities']
            names={t['name'] for t in (await rpc('tools/list'))['result']['tools']}
            assert not names & {'search_guides','read_guide'}
            assert (await rpc('resources/read',{'uri':'guide://catalog'}))['error']['code']==-32601
    asyncio.run(run())
