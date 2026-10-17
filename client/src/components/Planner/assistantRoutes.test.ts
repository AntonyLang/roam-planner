import { describe,it,expect } from 'vitest'
import { adoptedRouteIds,adoptedTransportSegments,changesRouteGeometry,draftRouteStyle,routeLines,plannedRouteSegments,type RouteEvent } from './assistantRoutes'
import { gcj02ToWgs84,type AgentPlan } from '@trek/shared'

const adopted:RouteEvent[]=[
  {seq:1,kind:'candidate_saved',payload:{candidate_id:'old',candidate_version:1,plan:{extensions:{route_source_ids:['tool:r']}}}},
  {seq:2,kind:'trip_changed',payload:{payload:{table:'agent_candidates',after:{candidate_id:'old',version:1,adopted_at:'now'}}}},
]

describe('native route continuity',()=>{
  it('preserves adopted routes through time-only edits and partial new candidates',()=>{
    const time={seq:3,kind:'trip_changed',payload:{payload:{table:'day_assignments',before:{id:20,day_id:37,place_id:20,order_index:6,end_time:'18:00'},after:{id:20,day_id:37,place_id:20,order_index:6,end_time:'17:50'}}}}
    expect(changesRouteGeometry(time)).toBe(false)
    expect(adoptedRouteIds([...adopted,time,{seq:4,kind:'candidate_saved',payload:{candidate_id:'new',candidate_version:1,plan:{extensions:{}}}}])).toEqual(['tool:r'])
  })
  it('invalidates routes after coordinate changes or reordering',()=>{
    for(const [table,key] of [['places','latitude'],['day_assignments','order_index']]){
      const change={seq:3,kind:'trip_changed',payload:{payload:{table,before:{[key]:1},after:{[key]:2}}}}
      expect(adoptedRouteIds([...adopted,change])).toEqual([])
    }
  })
  it('reads only the actual referenced geometry',()=>{
    const source={seq:3,kind:'source_available',payload:{capability:'routes',source_id:'tool:r',data:{result:{geometry:{coordinate_system:'WGS84',coordinates:[[[120,36],[121,37]]]}}}}}
    expect(routeLines([source],['tool:r'])).toEqual([[[120,36],[121,37]]])
    expect(routeLines([source],['tool:other'])).toEqual([])
  })
})

