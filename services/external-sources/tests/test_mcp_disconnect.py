import asyncio
import json
import logging
import socket
import sys
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
import pytest
import uvicorn

SOURCE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE_ROOT))


@pytest.fixture
def mcp_app(monkeypatch):
    isolated = (Path(__file__).resolve().parents[3] / '.run' / 'optimization-audit' /
                'S1-sources-disconnect-checks' / 'import-scratch')
    monkeypatch.setenv('RETRIEVAL_ROOT', str(isolated / 'retrieval'))
    monkeypatch.setenv('KNOWLEDGE_ARCHIVE_ROOT', str(isolated / 'archive'))
    monkeypatch.setenv('RETRIEVAL_DATASET_ROOT', str(isolated / 'datasets'))
    monkeypatch.delenv('KNOWLEDGE_LIBRARY_RELEASE', raising=False)
    monkeypatch.setenv('SOURCES_GUIDES_ENABLED', 'false')

    from app.common import make_app
    from app import mcp

    app = make_app('external-sources')
    app.state.http = object()
    app.include_router(mcp.router)
    return app, mcp


class RequestCapture:
    def __init__(self, app):
        self.app = app
        self.request_done = asyncio.Event()
        self.response_statuses = []

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('path') != '/mcp':
            await self.app(scope, receive, send)
            return

        self.request_done.clear()

        async def observe_send(message):
            if message['type'] == 'http.response.start':
                self.response_statuses.append(message['status'])
            await send(message)

        try:
            await self.app(scope, receive, observe_send)
        finally:
            self.request_done.set()


@asynccontextmanager
async def loopback_server(asgi_app, *, graceful_timeout=1):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', 0))
    sock.listen(128)
    sock.setblocking(False)
    port = sock.getsockname()[1]
    config = uvicorn.Config(
        asgi_app, host='127.0.0.1', port=port, log_level='critical',
        log_config=None, lifespan='off', timeout_graceful_shutdown=graceful_timeout,
    )
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve(sockets=[sock]), name='s1-test-uvicorn')
    try:
        for _ in range(300):
            if server.started:
                break
            if server_task.done():
                await server_task
            await asyncio.sleep(0.01)
        assert server.started
        yield port, server, server_task
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, timeout=5)
        finally:
            sock.close()


class ProviderGate:
    def __init__(self, result=None):
        self.started = asyncio.Event()
        self.finished = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.release = asyncio.Event()
        self.task = None
        self.result = result if result is not None else {'result': {'items': []}}

    async def wait(self, *_args, **_kwargs):
        self.task = asyncio.current_task()
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        finally:
            self.finished.set()
        return self.result


def rpc_body(name, arguments, ident=1):
    return {
        'jsonrpc': '2.0', 'id': ident, 'method': 'tools/call',
        'params': {'name': name, 'arguments': arguments},
    }


async def begin_raw_request(port, body, started):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
    request = (
        f'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
        'Content-Type: application/json\r\n'
        f'Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n'
    ).encode('ascii') + payload
    writer.write(request)
    await writer.drain()
    await asyncio.wait_for(started.wait(), timeout=3)
    return reader, writer


