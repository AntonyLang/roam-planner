"""A failed city match must not silently substitute a place in another city."""
import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parents[1]))
from app.providers import amap
from app.providers.cache import TtlCache


def test_place_lookup_restricts_city_and_caches_each_city_separately(monkeypatch):
    monkeypatch.setenv('AMAP_API_KEY', 'fixture')
    monkeypatch.setattr(amap, '_places_cache', TtlCache(10))
    requests = []
    def respond(request):
        requests.append(request)
        # Mirrors the documented city-priority behavior: without citylimit,
        # a Qingdao lookup can still return the well-known Beijing place.
        restricted = request.url.params.get('citylimit') == 'true'
        items = [] if restricted and request.url.params['city'] == '青岛' else [
            {'id': 'beijing-poi', 'name': '天安门', 'cityname': '北京市',
             'adname': '东城区', 'address': '长安街', 'location': '116.397,39.908'}]
        return httpx.Response(200, json={'status': '1', 'info': 'OK', 'infocode': '10000', 'count': str(len(items)), 'pois': items})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            qingdao = await amap.query_places(client, {'keywords': '天安门', 'city': '青岛'})
            assert qingdao['result']['items'] == []
            beijing = await amap.query_places(client, {'keywords': '天安门', 'city': '北京'})
            assert beijing['result']['items'][0]['city'] == '北京市'
            again = await amap.query_places(client, {'keywords': '天安门', 'city': '青岛'})
            assert again['result']['items'] == []
            assert len(requests) == 2
    asyncio.run(run())
