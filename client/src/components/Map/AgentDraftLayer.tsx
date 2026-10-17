import React, { useEffect, useRef } from 'react'
import { CircleMarker, Polyline, Popup, Tooltip, useMap } from 'react-leaflet'
import type { DraftMap } from '../Planner/TripAssistant'
import { draftDayColor, draftRouteStyle } from '../Planner/assistantRoutes'

export function AgentDraftLayer({ draft }: { draft?: DraftMap }) {
  const map = useMap()
  const fitted = useRef<string|undefined>(undefined)
  const markers = useRef<Record<string,any>>({})
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map])
  useEffect(() => {
    const bounds = [...(draft?.points ?? []).map(p => [p.lat,p.lng] as [number,number]),
      ...(draft?.formalLines ?? []).flatMap(line=>line.map(([lng,lat])=>[lat,lng] as [number,number]))]
    if (!bounds.length) { fitted.current = undefined; return }
    const viewKey=draft?.viewKey??'default'
    if (fitted.current!==viewKey) { map.fitBounds(bounds, { paddingTopLeft: [(draft?.padding?.left ?? 0)+45, 80], paddingBottomRight: [(draft?.padding?.right ?? 0)+45, 45], maxZoom: 14 }); fitted.current = viewKey }
    if (!draft) return
    const selected = draft.points.find(p => p.ref === draft.focus)
    if (selected) { map.flyTo([selected.lat, selected.lng], 15); markers.current[selected.ref]?.openPopup() }
  }, [map, draft?.focus, draft?.version, draft?.viewKey])
  return <>{draft?.formalSegments?draft.formalSegments.flatMap(s=>s.lines.map((line,i)=><Polyline key={`formal:${s.dayNumber}:${s.fromRef}:${s.toRef}:${i}`} positions={line.map(([lng,lat])=>[lat,lng])} pathOptions={draftRouteStyle(s,true)} bubblingMouseEvents={false}><Tooltip sticky>{s.label}</Tooltip><Popup>{s.label}</Popup></Polyline>))
    :draft?.formalLines?.map((line,i)=><Polyline key={`formal-${i}`} positions={line.map(([lng,lat])=>[lat,lng])} pathOptions={{color:'#28667f',weight:5,opacity:.9}}/>)}
    {draft?.segments?draft.segments.flatMap(s=>s.lines.map((line,i)=><Polyline key={`${s.dayNumber}:${s.fromRef}:${s.toRef}:${i}`} positions={line.map(([lng,lat])=>[lat,lng])} pathOptions={draftRouteStyle(s)} bubblingMouseEvents={false}><Tooltip sticky>{s.label}</Tooltip><Popup>{s.label}</Popup></Polyline>))
      :draft?.lines.map((line, i) => <Polyline key={i} positions={line.map(([lng, lat]) => [lat, lng])} pathOptions={{ color: draft.adopted ? '#28667f' : '#60a5bd', weight: 5, opacity: draft.adopted ? .9 : .6, dashArray: draft.adopted ? undefined : '8 5' }} />)}
    {draft?.points.map(p => <CircleMarker key={p.ref} ref={node=>{if(node)markers.current[p.ref]=node;else delete markers.current[p.ref]}} center={[p.lat, p.lng]} radius={draft?.focus===p.ref?12:9} pathOptions={{ color: draftDayColor(p.dayNumber), fillColor: '#b8dce9', fillOpacity: .8, weight: draft?.focus===p.ref?3:2 }}><Tooltip direction={p.labelDirection??'top'}><span>{p.label}<br/>{p.name}</span></Tooltip><Popup><strong>{p.label} {p.name}</strong><p>{p.notes}</p></Popup></CircleMarker>)}
  </>
}

