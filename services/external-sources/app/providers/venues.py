"""Bounded hotel/dining discovery; source dates and unknown booking data stay explicit."""
from __future__ import annotations

import asyncio
import json
import math
import os
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from . import amap
from .cache import TtlCache
from .coordinates import gcj02_to_wgs84, point, wgs84_to_gcj02
from .errors import UpstreamError
from .support import now_iso, text, with_cache_meta


class Center(BaseModel):
    model_config = ConfigDict(extra='forbid')
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    coordinate_system: Literal['WGS84', 'GCJ02']


class VenueQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    category: Literal['hotel', 'restaurant', 'cafe', 'bar']
    center: Center
    radius_m: int = Field(default=1500, ge=100, le=10000)
    limit: int = Field(default=10, ge=1, le=20)
    keywords: str = Field(default='', max_length=100)
    provider: Literal['auto', 'amap', 'trek', 'overpass', 'geoapify', 'foursquare'] = 'auto'
    lang: Literal['zh', 'en'] = 'zh'


TREK_CATEGORIES = {
    'hotel': 'hotel,lodging,hostel,motel,bed_and_breakfast',
    'restaurant': 'restaurant,casual_eatery,fast_food',
    'cafe': 'cafe,coffee_shop', 'bar': 'bar,pub,nightclub,brewery',
}
AMAP_TYPES = {'hotel': '100000', 'restaurant': '050100|050200|050300', 'cafe': '050500', 'bar': '050400'}
OSM_FILTERS = {'hotel': ('tourism', 'hotel|hostel|motel|guest_house'),
               'restaurant': ('amenity', 'restaurant|fast_food'),
               'cafe': ('amenity', 'cafe'), 'bar': ('amenity', 'bar|pub|biergarten')}
GEO_CATEGORIES = {'hotel': 'accommodation.hotel,accommodation.hostel,accommodation.motel,accommodation.guest_house',
                  'restaurant': 'catering.restaurant,catering.fast_food',
                  'cafe': 'catering.cafe', 'bar': 'catering.bar,catering.pub'}
# Places API taxonomy, not the retired v3 numeric category IDs.
# https://docs.foursquare.com/data-products/docs/categories
FSQ_CATEGORIES = {
    'hotel': '4bf58dd8d48988d1fa931735,4bf58dd8d48988d1ee931735,4bf58dd8d48988d1fb931735,4bf58dd8d48988d1f8931735',
    'restaurant': '4d4b7105d754a06374d81259',
    'cafe': '63be6904847c3692a84b9bb6',
    'bar': '4bf58dd8d48988d116941735',
}
FSQ_FIELDS = 'fsq_place_id,name,latitude,longitude,categories,location,tel,website,date_closed,unresolved_flags'
TTL = 900
_cache = TtlCache(512)
# Coalesce concurrent identical requests and keep public Overpass traffic serial.
_lock = asyncio.Lock()


def stats():
    return {'cache': _cache.stats(),
            'geoapify_configured': bool(os.getenv('GEOAPIFY_API_KEY', '').strip()),
            'foursquare_configured': bool(os.getenv('FOURSQUARE_API_KEY', '').strip())}


def _distance(lat, lng, a, b):
    p, q = math.radians(a-lat), math.radians(b-lng)
    h = math.sin(p/2)**2 + math.cos(math.radians(lat))*math.cos(math.radians(a))*math.sin(q/2)**2
    return round(6371000*2*math.asin(math.sqrt(min(1, h))))


def _venue(provider, identifier, name, lat, lng, category, **fields):
    coordinates = point({'latitude': lat, 'longitude': lng})
    if coordinates is None or not text(name) or not identifier:
        return None
    return {'id': f'{provider}:{identifier}', 'name': text(name), 'category': category,
            'latitude': coordinates[0], 'longitude': coordinates[1], 'coordinate_system': 'WGS84',
            'source': provider, 'address': None, 'phone': None, 'website': None,
            'opening_hours': None, 'cuisine': None, 'rating': None,
            'room_price': None, 'room_availability': None, 'bookable': None, **fields}


