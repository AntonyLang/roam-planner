"""HTTP plumbing owned locally by this service, with no imports from other services."""
import logging
import os
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException

request_id = ContextVar("request_id", default=None)
trace_id = ContextVar("trace_id", default=None)
calls = ContextVar("calls", default=None)


class Input(BaseModel):
    model_config = ConfigDict(extra="allow")


class ServiceError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        self.code, self.message, self.status = code, message, status


def timeout() -> float:
    return float(os.getenv("HTTP_TIMEOUT_SECONDS", "10"))


def envelope(data: Any = None, error: dict | None = None, mock: bool = True) -> dict:
    # mock 默认 True（骨架占位）；接真实来源的能力传 mock=False，便于调用方区分。
    meta = {"request_id": request_id.get() or "req_" + uuid.uuid4().hex, "mock": mock}
    if trace_id.get():
        meta["trace_id"] = trace_id.get()
    if calls.get():
        meta["calls"] = list(calls.get())
    return {"data": data, "error": error, "meta": meta}


async def call_http(client: httpx.AsyncClient, service: str, base: str, method: str, path: str, body=None) -> Any:
    entry = {"service": service, "method": method, "path": path, "status_code": None}
    if calls.get() is not None:
        calls.get().append(entry)
    headers = {"X-Trace-ID": trace_id.get() or uuid.uuid4().hex}
    try:
        response = await client.request(method, base.rstrip("/") + path, json=body, headers=headers)
    except httpx.TimeoutException as exc:
        entry["error"] = "timeout"
        raise ServiceError("UPSTREAM_TIMEOUT", f"{service} 调用超时", 504) from exc
    except httpx.RequestError as exc:
        entry["error"] = "unavailable"
        raise ServiceError("UPSTREAM_UNAVAILABLE", f"无法连接 {service} 服务", 503) from exc
    entry["status_code"] = response.status_code
    try:
        payload = response.json()
        if not isinstance(payload, dict) or not all(key in payload for key in ("data", "error", "meta")):
            raise ValueError("missing response envelope")
        if not isinstance(payload["meta"], dict) or not payload["meta"].get("request_id"):
            raise ValueError("missing request identity")
        entry["request_id"] = payload["meta"]["request_id"]
        entry["mock"] = payload["meta"].get("mock")
    except (ValueError, TypeError, KeyError) as exc:
        raise ServiceError("UPSTREAM_INVALID_RESPONSE", f"{service} 响应不符合公共约定", 502) from exc
    if not response.is_success or payload["error"] is not None:
        error = payload.get("error")
        entry["error"] = error.get("code") if isinstance(error, dict) else "upstream_error"
        raise ServiceError("UPSTREAM_ERROR", f"{service} 返回调用错误", 502)
    if payload["data"] is None:
        raise ServiceError("UPSTREAM_INVALID_RESPONSE", f"{service} 成功响应缺少 data", 502)
    return payload["data"]


def make_app(service: str) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=timeout(), trust_env=os.getenv('SOURCES_TRUST_ENV', 'false').lower() == 'true') as client:
            app.state.http = client
            yield

    app = FastAPI(title=f"{service} HTTP foundation", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def identify(request: Request, call_next):
        rid = "req_" + uuid.uuid4().hex
        incoming = request.headers.get("X-Trace-ID", "")
        tid = incoming if incoming and incoming.isalnum() and len(incoming) <= 64 else uuid.uuid4().hex
        tokens = [(request_id, request_id.set(rid)), (trace_id, trace_id.set(tid)), (calls, calls.set([]))]
        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = rid
            response.headers["X-Trace-ID"] = tid
            return response
        finally:
            for var, token in reversed(tokens):
                var.reset(token)

    @app.exception_handler(ServiceError)
    async def service_error(request, exc):
        return JSONResponse(envelope(error={"code": exc.code, "message": exc.message}), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exc):
        return JSONResponse(envelope(error={"code": "VALIDATION_ERROR", "message": "请求不符合最低字段约定",
                                            "details": jsonable_encoder(exc.errors())}), status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse(envelope(error={"code": f"HTTP_{exc.status_code}", "message": str(exc.detail)}), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        logging.getLogger(service).exception("Unhandled service error", exc_info=exc)
        return JSONResponse(envelope(error={"code": "INTERNAL_ERROR", "message": "服务内部错误"}), status_code=500)

    @app.get("/healthz", tags=["development"])
    async def health():
        return envelope({"service": service, "status": "ok"})

    return app
