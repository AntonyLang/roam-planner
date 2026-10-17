"""Open-Meteo 天气来源适配（真实来源，免 Key）。

来源验证结论（2026-09-30 实测）：
  - 免 Key；覆盖中国城市，支持中文名检索
  - 响应自带 current_units / hourly_units 单位表
  - 坐标系为 **WGS84**（注意：高德是 GCJ-02，跨来源拼接必须先统一坐标系）
  - forecast_days 可指定预报窗口

本模块只做「来源结果 → 契约结构」的转换，不做缓存、不做业务判断。
待实现：调用缓存（契约要求来源查询注明时效，重复查询应收敛调用量）。
"""
from __future__ import annotations

import os
from datetime import datetime, timezone, date
from zoneinfo import ZoneInfo
from typing import Any

import httpx

from .errors import UpstreamError
from .coordinates import gcj02_to_wgs84, point

GEOCODING_URL = os.getenv("OPEN_METEO_GEOCODING_URL", "https://geocoding-api.open-meteo.com/v1/search")
FORECAST_URL = os.getenv("OPEN_METEO_FORECAST_URL", "https://api.open-meteo.com/v1/forecast")

SOURCE_TYPE = "open-meteo"
COORDINATE_SYSTEM = "WGS84"
DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_FORECAST_DAYS = 3
MAX_FORECAST_DAYS = 16
DEFAULT_HOURLY_VARIABLES = (
    "temperature_2m",
    "precipitation_probability",
    "weather_code",
    "wind_speed_10m",
)
MAX_HOURLY_VARIABLES = 20


async def _get_json(client: httpx.AsyncClient, url: str, params: dict[str, Any]) -> Any:
    try:
        response = await client.get(url, params=params)
    except httpx.TimeoutException as exc:
        raise UpstreamError("UPSTREAM_TIMEOUT", "Open-Meteo 调用超时") from exc
    except httpx.RequestError as exc:
        raise UpstreamError("UPSTREAM_UNAVAILABLE", "无法连接 Open-Meteo") from exc
    if response.status_code == 429:
        raise UpstreamError("UPSTREAM_RATE_LIMITED", "Open-Meteo 触发限流")
    if not response.is_success:
        raise UpstreamError("UPSTREAM_ERROR", f"Open-Meteo 返回 HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", "Open-Meteo 响应不是合法 JSON") from exc


