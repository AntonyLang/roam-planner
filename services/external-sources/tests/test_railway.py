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


def test_time_window_filters_full_station_pair_before_limit_and_has_a_distinct_cache_key(monkeypatch):
    from app.mcp_contracts import Transport
    monkeypatch.setattr(railway, '_cache', TtlCache())
    calls=[]
    base={'from_station':'上海虹桥','to_station':'苏州'}
    async def upstream(*args):
        calls.append(args)
        return {'success':True,'trains':[
            {**base,'train_no':'G1','start_time':'09:00','arrive_time':'09:40'},
        ]*12+[
            {**base,'train_no':'G2','start_time':'11:40','arrive_time':'12:20'},
            {**base,'train_no':'G3','start_time':'17:50','arrive_time':'18:30'},
            {**base,'train_no':'unknown'},
            {**base,'from_station':'上海松江','train_no':'wrong','start_time':'17:50','arrive_time':'18:30'},
        ]}
    monkeypatch.setattr(railway,'_call_tool',upstream)
    async def run():
        async with httpx.AsyncClient() as client:
            request=Transport.model_validate({**base,'date':'2026-10-24','departure_after':'17:00','departure_before':'19:00','limit':1}).model_dump(mode='json',exclude_none=True)
            evening=await railway.query_transport(client,request)
            assert [row['train_code'] for row in evening['result']['items']]==['G3']
            assert evening['result']['station_pair_count']==15
            assert evening['result']['excluded_outside_time_window']==14
            assert evening['result']['excluded_other_station_pairs']==1
            noon=await railway.query_transport(client,{**base,'date':'2026-10-24','arrival_after':'11:00','arrival_before':'13:00','limit':1})
            assert [row['train_code'] for row in noon['result']['items']]==['G2']
            cached=await railway.query_transport(client,request)
            assert cached['cache']['hit'] is True
            assert len(calls)==2
    asyncio.run(run())


def test_transport_contract_rejects_invalid_clocks_and_exposes_bounded_result_count():
    from app.mcp_contracts import Transport
    from pydantic import ValidationError
    base={'from_station':'苏州','to_station':'上海虹桥','date':'2026-10-25'}
    for patch in ({'departure_after':'24:00'},{'arrival_before':'18:70'},{'limit':101}):
        with pytest.raises(ValidationError):
            Transport.model_validate({**base,**patch})