async def _json(client, method, url, **kwargs):
    # Stream with a cap: upstream errors must not become empty successful results.
    headers = {'Accept':'application/json','User-Agent':'TREK-travel-agent/0.1'}
    headers.update(kwargs.pop('headers', {}))
    try:
        async with client.stream(method, url, timeout=12, headers=headers, **kwargs) as response:
            if response.status_code == 429:
                raise UpstreamError('UPSTREAM_RATE_LIMITED', '地点来源触发限流')
            if response.status_code in (401, 403):
                raise UpstreamError('SOURCE_NOT_CONFIGURED', '地点来源拒绝访问，请检查配置或权限')
            if not response.is_success:
                raise UpstreamError('UPSTREAM_ERROR', f'地点来源返回 HTTP {response.status_code}')
            chunks, size = [], 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > 2_000_000:
                    raise UpstreamError('UPSTREAM_INVALID_RESPONSE', '地点来源响应超过大小限制')
                chunks.append(chunk)
            value = json.loads(b''.join(chunks))
            if not isinstance(value, dict):
                raise ValueError('object required')
            return value
    except httpx.TimeoutException as exc:
        raise UpstreamError('UPSTREAM_TIMEOUT', '地点来源查询超时') from exc
    except httpx.RequestError as exc:
        raise UpstreamError('UPSTREAM_UNAVAILABLE', '无法连接地点来源') from exc
    except (ValueError, TypeError) as exc:
        raise UpstreamError('UPSTREAM_INVALID_RESPONSE', '地点来源响应格式错误') from exc


