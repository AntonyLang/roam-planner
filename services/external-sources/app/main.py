from typing import Any

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from fastapi.responses import JSONResponse

from . import store
from .common import Input, envelope, make_app
from .providers import amap, open_meteo, railway, routing, venues, xhs
from .providers.errors import UpstreamError

# 来源失败 -> HTTP 状态码（与骨架里 call_http 的约定一致：超时 504）
STATUS_BY_ERROR = {
    "UPSTREAM_TIMEOUT": 504,
    "UPSTREAM_UNAVAILABLE": 503,
    "UPSTREAM_RATE_LIMITED": 503,
    "UPSTREAM_QUOTA_EXCEEDED": 503,
    "SOURCE_NOT_CONFIGURED": 503,
    "UNSUPPORTED_MODE": 422,
    "INVALID_ARGUMENTS": 422,
    "UPSTREAM_ERROR": 502,
    "UPSTREAM_INVALID_RESPONSE": 502,
    "XHS_USER_ACTION_REQUIRED": 409,
}

app = make_app("external-sources")
router = APIRouter(prefix="/api/v1/sources", tags=["sources"])


class Query(Input):
    query: dict[str, Any]


class VenueInput(Input):
    query: venues.VenueQuery


class XhsSearchInput(Input):
    query: xhs.SearchQuery


class XhsNoteInput(Input):
    query: xhs.NoteQuery


# ------------------------------------------------------- 采集成果读取（落库）
@router.get("/content")
async def content(keyword: str | None = None, limit: int = 20, offset: int = 0,
                  brief: bool = False):
    """按条件读取已落库采集成果列表。

    落库为空时返回空列表（查询成功但无结果，不是错误）。
    `limit` 限制在 1..100；`offset` 用于翻页；`brief=true` 只返回摘要。
    """
    safe_limit = max(1, min(int(limit), 100))
    safe_offset = max(0, int(offset))
    items = store.list_records(keyword=keyword, limit=safe_limit, offset=safe_offset, brief=brief)
    total = store.count(keyword=keyword)
    # total 要跟过滤条件一致，否则调用方会以为命中了很多
    return envelope(
        {"items": items, "total": total, "keyword": keyword, "brief": brief,
         "limit": safe_limit, "offset": safe_offset, "has_more": safe_offset + len(items) < total},
        mock=False,
    )


@router.get("/content/{record_id}")
async def record(record_id: str):
    """读取单条采集成果。

    使用实际落库的 `record_id`（形如 `xhs_<note_id>`），不存在时返回 404。
    """
    stored = store.get_record(record_id)
    if stored is None:
        return JSONResponse(
            envelope(error={"code": "RECORD_NOT_FOUND", "message": "没有这条采集成果"}, mock=False),
            status_code=404,
        )
    return envelope(stored, mock=False)


# ------------------------------------------------------- 实时来源（四个能力）
async def _serve_real_source(request: Request, call):
    """接入真实来源的统一出口。

    - 成功（含「无结果」）返回 meta.mock=false，表示结果不来自占位实现
    - 来源调用失败返回外层 error，meta.mock 仍为 false（这个能力已经是真实的）
    - 与「成功但无结果」严格区分：后者是 200 + 空 result + missing
    """
    try:
        data = await call(request.app.state.http)
    except UpstreamError as exc:
        return JSONResponse(
            envelope(error={"code": exc.code, "message": exc.message}, mock=False),
            status_code=STATUS_BY_ERROR.get(exc.code, 502),
        )
    return envelope(data, mock=False)


@router.post("/weather/query")
async def weather_query(request: Request, body: Query):
    """天气查询：Open-Meteo（免 Key，坐标 WGS84）。"""
    return await _serve_real_source(request, lambda http: open_meteo.query_weather(http, body.query))


@router.post("/places/query")
async def places_query(request: Request, body: Query):
    """地点查询：高德 Web 服务（坐标 GCJ-02，带缓存）。"""
    return await _serve_real_source(request, lambda http: amap.query_places(http, body.query))


@router.post("/routes/query")
async def routes_query(request: Request, body: Query):
    """城市内路线：配置的高德或Geoapify来源，保留坐标系与估时依据。"""
    return await _serve_real_source(request, lambda http: routing.query_routes(http, body.query))


@router.post("/transport/query")
async def transport_query(request: Request, body: Query):
    """跨城交通：社区逆向的 12306 MCP 服务（铁路，带缓存）。"""
    return await _serve_real_source(request, lambda http: railway.query_transport(http, body.query))


@router.post('/venues/query')
async def venues_query(request: Request, body: VenueInput):
    return await _serve_real_source(request, lambda http: venues.query_venues(http, body.query))


@router.post('/xhs/query')
async def xhs_search(request: Request, body: XhsSearchInput):
    return await _serve_real_source(request, lambda http: xhs.query(http,body.query))


@router.post('/xhs_note/query')
async def xhs_note(request: Request, body: XhsNoteInput):
    return await _serve_real_source(request, lambda http: xhs.query(http,body.query))


async def _venue_category(request, body, category):
    try:
        query = venues.VenueQuery.model_validate({'category':category, **body.query})
        if query.category != category:
            raise RequestValidationError([{'loc':('body','query','category'), 'msg':'分类与查询接口不一致', 'type':'value_error'}])
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error
    return await _serve_real_source(request, lambda http: venues.query_venues(http, query))


@router.post('/hotels/query')
async def hotels_query(request: Request, body: Query):
    return await _venue_category(request, body, 'hotel')


@router.post('/restaurants/query')
async def restaurants_query(request: Request, body: Query):
    return await _venue_category(request, body, 'restaurant')


app.include_router(router)
from .mcp import router as mcp_router
app.include_router(mcp_router)

