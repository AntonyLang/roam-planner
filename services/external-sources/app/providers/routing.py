"""Configured route provider; geometry and timing assumptions stay source-owned."""
import json
import math
import os

import httpx

from . import amap
from .cache import TtlCache
from .coordinates import gcj02_to_wgs84, point
from .errors import UpstreamError
from .support import empty_payload, now_iso, with_cache_meta

URL = 'https://api.geoapify.com/v1/routing'
TTL = int(os.getenv('GEOAPIFY_ROUTES_CACHE_TTL', '21600'))
cache = TtlCache(int(os.getenv('SOURCES_CACHE_MAX_ENTRIES', '512')))


def _wgs84(value):
    coordinates = point(value)
    if coordinates is None or value.get('coordinate_system') not in ('GCJ02', 'WGS84'):
        raise UpstreamError('INVALID_ARGUMENTS', '路线端点须有经纬度和明确的WGS84或GCJ02坐标系')
    return gcj02_to_wgs84(*coordinates) if value['coordinate_system'] == 'GCJ02' else coordinates


async def query_routes(client, query):
    provider = os.getenv('SOURCES_ROUTES_PROVIDER', 'amap')
    if provider == 'amap':
        return await amap.query_routes(client, query)
    if provider != 'geoapify':
        raise UpstreamError('SOURCE_NOT_CONFIGURED', 'SOURCES_ROUTES_PROVIDER须为amap或geoapify')

    mode = query.get('mode', 'walking')
    if mode not in ('walking', 'driving'):
        raise UpstreamError('UNSUPPORTED_MODE', '当前Geoapify路线来源只提供步行和驾车路网估算，不提供公交班次或实时交通')
    key = os.getenv('GEOAPIFY_API_KEY', '').strip()
    if not key:
        raise UpstreamError('SOURCE_NOT_CONFIGURED', 'Geoapify路线未配置GEOAPIFY_API_KEY')
    origin, destination = _wgs84(query.get('origin')), _wgs84(query.get('destination'))
    cache_key = json.dumps([origin, destination, mode])
    cached, stored_at = cache.get(cache_key)
    if cached is not None:
        return with_cache_meta(cached, stored_at, TTL, hit=True)

    params = {'waypoints': '|'.join(f'{lat},{lng}' for lat, lng in (origin, destination)),
              'mode': 'walk' if mode == 'walking' else 'drive', 'units': 'metric', 'apiKey': key}
    try:
        response = await client.get(URL, params=params)
    except httpx.TimeoutException as exc:
        raise UpstreamError('UPSTREAM_TIMEOUT', 'Geoapify路线查询超时') from exc
    except httpx.RequestError as exc:
        raise UpstreamError('UPSTREAM_UNAVAILABLE', '无法连接Geoapify路线来源') from exc
    if response.status_code in (401, 403):
        raise UpstreamError('SOURCE_NOT_CONFIGURED', 'Geoapify拒绝路线访问，请检查密钥及权限')
    if response.status_code == 429:
        raise UpstreamError('UPSTREAM_RATE_LIMITED', 'Geoapify路线触发限流')
    if not response.is_success:
        raise UpstreamError('UPSTREAM_ERROR', f'Geoapify路线返回HTTP {response.status_code}')
    try:
        features = response.json()['features']
        if features == []:
            return empty_payload('geoapify', 'routes', ['来源未返回可用路线，不代表两点之间可直接通行'])
        feature = features[0]
        properties, geometry = feature['properties'], feature['geometry']
        distance, duration = properties['distance'], properties['time']
        if geometry['type'] != 'MultiLineString' or not geometry['coordinates']:
            raise ValueError('Route geometry is absent')
        if not all(math.isfinite(v) and v >= 0 for v in (distance, duration)):
            raise ValueError('Route distance or duration is invalid')
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'Geoapify路线响应缺少有效路网几何、距离或耗时') from exc
    data = {
        'result': {'mode': mode, 'origin': f'{origin[1]},{origin[0]}',
                   'destination': f'{destination[1]},{destination[0]}',
                   'distance_m': distance, 'duration_s': math.ceil(duration),
                   'time_basis': 'road_network_estimate_without_live_traffic',
                   'geometry': {**geometry, 'coordinate_system': 'WGS84'}},
        'source': {'type': 'geoapify', 'capability': 'routes', 'url': URL,
                   'attribution': 'Geoapify / © OpenStreetMap contributors',
                   'note': '路网路线与估时；不含实时拥堵、排队或等候时间，不是含缓冲的门到门到达保证。'},
        'queried_at': now_iso(), 'data_time': None,
        'freshness': {'kind': 'route', 'cache_ttl_seconds': TTL},
        'units': {'distance': 'm', 'duration': 's'}, 'coordinate_system': 'WGS84', 'missing': [],
    }
    cache.set(cache_key, data, TTL)
    return with_cache_meta(data, None, TTL, hit=False)
