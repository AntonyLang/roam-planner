"""极简 TTL 缓存（进程内）。

为什么必须有：高德「关键字搜索」的日配额只有 5000（控制台实测数字），
而规划过程中同一个城市、同一批地点会被反复查询。不缓存很快就会打满配额。

特性：
  - 逐条 TTL
  - 容量上限 + LRU 淘汰（超限时丢最久未使用的）
  - 线程安全（uvicorn 默认在线程池里跑同步部分）
  - 只活在进程内，重启即失效；不做跨进程共享

命中情况会回写到响应的 cache 字段，调用方能看到「这条结果是缓存的」。
"""
from __future__ import annotations

import threading
import time
from typing import Any


class TtlCache:
    def __init__(self, max_entries: int = 512):
        self._data: dict[str, tuple[float, float, Any]] = {}
        self._lock = threading.Lock()
        self._max_entries = max(1, max_entries)
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def get(self, key: str) -> tuple[Any | None, float | None]:
        """返回 (值, 写入时刻)。未命中或已过期返回 (None, None)。"""
        now = time.time()
        with self._lock:
            item = self._data.get(key)
            if item is None:
                self.misses += 1
                return None, None
            stored_at, expires_at, value = item
            if now >= expires_at:
                self._data.pop(key, None)
                self.misses += 1
                return None, None
            # 触碰一次 -> 移到末尾，实现 LRU
            self._data.pop(key)
            self._data[key] = item
            self.hits += 1
            return value, stored_at

    def set(self, key: str, value: Any, ttl_seconds: float) -> None:
        now = time.time()
        with self._lock:
            self._data.pop(key, None)
            self._data[key] = (now, now + ttl_seconds, value)
            while len(self._data) > self._max_entries:
                oldest = next(iter(self._data))
                self._data.pop(oldest, None)
                self.evictions += 1

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "entries": len(self._data),
                "hits": self.hits,
                "misses": self.misses,
                "evictions": self.evictions,
            }
