"""Direct public HTTP fetch and deterministic text extraction; no model calls."""
import asyncio,hashlib,ipaddress,re,socket,time
from collections import OrderedDict
from datetime import datetime,timezone
from html.parser import HTMLParser
from urllib.parse import urljoin
import httpx
from pydantic import BaseModel,ConfigDict,Field
from typing import Literal
from .errors import UpstreamError

PAGES=OrderedDict()
PAGE_TTL=300

class FetchQuery(BaseModel):
    model_config=ConfigDict(extra='forbid')
    url: str=Field(min_length=1,max_length=2000)
    format: Literal['readable','raw']='readable'
    offset: int=Field(default=0,ge=0,strict=True)
    max_chars: int=Field(default=12000,ge=1000,le=30000,strict=True)
    force_refresh: bool=False
    content_id: str|None=Field(default=None,min_length=64,max_length=64)

class PageText(HTMLParser):
    def __init__(self,base):
        super().__init__(convert_charrefs=True);self.base=base;self.parts=[];self.title=[];self.links=[];self.anchors=[];self.hidden=0;self.stack=[];self.article=None;self.article_depth=0
    def handle_starttag(self,tag,attributes):
        attrs=dict(attributes);hidden=tag in {'script','style','noscript','template','svg','nav','footer','head'} or attrs.get('aria-hidden')=='true' or 'hidden' in attrs
        if tag not in {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}:
            self.stack.append((tag,hidden));self.hidden+=int(hidden)
        if not self.hidden and (tag=='article' or tag=='main') and self.article is None:
            self.article=len(self.parts);self.article_depth=len(self.stack)
        if not self.hidden:
            if tag in {'p','div','section','article','main','blockquote','tr'}:self.parts.append('\n\n')
            elif tag=='br':self.parts.append('\n')
            elif tag in {'h1','h2','h3','h4','h5','h6'}:self.parts.append('\n\n'+'#'*int(tag[1])+' ')
            elif tag=='li':self.parts.append('\n- ')
            elif tag in {'td','th'}:self.parts.append(' | ')
            if tag=='a':
                url=urljoin(self.base,attrs.get('href',''));self.anchors.append(url if url.startswith(('http://','https://')) else None)
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs);self.handle_endtag(tag)
    def handle_endtag(self,tag):
        if not self.hidden and tag=='a' and self.anchors:
            link=self.anchors.pop()
            if link:
                if len(self.links)<200:self.links.append(link)
                self.parts.append(' ('+link+')')
        for index in range(len(self.stack)-1,-1,-1):
            if self.stack[index][0]==tag:
                if self.article_depth and index+1==self.article_depth:
                    self.article_text=''.join(self.parts[self.article:]);self.article_depth=0
                for _,hidden in self.stack[index:]:self.hidden-=int(hidden)
                del self.stack[index:];break
        if tag in {'p','div','section','article','main','blockquote','tr','h1','h2','h3','h4','h5','h6'} and not self.hidden:self.parts.append('\n\n')
    def handle_data(self,data):
        if any(tag=='title' for tag,_ in self.stack) and not any(tag=='svg' for tag,_ in self.stack):self.title.append(data)
        elif not self.hidden:self.parts.append(data)
    def text(self):
        text=getattr(self,'article_text',None) or ''.join(self.parts)
        return re.sub(r'\n[ \t]*\n(?:[ \t]*\n)+','\n\n',text).strip()

async def resolve_public(url):
    try:parsed=httpx.URL(url)
    except httpx.InvalidURL:raise UpstreamError('INVALID_ARGUMENTS','网页 URL 不合法') from None
    if parsed.scheme not in ('http','https') or not parsed.host or parsed.username or parsed.password or parsed.port not in (None,80,443):
        raise UpstreamError('INVALID_ARGUMENTS','只支持无凭证的公开 HTTP/HTTPS 网页地址')
    try:addresses=await asyncio.get_running_loop().getaddrinfo(parsed.host,parsed.port or (443 if parsed.scheme=='https' else 80),type=socket.SOCK_STREAM)
    except OSError:raise UpstreamError('UPSTREAM_UNAVAILABLE','无法解析网页域名') from None
    ips=list(dict.fromkeys(a[4][0] for a in addresses))
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise UpstreamError('FETCH_URL_BLOCKED','网页读取仅支持公开网络地址')
    return parsed,ips[0]

