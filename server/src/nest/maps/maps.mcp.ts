import { McpController, Tool, TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_OPEN_WORLD_READONLY, errorResult, ok, type McpContext } from '../../nest-mcp';
import { z } from 'zod';
import { POI_CATEGORY_KEYS, MAX_POI_CATEGORIES } from './maps.helpers';
import { MapsService } from './maps.service';
import { readEnv } from '../../app-config';

type DiscoveryQuery = {
  category: string | string[];
  bbox?: { south: number; west: number; north: number; east: number };
  center?: { latitude: number; longitude: number; coordinate_system: 'WGS84' | 'GCJ02' };
  radius_m?: number; limit?: number; keywords?: string;
  provider?: 'auto' | 'amap' | 'trek' | 'overpass' | 'geoapify' | 'foursquare';
  lang?: 'zh' | 'en';
};

/**
 * Geo MCP tools, moved 1:1 from the legacy registrar in
 * src/mcp/tools/mapsWeather.ts when the maps domain went DI-native (the weather
 * and airport tools stay there until their services migrate). Same names,
 * descriptions, input schemas and result shapes; the legacy registration-time
 * `canRead(scopes, 'geo')` gate became the declarative `access` marker ('geo'
 * is a read-only scope group — there is no geo:write).
 */
@McpController()
export class MapsMcp {
  constructor(private readonly maps: MapsService) {}

