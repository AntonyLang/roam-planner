import asyncio
import json

import httpx
from fastapi import FastAPI

from app.internal import router
from app.runtime_config import clear_config_cache


def make_app(handler):
    app = FastAPI()
    app.include_router(router)
    app.state.http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return app


def test_maps_check_uses_submitted_config_for_a_real_upstream_request_and_never_echoes_key(monkeypatch, tmp_path):
    token_file = tmp_path / 'service-token'
    token_file.write_text('internal-token')
    monkeypatch.setenv('ROAM_SERVICE_TOKEN_FILE', str(token_file))
    monkeypatch.setenv('AMAP_API_KEY', 'environment-value')
    monkeypatch.delenv('ROAM_SETTINGS_URL', raising=False)
    clear_config_cache()
    calls = []

    def upstream(request):
        calls.append(request)
        assert request.url.host == 'restapi.amap.com'
        assert request.url.params['key'] == 'submitted-value'
        assert request.url.params['keywords'] == '栈桥'
        return httpx.Response(200, json={'status': '1', 'count': '0', 'pois': []})

    async def run():
        app = make_app(upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://sources') as client:
            response = await client.post('/internal/services/check', headers={'x-roam-service-token': 'internal-token'}, json={
                'service': 'maps',
                'config': {
                    'maps': {'provider': 'amap', 'amap_key': 'submitted-value', 'geoapify_key': ''},
                    'search': {'exa_mcp_url': ''},
                    'xhs': {'enabled': False},
                },
            })
        await app.state.http.aclose()
        return response

    response = asyncio.run(run())
    assert response.status_code == 200
    assert response.json()['ok'] is True
    assert response.json()['message'] == '高德地点服务已连通'
    assert len(calls) == 1
    assert 'submitted-value' not in json.dumps(response.json())


def test_internal_api_rejects_missing_service_token(monkeypatch, tmp_path):
    token_file = tmp_path / 'service-token'
    token_file.write_text('internal-token')
    monkeypatch.setenv('ROAM_SERVICE_TOKEN_FILE', str(token_file))

    async def run():
        app = make_app(lambda request: httpx.Response(500))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://sources') as client:
            response = await client.get('/internal/xhs/status')
        await app.state.http.aclose()
        return response

    response = asyncio.run(run())
    assert response.status_code == 401


def test_invalid_check_payload_does_not_echo_config_values(monkeypatch, tmp_path):
    token_file = tmp_path / 'service-token'
    token_file.write_text('internal-token')
    monkeypatch.setenv('ROAM_SERVICE_TOKEN_FILE', str(token_file))

    async def run():
        app = make_app(lambda request: httpx.Response(500))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://sources') as client:
            response = await client.post('/internal/services/check', headers={'x-roam-service-token': 'internal-token'}, json={
                'service': 'maps',
                'config': {
                    'maps': {'provider': 'amap', 'amap_key': {'secret': 'fixture-secret'}, 'geoapify_key': ''},
                    'search': {'exa_mcp_url': ''},
                    'xhs': {'enabled': False},
                },
            })
        await app.state.http.aclose()
        return response

    response = asyncio.run(run())
    assert response.json()['ok'] is False
    assert 'fixture-secret' not in json.dumps(response.json())


def test_search_check_calls_exa_and_returns_only_a_safe_summary(monkeypatch, tmp_path):
    token_file = tmp_path / 'service-token'
    token_file.write_text('internal-token')
    monkeypatch.setenv('ROAM_SERVICE_TOKEN_FILE', str(token_file))
    monkeypatch.delenv('ROAM_SETTINGS_URL', raising=False)
    clear_config_cache()
    calls = []

    def upstream(request):
        calls.append(request)
        assert request.url.host == 'exa.example'
        assert request.url.params['token'] == 'secret-in-url'
        body = json.loads(request.content)
        assert body['params']['arguments']['numResults'] == 1
        return httpx.Response(200, json={'result': {'content': [{'type': 'text', 'text': 'Title: Check\nURL: https://example.test/'}]}})

    async def run():
        app = make_app(upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://sources') as client:
            response = await client.post('/internal/services/check', headers={'x-roam-service-token': 'internal-token'}, json={
                'service': 'search',
                'config': {
                    'maps': {'provider': 'amap', 'amap_key': '', 'geoapify_key': ''},
                    'search': {'exa_mcp_url': 'https://exa.example/mcp?token=secret-in-url'},
                    'xhs': {'enabled': False},
                },
            })
        await app.state.http.aclose()
        return response

    response = asyncio.run(run())
    assert response.status_code == 200
    assert response.json()['ok'] is True
    assert response.json()['message'] == 'Exa 搜索服务已连通'
    assert len(calls) == 1
    assert 'secret-in-url' not in json.dumps(response.json())
