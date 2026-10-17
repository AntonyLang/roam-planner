import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapsMcp } from '../../../src/nest/maps/maps.mcp';
import type { MapsService } from '../../../src/nest/maps/maps.service';
import { createTestRegistry, type McpContext } from '../../../src/nest-mcp';
import { createAttachHarness } from '../nest-mcp/harness';

vi.mock('../../../src/app-config', async (original) => {
  const actual = await original<typeof import('../../../src/app-config')>();
  return {...actual, readEnv:()=>({...actual.readEnv(), agent:{...actual.readEnv().agent, externalSourcesUrl:'http://sources'}})};
});

const ctx = {userId:1} as McpContext;
const decode = (value: {content:{text:string}[]}) => JSON.parse(value.content[0].text);
function setup() {
  const pois = vi.fn().mockResolvedValue({pois:[
    {osm_id:'node:1', name:'海边酒店', lat:36.06, lng:120.38, category:'hotel', source:'trek-places'},
    {osm_id:'node:2', name:'另一酒店', lat:36.061, lng:120.381, category:'hotel', source:'trek-places'},
    {osm_id:'node:3', name:'博物馆', lat:36.06, lng:120.38, category:'museum', source:'openstreetmap'},
  ], source:'trek-places', clamped:false, truncated:false});
  return {pois, controller:new MapsMcp({pois} as unknown as MapsService)};
}
afterEach(() => vi.unstubAllGlobals());

describe('unified MCP venue discovery', () => {
  it('discovers its real schema and handles multiple viewport categories over MCP', async () => {
    const {controller, pois} = setup();
    const registry = createTestRegistry([controller], {accessPolicy:()=>true});
    const harness = await createAttachHarness(registry, {userId:1});
    try {
      const definition = (await harness.client.listTools()).tools.find(t=>t.name==='query_venues')!;
      expect(definition.description).toContain('query_places');
      expect(definition.inputSchema.properties).toHaveProperty('bbox');
      expect(definition.inputSchema.properties).toHaveProperty('center');
      const result = await harness.client.callTool({name:'query_venues', arguments:{category:['hotel','museum'], bbox:{south:36, west:120.3, north:36.2, east:120.5}, limit:1}});
      const data = JSON.parse((result.content as {text:string}[])[0].text);
      expect(pois).toHaveBeenCalledTimes(1);
      expect(data.result.items.map((p:{category:string})=>p.category)).toEqual(['hotel','museum']);
      expect(data.result.candidate_truncated).toBe(true);
      expect(data.coordinate_system).toBe('WGS84');
    } finally { await harness.cleanup(); }
  });

  it('reports the actual clamped rectangle and rejects conflicting ranges before I/O', async () => {
    const {controller, pois} = setup();
    const bbox={south:35,west:119,north:37,east:121};
    const data=decode(await controller.queryVenues({category:'hotel',bbox},ctx));
    expect(data.result.bbox).toEqual({south:35.75,north:36.25,west:119.75,east:120.25});
    expect(data.result.clamped).toBe(true);
    expect(data.result.requested_bbox).toEqual(bbox);
    pois.mockClear();
    const center={latitude:36,longitude:120,coordinate_system:'WGS84' as const};
    for (const query of [{category:'hotel'}, {category:'hotel',bbox,center}, {category:'hotel',bbox,radius_m:1000}, {category:'museum',center}]) {
      expect((await controller.queryVenues(query,ctx)).isError).toBe(true);
    }
    expect(pois).not.toHaveBeenCalled();
  });

  it('passes nearby queries to the existing multi-provider service without losing source metadata', async () => {
    const {controller, pois}=setup();
    const source={result:{items:[]},source:{type:'geoapify'},queried_at:'original-time',coordinate_system:'WGS84',cache:{hit:true}};
    const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({data:source,error:null,meta:{mock:false}})});
    vi.stubGlobal('fetch',fetchMock);
    const data=decode(await controller.queryVenues({category:'hotel',center:{latitude:36,longitude:120,coordinate_system:'GCJ02'},provider:'geoapify'},ctx));
    expect(data).toEqual(source);
    expect(pois).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).query).toMatchObject({radius_m:1500,limit:5,provider:'geoapify'});
  });

  it('never presents an upstream failure as an empty successful discovery', async () => {
    const {controller,pois}=setup();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,json:async()=>({error:{message:'来源限流'}})}));
    const result=await controller.queryVenues({category:'hotel',center:{latitude:36,longitude:120,coordinate_system:'WGS84'}},ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('来源限流');
    pois.mockRejectedValue(new Error('network'));
    expect((await controller.queryVenues({category:'hotel',bbox:{south:36,west:120,north:36.1,east:120.1}},ctx)).isError).toBe(true);
  });
});
