"""跨城铁路来源适配：社区逆向的 12306 MCP 服务。

来源验证结论见工作包记录第 4 节。选定 `drfccv/mcp-server-12306`（MIT），
以「边车进程 + 最小 MCP 客户端」方式接入，**不把第三方代码混进本交付物**。

三个实测踩到的坑（都在这里处理掉）：
  1. **业务失败不走 MCP 错误通道** —— 响应仍是 isError=false，失败在 payload 的 success 字段里。
  2. **结果被包两层** —— 真实数据是 `result.content[0].text` 里的一个 JSON 字符串。
  3. **座位字段命名不统一** —— 余票是英文键，票价与换乘是中文键，且车次号字段
     `query-tickets` 叫 `train_no`、`query-ticket-price` 叫 `train_code`，含义相同。

合规：非官方逆向来源，上游要求「仅供学习研究、禁止商用」。**必须限频，不得压测。**
"""
from __future__ import annotations

import json
import os
from typing import Any

import httpx

from .cache import TtlCache
from .errors import UpstreamError
from .mcp_client import McpHttpClient
from .support import as_int, empty_payload, now_iso, text, with_cache_meta

MCP_URL = os.getenv("RAILWAY_MCP_URL", "http://127.0.0.1:8010/mcp")
MCP_TIMEOUT = float(os.getenv("RAILWAY_MCP_TIMEOUT", "30"))
CACHE_TTL_SECONDS = int(os.getenv("RAILWAY_CACHE_TTL", "60"))
CACHE_MAX_ENTRIES = int(os.getenv("SOURCES_CACHE_MAX_ENTRIES", "512"))
MAX_ITEMS = 100
DEFAULT_ITEMS = 10

SOURCE_TYPE = "railway-mcp"
SUPPORTED_MODES = ("train",)
FLIGHT_ALIASES = ("flight", "plane", "航班", "飞机")

_mcp = McpHttpClient(MCP_URL, timeout=MCP_TIMEOUT, service_name="12306 MCP")
_cache = TtlCache(CACHE_MAX_ENTRIES)

# 座位名归一化：中文键（票价/换乘）与英文键（余票）统一成英文
SEAT_ALIASES = {
    "商务座": "business",
    "特等座": "premier",
    "一等座": "first_class",
    "优选一等座": "first_class_preferred",
    "二等座": "second_class",
    "无座": "no_seat",
    "硬座": "hard_seat",
    "软座": "soft_seat",
    "硬卧": "hard_sleeper",
    "软卧": "soft_sleeper",
    "动卧": "sleeper",
    "高级软卧": "deluxe_soft_sleeper",
}


def stats() -> dict[str, Any]:
    return {"cache": _cache.stats(), "mcp_url": MCP_URL, "session_active": _mcp.session_active}


def _seat_name(key: Any) -> str:
    raw = str(key)
    return SEAT_ALIASES.get(raw, raw)


def _normalize_seats(raw: Any) -> dict[str, Any]:
    """余票：值保留成「有 / 无 / 张数」的字符串 —— 那是 12306 的原始语义，不要转数字。"""
    if not isinstance(raw, dict):
        return {}
    return {_seat_name(key): text(value) for key, value in raw.items()}


