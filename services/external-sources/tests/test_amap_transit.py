import asyncio
import httpx
from app.providers import amap
from app.providers.cache import TtlCache


def test_transit_resolves_actual_origin_city_instead_of_using_countrywide_placeholder(monkeypatch):
    monkeypatch.setenv('AMAP_API_KEY', 'test-key')
    monkeypatch.setattr(amap, '_routes_cache', TtlCache())
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path.endswith('/regeo'):
            return httpx.Response(200, json={'status': '1', 'regeocode': {'addressComponent': {'citycode': '0512'}}})
        assert request.url.params['city'] == '0512'
        assert request.url.params['cityd'] == '0512'
        return httpx.Response(200, json={'status': '1', 'route': {'transits': [{'duration': '1200', 'distance': '5000', 'segments': [{'bus': {'buslines': [{'name': '地铁1号线', 'polyline': '120.6,31.3;120.61,31.31'}]}}]}]}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await amap.query_routes(client, {'origin': '120.6,31.3', 'destination': '120.61,31.31', 'mode': 'transit'})
        assert len(requests) == 2
        assert result['result']['geometry']['coordinates'] == [[[120.6, 31.3], [120.61, 31.31]]]
    asyncio.run(run())
