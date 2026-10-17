"""来源适配层的共用小工具。"""
from __future__ import annotations

import copy
import time
from datetime import datetime, timezone
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def as_int(value: Any, low: int, high: int, default: int) -> int:
    """把来源返回的数字规范成 int；越界或解析失败一律回落默认值。"""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if low <= parsed <= high else default


def text(value: Any) -> str | None:
    """来源在字段为空时的各种写法统一成 str | None。

    实测高德空字段返回 []、12306 返回空字符串或 '----'。
    """
    if value is None or value == "" or value == [] or value == {}:
        return None
    if value == "----":
        return None
    return str(value)


def empty_payload(source_type: str, capability: str, missing: list[str]) -> dict[str, Any]:
    """成功但无结果：error 为 null，缺失内容明确说明。"""
    return {
        "result": {},
        "source": {"type": source_type, "capability": capability},
        "queried_at": now_iso(),
        "data_time": None,
        "freshness": "unknown",
        "units": {},
        "coordinate_system": None,
        "missing": missing,
    }


def with_cache_meta(data: dict[str, Any], stored_at: float | None, ttl: int, hit: bool) -> dict[str, Any]:
    """给响应补上 cache 字段，让调用方知道这条结果是新查的还是命中了缓存。"""
    view = copy.deepcopy(data)
    meta: dict[str, Any] = {"hit": hit, "ttl_seconds": ttl}
    if hit and stored_at is not None:
        meta["stored_at"] = datetime.fromtimestamp(stored_at, timezone.utc).isoformat()
        meta["age_seconds"] = round(max(0.0, time.time() - stored_at), 1)
    view["cache"] = meta
    return view
