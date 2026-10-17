"""MCP tools call the native XHS search/detail client directly."""
import os
import asyncio
import json
import time
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from .errors import UpstreamError
from .xhs_api import XhsApi
from .xhs_live import query as live_query

_lock=asyncio.Lock()
_last_call=0.0


class SearchQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    keywords: str = Field(min_length=1, max_length=200)
    destination: str = Field(min_length=1, max_length=100)
    limit: int = Field(default=3, ge=1, le=10, strict=True)
    sort: Literal['general','latest','popular'] = 'general'
    force_refresh: bool = False


class NoteQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    note_id: str = Field(pattern=r'^[0-9a-fA-F]{24}$')
    force_refresh: bool = False


async def query(client: httpx.AsyncClient, parameters: SearchQuery | NoteQuery):
    global _last_call
    session_file=Path(os.getenv('XHS_SESSION_FILE','/run/xhs-session/session.json'))
    if not session_file.is_file():
        raise UpstreamError('SOURCE_NOT_CONFIGURED','尚未导出小红书登录状态，请使用采集器登录入口')
    session=json.loads(session_file.read_text(encoding='utf-8'))
    database=Path(os.getenv('XHS_ACCESS_DB','/data/crawled/xhs-access.sqlite'))
    keywords=parameters.keywords.strip() if isinstance(parameters,SearchQuery) else ''
    if isinstance(parameters,SearchQuery) and parameters.destination not in keywords:
        keywords=parameters.destination.strip()+' '+keywords
    async with _lock:
        remaining=5-(time.monotonic()-_last_call)
        if remaining>0:await asyncio.sleep(remaining)
        try:
            return await live_query(XhsApi(client,session),session_file.parent,database,
                keywords=keywords,count=parameters.limit if isinstance(parameters,SearchQuery) else 1,
                sort=parameters.sort if isinstance(parameters,SearchQuery) else 'general',
                note_id=parameters.note_id if isinstance(parameters,NoteQuery) else None)
        except httpx.TimeoutException:
            raise UpstreamError('UPSTREAM_TIMEOUT','小红书查询超时') from None
        except httpx.HTTPStatusError as error:
            raise UpstreamError('UPSTREAM_ERROR',f'小红书返回 HTTP {error.response.status_code}') from None
        except httpx.RequestError:
            raise UpstreamError('UPSTREAM_UNAVAILABLE','无法连接小红书查询接口') from None
        finally:_last_call=time.monotonic()
