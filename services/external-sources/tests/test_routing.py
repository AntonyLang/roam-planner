import asyncio
import json

import httpx
import pytest

from app.mcp_contracts import model_projection
from app.providers import routing
from app.providers.cache import TtlCache
from app.providers.coordinates import wgs84_to_gcj02
from app.providers.errors import UpstreamError


def route_query(mode='driving'):
    lat, lng = wgs84_to_gcj02(31.3318337, 120.6062832)
    return {'origin': {'latitude': lat, 'longitude': lng, 'coordinate_system': 'GCJ02'},
            'destination': {'latitude': 31.325476, 'longitude': 120.626364, 'coordinate_system': 'WGS84'},
            'mode': mode, 'city': '苏州'}


def configure(monkeypatch):
    monkeypatch.setenv('SOURCES_ROUTES_PROVIDER', 'geoapify')
    monkeypatch.setenv('GEOAPIFY_API_KEY', 'test-private-key')
    monkeypatch.setattr(routing, 'cache', TtlCache())


@pytest.mark.parametrize('mode,upstream_mode', [('driving', 'drive'), ('walking', 'walk')])
def test_provider_keeps_real_geometry_coordinate_system_and_timing_basis(monkeypatch, mode, upstream_mode):
    configure(monkeypatch)
    geometry = {'type': 'MultiLineString', 'coordinates': [[[120.6063, 31.3318], [120.607, 31.330], [120.6264, 31.3255]]]}
    requests = []
    def respond(request):
        requests.append(request)
        assert request.url.params['mode'] == upstream_mode
        start, end = request.url.params['waypoints'].split('|')
        assert tuple(map(float, start.split(','))) == pytest.approx((31.3318337, 120.6062832), abs=1e-8)
        assert tuple(map(float, end.split(','))) == (31.325476, 120.626364)
        return httpx.Response(200, json={'features': [{'properties': {'distance': 3741, 'time': 348.312}, 'geometry': geometry}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            first = await routing.query_routes(client, route_query(mode))
            cached = await routing.query_routes(client, route_query(mode))
        assert len(requests) == 1 and cached['cache']['hit']
        assert cached['queried_at'] == first['queried_at']
        assert first['result']['geometry'] == {**geometry, 'coordinate_system': 'WGS84'}
        assert first['coordinate_system'] == 'WGS84' and first['result']['mode'] == mode
        assert first['result']['duration_s'] == 349
        assert first['result']['time_basis'] == 'road_network_estimate_without_live_traffic'
        projected = model_projection('routes', first)
        assert projected['result']['map_geometry_available'] is True
        assert 'geometry' not in projected['result']
        assert first['result']['geometry']['coordinates'] == geometry['coordinates']
        assert 'test-private-key' not in json.dumps(first)
    asyncio.run(run())


def test_transit_is_not_silently_replaced_by_a_car_or_approximate_bus_route(monkeypatch):
    configure(monkeypatch)
    def respond(request):
        raise AssertionError('Unsupported transit must not dispatch')
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(UpstreamError) as error:
                await routing.query_routes(client, route_query('transit'))
            assert error.value.code == 'UNSUPPORTED_MODE'
    asyncio.run(run())


def test_connection_failure_remains_an_error_and_empty_success_stays_explicit(monkeypatch):
    configure(monkeypatch)
    attempts = []
    def failed(request):
        attempts.append(request)
        raise httpx.ConnectError('fixture connection failure', request=request)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(failed)) as client:
            with pytest.raises(UpstreamError) as error:
                await routing.query_routes(client, route_query())
            assert error.value.code == 'UPSTREAM_UNAVAILABLE' and len(attempts) == 1
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'features': []}))) as client:
            data = await routing.query_routes(client, route_query())
            assert data['result'] == {} and data['missing']
    asyncio.run(run())


def test_amap_default_keeps_existing_provider_contract(monkeypatch):
    monkeypatch.delenv('SOURCES_ROUTES_PROVIDER', raising=False)
    expected = {'existing': 'amap-result'}
    async def amap_query(client, query):
        assert query == route_query()
        return expected
    monkeypatch.setattr(routing.amap, 'query_routes', amap_query)
    assert asyncio.run(routing.query_routes(None, route_query())) is expected