def _normalize_prices(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in raw.items():
        try:
            out[_seat_name(key)] = float(value)
        except (TypeError, ValueError):
            out[_seat_name(key)] = text(value)
    return out


def _train_code(item: dict[str, Any]) -> str | None:
    """车次号：query-tickets 放在 train_no，query-ticket-price 放在 train_code，含义相同。"""
    return text(item.get("train_code")) or text(item.get("train_no"))


def _normalize_train(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "train_code": _train_code(item),
        "from_station": text(item.get("from_station")),
        "from_station_code": text(item.get("from_station_code")),
        "to_station": text(item.get("to_station")),
        "to_station_code": text(item.get("to_station_code")),
        "start_time": text(item.get("start_time")),
        "arrive_time": text(item.get("arrive_time")),
        "duration": text(item.get("duration")),
        "seats": _normalize_seats(item.get("seats")),
    }


def _station_matches(requested: Any, name: Any, code: Any) -> bool:
    normalized = ''.join(str(requested).split()).removesuffix('站').casefold()
    return normalized in {str(name or '').strip().removesuffix('站').casefold(), str(code or '').casefold()}


def _matches_time_window(item: dict, window: dict) -> bool:
    for field, after, before in (
        ('start_time', 'departure_after', 'departure_before'),
        ('arrive_time', 'arrival_after', 'arrival_before'),
    ):
        value = item.get(field)
        lower, upper = window.get(after), window.get(before)
        if (lower or upper) and not value:
            return False
        if lower and value < lower or upper and value > upper:
            return False
    return True


def _failure_reason(payload: dict[str, Any]) -> str:
    if payload.get("error"):
        reason = str(payload["error"])
    elif payload.get("errors"):
        reason = "；".join(str(item) for item in payload["errors"])
    else:
        reason = "来源返回失败但未说明原因"
    hint = payload.get("hint")
    return f"{reason}（{hint}）" if hint else reason


async def _call_tool(client: httpx.AsyncClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """调用 MCP 工具，并把 `result.content[0].text` 里的 JSON 字符串解出来。"""
    result = await _mcp.call_tool(client, name, arguments)
    if not isinstance(result, dict) or result.get("isError"):
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", f"{name} 返回了 MCP 工具错误")
    content = (result or {}).get("content") or []
    if not content:
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", f"{name} 返回内容为空")
    raw = content[0].get("text") if isinstance(content[0], dict) else None
    if not raw:
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", f"{name} 返回内容不是文本")
    try:
        decoded = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", f"{name} 返回内容不是 JSON") from exc
    if not isinstance(decoded, dict):
        raise UpstreamError("UPSTREAM_INVALID_RESPONSE", f"{name} 返回内容不是对象")
    return decoded


async def query_transport(client: httpx.AsyncClient, query: dict[str, Any]) -> dict[str, Any]:
    """跨城交通查询（当前只支持铁路）。

    查询条件：
      mode              train（默认）/ flight。flight 明确返回「不支持」
      from / to         必填，车站名（支持中文 / 拼音 / 简拼 / 三字码），如「青岛」「济南」
      date              必填，出发日期 YYYY-MM-DD，**不能早于今天**
      include_price     可选，是否附票价（默认 false，会多打一次上游）
      include_transfer  可选，是否附中转换乘方案（默认 false，会多打一次上游）
      limit             可选，返回车次条数，1..100，默认 10
    """
    mode = str(query.get("mode") or "train").strip().lower()
    if mode in FLIGHT_ALIASES:
        return empty_payload(SOURCE_TYPE, "transport", ["mode=flight 暂不支持：航班来源尚未接入"])
    if mode not in SUPPORTED_MODES:
        return empty_payload(
            SOURCE_TYPE, "transport", [f"mode 只支持 {list(SUPPORTED_MODES)}，收到 {mode}"]
        )

    from_station = query.get("from") or query.get("from_station")
    to_station = query.get("to") or query.get("to_station")
    travel_date = query.get("date") or query.get("train_date")
    if not from_station or not to_station or not travel_date:
        return empty_payload(SOURCE_TYPE, "transport", ["from / to / date"])

    if not MCP_URL:
        raise UpstreamError("SOURCE_NOT_CONFIGURED", "铁路查询未启用，当前没有可用车次来源")

    include_price = bool(query.get("include_price"))
    include_transfer = bool(query.get("include_transfer"))
    limit = as_int(query.get("limit"), 1, MAX_ITEMS, DEFAULT_ITEMS)
    window = {key: query[key] for key in ('departure_after','departure_before','arrival_after','arrival_before') if query.get(key)}

    cache_key = json.dumps(
        {
            "f": str(from_station), "t": str(to_station), "d": str(travel_date),
            "p": include_price, "x": include_transfer, "n": limit, "window": window,
        },
        ensure_ascii=False, sort_keys=True,
    )
    cached, stored_at = _cache.get(cache_key)
    if cached is not None:
        return with_cache_meta(cached, stored_at, CACHE_TTL_SECONDS, hit=True)

    arguments = {
        "from_station": str(from_station),
        "to_station": str(to_station),
        "train_date": str(travel_date),
    }

    tickets = await _call_tool(client, "query-tickets", arguments)
    if not tickets.get("success"):
        reason = _failure_reason(tickets)
        if tickets.get("errors") or tickets.get("error") == "车站名称无效":
            return empty_payload(SOURCE_TYPE, "transport", [reason])
        raise UpstreamError("UPSTREAM_ERROR", f"12306 余票查询失败：{reason}")

    # 12306 may include same-city alternatives even for an exact station request.
    # Filter the complete response before limiting; otherwise the requested pair
    # can disappear behind the first ten alternatives and a different station is
    # silently presented as its timetable.
    all_items = [_normalize_train(item) for item in (tickets.get("trains") or [])]
    station_pairs = [item for item in all_items
                if _station_matches(from_station, item['from_station'], item['from_station_code'])
                and _station_matches(to_station, item['to_station'], item['to_station_code'])]
    matching = [item for item in station_pairs if _matches_time_window(item, window)]
    items = matching[:limit]
    result: dict[str, Any] = {
        "mode": "train",
        "from": str(from_station),
        "to": str(to_station),
        "date": str(travel_date),
        "total_count": len(matching),
        "station_pair_count": len(station_pairs),
        "upstream_count": len(all_items),
        "excluded_other_station_pairs": len(all_items) - len(station_pairs),
        "excluded_outside_time_window": len(station_pairs) - len(matching),
        "time_window": window,
        "returned": len(items),
        "items": items,
    }
    unsupported: list[str] = ["实时运行变化（延误 / 取消）尚未接入"]

    if include_price:
        prices = await _call_tool(client, "query-ticket-price", arguments)
        if prices.get("success"):
            index = {_train_code(row): _normalize_prices(row.get("prices")) for row in (prices.get("data") or [])}
            for item in items:
                item["prices"] = index.get(item["train_code"] or "", {})
        else:
            unsupported.append(f"票价获取失败：{_failure_reason(prices)}")

    if include_transfer:
        transfers = await _call_tool(client, "query-transfer", arguments)
        if transfers.get("success"):
            result["transfers"] = [
                {
                    "middle_station": text(row.get("middle_station")),
                    "wait_time": text(row.get("wait_time")),
                    "total_duration": text(row.get("total_duration")),
                    "segments": [
                        {
                            "train_code": _train_code(segment),
                            "from_station": text(segment.get("from_station")),
                            "to_station": text(segment.get("to_station")),
                            "start_time": text(segment.get("start_time")),
                            "arrive_time": text(segment.get("arrive_time")),
                            "duration": text(segment.get("duration")),
                            "seats": _normalize_seats(segment.get("seats")),
                        }
                        for segment in (row.get("segments") or [])
                    ],
                }
                for row in (transfers.get("transfers") or [])[:5]
            ]
        else:
            unsupported.append(f"换乘方案获取失败：{_failure_reason(transfers)}")

    data = {
        "result": result,
        "source": {
            "type": SOURCE_TYPE,
            "capability": "transport",
            "note": "社区逆向来源（drfccv/mcp-server-12306，MIT）；非官方数据，仅供学习研究",
            "upstream": MCP_URL,
        },
        "queried_at": now_iso(),
        # 12306 边车没有提供上游数据的生成时间；出发日期已在 result.date。
        "data_time": None,
        "freshness": {"kind": "realtime", "cache_ttl_seconds": CACHE_TTL_SECONDS},
        "units": {"duration": "HH:MM", "seats": "余票为「有 / 无 / 张数」字符串"},
        "coordinate_system": None,
        "missing": [] if matching else ["指定站对在所选时刻范围内未返回直达车次" if station_pairs else "指定出发站与到达站之间未返回直达车次；未用同城其他车站替代"],
        "unsupported": unsupported,
    }
    _cache.set(cache_key, data, CACHE_TTL_SECONDS)
    return with_cache_meta(data, None, CACHE_TTL_SECONDS, hit=False)