CJK_CITY_SUFFIXES = ("市", "县", "区")
# 行政区级别：越靠前越优先。PPL 是普通聚落（村镇），最低。
FEATURE_ORDER = ("PPLC", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLG", "PPLL", "PPLX", "PPL")


def _simplify(hit: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": hit.get("name"),
        "admin": hit.get("admin1"),
        "country": hit.get("country"),
        "latitude": hit.get("latitude"),
        "longitude": hit.get("longitude"),
        "timezone": hit.get("timezone"),
        "population": hit.get("population"),
        "feature_code": hit.get("feature_code"),
    }


def _country_code(value: Any) -> str | None:
    """只接受 ISO-3166-1 alpha-2（如 CN）；传入「中国」这类值直接忽略。"""
    if not value:
        return None
    code = str(value).strip().upper()
    return code if len(code) == 2 and code.isascii() and code.isalpha() else None


def _is_cjk(value: str) -> bool:
    return bool(value) and all("\u4e00" <= ch <= "\u9fff" for ch in value)


def _score(hit: dict[str, Any]) -> tuple[int, int]:
    code = str(hit.get("feature_code") or "")
    rank = len(FEATURE_ORDER) - FEATURE_ORDER.index(code) if code in FEATURE_ORDER else 0
    return rank, hit.get("population") or 0


async def _search(
    client: httpx.AsyncClient, name: str, country_code: str | None
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"name": name, "count": 10, "language": "zh", "format": "json"}
    if country_code:
        params["countryCode"] = country_code
    payload = await _get_json(client, GEOCODING_URL, params)
    return payload.get("results") or []


async def resolve_location(
    client: httpx.AsyncClient,
    name: str,
    country: str | None = None,
    admin: str | None = None,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """地点名 → 坐标；返回 (选中地点, 候选列表)。

    必须消歧，实测两个坑：
      1. 查「青岛」时数据集里根本没有青岛市，只返回辽宁的同名村镇和两个山东岛屿；
         加上「市」后缀才能命中（36.06488,120.38042，人口 717 万）。
      2. 即使命中了，第一条也未必是主城区。

    因此：纯中文地名先补一个「市」变体再搜一遍，全部候选按「行政区级别 → 人口」
    排序后取第一名。返回 None 表示来源正常但没有匹配结果。
    """
    country_code = _country_code(country)
    hits = await _search(client, name, country_code)
    if _is_cjk(name) and not name.endswith(CJK_CITY_SUFFIXES):
        hits = hits + await _search(client, name + "市", country_code)

    if admin:
        expected = str(admin).strip().casefold()
        hits = [hit for hit in hits if expected in str(hit.get("admin1") or "").casefold()]
    if not hits:
        return None, []

    seen: set[tuple[Any, Any, Any]] = set()
    unique: list[dict[str, Any]] = []
    for hit in hits:
        key = (hit.get("name"), hit.get("latitude"), hit.get("longitude"))
        if key not in seen:
            seen.add(key)
            unique.append(hit)
    unique.sort(key=_score, reverse=True)

    candidates = [_simplify(hit) for hit in unique[:3]]
    return candidates[0], candidates


def _as_int(value: Any, low: int, high: int, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if low <= parsed <= high else default


def _empty(missing: list[str]) -> dict[str, Any]:
    """成功但无结果：调用方拿到的 error 为 null，缺失内容明确说明。"""
    return {
        "result": {},
        "source": {"type": SOURCE_TYPE, "capability": "weather"},
        "queried_at": datetime.now(timezone.utc).isoformat(),
        "data_time": None,
        "freshness": "unknown",
        "units": {},
        "coordinate_system": None,
        "missing": missing,
    }


async def query_weather(client: httpx.AsyncClient, query: dict[str, Any]) -> dict[str, Any]:
    """把 weather 查询条件转成契约要求的 data 结构。

    接受的查询条件（均为可选，但至少要能定位一个地点）：
      location / city        地点名，走地理编码解析（中文名会自动补「市」消歧）
      country                国家代码（如 CN），缩小地理编码范围
      admin                  一级行政区名（如 山东），用于消歧
      latitude + longitude   直接给坐标，跳过地理编码
      forecast_days          预报天数，1..16，默认 3
      hourly_variables       逐时变量列表，默认 4 个常用变量
      timezone               时区名，默认 Asia/Shanghai
    """
    latitude, longitude = query.get("latitude"), query.get("longitude")
    location: dict[str, Any] | None = None
    candidates: list[dict[str, Any]] = []

    if latitude is None or longitude is None:
        name = query.get("location") or query.get("city")
        if not name:
            return _empty(["location（或 latitude + longitude）"])
        location, candidates = await resolve_location(
            client, str(name), query.get("country"), query.get("admin")
        )
        if location is None:
            return _empty([f"未找到地点：{name}"])
        latitude, longitude = location["latitude"], location["longitude"]

    forecast_days = _as_int(query.get("forecast_days"), 1, MAX_FORECAST_DAYS, DEFAULT_FORECAST_DAYS)
    coordinates = point({'latitude': latitude, 'longitude': longitude})
    if coordinates is None: return _empty(['无效经纬度'])
    latitude, longitude = coordinates
    if str(query.get('coordinate_system', 'WGS84')).replace('-', '').upper() == 'GCJ02':
        latitude, longitude = gcj02_to_wgs84(latitude, longitude)
    if query.get('end_date') or query.get('start_date'):
        try:
            today = datetime.now(ZoneInfo(DEFAULT_TIMEZONE)).date()
            start = date.fromisoformat(query.get('start_date') or today.isoformat())
            end = date.fromisoformat(query.get('end_date') or start.isoformat())
        except ValueError: return _empty(['日期必须为 YYYY-MM-DD'])
        if end < start or start < today: return _empty(['天气预报不能查询过去日期或倒置日期范围'])
        if (end-today).days >= MAX_FORECAST_DAYS: return _empty(['目标日期超出当前16天天气预报范围；需临近出行再核实'])
        forecast_days = (end-today).days + 1
    requested = query.get("hourly_variables") or list(DEFAULT_HOURLY_VARIABLES)
    hourly_variables = [str(item) for item in requested][:MAX_HOURLY_VARIABLES]
    timezone_name = query.get("timezone") or (location or {}).get("timezone") or DEFAULT_TIMEZONE

    payload = await _get_json(
        client,
        FORECAST_URL,
        {
            "latitude": latitude,
            "longitude": longitude,
            "current": "temperature_2m,weather_code,wind_speed_10m",
            "hourly": ",".join(hourly_variables),
            "timezone": timezone_name,
            "forecast_days": forecast_days,
        },
    )

    hourly = payload.get("hourly") or {}
    if query.get('start_date') or query.get('end_date'):
        selected = [i for i,t in enumerate(hourly.get('time', [])) if start.isoformat() <= t[:10] <= end.isoformat()]
        hourly = {k:[values[i] for i in selected if i<len(values)] for k,values in hourly.items()}
    times = hourly.get("time") or []
    current = payload.get("current") or {}
    units = {**(payload.get("current_units") or {}), **(payload.get("hourly_units") or {})}
    units.pop("interval", None)

    return {
        "result": {
            "location": location
            or {"name": None, "latitude": latitude, "longitude": longitude, "timezone": timezone_name},
            "candidates": candidates if len(candidates) > 1 else [],
            "current": current,
            "hourly": hourly,
            "forecast_days": forecast_days,
        },
        "source": {
            "type": SOURCE_TYPE,
            "capability": "weather",
            "url": FORECAST_URL,
            "note": "免 Key 的公开预报服务；结果为预报而非观测",
        },
        "queried_at": datetime.now(timezone.utc).isoformat(),
        "data_time": {
            "current": current.get("time"),
            "hourly_start": times[0] if times else None,
            "hourly_end": times[-1] if times else None,
        },
        "freshness": {
            "kind": "forecast",
            "forecast_days": forecast_days,
            "utc_offset_seconds": payload.get("utc_offset_seconds"),
        },
        "units": units,
        "coordinate_system": COORDINATE_SYSTEM,
        "missing": [],
    }
