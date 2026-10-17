import asyncio
import json

import httpx
import pytest

from app.main import app
from app.providers import venues
from app.providers.cache import TtlCache
from app.providers.coordinates import wgs84_to_gcj02


def query(**extra):
    return venues.VenueQuery(category='hotel', center={'latitude':36.064,'longitude':120.38,'coordinate_system':'WGS84'}, **extra)


def test_amap_coordinates_cache_and_unknown_booking(monkeypatch):
    monkeypatch.setenv('AMAP_API_KEY','test-key')
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    lat,lng=wgs84_to_gcj02(36.064,120.38)
    requests=[]
    def respond(request):
        requests.append(request)
        assert request.url.params['types']=='100000'
        assert request.url.params['location']==f'{lng:.6f},{lat:.6f}'
        return httpx.Response(200,json={'status':'1','count':'1','pois':[
            {'id':'hotel-1','name':'真实来源酒店','location':f'{lng},{lat}','address':'测试地址','tel':[]}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            first,second=await asyncio.gather(venues.query_venues(client,query()),venues.query_venues(client,query()))
        assert len(requests)==1 and second['cache']['hit']
        assert first['queried_at']==second['queried_at']
        hotel=first['result']['items'][0]
        assert abs(hotel['latitude']-36.064)<1e-7
        assert abs(hotel['longitude']-120.38)<1e-7
        assert hotel['room_price'] is hotel['room_availability'] is hotel['bookable'] is None
        assert hotel['phone'] is None and first['coordinate_system']=='WGS84'
    asyncio.run(run())


def test_fallback_preserves_failure_and_source_not_empty_success(monkeypatch):
    monkeypatch.setenv('AMAP_API_KEY','test-key')
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    def respond(request):
        if 'amap.com' in request.url.host:
            return httpx.Response(200,json={'status':'0','infocode':'10001','info':'INVALID_USER_KEY'})
        assert request.url.path=='/v1/nearby'
        return httpx.Response(200,json={'results':[{'gers':'a','name':'附近酒店','lat':36.064,'lng':120.381,
            'contact':{'phone':'123'},'address':{},'hours':None}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            data=await venues.query_venues(client,query())
        assert data['source']['type']=='trek'
        assert data['attempts'][0]['code']=='SOURCE_NOT_CONFIGURED'
        assert data['result']['items'][0]['source']=='trek-places'
    asyncio.run(run())


def test_overpass_partial_response_is_error_and_query_is_bounded(monkeypatch):
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    def respond(request):
        from urllib.parse import parse_qs
        ql=parse_qs(request.content.decode())['data'][0]
        assert '[timeout:10]' in ql and 'around:1500' in ql and 'out center tags 30;' in ql
        return httpx.Response(200,json={'elements':[], 'remark':'runtime error: timed out'})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(venues.UpstreamError) as caught:
                await venues.query_venues(client,query(provider='overpass'))
        assert caught.value.code=='UPSTREAM_INVALID_RESPONSE'
    asyncio.run(run())


def test_endpoint_rejects_conflicting_category_and_unbounded_area():
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            conflicting=await client.post('/api/v1/sources/hotels/query',json={'query':query().model_dump()|{'category':'restaurant'}})
            too_large=await client.post('/api/v1/sources/venues/query',json={'query':query().model_dump()|{'radius_m':100000}})
            assert conflicting.status_code==too_large.status_code==422
    asyncio.run(run())


def test_osm_way_centers_and_missing_tags_are_retained(monkeypatch):
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    def respond(request):
        return httpx.Response(200,json={'osm3s':{'timestamp_osm_base':'2026-10-03T00:00:00Z'},'elements':[
            {'type':'way','id':7,'center':{'lat':36.064,'lon':120.38},'tags':{'name':'海边旅馆','tourism':'hotel'}}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result=await venues.query_venues(client,query(provider='overpass'))
        item=result['result']['items'][0]
        assert item['id']=='osm:way/7' and item['opening_hours'] is None
        assert result['data_time']=='2026-10-03T00:00:00Z'
    asyncio.run(run())


@pytest.mark.parametrize('category', ['hotel','restaurant','cafe','bar'])
def test_foursquare_current_api_contract_and_normalization(monkeypatch, category):
    monkeypatch.setenv('FOURSQUARE_API_KEY','test-service-key')
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    requests=[]
    def respond(request):
        requests.append(request)
        assert str(request.url.copy_with(query=None))=='https://places-api.foursquare.com/places/search'
        assert request.headers['Authorization']=='Bearer test-service-key'
        assert request.headers['X-Places-Api-Version']=='2025-06-17'
        assert request.headers['Accept']=='application/json'
        assert request.url.params['ll']=='36.064,120.38'
        assert request.url.params['fsq_category_ids']==venues.FSQ_CATEGORIES[category]
        assert int(request.url.params['limit'])==50  # upstream max, even when our limit=20
        assert request.url.params['query']=='附近'
        assert 'hours' not in request.url.params['fields'].split(',')  # no implicit Premium charges
        place={'fsq_place_id':'one','name':'附近地点','latitude':36.064,'longitude':120.381,
               'location':{'address':'海边路1号','locality':'青岛','country':'CN'},'tel':'123',
               'website':'https://example.org','categories':[{'id':'fixture','name':category}],
               'unresolved_flags':['duplicate']}
        return httpx.Response(200,json={'results':[place,place,
            place|{'fsq_place_id':'closed','date_closed':'2026-01-01'},
            place|{'fsq_place_id':'private','unresolved_flags':['privatevenue']},
            place|{'fsq_place_id':'far','latitude':40},
            place|{'fsq_place_id':'missing-coordinates','latitude':None}]})
    async def run():
        payload=query(provider='foursquare',limit=20,keywords='附近').model_dump()|{'category':category}
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            first=await venues.query_venues(client,venues.VenueQuery(**payload))
            second=await venues.query_venues(client,venues.VenueQuery(**payload))
        assert len(requests)==1 and second['cache']['hit']
        assert first['queried_at']==second['queried_at']
        assert first['source']['type']=='foursquare' and 'test-service-key' not in json.dumps(first)
        assert len(first['result']['items'])==1
        item=first['result']['items'][0]
        assert item['id']=='foursquare:one' and item['category']==category
        assert item['address']=='海边路1号, 青岛, CN' and item['phone']=='123'
        assert item['source_warnings']==['duplicate'] and item['distance_m']<=1500
        assert item['opening_hours'] is item['room_price'] is item['room_availability'] is item['bookable'] is None
    asyncio.run(run())


def test_geoapify_contract_cache_and_no_credentials_in_evidence(monkeypatch):
    monkeypatch.setenv('GEOAPIFY_API_KEY','test-geo-key')
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    requests=[]
    def respond(request):
        requests.append(request)
        assert request.url.params['apiKey']=='test-geo-key'
        assert request.url.params['filter']=='circle:120.38,36.064,1500'
        return httpx.Response(200,json={'features':[{'properties':{'place_id':'one','name':'附近酒店',
            'lat':36.064,'lon':120.38,'formatted':'海边路',
            'datasource':{'raw':{'opening_hours':'Mo-Su 09:00-18:00','phone':'123'}}}}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            first=await venues.query_venues(client,query(provider='geoapify'))
            second=await venues.query_venues(client,query(provider='geoapify'))
        assert len(requests)==1 and second['cache']['hit']
        assert first['source']['type']=='geoapify' and 'test-geo-key' not in json.dumps(first)
        item=first['result']['items'][0]
        assert item['opening_hours']=='Mo-Su 09:00-18:00' and item['room_price'] is None
    asyncio.run(run())


def test_configured_sources_participate_in_auto_fallback(monkeypatch):
    monkeypatch.delenv('AMAP_API_KEY',raising=False)
    monkeypatch.setenv('GEOAPIFY_API_KEY','test-geo-key')
    monkeypatch.setenv('FOURSQUARE_API_KEY','test-service-key')
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    def respond(request):
        if request.url.host=='places.liketrek.com': return httpx.Response(503)
        if request.url.host=='api.geoapify.com': return httpx.Response(200,json={'features':[]})
        assert request.url.host=='places-api.foursquare.com'
        return httpx.Response(200,json={'results':[{'fsq_place_id':'one','name':'附近酒店','latitude':36.064,'longitude':120.38}]})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result=await venues.query_venues(client,query())
        assert [a['provider'] for a in result['attempts']]==['trek','geoapify','foursquare']
        assert result['source']['type']=='foursquare'
        assert result['attempts'][0]['status']=='error' and result['attempts'][1]['returned']==0
    asyncio.run(run())


def test_foursquare_missing_key_and_rejection_are_errors_not_cached_empty(monkeypatch):
    monkeypatch.delenv('FOURSQUARE_API_KEY',raising=False)
    monkeypatch.setattr(venues,'_cache',TtlCache())
    monkeypatch.setattr(venues,'_lock',asyncio.Lock())
    requests=[]
    def respond(request):
        requests.append(request)
        return httpx.Response(401,json={'message':'do not leak test-service-key'})
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            with pytest.raises(venues.UpstreamError) as missing:
                await venues.query_venues(client,query(provider='foursquare'))
            assert missing.value.code=='SOURCE_NOT_CONFIGURED' and not requests
            monkeypatch.setenv('FOURSQUARE_API_KEY','test-service-key')
            for _ in range(2):
                with pytest.raises(venues.UpstreamError) as denied:
                    await venues.query_venues(client,query(provider='foursquare'))
                assert denied.value.code=='SOURCE_NOT_CONFIGURED'
                assert 'test-service-key' not in denied.value.message
        assert len(requests)==2  # failures never masquerade as cached successful empties
    asyncio.run(run())
