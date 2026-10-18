"""Provider-owned inputs and model projections, also discovered over MCP."""
from collections import defaultdict
from datetime import date
import json
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from .providers.xhs import SearchQuery, NoteQuery
from .providers.web_search import WebSearchQuery
from .providers.web_fetch import FetchQuery

class Input(BaseModel):
    model_config = ConfigDict(extra='forbid')

class Point(Input):
    latitude: float = Field(ge=-90,le=90)
    longitude: float = Field(ge=-180,le=180)
    coordinate_system: Literal['WGS84','GCJ02']

class Places(Input):
    keywords: str = Field(min_length=1,max_length=200,description='具体地点名或完整分店／车站名；按区域和类别发现候选用query_venues')
    city: str = Field(min_length=1,max_length=100,description='仅返回指定城市的匹配地点，避免外地同名结果；当前为高德覆盖地区')
    limit: int = Field(default=5,ge=1,le=10,strict=True)

class Routes(Input):
    origin: Point
    destination: Point
    mode: Literal['walking','transit','driving']
    city: str | None = None

class Weather(Point):
    start_date: date | None = None
    end_date: date | None = None
    forecast_days: int = Field(default=7,ge=1,le=16,strict=True)

class Transport(Input):
    from_station: str = Field(min_length=1,max_length=100)
    to_station: str = Field(min_length=1,max_length=100)
    date: date
    departure_after: str | None = Field(default=None,pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$',description='出发当地时刻下限（含），HH:MM')
    departure_before: str | None = Field(default=None,pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$',description='出发当地时刻上限（含），HH:MM')
    arrival_after: str | None = Field(default=None,pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$',description='到达当地时刻下限（含），HH:MM；不表示到达日期')
    arrival_before: str | None = Field(default=None,pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$',description='到达当地时刻上限（含），HH:MM；不表示到达日期')
    limit: int = Field(default=10,ge=1,le=100,strict=True,description='精确站对与时间窗口筛选后的最多结果数')
    include_price: bool = Field(default=False,description='查询票价，会额外请求上游')
    include_transfer: bool = Field(default=False,description='附中转换乘候选，会额外请求上游；候选仍需逐段核实')

from .providers.venues import VenueQuery
SOURCE_MODELS = {'places':Places,'routes':Routes,'weather':Weather,'transport':Transport,'xhs':SearchQuery,'xhs_note':NoteQuery,'web':WebSearchQuery,'web_fetch':FetchQuery,'venues':VenueQuery}
SOURCE_SCHEMAS = {name:model.model_json_schema() for name,model in SOURCE_MODELS.items()}

def model_projection(capability, payload):
    """Structured summaries; never truncate JSON into an invalid preview string."""
    value = json.loads(json.dumps(payload, ensure_ascii=False, default=str))
    if capability in ('web','web_fetch'):value.pop('raw_response',None)
    wrapper = value.get('data', value)
    # read_tool wraps the external envelope in source_id/data.
    data = wrapper.get('data', wrapper)
    result = data.get('result', {})
    if capability == 'xhs_note':
        note = result.get('note') or {}
        content = note.get('content') or ''
        # With the evidence reread tool disabled, selected notes must be readable
        # in full. Images remain outside text-only model context.
        note['content'] = content
        images = note.pop('images', [])
        note['image_count'] = len(images)
    if capability == 'places':
        result['items'] = [{k: p[k] for k in ('id', 'name', 'address', 'city', 'district', 'latitude', 'longitude') if p.get(k) is not None} for p in result.get('items', [])]
    if capability == 'venues':
        result['items'] = [{k:p[k] for k in ('id','name','category','latitude','longitude','distance_m','address','phone','website','opening_hours','cuisine','source','source_warnings') if p.get(k) is not None} for p in result.get('items',[])]
    if capability == 'routes':
        geometry = result.pop('geometry', None)
        if geometry: result['map_geometry_available'] = bool(geometry.get('coordinates'))
        steps = result.pop('steps', [])
        if steps:
            result['roads'] = list(dict.fromkeys(s.get('road') for s in steps if s.get('road')))
            result['step_count'] = len(steps)
    if capability == 'weather':
        hourly = result.pop('hourly', {})
        by_day = defaultdict(lambda: defaultdict(list))
        for index, time in enumerate(hourly.get('time', [])):
            for key, values in hourly.items():
                if key == 'time' or index >= len(values) or values[index] is None: continue
                by_day[time[:10]][key].append(values[index])
        result['daily_summary'] = [{'date': day, **{k: {'min':min(v),'max':max(v)} for k,v in values.items() if v}} for day,values in sorted(by_day.items())]
        result.pop('candidates', None)
    return value