async def fetch_page(client,parameters:FetchQuery):
    url=parameters.url;redirects=[]
    for hop in range(6):
        parsed,ip=await resolve_public(url)
        # Pin the validated IP while preserving the origin Host and TLS name.
        pinned=parsed.copy_with(host=ip)
        try:
            async with client.stream('GET',pinned,headers={'Host':parsed.netloc.decode('ascii'),'Accept':'text/html,text/plain,application/json;q=0.9','User-Agent':'TREK-TravelAgent/1.0'},
                extensions={'sni_hostname':parsed.raw_host.decode('ascii')},timeout=25,follow_redirects=False) as response:
                if response.status_code in (301,302,303,307,308):
                    target=response.headers.get('location')
                    if not target or hop==5:raise UpstreamError('UPSTREAM_ERROR','网页重定向过多或缺少目标')
                    redirects.append({'url':url,'status':response.status_code});url=urljoin(url,target);continue
                if not response.is_success:raise UpstreamError('UPSTREAM_ERROR',f'网页返回 HTTP {response.status_code}')
                content_type=response.headers.get('content-type','').lower()
                if not any(t in content_type for t in ('text/','application/json','application/xhtml+xml')):
                    raise UpstreamError('FETCH_UNSUPPORTED_CONTENT','当前网页读取支持 HTML、文本和 JSON；不支持该二进制类型')
                chunks=[];size=0
                async for chunk in response.aiter_bytes():
                    size+=len(chunk)
                    if size>2_000_000:raise UpstreamError('FETCH_TOO_LARGE','网页响应超过 2MB 读取范围')
                    chunks.append(chunk)
                body=b''.join(chunks)
                try:raw=body.decode(response.encoding or 'utf-8',errors='replace')
                except LookupError:raw=body.decode('utf-8',errors='replace')
        except httpx.TimeoutException:raise UpstreamError('UPSTREAM_TIMEOUT','网页读取超时') from None
        except httpx.RequestError:raise UpstreamError('UPSTREAM_UNAVAILABLE','无法读取网页') from None
        break
    title='';links=[];text=raw
    if 'html' in content_type:
        page=PageText(url);page.feed(raw);text=page.text();title=''.join(page.title).strip();links=list(dict.fromkeys(page.links))
    return {'raw':raw,'text':text,'title':title,'url':url,'links':links,'redirects':redirects,'content_type':content_type,'queried_at':datetime.now(timezone.utc).isoformat()}

async def query(client,parameters:FetchQuery):
    key=parameters.url
    cached=PAGES.get(key)
    cache_hit=bool(cached and time.monotonic()-cached[0]<PAGE_TTL and not parameters.force_refresh)
    if parameters.content_id and (not cache_hit or parameters.content_id!=cached[1]['content_id']):
        raise UpstreamError('FETCH_PAGE_EXPIRED','续读页面版本已失效，请从头重新读取，避免拼接不同版本的正文')
    if cache_hit:
        page=cached[1];PAGES.move_to_end(key)
    else:
        page=await fetch_page(client,parameters)
        page['content_id']=hashlib.sha256(page['raw'].encode('utf-8')).hexdigest()
        PAGES[key]=(time.monotonic(),page);PAGES.move_to_end(key)
        while len(PAGES)>8:PAGES.popitem(last=False)
    raw,text=page['raw'],page['text'];content=raw if parameters.format=='raw' else text
    end=min(len(content),parameters.offset+parameters.max_chars)
    return {'result':{'url':page['url'],'requested_url':parameters.url,'title':page['title'],'content_type':page['content_type'],
        'content':content[parameters.offset:end],'content_id':page['content_id'],'format':parameters.format,'offset':parameters.offset,'next_offset':end if end<len(content) else None,
        'total_chars':len(content),'links':page['links'][:40],'content_scope':'http_response' if parameters.format=='raw' else 'extracted_page_text'},
        'source':{'type':'direct-http-fetch','url':page['url']},'queried_at':page['queried_at'],
        'raw_response':{'body':raw,'readable_text':text,'redirects':page['redirects'],'content_type':page['content_type']},
        'cache':{'hit':cache_hit,'ttl_seconds':PAGE_TTL,'age_seconds':time.monotonic()-PAGES[key][0]},
        'missing':[] if text else ['静态响应没有可读正文，内容可能需要 JavaScript 或登录'],
        'limitations':['直接读取 HTTP 响应，不执行 JavaScript，不登录，不调用模型或第三方抽取服务。']}
