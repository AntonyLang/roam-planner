import asyncio

import httpx

from app.runtime_config import clear_config_cache, get_effective_config


def test_xhs_is_optional_and_disabled_by_default_in_source_deployments(monkeypatch):
    monkeypatch.delenv('XHS_ENABLED', raising=False)
    monkeypatch.delenv('ROAM_SETTINGS_URL', raising=False)
    assert asyncio.run(get_effective_config(None)).xhs.enabled is False
    monkeypatch.setenv('XHS_ENABLED','')
    assert asyncio.run(get_effective_config(None)).xhs.enabled is False


def test_central_config_overlay_falls_back_only_for_missing_values_and_caches(monkeypatch, tmp_path):
    token_file = tmp_path / 'token'
    token_file.write_text('service-token')
    monkeypatch.setenv('ROAM_SETTINGS_URL', 'http://trek.test/api/services/internal/sources')
    monkeypatch.setenv('ROAM_SERVICE_TOKEN_FILE', str(token_file))
    monkeypatch.setenv('SOURCES_ROUTES_PROVIDER', 'amap')
    monkeypatch.setenv('AMAP_API_KEY', 'environment-key')
    monkeypatch.setenv('GEOAPIFY_API_KEY', 'environment-geo')
    monkeypatch.setenv('EXA_MCP_URL', 'https://exa.example/mcp')
    clear_config_cache()
    calls = []

    def handle(request):
        calls.append(request)
        assert request.headers['x-roam-service-token'] == 'service-token'
        return httpx.Response(200, json={
            'revision': 4,
            'maps': {'provider': None, 'amap_key': '', 'geoapify_key': None},
            'search': {'exa_mcp_url': ''},
            'xhs': {'enabled': False},
        })

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            first = await get_effective_config(client)
            second = await get_effective_config(client)
        assert first.maps.provider == 'amap'
        assert first.maps.amap_key == ''
        assert first.maps.geoapify_key == 'environment-geo'
        assert first.search.exa_mcp_url == ''
        assert first.xhs.enabled is False
        assert second == first
        return first

    first = asyncio.run(run())
    assert len(calls) == 1
    assert 'environment-geo' not in repr(first)


def test_environment_is_used_when_central_endpoint_is_not_configured(monkeypatch):
    monkeypatch.delenv('ROAM_SETTINGS_URL', raising=False)
    monkeypatch.setenv('AMAP_KEY', 'environment-key')
    monkeypatch.setenv('XHS_ENABLED', 'false')

    async def run():
        async with httpx.AsyncClient() as client:
            config = await get_effective_config(client)
        assert config.maps.amap_key == 'environment-key'
        assert config.xhs.enabled is False

    asyncio.run(run())
