"""高德 Web 服务来源适配：地点查询 + 城市内路线。

来源验证结论（2026-09-30 实测）：
  - 关键字搜索命中正常（查「栈桥」返回 98 条，首条「栈桥景区」市南区）
  - 步行路线、公交路线均返回正常
  - 坐标系为 **GCJ-02**（与 Open-Meteo 的 WGS84 不一致）

配额（个人认证开发者，控制台实测数字）：
    基础搜索服务（关键字/周边搜索…）   5000      ← 瓶颈
    基础 LBS 服务（地理编码/坐标转换…） 150000
因此搜索**必须走缓存**（providers/cache.py），地理编码额度宽松得多。

Key 从环境变量 AMAP_KEY 读取，**不进仓库**。
未配置 Key 时不会伪造数据：查询条件不足仍然返回「无结果」，
条件足够但没 Key 或 Key 失效则明确报 SOURCE_NOT_CONFIGURED。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import httpx

from .cache import TtlCache
from .coordinates import point, wgs84_to_gcj02
from .errors import UpstreamError
from .support import as_int, empty_payload, now_iso, text, with_cache_meta as _with_cache_meta
from ..runtime_config import current_config

API_KEY_ENV = "AMAP_KEY"
BASE = "https://restapi.amap.com"

PLACE_URL = BASE + "/v3/place/text"
GEOCODE_URL = BASE + "/v3/geocode/geo"
MODE_URLS = {
    "walking": BASE + "/v3/direction/walking",
    "transit": BASE + "/v3/direction/transit/integrated",
    "driving": BASE + "/v3/direction/driving",
}
MODE_LABELS = {"walking": "步行", "transit": "公共交通", "driving": "驾车"}

SOURCE_TYPE = "amap"
COORDINATE_SYSTEM = "GCJ-02"
MAX_STEPS = 40
PLACES_TTL_SECONDS = int(os.getenv("AMAP_PLACES_CACHE_TTL", "86400"))
ROUTES_TTL_SECONDS = int(os.getenv("AMAP_ROUTES_CACHE_TTL", "21600"))
CACHE_MAX_ENTRIES = int(os.getenv("SOURCES_CACHE_MAX_ENTRIES", "512"))

# 个人认证账号的并发限制很低（实测连续调用会返回 infocode=10021 CUQPS_HAS_EXCEEDED_THE_LIMIT），
# 所以命中限流时退避重试一次，而不是直接把错误丢给调用方。
RETRY_ON_RATE_LIMIT = os.getenv("AMAP_RETRY_ON_RATE_LIMIT", "1").lower() not in ("0", "false", "no")
RATE_LIMIT_RETRY_DELAY = float(os.getenv("AMAP_RATE_LIMIT_RETRY_DELAY", "1.5"))

_places_cache = TtlCache(CACHE_MAX_ENTRIES)
_routes_cache = TtlCache(CACHE_MAX_ENTRIES)

COORD_PATTERN = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")

# 高德 infocode -> 本服务的错误码
_QUOTA_CODES = {"10003", "10044"}
_RATE_CODES = {"10004", "10019", "10020", "10021"}
_KEY_CODES = {"10001", "10002", "10005", "10006", "10007", "10008", "10009", "10012", "10013", "10014"}


def api_key() -> str | None:
    value = current_config().maps.amap_key.strip()
    return value or None


def cache_stats() -> dict[str, dict[str, int]]:
    return {"places": _places_cache.stats(), "routes": _routes_cache.stats()}


def _error_code(infocode: str) -> str:
    if infocode in _QUOTA_CODES:
        return "UPSTREAM_QUOTA_EXCEEDED"
    if infocode in _RATE_CODES:
        return "UPSTREAM_RATE_LIMITED"
    if infocode in _KEY_CODES:
        return "SOURCE_NOT_CONFIGURED"
    return "UPSTREAM_ERROR"


async def _amap_once(client: httpx.AsyncClient, url: str, params: dict[str, Any], key: str) -> dict[str, Any]:
    query = {**params, "key": key, "output": "JSON"}
    try:
        response = await client.get(url, params=query)
    except httpx.TimeoutException as exc:
        raise UpstreamError("UPSTREAM_TIMEOUT", "高德调用超时") from exc
    except httpx.ConnectError as exc:
        raise UpstreamError("UPSTREAM_UNAVAILABLE", "高德网络连接失败，当前无法连接该来源的地点和路线接口；更换地点关键词不能修复连接，请改用其他来源或待网络恢复。") from exc
    except httpx.RequestError as exc:
        raise UpstreamError("UPSTREAM_UNAVAILABLE", "无法连接高德服务") from exc
    if response.status_code == 429:
        raise UpstreamError("UPSTREAM_RATE_LIMITED", "高德触发限流")
    if not response.is_success:
        raise UpstreamError("UPSTREAM_ERROR", f"高德返回 HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", "高德响应不是合法 JSON") from exc

    # 高德把业务错误放在 HTTP 200 里：status=0 表示失败，infocode 说明原因。
    if str(payload.get("status")) != "1":
        infocode = str(payload.get("infocode") or "")
        info = payload.get("info") or "unknown"
        raise UpstreamError(_error_code(infocode), f"高德返回 {info}（infocode={infocode}）")
    return payload


async def _amap_get(client: httpx.AsyncClient, url: str, params: dict[str, Any], key: str) -> dict[str, Any]:
    """带限流退避的调用。限流以外的错误一律原样上抛。"""
    attempts = 2 if RETRY_ON_RATE_LIMIT else 1
    for attempt in range(1, attempts + 1):
        try:
            return await _amap_once(client, url, params, key)
        except UpstreamError as exc:
            if exc.code != "UPSTREAM_RATE_LIMITED" or attempt >= attempts:
                raise
            await asyncio.sleep(RATE_LIMIT_RETRY_DELAY)


def _require_key() -> str:
    key = api_key()
    if not key:
        raise UpstreamError("SOURCE_NOT_CONFIGURED", f"未配置 {API_KEY_ENV}，该来源不可用")
    return key


# ----------------------------------------------------------------- 地点查询
def _simplify_poi(item: dict[str, Any]) -> dict[str, Any]:
    location = text(item.get("location"))
    longitude = latitude = None
    if location and "," in location:
        longitude, latitude = (part.strip() for part in location.split(",", 1))
    return {
        "id": text(item.get("id")),
        "name": text(item.get("name")),
        "address": text(item.get("address")),
        "city": text(item.get("cityname")),
        "district": text(item.get("adname")),
        "type": text(item.get("type")),
        "typecode": text(item.get("typecode")),
        "tel": text(item.get("tel")),
        "location": location,
        "longitude": longitude,
        "latitude": latitude,
    }


async def query_places(client: httpx.AsyncClient, query: dict[str, Any]) -> dict[str, Any]:
    """地点查询。

    查询条件：
      keywords      必填，搜索词（如「栈桥」「海鲜餐厅」）
      city          可选，限定城市（如「青岛」）
      types         可选，高德 POI 类型码
      limit         可选，返回条数，1..25，默认 5
    """
    keywords = str(query.get("keywords") or query.get("keyword") or "").strip()
    if not keywords:
        return empty_payload(SOURCE_TYPE, "places", ["keywords"])
    key = _require_key()

    city = str(query.get("city") or query.get("location") or "").strip()
    types = str(query.get("types") or "").strip()
    limit = as_int(query.get("limit"), 1, 25, 5)

    cache_key = json.dumps(
        {"k": keywords, "c": city, "t": types, "n": limit}, ensure_ascii=False, sort_keys=True
    )
    cached, stored_at = _places_cache.get(cache_key)
    if cached is not None:
        return _with_cache_meta(cached, stored_at, PLACES_TTL_SECONDS, hit=True)

    params: dict[str, Any] = {"keywords": keywords, "offset": limit, "page": 1, "extensions": "base"}
    if city:
        params["city"] = city
        params["citylimit"] = "true"
    if types:
        params["types"] = types

    payload = await _amap_get(client, PLACE_URL, params, key)
    data = {
        "result": {
            "keywords": keywords,
            "city": city or None,
            "count": as_int(payload.get("count"), 0, 10**9, 0),
            "items": [_simplify_poi(item) for item in (payload.get("pois") or [])],
        },
        "source": {
            "type": SOURCE_TYPE,
            "capability": "places",
            "url": PLACE_URL,
            "note": "高德关键字搜索；坐标系 GCJ-02",
        },
        "queried_at": now_iso(),
        "data_time": None,
        "freshness": {"kind": "poi", "cache_ttl_seconds": PLACES_TTL_SECONDS},
        "units": {"coordinates": "GCJ-02 经纬度（度）"},
        "coordinate_system": COORDINATE_SYSTEM,
        "missing": [],
    }
    _places_cache.set(cache_key, data, PLACES_TTL_SECONDS)
    return _with_cache_meta(data, None, PLACES_TTL_SECONDS, hit=False)


# ----------------------------------------------------------------- 城市内路线
async def _resolve_point(
    client: httpx.AsyncClient, value: Any, city: str | None, key: str
) -> str | None:
    """把「lng,lat」字符串、坐标对象或地名统一成高德要求的 'lng,lat'。

    返回 None 表示解析不出来（地名查不到）。
    """
    if isinstance(value, dict):
        coordinates = point(value)
        if coordinates is None: return None
        latitude, longitude = coordinates
        system = str(value.get('coordinate_system', 'GCJ02')).replace('-', '').upper()
        if system == 'WGS84': latitude, longitude = wgs84_to_gcj02(latitude, longitude)
        elif system != 'GCJ02': return None
        return f"{longitude:.6f},{latitude:.6f}"
    raw = str(value or "").strip()
    if not raw:
        return None
    match = COORD_PATTERN.match(raw)
    if match:
        return f"{match.group(1)},{match.group(2)}"

    params: dict[str, Any] = {"address": raw}
    if city:
        params["city"] = city
    payload = await _amap_get(client, GEOCODE_URL, params, key)
    geocodes = payload.get("geocodes") or []
    if not geocodes:
        return None
    return text(geocodes[0].get("location"))


def _simplify_step(step: dict[str, Any]) -> dict[str, Any]:
    return {
        "instruction": text(step.get("instruction")),
        "road": text(step.get("road")),
        "distance_m": as_int(step.get("distance"), 0, 10**9, 0) or None,
        "duration_s": as_int(step.get("duration"), 0, 10**9, 0) or None,
    }


def _simplify_segment(segment: dict[str, Any]) -> dict[str, Any]:
    line = ((segment.get("bus") or {}).get("buslines") or [{}])[0]
    return {
        "walking_m": as_int((segment.get("walking") or {}).get("distance"), 0, 10**9, 0) or None,
        "bus": {
            "name": text(line.get("name")),
            "type": text(line.get("type")),
            "departure_stop": text((line.get("departure_stop") or {}).get("name")),
            "arrival_stop": text((line.get("arrival_stop") or {}).get("name")),
            "via_num": text(line.get("via_num")),
        }
        if line
        else None,
    }


def _geometry(parts):
    lines = []
    for part in parts:
        points = []
        for raw in str(part.get('polyline') or '').split(';'):
            try:
                lng, lat = map(float, raw.split(','))
                if -180 <= lng <= 180 and -90 <= lat <= 90: points.append([lng, lat])
            except (ValueError, TypeError): continue
        if len(points) > 1: lines.append(points)
    return {'type': 'MultiLineString', 'coordinates': lines, 'coordinate_system': 'GCJ02'}


def _build_route_result(mode: str, payload: dict[str, Any], origin: str, destination: str) -> dict[str, Any]:
    route = payload.get("route") or {}
    result: dict[str, Any] = {"mode": mode, "origin": origin, "destination": destination}

    if mode == "transit":
        transits = route.get("transits") or []
        if not transits:
            return {}
        first = transits[0]
        geometry_parts = []
        for segment in first.get('segments') or []:
            geometry_parts.extend((segment.get('walking') or {}).get('steps') or [])
            geometry_parts.extend((segment.get('bus') or {}).get('buslines') or [])
        result.update(
            {
                "distance_m": as_int(first.get("distance"), 0, 10**9, 0) or None,
                "duration_s": as_int(first.get("duration"), 0, 10**9, 0) or None,
                "cost_cny": text(first.get("cost")),
                "walking_distance_m": as_int(first.get("walking_distance"), 0, 10**9, 0) or None,
                "segments": [_simplify_segment(item) for item in (first.get("segments") or [])],
                'geometry': _geometry(geometry_parts),
            }
        )
        return result

    paths = route.get("paths") or []
    if not paths:
        return {}
    first = paths[0]
    result.update(
        {
            "distance_m": as_int(first.get("distance"), 0, 10**9, 0) or None,
            "duration_s": as_int(first.get("duration"), 0, 10**9, 0) or None,
            "steps": [_simplify_step(item) for item in (first.get("steps") or [])[:MAX_STEPS]],
            'geometry': _geometry(first.get('steps') or []),
        }
    )
    return result


async def query_routes(client: httpx.AsyncClient, query: dict[str, Any]) -> dict[str, Any]:
    """城市内路线查询。

    查询条件：
      origin / destination   必填。可以是「lng,lat」、{longitude,latitude} 或地名
      mode                   可选，walking / transit / driving，默认 walking
      city                   可选，地名解析与公交查询的城市限定
    """
    origin_raw, destination_raw = query.get("origin"), query.get("destination")
    if not origin_raw or not destination_raw:
        return empty_payload(SOURCE_TYPE, "routes", ["origin", "destination"])

    mode = str(query.get("mode") or "walking").strip().lower()
    if mode not in MODE_URLS:
        return empty_payload(SOURCE_TYPE, "routes", [f"mode 只支持 {sorted(MODE_URLS)}"])
    key = _require_key()

    city = str(query.get("city") or "").strip()
    cache_key = json.dumps(
        {"o": str(origin_raw), "d": str(destination_raw), "m": mode, "c": city},
        ensure_ascii=False,
        sort_keys=True,
    )
    cached, stored_at = _routes_cache.get(cache_key)
    if cached is not None:
        return _with_cache_meta(cached, stored_at, ROUTES_TTL_SECONDS, hit=True)

    origin = await _resolve_point(client, origin_raw, city or None, key)
    if origin is None:
        return empty_payload(SOURCE_TYPE, "routes", [f"无法解析起点：{origin_raw}"])
    destination = await _resolve_point(client, destination_raw, city or None, key)
    if destination is None:
        return empty_payload(SOURCE_TYPE, "routes", [f"无法解析终点：{destination_raw}"])

    params: dict[str, Any] = {"origin": origin, "destination": destination}
    if mode == "transit":
        params["city"] = city or "全国"
        params["cityd"] = city or "全国"
    elif mode == "driving":
        params["extensions"] = "base"

    payload = await _amap_get(client, MODE_URLS[mode], params, key)
    result = _build_route_result(mode, payload, origin, destination)
    if not result:
        return empty_payload(SOURCE_TYPE, "routes", [f"来源没有返回可行路线（mode={mode}）"])

    data = {
        "result": result,
        "source": {
            "type": SOURCE_TYPE,
            "capability": "routes",
            "url": MODE_URLS[mode],
            "note": f"高德路线规划（{MODE_LABELS[mode]}）；坐标系 GCJ-02",
        },
        "queried_at": now_iso(),
        "data_time": None,
        "freshness": {"kind": "route", "cache_ttl_seconds": ROUTES_TTL_SECONDS},
        "units": {"distance": "m", "duration": "s"},
        "coordinate_system": COORDINATE_SYSTEM,
        "missing": [],
    }
    _routes_cache.set(cache_key, data, ROUTES_TTL_SECONDS)
    return _with_cache_meta(data, None, ROUTES_TTL_SECONDS, hit=False)
