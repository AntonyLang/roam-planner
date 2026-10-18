"""Single-source discovery with bounded fallback; adapters own wire formats."""
from datetime import datetime,timezone
import os,time
from typing import Literal
import httpx
from pydantic import BaseModel,ConfigDict,Field,field_validator
from .errors import UpstreamError
from .search_adapters import ADAPTERS, public_endpoint

class WebSearchQuery(BaseModel):
    model_config=ConfigDict(extra='forbid')
    query: str=Field(min_length=1,max_length=400)
    limit: int=Field(default=5,ge=1,le=10,strict=True)
    freshness: Literal['noLimit','oneDay','oneWeek','oneMonth','oneYear']='noLimit'
    provider: Literal['auto','exa','brave','tavily','searxng']='auto'
    force_refresh: bool=False
    @field_validator('query')
    @classmethod
    def meaningful(cls,value):
        if not value.strip():raise ValueError('Search query must contain text')
        return value.strip()

async def query(client,parameters:WebSearchQuery):
    order=[n.strip() for n in os.getenv('WEB_SEARCH_PROVIDERS','exa').split(',')]
    if any(n not in ADAPTERS for n in order):raise UpstreamError('SOURCE_NOT_CONFIGURED','搜索来源配置包含未知适配器')
    names=[parameters.provider] if parameters.provider!='auto' else list(dict.fromkeys(order))
    choices=[ADAPTERS[n] for n in names if ADAPTERS[n].available()][:2]
    if not choices:raise UpstreamError('SOURCE_NOT_CONFIGURED','指定搜索来源未配置密钥或实例地址')
    attempts=[];last=None
    for adapter in choices:
        start=time.monotonic();method,url,options=adapter.request(parameters)
        try:
            response=await client.request(method,url,**options,timeout=60 if adapter.name=='exa' else 20)
            if not response.is_success:
                code={401:'UPSTREAM_AUTH_FAILED',403:'UPSTREAM_QUOTA_EXCEEDED',429:'UPSTREAM_RATE_LIMITED'}.get(response.status_code,'UPSTREAM_ERROR')
                raise UpstreamError(code,f'{adapter.name} 搜索返回 HTTP {response.status_code}')
            value=adapter.decode(response);items=adapter.normalize(value)[:parameters.limit]
        except httpx.TimeoutException:
            last=UpstreamError('UPSTREAM_TIMEOUT',adapter.name+' 搜索超时')
        except httpx.RequestError:
            last=UpstreamError('UPSTREAM_UNAVAILABLE','无法连接 '+adapter.name+' 搜索')
        except (ValueError,TypeError,KeyError,AttributeError,StopIteration):
            last=UpstreamError('UPSTREAM_INVALID_RESPONSE',adapter.name+' 搜索响应格式不合法')
        except UpstreamError as error:last=error
        else:
            attempts.append({'provider':adapter.name,'success':True,'elapsed_seconds':time.monotonic()-start})
            return {'result':{'items':items},'source':{'type':adapter.name+'-web-search','url':public_endpoint(url),'provider':adapter.name},
                'queried_at':datetime.now(timezone.utc).isoformat(),'missing':[] if items else ['无网页搜索结果'],
                'attempts':attempts,'raw_response':value,
                'limitations':['返回搜索摘要而非完整网页；需要完整依据时读取原始链接。没有结果不触发来源切换。'] +
                    (['SearXNG 不支持一周时间筛选；本次未应用时间筛选，请核实每条来源的发布时间。'] if adapter.name=='searxng' and parameters.freshness=='oneWeek' else []) +
                    (['Exa MCP 的时间条件加入搜索词，不是严格日期过滤；请核实网页发布时间。'] if adapter.name=='exa' and parameters.freshness!='noLimit' else [])}
        attempts.append({'provider':adapter.name,'success':False,'code':last.code,'message':last.message,'elapsed_seconds':time.monotonic()-start})
    last.attempts=attempts
    raise last
