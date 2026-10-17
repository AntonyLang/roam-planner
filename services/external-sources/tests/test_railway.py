import asyncio
import httpx
import pytest
from app.providers import railway
from app.providers.cache import TtlCache
from app.providers.errors import UpstreamError


def test_disabled_railway_reports_missing_source_without_querying(monkeypatch):
    monkeypatch.setattr(railway, 'MCP_URL', '')
    async def unexpected_query(*args):
        raise AssertionError('Disabled source must not dispatch upstream work')
    monkeypatch.setattr(railway, '_call_tool', unexpected_query)
    async def run():
        async with httpx.AsyncClient() as client:
            with pytest.raises(UpstreamError) as error:
                await railway.query_transport(client, {'from': '青岛', 'to': '济南', 'date': '2026-10-20'})
            assert error.value.code == 'SOURCE_NOT_CONFIGURED'
    asyncio.run(run())


def test_filters_exact_pair_before_limit_and_supports_station_suffix_and_code(monkeypatch):
    monkeypatch.setattr(railway, '_cache', TtlCache())
    async def upstream(client, name, args):
        assert name == 'query-tickets'
        wrong = {'train_no': 'C1', 'from_station': '青岛北', 'from_station_code': 'QHK', 'to_station': '威海', 'to_station_code': 'WKK'}
        selected = {'train_no': 'C2', 'from_station': '青岛', 'from_station_code': 'QDK', 'to_station': '威海北', 'to_station_code': 'WHK', 'start_time': '09:00', 'arrive_time': '11:00'}
        return {'success': True, 'count': 13, 'trains': [wrong] * 12 + [selected]}
    monkeypatch.setattr(railway, '_call_tool', upstream)
    async def run():
        async with httpx.AsyncClient() as client:
            for departure, arrival in [('青岛站', '威海北站'), ('QDK', 'WHK')]:
                data = await railway.query_transport(client, {'from_station': departure, 'to_station': arrival, 'date': '2026-10-14', 'limit': 1})
                result = data['result']
                assert result['total_count'] == result['returned'] == 1
                assert result['excluded_other_station_pairs'] == 12
                assert result['items'][0]['train_code'] == 'C2'
                assert not data['missing']
    asyncio.run(run())


def test_no_exact_pair_never_substitutes_a_city_station(monkeypatch):
    monkeypatch.setattr(railway, '_cache', TtlCache())
    async def upstream(*args):
        return {'success': True, 'count': 1, 'trains': [{'train_no': 'C1', 'from_station': '青岛', 'to_station': '威海'}]}
    monkeypatch.setattr(railway, '_call_tool', upstream)
    async def run():
        async with httpx.AsyncClient() as client:
            data = await railway.query_transport(client, {'from_station': '青岛', 'to_station': '威海北', 'date': '2026-10-14'})
            assert data['result']['items'] == [] and data['result']['total_count'] == 0
            assert data['missing'] and data['result']['excluded_other_station_pairs'] == 1
    asyncio.run(run())