async def _fetch(client, provider, query, lat, lng):
    n = min(60, query.limit*3)  # bounded candidates before local keyword/radius filtering
    data_time = None
    if provider == 'amap':
        a, b = wgs84_to_gcj02(lat, lng)
        url = amap.BASE + '/v3/place/around'
        params = {'location': f'{b:.6f},{a:.6f}', 'types': AMAP_TYPES[query.category],
                  'radius': query.radius_m, 'offset': min(25, n), 'page': 1,
                  'extensions': 'all', 'sortrule': 'distance', 'keywords': query.keywords}
        body = await amap._amap_get(client, url, params, amap._require_key())
        rows = body.get('pois')
        if not isinstance(rows, list):
            raise UpstreamError('UPSTREAM_INVALID_RESPONSE', '高德地点响应缺少 pois 列表')
        items = []
        for p in rows:
            try:
                b, a = map(float, p['location'].split(','))
                a, b = gcj02_to_wgs84(a, b)
            except (KeyError, ValueError, TypeError, AttributeError):
                continue
            business = p.get('business') or p.get('biz_ext') or {}
            items.append(_venue('amap', p.get('id'), p.get('name'), a, b, query.category,
                address=text(p.get('address')), phone=text(p.get('tel')),
                opening_hours=text(business.get('opentime_week') or business.get('opentime')),
                source_coordinates={'location':p.get('location'), 'coordinate_system':'GCJ02'}))
        truncated = int(body.get('count') or 0) > len(rows)
        attribution = '高德地图'
    elif provider == 'trek':
        url = os.getenv('TREK_PLACES_URL', 'https://places.liketrek.com').rstrip('/') + '/v1/nearby'
        body = await _json(client, 'GET', url, params={'lat':lat, 'lng':lng,
            'radius':query.radius_m, 'limit':n, 'category':TREK_CATEGORIES[query.category]})
        rows = body.get('results')
        if not isinstance(rows, list):
            raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'TREK Places 响应缺少 results 列表')
        items = []
        for p in rows:
            address, contact, hours = p.get('address') or {}, p.get('contact') or {}, p.get('hours') or {}
            items.append(_venue('trek-places', p.get('gers'), p.get('name'), p.get('lat'), p.get('lng'), query.category,
                address=text(address.get('freeform') or address.get('locality')), phone=text(contact.get('phone')),
                website=text(contact.get('website')), opening_hours=text(hours.get('osm')),
                upstream_source=p.get('source'), hours_source_url=hours.get('sourceUrl')))
        truncated, attribution = len(rows) >= n, 'TREK Places / Overture Maps（各记录保留来源）'
    elif provider == 'overpass':
        url = os.getenv('OVERPASS_URL', 'https://overpass-api.de/api/interpreter')
        key, values = OSM_FILTERS[query.category]
        name_filter = ''
        # User keywords must be literal matches, not arbitrary regular expressions.
        if query.keywords:
            import re
            name_filter = '["name"~' + json.dumps(re.escape(query.keywords), ensure_ascii=False) + ',i]'
        ql = f'[out:json][timeout:10][maxsize:16777216];nwr["{key}"~"^({values})$"]{name_filter}(around:{query.radius_m},{lat},{lng});out center tags {n};'
        body = await _json(client, 'POST', url, data={'data':ql})
        if body.get('remark') or not isinstance(body.get('elements'), list):
            raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'Overpass 查询未完整执行')
        rows = body['elements']; items = []
        for p in rows:
            t, center = p.get('tags') or {}, p.get('center') or p
            address = t.get('addr:full') or ' '.join(t[k] for k in ('addr:city','addr:street','addr:housenumber') if t.get(k))
            items.append(_venue('osm', f"{p.get('type')}/{p.get('id')}", t.get('name:'+query.lang) or t.get('name'), center.get('lat'), center.get('lon'), query.category,
                address=text(address), phone=text(t.get('phone') or t.get('contact:phone')),
                website=text(t.get('website') or t.get('contact:website')),
                opening_hours=text(t.get('opening_hours')), cuisine=text(t.get('cuisine'))))
        data_time = (body.get('osm3s') or {}).get('timestamp_osm_base')
        truncated, attribution = len(rows) >= n, '© OpenStreetMap contributors / ODbL'
    elif provider == 'geoapify':
        key = os.getenv('GEOAPIFY_API_KEY', '').strip()
        if not key:
            raise UpstreamError('SOURCE_NOT_CONFIGURED', '未配置 GEOAPIFY_API_KEY')
        url = 'https://api.geoapify.com/v2/places'
        params = {'apiKey':key, 'categories':GEO_CATEGORIES[query.category],
                  'filter':f'circle:{lng},{lat},{query.radius_m}', 'bias':f'proximity:{lng},{lat}',
                  'limit':n, 'lang':query.lang}
        if query.keywords: params['name'] = query.keywords
        body = await _json(client, 'GET', url, params=params)
        rows = body.get('features')
        if not isinstance(rows, list):
            raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'Geoapify 响应缺少 features 列表')
        items = []
        for row in rows:
            p = row.get('properties') or {}; raw = (p.get('datasource') or {}).get('raw') or {}
            items.append(_venue('geoapify', p.get('place_id'), p.get('name'), p.get('lat'), p.get('lon'), query.category,
                address=text(p.get('formatted')), phone=text(raw.get('phone')),
                website=text(raw.get('website')), opening_hours=text(raw.get('opening_hours')), cuisine=text(raw.get('cuisine'))))
        truncated, attribution = len(rows) >= n, 'Powered by Geoapify / © OpenStreetMap contributors'
    elif provider == 'foursquare':
        key = os.getenv('FOURSQUARE_API_KEY', '').strip()
        if not key:
            raise UpstreamError('SOURCE_NOT_CONFIGURED', '未配置 FOURSQUARE_API_KEY（Places Service Key）')
        url = 'https://places-api.foursquare.com/places/search'
        # Request Pro fields only: hours, ratings and price tiers are Premium;
        # they are neither hotel rates nor confirmed booking availability.
        params = {'ll':f'{lat},{lng}', 'radius':query.radius_m, 'limit':min(n,50),
                  'fsq_category_ids':FSQ_CATEGORIES[query.category], 'sort':'DISTANCE', 'fields':FSQ_FIELDS}
        if query.keywords: params['query'] = query.keywords
        body = await _json(client, 'GET', url, params=params,
                           headers={'Authorization':f'Bearer {key}', 'X-Places-Api-Version':'2025-06-17'})
        rows = body.get('results')
        if not isinstance(rows, list):
            raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'Foursquare 响应缺少 results 列表')
        items = []
        for p in rows:
            if not isinstance(p, dict):
                raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'Foursquare 地点记录格式错误')
            flags = p.get('unresolved_flags') or []
            if p.get('date_closed') or any(f in flags for f in ('closed','delete','privatevenue','doesnt_exist')):
                continue
            address = p.get('location') or {}
            if not isinstance(address, dict):
                raise UpstreamError('UPSTREAM_INVALID_RESPONSE', 'Foursquare 地址格式错误')
            items.append(_venue('foursquare', p.get('fsq_place_id'), p.get('name'), p.get('latitude'), p.get('longitude'), query.category,
                address=text(', '.join(str(address[k]) for k in ('address','locality','region','postcode','country') if address.get(k))),
                phone=text(p.get('tel')), website=text(p.get('website')),
                source_categories=p.get('categories') or [], source_warnings=flags))
        truncated, attribution = len(rows) >= min(n,50), 'Powered by Foursquare'
    else:
        raise UpstreamError('SOURCE_NOT_CONFIGURED', '不支持此地点来源')
    selected, seen = [], set()
    for item in items:
        if not item or item['id'] in seen: continue
        item['distance_m'] = _distance(lat, lng, item['latitude'], item['longitude'])
        if item['distance_m'] > query.radius_m: continue
        if provider == 'trek' and query.keywords and query.keywords.casefold() not in item['name'].casefold(): continue
        seen.add(item['id']); selected.append(item)
    selected.sort(key=lambda item: item['distance_m'])
    return {'items': selected[:query.limit], 'candidate_truncated':truncated or len(selected)>query.limit,
            'source':{'type':provider,'capability':'venues','url':url,'attribution':attribution}, 'data_time':data_time}