  @Tool({
    name: 'query_venues',
    description: '用于按区域和类别发现、比较多个尚未选定的场所，回答“这一带有哪些合适的地方”，例如附近餐馆、住宿或某片区域的博物馆与景点；不要用它精确定位一个已知名称。范围二选一：bbox为WGS84矩形，可一次查询多类景点、博物馆、自然地点、活动、住宿和餐饮等；center+radius_m只支持附近单类hotel/restaurant/cafe/bar。keywords用于筛选范围内候选，不是全城按名称查找。返回候选名称、地址、坐标、类别、来源及可用的营业信息；这些信息足够时直接用于方案，不必逐个再调用query_places。只有同名、分店、地址或坐标存在歧义，或需要定位某个具体车站、景点时，才用query_places。攻略搜索提供体验线索，本工具提供实际场所候选；路线用query_routes。默认limit=5，bbox为每类上限；bbox只支持provider=auto/trek，跨度超过0.5度会缩小并返回实际范围；center按可用来源回退。缺失营业、房价、房态为未知，不提供预订或营业保证；查询不会修改旅程。',
    inputSchema: {
      category: z.union([z.enum(POI_CATEGORY_KEYS), z.array(z.enum(POI_CATEGORY_KEYS)).min(1).max(MAX_POI_CATEGORIES)]).describe('bbox可一次发现多类候选；center仅支持单类hotel/restaurant/cafe/bar'),
      bbox: z.strictObject({south: z.number().min(-90).max(90), west: z.number().min(-180).max(180), north: z.number().min(-90).max(90), east: z.number().min(-180).max(180)}).optional().describe('WGS84矩形；与center二选一，south<north且west<east'),
      center: z.strictObject({latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), coordinate_system: z.enum(['WGS84','GCJ02'])}).optional().describe('附近搜索中心；与bbox二选一'),
      radius_m: z.number().int().min(100).max(10000).optional().describe('仅center模式，默认1500米'),
      limit: z.number().int().min(1).max(20).optional().describe('默认5；bbox模式为每类上限'),
      keywords: z.string().max(100).optional().describe('筛选指定范围内候选；已知完整地点名需要定位时用query_places'),
      provider: z.enum(['auto','amap','trek','overpass','geoapify','foursquare']).optional(),
      lang: z.enum(['zh','en']).optional(),
    },
    annotations: TOOL_ANNOTATIONS_OPEN_WORLD_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async queryVenues(query: DiscoveryQuery, _ctx: McpContext) {
    if (!!query.bbox === !!query.center) return errorResult('范围必须且只能提供bbox或center之一。');
    const categories = [...new Set(Array.isArray(query.category) ? query.category : [query.category])];
    const limit = query.limit ?? 5;
    if (query.bbox) {
      if (query.radius_m !== undefined) return errorResult('bbox模式不能提供radius_m。');
      if (query.provider && !['auto','trek'].includes(query.provider)) return errorResult('bbox模式使用TREK原生Places/OSM，provider只能auto或trek。');
      const {south, west, north, east} = query.bbox;
      if (south >= north || west >= east) return errorResult('bbox需要south<north且west<east。');
      const lat = (south+north)/2, lng = (west+east)/2;
      const h = Math.min((north-south)/2, .25), w = Math.min((east-west)/2, .25);
      const bounds = {south: lat-h, north: lat+h, west: lng-w, east: lng+w};
      try {
        const data = await this.maps.pois(categories.join(','), bounds, query.lang ?? 'zh');
        const keyword = (query.keywords ?? '').trim().toLocaleLowerCase();
        const candidates = data.pois.filter(p => !keyword || `${p.name} ${p.address ?? ''}`.toLocaleLowerCase().includes(keyword));
        const counts = new Map<string, number>();
        const selected = candidates.filter(p => { const n = (counts.get(p.category) ?? 0)+1; counts.set(p.category,n); return n<=limit; });
        const items = selected.map(p => ({id:p.osm_id, name:p.name, category:p.category, latitude:p.lat, longitude:p.lng, coordinate_system:'WGS84', address:p.address, phone:p.phone, website:p.website, opening_hours:p.opening_hours, cuisine:p.cuisine, charging:p.charging, source:p.source}));
        return ok({result:{categories, bbox:bounds, requested_bbox:query.bbox, items, candidate_truncated:data.truncated || selected.length<candidates.length, clamped:data.clamped || north-south>.5 || east-west>.5}, source:{type:data.source, capability:'venues', mode:'viewport'}, queried_at:new Date().toISOString(), coordinate_system:'WGS84', units:{coordinates:'WGS84 degrees'}, missing:items.length ? [] : ['matching_venues'], unknowns:['不提供实时房价、房态或预订；缺失营业时间表示未知，营业情况需临行复核']});
      } catch {
        return errorResult('地图地点发现失败，不能当作无结果。');
      }
    }
    if (categories.length !== 1 || !['hotel','restaurant','cafe','bar'].includes(categories[0])) return errorResult('center模式只支持单类hotel/restaurant/cafe/bar；其他分类或多分类请使用bbox。');
    try {
      const response = await fetch(readEnv().agent.externalSourcesUrl.replace(/\/$/,'')+'/api/v1/sources/venues/query', {
        method:'POST', headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(80000),
        body:JSON.stringify({query:{category:categories[0], center:query.center, radius_m:query.radius_m ?? 1500, limit, keywords:query.keywords ?? '', provider:query.provider ?? 'auto', lang:query.lang ?? 'zh'}}),
      });
      const raw = await response.json();
      const failure = z.object({error:z.object({message:z.string()})}).safeParse(raw);
      if (failure.success) return errorResult(failure.data.error.message.slice(0,400));
      const parsed = z.object({meta:z.object({mock:z.literal(false)}), error:z.null().optional(), data:z.object({result:z.object({items:z.array(z.unknown())}).passthrough(), source:z.record(z.string(),z.unknown()), queried_at:z.string()}).passthrough()}).safeParse(raw);
      if (!response.ok || !parsed.success) return errorResult('附近地点来源响应无效。');
      return ok(parsed.data.data);
    } catch {
      return errorResult('附近地点服务不可用或超时，不能当作无结果。');
    }
  }

  @Tool({
    name: 'get_place_details',
    description: 'Fetch detailed information about a place by its Google Place ID. The plain lookup returns name, address, coordinates, rating, opening hours, phone and website, and always answers with an empty review list. Set expand only when visitor reviews or the editorial summary are what was actually asked for: that field mask bills as a Google Enterprise SKU and costs the instance owner several times a plain lookup.',
    inputSchema: {
      placeId: z.string().describe('Google Place ID'),
      lang: z.string().optional().default('en'),
      expand: z.boolean().optional().default(false).describe('Also fetch up to five visitor reviews and the editorial summary. Billed as an Enterprise SKU, so leave it off unless the answer needs them'),
      refresh: z.boolean().optional().default(false).describe('Bypass the cached expanded payload and re-fetch from the provider. Only does anything together with expand, and pays the expanded price again'),
    },
    annotations: TOOL_ANNOTATIONS_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async getPlaceDetails(
    { placeId, lang, expand, refresh }: { placeId: string; lang?: string; expand?: boolean; refresh?: boolean },
    ctx: McpContext,
  ) {
    // The admin kill switch, checked before either path. An instance owner who
    // turns Place Details off does it to stop Google billing them, and an
    // assistant reaching the provider anyway would bill them from the one
    // surface the switch does not cover. REST answers { place: null, disabled }
    // rather than an error, so this does too, with a line the model can act on.
    if (this.maps.detailsDisabled()) {
      return ok({
        details: null,
        disabled: true,
        note: 'Place Details is turned off on this instance by an administrator. Nothing was fetched.',
      });
    }

    // Same split the REST route makes, and for the same reason: the expanded
    // field mask is the expensive one, so nothing reaches it unless it was asked for.
    const details = expand
      ? await this.maps.getPlaceDetailsExpanded(ctx.userId, placeId, lang ?? 'en', refresh ?? false)
      : await this.maps.getPlaceDetails(ctx.userId, placeId, lang ?? 'en');
    return ok({ details });
  }

  @Tool({
    name: 'reverse_geocode',
    description: 'Get a human-readable address for given coordinates.',
    inputSchema: {
      lat: z.number(),
      lng: z.number(),
      lang: z.string().optional().default('en'),
    },
    annotations: TOOL_ANNOTATIONS_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async reverseGeocode({ lat, lng, lang }: { lat: number; lng: number; lang?: string }, _ctx: McpContext) {
    const result = await this.maps.reverseGeocode(String(lat), String(lng), lang ?? 'en');
    return ok(result);
  }

  @Tool({
    name: 'resolve_maps_url',
    description: 'Resolve a Google Maps or Amap (高德地图) share URL to coordinates and place name.',
    inputSchema: {
      url: z.string().describe('Google Maps or Amap share URL'),
    },
    annotations: TOOL_ANNOTATIONS_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async resolveMapsUrl({ url }: { url: string }, _ctx: McpContext) {
    const result = await this.maps.resolveGoogleMapsUrl(url);
    return ok(result);
  }

  /**
   * The MCP side of GET /api/maps/pois, the "explore" pill on the trip map. Not
   * part of the 1:1 move above: the route had no tool at all, which left the
   * whole discover-what-is-here half of the map unreachable from a conversation.
   */
  @Tool({
    name: 'search_pois',
    description: 'List points of interest of one category inside a map rectangle, with address, opening hours, website, phone and cuisine wherever the source carries them. Answers from the TREK place index where it can and from OpenStreetMap otherwise; each result names which one it came from in its `source` field. A charging station also reports its sockets: which plug families it has, how many of each and at what power, plus how many vehicles fit and whether it charges a fee. OSM states a socket type on roughly a third of them and a power on fewer, so treat a missing figure as unknown rather than as absent. This is the discovery tool: use it to answer "what is around here" for a neighbourhood or a whole city district. Prefer search_place when the user already named the place they mean. Never calls Google, so it costs nothing and works on an instance with no Places key.',
    inputSchema: {
      category: z.union([
        z.enum(POI_CATEGORY_KEYS),
        z.array(z.enum(POI_CATEGORY_KEYS)).min(1).max(MAX_POI_CATEGORIES),
      ]).describe('Which kind of place to look for. Pass several to cover them in one query rather than one request per kind'),
      bbox: z.strictObject({
        south: z.number().min(-90).max(90).describe('Southern edge, latitude'),
        west: z.number().min(-180).max(180).describe('Western edge, longitude'),
        north: z.number().min(-90).max(90).describe('Northern edge, latitude'),
        east: z.number().min(-180).max(180).describe('Eastern edge, longitude'),
      }).describe('The rectangle to search. Anything wider than 0.5 degrees is narrowed to a centred window so the query stays fast; the answer reports that as `clamped`'),
      lang: z.string().max(35).optional().describe('Language for the POI names, e.g. "de" or "ja". Falls back to the OSM international name and then the local one'),
    },
    annotations: TOOL_ANNOTATIONS_READONLY,
    access: { group: 'geo', mode: 'read' },
  })
  async searchPois(
    { category, bbox, lang }: {
      category: string | string[];
      bbox: { south: number; west: number; north: number; east: number };
      lang?: string;
    },
    _ctx: McpContext,
  ) {
    try {
      return ok(await this.maps.pois(Array.isArray(category) ? category.join(',') : category, bbox, lang));
    } catch {
      // Overpass is a set of public mirrors; an outage there is not a bad request.
      return errorResult('POI search failed.');
    }
  }
}
