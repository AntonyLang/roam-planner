import { agentTransportLegSchema, gcj02ToWgs84, type AgentPlan, type AgentRailLeg, type AgentTransportLeg } from '@trek/shared'

export type RouteEvent = { seq:number; kind:string; payload:any }
export type DraftRouteSegment = { sourceId?:string; dayNumber:number; fromRef:string; toRef:string;
  fromName:string; toName:string; mode:string; durationMinutes?:number; schematic?:boolean; trainCode?:string; flightCode?:string;
  sourceConfirmed?:boolean; sourceLabel?:string; lines:number[][][] }
export type RailLeg = AgentRailLeg
export type TransportLeg = AgentTransportLeg
export type RouteStop = Pick<AgentPlan['activities'][number], 'ref'|'day_number'|'name'|'notes'|'latitude'|'longitude'|'coordinate_system'> & {transport_mode?:string}
export const draftDayColor = (day:number) => ['#397b94','#8b5eaa','#b76d31','#34846e','#aa526c'][(day-1)%5]

function routePoint(value:unknown, system:unknown):{lat:number;lng:number}|undefined {
  if(typeof value!=='string'||typeof system!=='string')return
  const parts=value.split(',')
  if(parts.length!==2||parts.some(p=>!p.trim()))return
  const [lng,lat]=parts.map(Number)
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return
  const normalized=system.replace(/-/g,'').toUpperCase()
  if(normalized==='GCJ02')return gcj02ToWgs84(lat,lng)
  if(normalized==='WGS84')return {lat,lng}
}
const located=(a:RouteStop)=>a.latitude==null||a.longitude==null?undefined:routePoint(`${a.longitude},${a.latitude}`,a.coordinate_system)
const distance=(a:{lat:number;lng:number}|undefined,b:{lat:number;lng:number}|undefined)=>a&&b?
  Math.hypot((a.lat-b.lat)*111320,(a.lng-b.lng)*111320*Math.cos(a.lat*Math.PI/180)):Infinity
const near=(a:{lat:number;lng:number}|undefined,b:{lat:number;lng:number}|undefined)=>distance(a,b)<=100

export function draftRouteStyle(segment:DraftRouteSegment,formal=false){
  return {color:draftDayColor(segment.dayNumber),weight:segment.schematic?3:5,opacity:formal?.9:.65,
    dashArray:segment.schematic?(segment.mode==='flight'?'1 9':'12 6 2 6'):formal?undefined:'8 5'}
}

// A queried route becomes itinerary geometry only when it joins consecutive
// stops in the planned direction and transport mode. Comparison routes stay out.
export function plannedRouteSegments(events:RouteEvent[],ids:string[],activities:RouteStop[],legs:TransportLeg[]=[]):DraftRouteSegment[] {
  const sources=events.filter(e=>e.kind==='source_available'&&e.payload.capability==='routes'&&ids.includes(e.payload.source_id)).reverse()
  const segments:DraftRouteSegment[]=[]
  for(const day of new Set(activities.map(a=>a.day_number))){
    const stops=activities.filter(a=>a.day_number===day)
    for(let i=1;i<stops.length;i++){
      const from=stops[i-1],to=stops[i]
      const leg=legs.find(l=>l.from_ref===from.ref&&l.to_ref===to.ref)
      if(leg){
        const start=located(from),end=located(to)
        const receipt=events.find(e=>e.kind==='source_available'&&e.payload.capability==='transport'&&e.payload.source_id===leg.source_id)
        const data=receipt?.payload.data?.data??receipt?.payload.data
        const confirmed=!!(leg.mode==='train'&&data?.result?.date===leg.date&&data.result.items?.some((t:any)=>t.train_code===leg.train_code&&t.start_time===leg.departure_time&&t.arrive_time===leg.arrival_time&&
          t.from_station?.replace(/站$/,'')===leg.from_station.replace(/站$/,'')&&t.to_station?.replace(/站$/,'')===leg.to_station.replace(/站$/,'')))
        if(start&&end&&to.transport_mode==='transit'){
          const minutes=(s:string)=>s.split(':').reduce((n,v,i)=>n+Number(v)*(i?1:60),0)
          const duration=leg.mode==='train'&&confirmed?minutes(leg.arrival_time)-minutes(leg.departure_time):0
          segments.push({sourceId:leg.source_id,dayNumber:day,fromRef:from.ref,toRef:to.ref,
            fromName:leg.mode==='train'?leg.from_station:leg.from_airport,toName:leg.mode==='train'?leg.to_station:leg.to_airport,
            mode:leg.mode,schematic:true,sourceConfirmed:confirmed,sourceLabel:confirmed?'铁路查询':'规划中的交通意图',
            ...(leg.mode==='train'?{trainCode:leg.train_code,...(duration>0?{durationMinutes:duration}:{})}:{flightCode:leg.flight_code}),
            lines:[[[start.lng,start.lat],[end.lng,end.lat]]]})
        }
        // A missing railway receipt never falls back to a road route.
        continue
      }
      // Legacy drafts sometimes put the complete train journey at its departure
      // point. That point is not the origin of the destination-city taxi leg.
      if(/乘.{0,12}(?:高铁|动车|火车)|[GDC]\d{2,}/.test(from.name+' '+from.notes)&&!legs.some(l=>l.to_ref===from.ref))continue
      const mode=to.transport_mode
      if(!mode)continue
      // Nearby POIs may share the tolerance window; prefer their actual queried endpoints.
      const match=sources.map(e=>{
        const data=e.payload.data,route=data?.result
        const system=data?.coordinate_system??route?.geometry?.coordinate_system
        return {event:e,mode:route?.mode,fromDistance:distance(located(from),routePoint(route?.origin,system)),toDistance:distance(located(to),routePoint(route?.destination,system))}
      }).filter(route=>route.mode===mode&&route.fromDistance<=100&&route.toDistance<=100)
        .sort((a,b)=>(a.fromDistance+a.toDistance)-(b.fromDistance+b.toDistance))[0]?.event
      if(!match)continue
      const lines=routeLines([match],[match.payload.source_id])
      if(!lines.length)continue
      const duration=match.payload.data.result.duration_s
      segments.push({sourceId:match.payload.source_id,dayNumber:day,fromRef:from.ref,toRef:to.ref,
        fromName:from.name,toName:to.name,mode,
        sourceLabel:({'amap':'高德','geoapify':'Geoapify / OpenStreetMap'} as Record<string,string>)[match.payload.data.source?.type]??'路线查询',
        ...(duration>0?{durationMinutes:Math.ceil(duration/60)}:{}),lines})
    }
  }
  return segments
}

