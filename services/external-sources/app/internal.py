"""Token-protected service APIs used by the Trek configuration proxy."""
from __future__ import annotations

import hmac
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from .providers import amap, routing, web_search, xhs
from .providers.errors import UpstreamError
from .providers.search_adapters import ADAPTERS
from .providers.web_search import WebSearchQuery
from .providers.xhs_login import login_manager, verify_session
from .providers.xhs_session import load_session
from .runtime_config import SourcesConfig, from_request, get_effective_config, use_config


router = APIRouter()


class MapsConfigInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: str
    amap_key: str | None
    geoapify_key: str | None


class SearchConfigInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    exa_mcp_url: str | None


class XhsConfigInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool


class SourcesConfigInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    revision: int | None = None
    maps: MapsConfigInput
    search: SearchConfigInput
    xhs: XhsConfigInput


class ConnectionCheckInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    service: Literal['maps', 'search', 'xhs']
    config: SourcesConfigInput


def require_service_token(request: Request) -> None:
    token_file = Path(os.getenv('ROAM_SERVICE_TOKEN_FILE', '/run/roam-service/token'))
    try:
        token = token_file.read_text(encoding='utf-8').strip()
    except OSError:
        token = ''
    supplied = request.headers.get('x-roam-service-token', '')
    if not token or not supplied or not hmac.compare_digest(token, supplied):
        raise HTTPException(status_code=401, detail='服务凭据无效')


def _checked_at() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _check_maps(client: httpx.AsyncClient, config: SourcesConfig) -> str:
    with use_config(config):
        if config.maps.provider == 'amap':
            key = amap.api_key()
            if not key:
                raise UpstreamError('SOURCE_NOT_CONFIGURED', '请先配置高德 Web 服务 Key')
            response = await client.get('https://restapi.amap.com/v3/place/text', params={
                'key': key, 'keywords': '栈桥', 'city': '青岛', 'offset': 1, 'page': 1, 'extensions': 'base',
            }, timeout=12)
            if not response.is_success:
                raise UpstreamError('UPSTREAM_ERROR', f'高德地点服务返回 HTTP {response.status_code}')
            value = response.json()
            if not isinstance(value, dict) or value.get('status') != '1':
                raise UpstreamError('SOURCE_NOT_CONFIGURED', '高德未接受当前 Key，请检查 Key 类型与权限')
            return '高德地点服务已连通'
        if config.maps.provider == 'geoapify':
            key = config.maps.geoapify_key
            if not key:
                raise UpstreamError('SOURCE_NOT_CONFIGURED', '请先配置 Geoapify Key')
            response = await client.get('https://api.geoapify.com/v1/routing', params={
                'waypoints': '36.0671,120.3826|36.0629,120.3440', 'mode': 'walk',
                'units': 'metric', 'apiKey': key,
            }, timeout=12)
            if not response.is_success:
                raise UpstreamError('UPSTREAM_ERROR', f'Geoapify 路线服务返回 HTTP {response.status_code}')
            response.json()
            return 'Geoapify 路线服务已连通'
        raise UpstreamError('SOURCE_NOT_CONFIGURED', '地图来源必须选择 amap 或 geoapify')


async def _check_search(client: httpx.AsyncClient, config: SourcesConfig) -> str:
    with use_config(config):
        adapter = ADAPTERS['exa']
        if not adapter.available():
            raise UpstreamError('SOURCE_NOT_CONFIGURED', '请先配置 Exa MCP 地址')
        query = WebSearchQuery(query='Roam Planner connectivity check', limit=1, provider='exa')
        method, url, options = adapter.request(query)
        try:
            response = await client.request(method, url, **options, timeout=15)
        except httpx.TimeoutException as error:
            raise UpstreamError('UPSTREAM_TIMEOUT', 'Exa 搜索连接超时') from error
        except httpx.RequestError as error:
            raise UpstreamError('UPSTREAM_UNAVAILABLE', '无法连接 Exa 搜索服务') from error
        if not response.is_success:
            raise UpstreamError('UPSTREAM_ERROR', f'Exa 搜索服务返回 HTTP {response.status_code}')
        value = adapter.decode(response)
        try:
            adapter.normalize(value)
        except UpstreamError as error:
            raise UpstreamError(error.code, 'Exa 搜索服务未接受当前请求') from error
        return 'Exa 搜索服务已连通'


async def _check_xhs(client: httpx.AsyncClient, config: SourcesConfig) -> str:
    with use_config(config):
        if not config.xhs.enabled:
            raise UpstreamError('SOURCE_NOT_CONFIGURED', '小红书来源已停用')
        session = load_session()
        if not session:
            raise UpstreamError('SOURCE_NOT_CONFIGURED', '请先完成小红书二维码登录')
        await verify_session(client, session)
        return '小红书登录状态已通过真实接口验证'


@router.post('/internal/services/check', dependencies=[Depends(require_service_token)])
async def check_connection(request: Request):
    started = time.monotonic()
    try:
        body = ConnectionCheckInput.model_validate(await request.json())
    except ValueError:
        return {'ok': False, 'message': '检查请求格式无效，请重新载入 Sources 配置',
                'latency_ms': round((time.monotonic() - started) * 1000), 'checked_at': _checked_at()}
    config = from_request(body.config.model_dump())
    checks = {'maps': _check_maps, 'search': _check_search, 'xhs': _check_xhs}
    try:
        message = await checks[body.service](request.app.state.http, config)
        ok = True
    except UpstreamError as error:
        message = error.message
        ok = False
    except (httpx.TimeoutException, httpx.RequestError):
        message = '连接上游服务失败'
        ok = False
    except (OSError, ValueError):
        message = '来源返回的数据无效或本地登录状态不可用'
        ok = False
    return {'ok': ok, 'message': message, 'latency_ms': round((time.monotonic() - started) * 1000),
            'checked_at': _checked_at()}


@router.get('/internal/xhs/status', dependencies=[Depends(require_service_token)])
async def xhs_status(request: Request):
    return await login_manager.status(request.app.state.http)


@router.post('/internal/xhs/login', dependencies=[Depends(require_service_token)])
async def xhs_login(request: Request):
    try:
        config = await get_effective_config(request.app.state.http)
    except UpstreamError as error:
        return {'status': 'error', 'message': error.message}
    if not config.xhs.enabled:
        return {'status': 'not_logged_in', 'message': '小红书来源已停用，请先在来源设置中启用'}
    return await login_manager.start(request.app.state.http)


@router.post('/internal/xhs/logout', dependencies=[Depends(require_service_token)])
async def xhs_logout():
    return await login_manager.logout()