describe('itinerary route previews',()=>{
  const stop=(ref:string,day:number,longitude:number,mode:'walking'|'driving'='walking'):AgentPlan['activities'][number]=>({
    ref,name:ref,day_number:day,scope_ref:'day'+day,latitude:36,longitude,coordinate_system:'WGS84',
    transport_mode:mode,currency:'CNY',notes:'',evidence_ids:[],
  })
  const source=(id:string,origin:string,destination:string,mode='walking'):RouteEvent=>({seq:1,kind:'source_available',
    payload:{capability:'routes',source_id:id,data:{coordinate_system:'WGS84',result:{origin,destination,mode,duration_s:601,
      geometry:{coordinate_system:'WGS84',coordinates:[[[120,36],[120.01,36]]]}}}}})

  it('omits comparison, reverse, wrong-mode and unrelated routes and identifies each day',()=>{
    const events=[source('right','120,36','120.01,36'),source('reverse','120.01,36','120,36'),
      source('wrong-mode','120,36','120.01,36','driving'),source('comparison','120,36','121,36'),
      source('unused','120,36','120.01,36')]
    const activities=[stop('A',1,120),stop('B',1,120.01),stop('C',2,120),stop('D',2,120.01)]
    expect(plannedRouteSegments(events,['right','reverse','wrong-mode','comparison'],activities)).toEqual([
      expect.objectContaining({sourceId:'right',dayNumber:1,fromRef:'A',toRef:'B',fromName:'A',toName:'B',durationMinutes:11}),
      expect.objectContaining({sourceId:'right',dayNumber:2,fromRef:'C',toRef:'D'}),
    ])
    expect(plannedRouteSegments(events,['right'],[stop('A',1,120),stop('B',2,120.01)])).toEqual([])
  })

  it('matches explicit coordinate systems without treating unknown systems as WGS84',()=>{
    const first=gcj02ToWgs84(36,120),second=gcj02ToWgs84(36,120.01)
    const activities=[{...stop('A',1,first.lng),latitude:first.lat},{...stop('B',1,second.lng),latitude:second.lat}]
    const route=source('gcj','120,36','120.01,36')
    route.payload.data.coordinate_system='GCJ-02'
    route.payload.data.result.geometry.coordinate_system='GCJ02'
    expect(plannedRouteSegments([route],['gcj'],activities)).toHaveLength(1)
    route.payload.data.coordinate_system='unknown'
    expect(plannedRouteSegments([route],['gcj'],activities)).toEqual([])
    expect(plannedRouteSegments([route],['gcj'],[])).toEqual([])
  })
  it('prefers the queried endpoints of the actual stops over a newer route to a nearby place',()=>{
    const exact=source('actual-restaurant','120,36','120.01,36')
    const nearby=source('nearby-restaurant','120,36','120.0104,36')
    expect(plannedRouteSegments([exact,nearby],['actual-restaurant','nearby-restaurant'],[stop('hotel',1,120),stop('lunch',1,120.01)]))
      .toEqual([expect.objectContaining({sourceId:'actual-restaurant',fromName:'hotel',toName:'lunch'})])
  })
  it('distinguishes a source-confirmed railway from an unverified plan without a road fallback',()=>{
    const a=stop('from',1,120),b={...stop('to',1,122),transport_mode:'transit' as const}
    const leg={from_ref:'from',to_ref:'to',mode:'train' as const,source_id:'rail',train_code:'C1234',from_station:'青岛',to_station:'威海北',date:'2026-10-14',departure_time:'08:00',arrival_time:'10:00'}
    const road=source('road','120,36','122,36','transit')
    const rail:RouteEvent={seq:2,kind:'source_available',payload:{capability:'transport',source_id:'rail',data:{result:{date:leg.date,items:[{train_code:'C1234',from_station:'青岛',to_station:'威海北',start_time:'08:00',arrive_time:'10:00'}]}}}}
    expect(plannedRouteSegments([road,rail],['road'],[a,b],[leg])).toEqual([expect.objectContaining({mode:'train',schematic:true,durationMinutes:120,lines:[[[120,36],[122,36]]]})])
    expect(plannedRouteSegments([road],['road'],[a,b],[leg])).toEqual([expect.objectContaining({mode:'train',schematic:true,sourceConfirmed:false})])
    expect(plannedRouteSegments([road,rail],['road'],[a,b],[{...leg,train_code:'G9999'}])).toEqual([expect.objectContaining({sourceConfirmed:false,trainCode:'G9999'})])
    const legacy={...a,name:'青岛站乘C6496高铁',transport_mode:'transit' as const}
    expect(plannedRouteSegments([source('taxi','120,36','122,36','driving')],['taxi'],[legacy,{...b,transport_mode:'driving'}])).toEqual([])
  })
  it('uses a distinct flight schematic without inventing a flight number, duration, geometry or source',()=>{
    const a=stop('airport-a',1,120),b={...stop('airport-b',1,122),transport_mode:'transit' as const}
    const leg={mode:'flight' as const,from_ref:a.ref,to_ref:b.ref,from_airport:'出发机场',to_airport:'到达机场'}
    const [flight]=plannedRouteSegments([source('road','120,36','122,36','transit')],['road'],[a,b],[leg])
    expect(flight).toMatchObject({mode:'flight',schematic:true,sourceConfirmed:false,lines:[[[120,36],[122,36]]]})
    expect(flight.sourceId).toBeUndefined()
    expect(flight.durationMinutes).toBeUndefined()
    expect(flight.flightCode).toBeUndefined()
    expect(draftRouteStyle(flight,true)).toMatchObject({dashArray:'1 9',weight:3})
    expect(draftRouteStyle({...flight,mode:'train'},true).dashArray).toBe('12 6 2 6')
    expect(draftRouteStyle({...flight,mode:'driving',schematic:false},true).dashArray).toBeUndefined()
    expect(plannedRouteSegments([],[],[a,{...b,transport_mode:'driving'}],[leg])).toEqual([])
    expect(plannedRouteSegments([],[],[a,{...b,latitude:null}],[leg])).toEqual([])
  })
  it('maps adopted transfer intent to the current adjacent formal endpoints and stops at the latest adopted pair',()=>{
    const a=stop('airport-a',1,120),b={...stop('airport-b',1,122),transport_mode:'transit' as const}
    const leg={mode:'flight',from_ref:a.ref,to_ref:b.ref,from_airport:'出发机场',to_airport:'到达机场'}
    const old:AgentPlan={goal:'机场间移动',scope:{description:'同日航段',segments:[{ref:'day1',day_id:1,day_number:1,replace_assignment_ids:[],insert_after_assignment_id:null,start_time:null,end_time:null,description:'同日航段'}]},
      activities:[a,b],constraints:[],evidence:[],tradeoffs:[],unknowns:[],explanation:'仅绘制交通意图',extensions:{transport_legs:[leg]}}
    const formal=[{...a,ref:'assignment:1'},{...b,ref:'assignment:2'}]
    expect(adoptedTransportSegments([],[old],formal)).toEqual([expect.objectContaining({mode:'flight',fromRef:'assignment:1',toRef:'assignment:2'})])
    expect(adoptedTransportSegments([],[{...old,extensions:{}},old],formal)).toEqual([])
    expect(adoptedTransportSegments([],[old],[formal[0],{...formal[1],longitude:124}])).toEqual([])
    expect(adoptedTransportSegments([],[old],[formal[0],{...formal[1],ref:'middle',latitude:null},formal[1]])).toEqual([])
  })
})
