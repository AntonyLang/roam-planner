import React from 'react'
import type { DraftMap } from '../Planner/TripAssistant'

export function AgentRouteLegend({draft,left=16}:{draft:DraftMap;left?:number}){
  const segments=[...(draft.segments??[]),...(draft.formalSegments??[])]
  const kinds=[
    {show:segments.some(s=>!s.schematic),label:'路网路线',dash:undefined},
    {show:segments.some(s=>s.mode==='train'),label:'铁路示意',dash:'12 6 2 6'},
    {show:segments.some(s=>s.mode==='flight'),label:'航段示意',dash:'1 9'},
  ].filter(kind=>kind.show)
  if(!kinds.length)return null
  return <div aria-label="地图路线图例" style={{position:'absolute',zIndex:800,top:72,left,maxWidth:'min(440px,calc(100% - 32px))',
    padding:'7px 10px',borderRadius:10,background:'var(--bg-primary)',color:'var(--text-secondary)',boxShadow:'0 1px 7px rgba(0,0,0,.14)',fontSize:12}}>
    <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>{kinds.map(kind=><span key={kind.label} style={{display:'inline-flex',alignItems:'center',gap:5}}><svg width="34" height="8" aria-hidden="true"><path d="M1 4H33" stroke="currentColor" strokeWidth="3" strokeDasharray={kind.dash}/></svg>{kind.label}</span>)}</div>
    <details key={draft.viewKey} style={{marginTop:5}}>
      <summary style={{cursor:'pointer'}}>路线详情 · {segments.length} 段</summary>
      <ol aria-label="当前地图路线" style={{margin:'8px 0 0',paddingLeft:20,maxHeight:'min(38vh,300px)',overflowY:'auto',lineHeight:1.6}}>
        {segments.map((segment,index)=><li key={`${segment.dayNumber}:${segment.fromRef}:${segment.toRef}:${index}`} style={{padding:'5px 2px'}}>{segment.label}</li>)}
      </ol>
    </details>
  </div>
}