async def query_venues(client: httpx.AsyncClient, query: VenueQuery):
    lat, lng = query.center.latitude, query.center.longitude
    if query.center.coordinate_system == 'GCJ02': lat, lng = gcj02_to_wgs84(lat, lng)
    domestic = 72.004 <= lng <= 137.8347 and .8293 <= lat <= 55.8271
    providers = [query.provider] if query.provider != 'auto' else (
        (['amap'] if domestic and amap.api_key() else []) + ['trek'] +
        (['geoapify'] if os.getenv('GEOAPIFY_API_KEY', '').strip() else []) +
        (['foursquare'] if os.getenv('FOURSQUARE_API_KEY', '').strip() else []) + ['overpass'])
    key = json.dumps({'query':query.model_dump(), 'providers':providers,
                      'trek':os.getenv('TREK_PLACES_URL'), 'overpass':os.getenv('OVERPASS_URL')}, sort_keys=True)
    async with _lock:
        cached, stored = _cache.get(key)
        if cached is not None: return with_cache_meta(cached, stored, cached['freshness']['cache_ttl_seconds'], True)
        attempts, last, succeeded = [], None, []
        for provider in providers:
            try:
                result = await _fetch(client, provider, query, lat, lng)
                attempts.append({'provider':provider,'status':'ok','returned':len(result['items'])})
                succeeded.append(result)
                if result['items']: break
            except UpstreamError as error:
                attempts.append({'provider':provider,'status':'error','code':error.code})
                last = error
                if query.provider != 'auto': raise
        if not succeeded:
            raise last or UpstreamError('UPSTREAM_UNAVAILABLE', '没有可用地点来源')
        result = succeeded[-1]
        payload = {'result':{'category':query.category,'center':{'latitude':lat,'longitude':lng},
                    'radius_m':query.radius_m,'items':result['items'],'candidate_truncated':result['candidate_truncated']},
                   'source':result['source'], 'attempts':attempts, 'queried_at':now_iso(),
                   'data_time':result['data_time'], 'coordinate_system':'WGS84',
                   'units':{'coordinates':'WGS84 degrees','distance':'m'},
                   'freshness':{'kind':'poi','cache_ttl_seconds':TTL,'live_booking':False},
                   'missing':[] if result['items'] else ['matching_venues'],
                   'unknowns':['来源名称、地址与坐标未经交叉核验；营业情况及营业时间需临行复核', '不提供实时房价、房型库存或预订确认']}
        ttl = TTL if result['items'] else 120
        payload['freshness']['cache_ttl_seconds'] = ttl
        _cache.set(key,payload,ttl)
        return with_cache_meta(payload,None,ttl,False)