// Adopted transfer intent is matched to consecutive formal stops; a later
// adopted pair without a transfer also prevents older metadata from resurfacing.
export function adoptedTransportSegments(events:RouteEvent[],plans:AgentPlan[],activities:RouteStop[]):DraftRouteSegment[]{
  const segments:DraftRouteSegment[]=[]
  for(let i=1;i<activities.length;i++){
    const from=activities[i-1],to=activities[i]
    if(from.day_number!==to.day_number||to.transport_mode!=='transit')continue
    for(const plan of plans){
      const index=plan.activities.findIndex((a,j)=>j<plan.activities.length-1&&a.day_number===from.day_number&&a.name===from.name&&near(located(a),located(from))&&
        plan.activities[j+1].day_number===to.day_number&&plan.activities[j+1].name===to.name&&near(located(plan.activities[j+1]),located(to)))
      if(index<0)continue
      const originalFrom=plan.activities[index],originalTo=plan.activities[index+1]
      const legs=Array.isArray(plan.extensions.transport_legs)?plan.extensions.transport_legs:[]
      const parsed=legs.map(leg=>agentTransportLegSchema.safeParse(leg)).find(result=>result.success&&result.data.from_ref===originalFrom.ref&&result.data.to_ref===originalTo.ref)
      if(parsed?.success)segments.push(...plannedRouteSegments(events,[],[from,to],[{...parsed.data,from_ref:from.ref,to_ref:to.ref}]))
      break
    }
  }
  return segments
}

export function changesRouteGeometry(event:RouteEvent):boolean {
  const change=event.payload?.payload
  if(event.kind!=='trip_changed'||change?.origin==='agent')return false
  const fields:Record<string,string[]>={
    places:['latitude','longitude'], day_assignments:['place_id','day_id','order_index','incoming_leg_transport_mode'],
    days:['day_number','date'], trips:['start_date','end_date'],
  }
  const keys=fields[change?.table]
  if(!keys)return false
  if(!change.before||!change.after)return true
  return keys.some(key=>change.before[key]!==change.after[key])
}

export function routeLines(events:RouteEvent[],ids:string[]):number[][][] {
  return events.filter(e=>e.kind==='source_available'&&e.payload.capability==='routes'&&ids.includes(e.payload.source_id)).flatMap(e=>{
    const geometry=e.payload.data?.result?.geometry
    return (geometry?.coordinates??[]).map((line:number[][])=>line.map(([lng,lat])=>{
      const p=geometry.coordinate_system?.replace('-','')==='GCJ02'?gcj02ToWgs84(lat,lng):{lat,lng}
      return [p.lng,p.lat]
    }))
  })
}

export function adoptedRoutePlan(events:RouteEvent[]):AgentPlan|undefined {
  const adoption=[...events].reverse().find(e=>e.kind==='trip_changed'&&e.payload.payload?.table==='agent_candidates'&&e.payload.payload?.after?.adopted_at)
  if(!adoption||events.some(e=>e.seq>adoption.seq&&changesRouteGeometry(e)))return
  const row=adoption.payload.payload.after
  const saved=[...events].reverse().find(e=>e.kind==='candidate_saved'&&e.payload.candidate_id===row.candidate_id&&e.payload.candidate_version===row.version)
  return saved?.payload.plan
}

export function adoptedRouteIds(events:RouteEvent[]):string[] {
  const extensions=adoptedRoutePlan(events)?.extensions
  const ids=extensions?.route_source_ids??(extensions?.map_draft as {route_source_ids?:unknown}|undefined)?.route_source_ids
  return Array.isArray(ids)?ids.filter((id):id is string=>typeof id==='string'):[]
}