def test_mcp_disconnect_cancellation_scope_and_response_semantics(mcp_app, monkeypatch, caplog):
    app, mcp = mcp_app
    capture = RequestCapture(app)
    caplog.set_level(logging.INFO, logger='app.mcp')
    monkeypatch.setenv('SOURCES_GUIDES_ENABLED', 'false')

    async def scenario():
        async with loopback_server(capture) as (port, _server, _server_task):
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=3, trust_env=False) as client:
                original = {
                    'result': {
                        'url': 'https://example.org/', 'requested_url': 'https://example.org/',
                        'title': 'Fixture', 'content_type': 'text/html', 'content': 'fixture text',
                        'content_id': 'a' * 64, 'format': 'readable', 'offset': 0,
                        'next_offset': None, 'total_chars': 12, 'links': [],
                        'content_scope': 'extracted_page_text',
                    },
                    'source': {'type': 'direct-http-fetch', 'url': 'https://example.org/'},
                    'queried_at': '2026-10-18T00:00:00+00:00',
                    'raw_response': {'body': '<p>fixture text</p>', 'content_type': 'text/html'},
                    'missing': [], 'limitations': [],
                }

                async def successful_provider(_http, _query):
                    return original

                monkeypatch.setattr(mcp.web_fetch, 'query', successful_provider)
                response = await client.post('/mcp', json=rpc_body(
                    'web_fetch', {'url': 'https://example.org/'}, ident='success',
                ))
                projected = mcp.model_projection('web_fetch', original)
                expected = {
                    'jsonrpc': '2.0', 'id': 'success', 'result': {
                        'content': [{'type': 'text', 'text': json.dumps(projected, ensure_ascii=False)}],
                        'structuredContent': projected,
                        '_meta': {
                            mcp.META + '/original': original,
                            mcp.META + '/events': [{
                                'kind': 'source_available',
                                'payload': {'capability': 'web_fetch', 'data': original},
                            }],
                        },
                    },
                }
                assert response.status_code == 200, response.text
                assert response.json() == expected
                assert '<p>fixture text</p>' not in response.json()['result']['content'][0]['text']
                assert response.json()['result']['_meta'][mcp.META + '/original'] == original
                await asyncio.sleep(0)
                assert not [task for task in asyncio.all_tasks() if not task.done() and
                            task.get_name().startswith('mcp-')]

                from app.providers.errors import UpstreamError

                async def failed_provider(_http, _query):
                    raise UpstreamError('UPSTREAM_TIMEOUT', 'fixture timeout')

                monkeypatch.setattr(mcp.web_fetch, 'query', failed_provider)
                response = await client.post('/mcp', json=rpc_body(
                    'web_fetch', {'url': 'https://example.org/'}, ident=2,
                ))
                assert response.status_code == 200
                assert response.json()['result'] == {
                    'isError': True,
                    'content': [{'type': 'text', 'text': json.dumps({
                        'error': {'code': 'UPSTREAM_TIMEOUT', 'message': 'fixture timeout'},
                        'needs_user_action': False,
                    }, ensure_ascii=False)}],
                    'structuredContent': {
                        'error': {'code': 'UPSTREAM_TIMEOUT', 'message': 'fixture timeout'},
                        'needs_user_action': False,
                    },
                }
                await asyncio.sleep(0)
                assert not [task for task in asyncio.all_tasks() if not task.done() and
                            task.get_name().startswith('mcp-')]

                helper = mcp._call_provider_until_disconnect

                async def disconnected_before_reply(_request, provider, _tool_name):
                    provider.close()
                    raise mcp._ClientDisconnected

                monkeypatch.setattr(mcp, '_call_provider_until_disconnect', disconnected_before_reply)
                response = await client.post('/mcp', json=rpc_body(
                    'web_fetch', {'url': 'https://example.org/'}, ident=21,
                ))
                assert response.status_code == 499
                assert response.content == b''
                monkeypatch.setattr(mcp, '_call_provider_until_disconnect', helper)

            gate = ProviderGate()

            async def blocked_provider(_http, _query):
                return await gate.wait()

            monkeypatch.setattr(mcp.web_fetch, 'query', blocked_provider)
            response_count = len(capture.response_statuses)
            _reader, writer = await begin_raw_request(
                port, rpc_body('web_fetch', {'url': 'https://example.org/'}, ident=3), gate.started,
            )
            writer.close()
            with suppress(Exception):
                await writer.wait_closed()
            await asyncio.wait_for(gate.finished.wait(), timeout=3)
            assert gate.cancelled.is_set()
            assert len(capture.response_statuses) == response_count
            assert 'MCP HTTP client disconnected while provider was active (tool=web_fetch)' in caplog.text
            await asyncio.sleep(0)
            assert not [task for task in asyncio.all_tasks() if not task.done() and
                        task.get_name() in {'mcp-provider:web_fetch', 'mcp-disconnect:web_fetch'}]

            async def verify_excluded_tool(tool_name, arguments, patch_target):
                excluded_gate = ProviderGate()

                async def blocked_excluded(*_args, **_kwargs):
                    return await excluded_gate.wait()

                monkeypatch.setattr(patch_target[0], patch_target[1], blocked_excluded)
                _reader, excluded_writer = await begin_raw_request(
                    port, rpc_body(tool_name, arguments, ident=4), excluded_gate.started,
                )
                excluded_writer.close()
                with suppress(Exception):
                    await excluded_writer.wait_closed()
                await asyncio.sleep(0.15)
                assert not excluded_gate.cancelled.is_set(), tool_name
                excluded_gate.release.set()
                await asyncio.wait_for(excluded_gate.finished.wait(), timeout=2)

            assert mcp.DISCONNECT_CANCELLABLE_CAPABILITIES == {
                'venues', 'places', 'routes', 'weather', 'transport', 'web', 'web_fetch',
            }
            await verify_excluded_tool(
                'search_xhs', {'keywords': '青岛 住宿', 'destination': '青岛'}, (mcp.xhs, 'query'),
            )
            await verify_excluded_tool(
                'read_xhs_note', {'note_id': 'a' * 24}, (mcp.xhs, 'query'),
            )

            monkeypatch.setenv('SOURCES_GUIDES_ENABLED', 'true')
            from app.knowledge import api
            guide_gate = ProviderGate({'fixture': 'guide result'})

            async def blocked_guides(**_kwargs):
                return await guide_gate.wait()

            monkeypatch.setattr(api.retrieval, 'search', blocked_guides)
            _reader, guide_writer = await begin_raw_request(
                port, rpc_body('search_guides', {'query': 'fixture guide'}, ident=5), guide_gate.started,
            )
            guide_writer.close()
            with suppress(Exception):
                await guide_writer.wait_closed()
            await asyncio.sleep(0.15)
            assert not guide_gate.cancelled.is_set()
            guide_gate.release.set()
            await asyncio.wait_for(guide_gate.finished.wait(), timeout=2)

            outer_gate = ProviderGate()

            async def outer_blocked_provider(_http, _query):
                return await outer_gate.wait()

            monkeypatch.setenv('SOURCES_GUIDES_ENABLED', 'false')
            monkeypatch.setattr(mcp.web_fetch, 'query', outer_blocked_provider)
            capture.request_done.clear()
            _reader, outer_writer = await begin_raw_request(
                port, rpc_body('web_fetch', {'url': 'https://example.org/'}, ident=6), outer_gate.started,
            )
            _port, server, server_task = port, _server, _server_task
            server.should_exit = True
            await asyncio.wait_for(server_task, timeout=5)
            await asyncio.wait_for(outer_gate.finished.wait(), timeout=2)
            await asyncio.wait_for(capture.request_done.wait(), timeout=2)
            assert outer_gate.cancelled.is_set()
            await asyncio.sleep(0)
            assert not [task for task in asyncio.all_tasks() if not task.done() and
                        task.get_name() in {'mcp-provider:web_fetch', 'mcp-disconnect:web_fetch'}]
            outer_writer.close()
            with suppress(Exception):
                await outer_writer.wait_closed()

    asyncio.run(scenario())


def test_provider_result_wins_when_disconnect_is_already_ready(mcp_app):
    _app, mcp = mcp_app

    class AlreadyDisconnected:
        async def receive(self):
            return {'type': 'http.disconnect'}

    async def scenario():
        async def completed_provider():
            return {'provider': 'completed'}

        assert await mcp._call_provider_until_disconnect(
            AlreadyDisconnected(), completed_provider(), 'web_fetch',
        ) == {'provider': 'completed'}
        await asyncio.sleep(0)
        assert not [task for task in asyncio.all_tasks() if not task.done() and
                    task.get_name() in {'mcp-provider:web_fetch', 'mcp-disconnect:web_fetch'}]

    asyncio.run(scenario())
