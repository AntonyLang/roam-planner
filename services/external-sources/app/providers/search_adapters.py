"""Provider wire formats stay behind one public-search contract."""
from dataclasses import dataclass
import os
import json
import re
from urllib.parse import urlsplit

@dataclass(frozen=True)
class SearchAdapter:
    name: str
    credential: str
    endpoint_env: str
    endpoint: str

    def available(self):return bool(os.getenv(self.credential,''))

    def request(self,query):
        endpoint=os.getenv(self.endpoint_env,self.endpoint);key=os.getenv(self.credential,'')
        if self.name=='brave':
            params={'q':query.query,'count':query.limit}
            if query.freshness!='noLimit':params['freshness']={'oneDay':'pd','oneWeek':'pw','oneMonth':'pm','oneYear':'py'}[query.freshness]
            return 'GET',endpoint,{'headers':{'X-Subscription-Token':key},'params':params}
        if self.name=='tavily':
            body={'query':query.query,'max_results':query.limit,'search_depth':'basic','include_answer':False,'include_raw_content':False,'auto_parameters':False,'include_usage':True}
            if query.freshness!='noLimit':body['time_range']={'oneDay':'day','oneWeek':'week','oneMonth':'month','oneYear':'year'}[query.freshness]
            return 'POST',endpoint,{'headers':{'Authorization':'Bearer '+key},'json':body}
        params={'q':query.query,'format':'json'}
        if query.freshness not in ('noLimit','oneWeek'):params['time_range']={'oneDay':'day','oneMonth':'month','oneYear':'year'}[query.freshness]
        return 'GET',key.rstrip('/')+'/search',{'params':params}

    def decode(self,response):return response.json()

    def normalize(self,value):
        if not isinstance(value,dict):raise ValueError('Invalid search response')
        if self.name=='brave':
            pages=value.get('web',{}).get('results',[]);title='title';summary='description';date='page_age'
        else:
            pages=value['results'];title='title';summary='content';date='published_date'
        if not isinstance(pages,list):raise ValueError('Invalid result list')
        items=[]
        for page in pages:
            if not isinstance(page,dict):continue
            url=page.get('url','')
            if not isinstance(url,str) or urlsplit(url).scheme not in ('http','https'):continue
            items.append({'title':page.get(title,''),'url':url,'summary':page.get(summary) or page.get('snippet') or '',
                'published_at':page.get(date),'site_name':page.get('siteName'),'content_scope':'search_summary','provider':self.name})
        return items

class ExaMcpAdapter(SearchAdapter):
    """The keyless Exa MCP source used by pi-web-access (exa.ts)."""
    def available(self):return True

    def request(self,query):
        qualifiers={'oneDay':'past 24 hours','oneWeek':'past week','oneMonth':'past month','oneYear':'past year'}
        text=query.query + (' '+qualifiers[query.freshness] if query.freshness in qualifiers else '')
        endpoint=os.getenv(self.endpoint_env,self.endpoint)
        return 'POST',endpoint,{'params':{'tools':'web_search_exa'},
            'headers':{'Content-Type':'application/json','Accept':'application/json, text/event-stream','x-exa-source':'travel-agent'},
            'json':{'jsonrpc':'2.0','id':1,'method':'tools/call',
                    'params':{'name':'web_search_exa','arguments':{'query':text,'numResults':query.limit}}}}

    def decode(self,response):
        if response.headers.get('content-type','').startswith('text/event-stream'):
            messages=[json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith('data:')]
            return next(value for value in reversed(messages) if 'result' in value or 'error' in value)
        return response.json()

    def normalize(self,value):
        if value.get('error') or value.get('result',{}).get('isError'):
            from .errors import UpstreamError
            raise UpstreamError('UPSTREAM_ERROR','Exa MCP 搜索失败：'+str(value.get('error') or value['result'].get('content'))[:200])
        text='\n'.join(part['text'] for part in value['result'].get('content',[]) if part.get('type')=='text')
        if not text.strip() or 'no results found' in text.casefold():return []
        items=[]
        for block in re.split(r'(?=^Title: )',text,flags=re.M):
            def field(name):
                match=re.search(r'^'+name+r':\s*(.+)$',block,re.M)
                return match.group(1).strip() if match else None
            url=field('URL')
            if not url or urlsplit(url).scheme not in ('http','https'):continue
            content=re.split(r'\n(?:Text: |Highlights:\s*\n)',block,maxsplit=1)
            items.append({'title':field('Title') or url,'url':url,
                'summary':content[1].strip()[:2000] if len(content)>1 else '',
                'published_at':field('Published Date'),'content_scope':'search_summary','provider':'exa'})
        if not items:raise ValueError('Unrecognized Exa search result format')
        return items

ADAPTERS={a.name:a for a in (
    ExaMcpAdapter('exa','','EXA_MCP_URL','https://mcp.exa.ai/mcp'),
    SearchAdapter('brave','BRAVE_SEARCH_API_KEY','BRAVE_WEB_SEARCH_URL','https://api.search.brave.com/res/v1/web/search'),
    SearchAdapter('tavily','TAVILY_API_KEY','TAVILY_SEARCH_URL','https://api.tavily.com/search'),
    SearchAdapter('searxng','SEARXNG_URL','SEARXNG_URL',''),
)}