export function useAgentDraftGL(map: any, ready: boolean, draft?: DraftMap, popupFactory?:()=>any) {
  const fitted = useRef<string|undefined>(undefined)
  useEffect(() => {
    if (!map || !ready) return
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map, ready])
  useEffect(() => {
    if (!map || !ready) return
    const data = { type: 'FeatureCollection', features: [
      ...(draft?.points ?? []).map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { name: `${p.label}\n${p.name}`, notes:p.notes, ref: p.ref, color:draftDayColor(p.dayNumber), labelDirection:p.labelDirection??'top' } })),
      ...(draft?.formalSegments?draft.formalSegments.flatMap(s=>s.lines.map(line=>({type:'Feature',geometry:{type:'LineString',coordinates:line},properties:{formal:true,schematic:!!s.schematic,mode:s.mode,color:draftDayColor(s.dayNumber),name:s.label}})))
        :(draft?.formalLines ?? []).map(line=>({type:'Feature',geometry:{type:'LineString',coordinates:line},properties:{formal:true}}))),
      ...(draft?.segments?draft.segments.flatMap(s=>s.lines.map(line=>({type:'Feature',geometry:{type:'LineString',coordinates:line},properties:{formal:false,schematic:!!s.schematic,mode:s.mode,color:draftDayColor(s.dayNumber),name:s.label}})))
        :(draft?.lines ?? []).map(line => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {formal:!!draft?.adopted} }))),
    ] }
    const apply = () => {
      if (!map.isStyleLoaded()) return
      if (!map.getSource('agent-draft')) map.addSource('agent-draft', { type: 'geojson', data })
      else map.getSource('agent-draft').setData(data)
      if (!map.getLayer('agent-draft-lines')) map.addLayer({ id: 'agent-draft-lines', type: 'line', source: 'agent-draft', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#60a5bd', 'line-width': 5, 'line-opacity': .6, 'line-dasharray': [2, 1] } })
      map.setFilter('agent-draft-lines',['all',['==','$type','LineString'],['!=','schematic',true]])
      map.setPaintProperty('agent-draft-lines','line-color',['coalesce',['get','color'],['case',['==',['get','formal'],true],'#28667f','#60a5bd']])
      map.setPaintProperty('agent-draft-lines','line-opacity',['case',['==',['get','formal'],true],.9,.6])
      map.setPaintProperty('agent-draft-lines','line-dasharray',['case',['==',['get','formal'],true],['literal',[1,0]],['literal',[2,1]]])
      if(!map.getLayer('agent-draft-transfers'))map.addLayer({id:'agent-draft-transfers',type:'line',source:'agent-draft',filter:['all',['==','$type','LineString'],['==','schematic',true]],paint:{'line-color':['get','color'],'line-width':3,'line-opacity':.85,
        'line-dasharray':['case',['==',['get','mode'],'flight'],['literal',[1,3]],['literal',[4,2,1,2]]]}})
      if (!map.getLayer('agent-draft-points')) map.addLayer({ id: 'agent-draft-points', type: 'circle', source: 'agent-draft', filter: ['==', '$type', 'Point'], paint: { 'circle-color': '#b8dce9', 'circle-radius': 9, 'circle-stroke-color': '#397b94', 'circle-stroke-width': 2 } })
      map.setPaintProperty('agent-draft-points','circle-stroke-color',['coalesce',['get','color'],'#397b94'])
      if (!map.getLayer('agent-draft-labels')) map.addLayer({ id: 'agent-draft-labels', type: 'symbol', source: 'agent-draft', filter: ['==', '$type', 'Point'], layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.5] }, paint: { 'text-color': '#204e60', 'text-halo-color': '#fff', 'text-halo-width': 2 } })
      map.setLayoutProperty('agent-draft-labels','text-allow-overlap',false)
      map.setLayoutProperty('agent-draft-labels','text-anchor',['case',['==',['get','labelDirection'],'bottom'],'top','bottom'])
      map.setLayoutProperty('agent-draft-labels','text-offset',['case',['==',['get','labelDirection'],'bottom'],['literal',[0,1.5]],['literal',[0,-1.5]]])
    }
    apply(); map.on('styledata', apply)
    const bounds = [...(draft?.points ?? []).map(p=>[p.lng,p.lat]),...(draft?.formalLines ?? []).flat()]
    const viewKey=draft?.viewKey??'default'
    if (bounds.length && fitted.current!==viewKey) {
      const xs = bounds.map(p=>p[0]), ys = bounds.map(p=>p[1])
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { left: (draft.padding?.left ?? 0)+45, right: (draft.padding?.right ?? 0)+45, top: 80, bottom: 45 }, maxZoom: 14 }); fitted.current = viewKey
    }
    if (!bounds.length) fitted.current = undefined
    return () => { map.off('styledata', apply) }
  }, [map, ready, draft])
  useEffect(() => {
    const p = draft?.points.find(p => p.ref === draft.focus)
    if (map && ready && p) map.flyTo({ center: [p.lng, p.lat], zoom: 15 })
  }, [map, ready, draft?.focus])
  useEffect(()=>{
    if(!map||!ready||!popupFactory)return
    let popup:any
    const open=(event:any)=>{
      const properties=event.features?.[0]?.properties
      if(!properties?.name)return
      popup?.remove()
      const body=document.createElement('div')
      body.style.whiteSpace='pre-line'
      body.textContent=properties.name+(properties.notes?'\n'+properties.notes:'')
      popup=popupFactory().setLngLat(event.lngLat).setDOMContent(body).addTo(map)
    }
    map.on('click','agent-draft-lines',open);map.on('click','agent-draft-transfers',open);map.on('click','agent-draft-points',open)
    return()=>{map.off('click','agent-draft-lines',open);map.off('click','agent-draft-transfers',open);map.off('click','agent-draft-points',open);popup?.remove()}
  },[map,ready,popupFactory,draft?.viewKey])
}
