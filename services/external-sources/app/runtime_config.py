"""Sources-owned view of the central, redacted-at-read configuration contract."""
from __future__ import annotations

import asyncio
import os
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .providers.errors import UpstreamError


@dataclass(frozen=True)
class MapsConfig:
    provider: str
    amap_key: str = field(repr=False)
    geoapify_key: str = field(repr=False)


@dataclass(frozen=True)
class SearchConfig:
    exa_mcp_url: str = field(repr=False)


@dataclass(frozen=True)
class XhsConfig:
    enabled: bool


@dataclass(frozen=True)
class SourcesConfig:
    revision: int | None
    maps: MapsConfig
    search: SearchConfig
    xhs: XhsConfig


_current: ContextVar[SourcesConfig | None] = ContextVar('sources_config', default=None)
_cache: tuple[float, SourcesConfig] | None = None
_cache_lock = asyncio.Lock()
_CACHE_SECONDS = 5


def _env_config() -> SourcesConfig:
    return SourcesConfig(
        revision=None,
        maps=MapsConfig(
            provider=os.getenv('SOURCES_ROUTES_PROVIDER', 'amap'),
            amap_key=(os.getenv('AMAP_API_KEY') or os.getenv('AMAP_KEY', '')).strip(),
            geoapify_key=os.getenv('GEOAPIFY_API_KEY', '').strip(),
        ),
        search=SearchConfig(os.getenv('EXA_MCP_URL', 'https://mcp.exa.ai/mcp').strip()),
        xhs=XhsConfig(os.getenv('XHS_ENABLED', 'false').strip().lower() in ('1', 'true', 'yes', 'on')),
    )


def _choose(value, fallback):
    return fallback if value is None else value


def _from_remote(value: dict) -> SourcesConfig:
    fallback = _env_config()
    maps = value.get('maps') or {}
    search = value.get('search') or {}
    xhs = value.get('xhs') or {}
    revision = value.get('revision')
    return SourcesConfig(
        revision=revision if isinstance(revision, int) else None,
        maps=MapsConfig(
            provider=str(_choose(maps.get('provider'), fallback.maps.provider)),
            amap_key=str(_choose(maps.get('amap_key'), fallback.maps.amap_key)).strip(),
            geoapify_key=str(_choose(maps.get('geoapify_key'), fallback.maps.geoapify_key)).strip(),
        ),
        search=SearchConfig(str(_choose(search.get('exa_mcp_url'), fallback.search.exa_mcp_url)).strip()),
        xhs=XhsConfig(bool(_choose(xhs.get('enabled'), fallback.xhs.enabled))),
    )


async def get_effective_config(client: httpx.AsyncClient | None) -> SourcesConfig:
    """Fetch the central overlay at most once per five seconds; env is the dev fallback."""
    global _cache
    settings_url = os.getenv('ROAM_SETTINGS_URL', '').strip()
    if not settings_url:
        return _env_config()
    if client is None:
        raise UpstreamError('SOURCE_CONFIG_UNAVAILABLE', '无法读取 Roam 配置，请检查服务连接')
    now = time.monotonic()
    if _cache is not None and _cache[0] > now:
        return _cache[1]
    async with _cache_lock:
        now = time.monotonic()
        if _cache is not None and _cache[0] > now:
            return _cache[1]
        token_file = Path(os.getenv('ROAM_SERVICE_TOKEN_FILE', '/run/roam-service/token'))
        try:
            token = token_file.read_text(encoding='utf-8').strip()
            if not token:
                raise ValueError('empty service token')
            response = await client.get(settings_url, headers={'x-roam-service-token': token}, timeout=5)
            response.raise_for_status()
            config = _from_remote(response.json())
        except (OSError, ValueError, TypeError, httpx.HTTPError) as error:
            raise UpstreamError('SOURCE_CONFIG_UNAVAILABLE', '无法读取 Roam 配置，请检查服务连接') from error
        _cache = (time.monotonic() + _CACHE_SECONDS, config)
        return config


def from_request(value: dict) -> SourcesConfig:
    """Build a temporary effective view from an explicit connectivity-check payload."""
    return _from_remote({'revision': None, **value})


@contextmanager
def use_config(config: SourcesConfig):
    token = _current.set(config)
    try:
        yield config
    finally:
        _current.reset(token)


def current_config() -> SourcesConfig:
    return _current.get() or _env_config()


def clear_config_cache() -> None:
    global _cache
    _cache = None
