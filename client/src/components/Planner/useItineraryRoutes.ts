import {useEffect,useState} from 'react'
import {gcj02ToWgs84} from '@trek/shared'
import {apiClient} from '../../api/client'
import {routeLines,type DraftRouteSegment,type RouteStop} from './assistantRoutes'

const point=(stop:RouteStop)=>stop.latitude==null||stop.longitude==null?undefined:
  stop.coordinate_system==='GCJ02'?gcj02ToWgs84(stop.latitude,stop.longitude):{lat:stop.latitude,lng:stop.longitude}
const cache=new Map<string,DraftRouteSegment>()

export function useItineraryRoutes(tripId:number,stops:RouteStop[],known:DraftRouteSegment[],selectedDay?:number){
  const [resolved,setResolved]=useState<{key:string;segments:DraftRouteSegment[];pending:number;failed:number}>({key:'',segments:[],pending:0,failed:0})
  const edges=stops.flatMap((to,index)=>{
    const from=stops[index-1],a=from&&point(from),b=point(to)
    if(!a||!b||from.day_number!==to.day_number||(selectedDay!=null&&to.day_number!==selectedDay)||known.some(s=>s.fromRef===from.ref&&s.toRef===to.ref))return []
    const meters=Math.hypot((a.lat-b.lat)*111320,(a.lng-b.lng)*111320*Math.cos(a.lat*Math.PI/180))
    if(meters<15)return []
    return [{from,to,a,b,meters,key:JSON.stringify([tripId,a,b,to.transport_mode??'walking'])}]
  })
  const key=JSON.stringify(edges.map(e=>[e.key,e.from.ref,e.to.ref,e.from.day_number]))
  useEffect(()=>{
    let cancelled=false,cursor=0,failed=0,pending=edges.length
    const segments:DraftRouteSegment[]=[]
    const publish=()=>{if(!cancelled)setResolved({key,segments:[...segments],pending,failed})}
    publish()
    const worker=async()=>{
      while(!cancelled&&cursor<edges.length){
        const edge=edges[cursor++],{from,to,a,b}=edge
        const base={dayNumber:to.day_number,fromRef:from.ref,toRef:to.ref,fromName:from.name,toName:to.name,mode:to.transport_mode??'walking'}
        try{
          if(edge.meters>50000){
            segments.push({...base,mode:'transfer',schematic:true,sourceLabel:'城际转场示意',lines:[[[a.lng,a.lat],[b.lng,b.lat]]]})
          }else{
            let segment=cache.get(edge.key)
            if(!segment){
              const {data}=await apiClient.post(`/agent/trips/${tripId}/routes`,{origin:{latitude:a.lat,longitude:a.lng,coordinate_system:'WGS84'},destination:{latitude:b.lat,longitude:b.lng,coordinate_system:'WGS84'},mode:base.mode},{timeout:30000})
              const lines=routeLines([{seq:0,kind:'source_available',payload:{capability:'routes',source_id:edge.key,data}}],[edge.key])
              if(!lines.length)throw new Error('路线暂无几何数据')
              segment={...base,sourceId:edge.key,lines,sourceLabel:data.source?.type==='amap'?'高德':'路线查询',durationMinutes:Math.ceil(data.result.duration_s/60)||undefined}
              cache.set(edge.key,segment)
            }
            segments.push({...segment,...base})
          }
        }catch{
          failed++
          segments.push({...base,schematic:true,sourceLabel:'直线示意，路网路线暂不可用',lines:[[[a.lng,a.lat],[b.lng,b.lat]]]})
        }
        pending--;publish()
      }
    }
    void Promise.all([worker(),worker()])
    return()=>{cancelled=true}
  },[key])
  return resolved.key===key?resolved:{segments:[],pending:edges.length,failed:0}
}
