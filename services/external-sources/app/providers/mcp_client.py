"""最小 MCP Streamable HTTP 客户端。

只实现本项目需要的三件事：握手、`notifications/initialized`、`tools/call`。

**为什么不用官方 SDK**：实测官方 MCP Python SDK 2.2.0 只讲 2026-07-28 现代协议，
而社区 12306 服务（drfccv/mcp-server-12306 0.5.0）的现代协议路径要求 `params._meta`
携带 `io.modelcontextprotocol/protocolVersion` 与 `clientCapabilities` 信封，
两者不兼容（initialize 返回 `-32603`）。经典握手 `2025-11-25` 实测稳定可用。

**零额外依赖** —— 只用 httpx。约 80 行，比钉死一个旧版 SDK 更好维护。

协议要点（实测）：
  - 请求头 `Accept: application/json, text/event-stream`
  - 响应可能是 JSON，也可能是 SSE（`text/event-stream`），两种都要能解
  - 会话 id 由响应头 `mcp-session-id` 下发，后续请求带回去
  - 会话可能失效：调用失败时丢会话重连一次
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from .errors import UpstreamError

CANONICAL_PROTOCOL = "2025-11-25"


class McpHttpClient:
    def __init__(self, url: str, timeout: float = 30.0, service_name: str = "MCP", protocol: str = CANONICAL_PROTOCOL):
        self.url = url
        self.timeout = timeout
        self.service_name = service_name
        self.protocol = protocol
        self._session_id: str | None = None
        self._lock = asyncio.Lock()
        self._counter = 0

    @property
    def session_active(self) -> bool:
        return self._session_id is not None

    def _next_id(self) -> int:
        self._counter += 1
        return self._counter

    async def _post(self, client: httpx.AsyncClient, body: dict[str, Any]) -> httpx.Response:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        try:
            response = await client.post(self.url, json=body, headers=headers, timeout=self.timeout)
        except httpx.TimeoutException as exc:
            raise UpstreamError("UPSTREAM_TIMEOUT", f"{self.service_name} 调用超时") from exc
        except httpx.RequestError as exc:
            raise UpstreamError("UPSTREAM_UNAVAILABLE", f"无法连接 {self.service_name}") from exc
        session_id = response.headers.get("mcp-session-id")
        if session_id:
            self._session_id = session_id
        return response

    @staticmethod
    def _parse(response: httpx.Response) -> Any:
        if response.headers.get("content-type", "").startswith("text/event-stream"):
            last: Any = None
            for line in response.text.splitlines():
                if line.startswith("data:"):
                    chunk = line[5:].strip()
                    if chunk:
                        try:
                            last = json.loads(chunk)
                        except ValueError:
                            pass
            return last
        try:
            return response.json()
        except ValueError:
            return None

    async def _initialize(self, client: httpx.AsyncClient) -> None:
        self._session_id = None
        response = await self._post(client, {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": self.protocol,
                "capabilities": {},
                "clientInfo": {"name": "sda-external-sources", "version": "0.1"},
            },
        })
        payload = self._parse(response)
        if response.status_code >= 400 or not isinstance(payload, dict) or "error" in payload:
            raise UpstreamError(
                "UPSTREAM_ERROR",
                f"{self.service_name} 握手失败（HTTP {response.status_code}）",
            )
        await self._post(client, {"jsonrpc": "2.0", "method": "notifications/initialized"})

    async def call_tool(self, client: httpx.AsyncClient, name: str, arguments: dict[str, Any]) -> Any:
        """返回 MCP 的 result 对象；协议层失败抛 UpstreamError。"""
        async with self._lock:
            for attempt in (1, 2):
                if self._session_id is None:
                    await self._initialize(client)
                response = await self._post(client, {
                    "jsonrpc": "2.0",
                    "id": self._next_id(),
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                })
                payload = self._parse(response)
                if response.status_code < 400 and isinstance(payload, dict) and "error" not in payload:
                    return payload.get("result")
                if attempt == 1:
                    # 大概率是会话失效，丢掉重连一次
                    self._session_id = None
                    continue
                detail = "未知错误"
                if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
                    detail = payload["error"].get("message") or detail
                raise UpstreamError(
                    "UPSTREAM_ERROR",
                    f"{self.service_name} 调用 {name} 失败：{detail}",
                )
        return None
