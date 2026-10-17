"""Native signed XHS requests using the same xhshow signer as MediaCrawler."""
import json
from .errors import UpstreamError


class XhsApi:
    def __init__(self, client, session):
        self.client, self.session = client, session
        self.timeout=30

    async def post(self, uri, body):
        from xhshow import Xhshow
        cookie = self.session['cookie']
        headers = {'Cookie':cookie, 'User-Agent':self.session['user_agent'],
                   'Origin':'https://www.xiaohongshu.com', 'Referer':'https://www.xiaohongshu.com/',
                   'Accept':'application/json, text/plain, */*', 'Content-Type':'application/json;charset=UTF-8'}
        headers.update(Xhshow().sign_headers_post(uri=uri,cookies=cookie,payload=body))
        response = await self.client.post('https://edith.xiaohongshu.com'+uri, headers=headers,
            content=json.dumps(body,separators=(',',':'),ensure_ascii=False),timeout=self.timeout)
        if response.status_code in (401,403,429,461,471):
            raise UpstreamError('XHS_USER_ACTION_REQUIRED',f'小红书返回 HTTP {response.status_code}，请检查登录或平台验证')
        response.raise_for_status()
        value=response.json()
        if value.get('code') in (-510000,-510001):return {}
        if value.get('success') is not True:
            raise UpstreamError('XHS_USER_ACTION_REQUIRED','小红书查询被拒绝，需检查登录或平台验证（code='+str(value.get('code'))+'）')
        return value.get('data') or {}

    async def get_note_by_keyword(self, keyword, search_id, page, page_size, sort):
        return await self.post('/api/sns/web/v1/search/notes',{
            'keyword':keyword,'page':page,'page_size':page_size,'search_id':search_id,
            'sort':sort.value,'note_type':0})

    async def get_note_by_id(self, note_id, xsec_source, xsec_token):
        value=await self.post('/api/sns/web/v1/feed',{'source_note_id':note_id,
            'image_formats':['jpg','webp','avif'],'extra':{'need_body_topic':1},
            'xsec_source':xsec_source or 'pc_search','xsec_token':xsec_token})
        return value['items'][0]['note_card'] if value.get('items') else {}
