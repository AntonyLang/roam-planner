import React from 'react'
import {render,renderHook,screen} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {AgentDraftLayer,useAgentDraftGL} from './AgentDraftLayer'
import type {DraftMap} from '../Planner/TripAssistant'

const map=vi.hoisted(()=>({getContainer:()=>document.createElement('div'),invalidateSize:vi.fn(),fitBounds:vi.fn(),flyTo:vi.fn(),
  resize:vi.fn(),isStyleLoaded:()=>true,getSource:vi.fn(),addSource:vi.fn(),getLayer:()=>undefined,addLayer:vi.fn(),
  setFilter:vi.fn(),setPaintProperty:vi.fn(),setLayoutProperty:vi.fn(),on:vi.fn(),off:vi.fn()}))
vi.mock('react-leaflet',()=>({useMap:()=>map,Marker:React.forwardRef(({icon,title}:any,_ref)=><button data-testid="stop-marker" title={title} dangerouslySetInnerHTML={{__html:icon.options.html}}/>),Tooltip:()=>null,Popup:()=>null,
  Polyline:({pathOptions,positions,bubblingMouseEvents}:any)=><div data-testid="route-line" data-dash={pathOptions.dashArray??'solid'} data-weight={pathOptions.weight} data-points={positions.length} data-map-bubbling={String(bubblingMouseEvents)}/>}))
beforeEach(()=>{
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
})
afterEach(()=>vi.unstubAllGlobals())
function draft():DraftMap{
  const common={dayNumber:1,fromRef:'a',toRef:'b',fromName:'起点',toName:'终点',label:'说明',lines:[[[120,36],[121,37]]]}
  return {points:[],lines:[],formalLines:common.lines,version:'1',formalSegments:[
    {...common,mode:'walking',sourceId:'real-road'},
    {...common,mode:'train',schematic:true,sourceConfirmed:false},
    {...common,mode:'flight',schematic:true,sourceConfirmed:false},
  ]}
}
it('keeps adopted road, rail and flight lines visually distinct in Leaflet',()=>{
  render(<AgentDraftLayer draft={draft()}/>)
  expect(screen.getAllByTestId('route-line').map(el=>[el.dataset.dash,el.dataset.weight])).toEqual([
    ['solid','5'],['12 6 2 6','3'],['1 9','3'],
  ])
  expect(screen.getAllByTestId('route-line').every(el=>el.dataset.mapBubbling==='false')).toBe(true)
})
it('keeps transfer intent separate from road geometry in the GL source and layers',()=>{
  renderHook(()=>useAgentDraftGL(map,true,draft()))
  const data=map.addSource.mock.calls.find(([id])=>id==='agent-draft')?.[1].data
  expect(data.features.map((feature:any)=>[feature.properties.mode,feature.properties.schematic])).toEqual([
    ['walking',false],['train',true],['flight',true],
  ])
  expect(map.setFilter).toHaveBeenCalledWith('agent-draft-lines',['all',['==','$type','LineString'],['!=','schematic',true]])
  const transfers=map.addLayer.mock.calls.map(([layer])=>layer).find(layer=>layer.id==='agent-draft-transfers')
  expect(transfers.filter).toEqual(['all',['==','$type','LineString'],['==','schematic',true]])
  expect(transfers.paint['line-width']).toBe(3)
  expect(transfers.paint['line-dasharray']).toContainEqual(['literal',[1,3]])
  expect(transfers.paint['line-dasharray']).toContainEqual(['literal',[4,2,1,2]])
})

it('shows stop order on the marker before opening a popup in both renderers',()=>{
  const value={...draft(),points:[{ref:'a',name:'酒店',lat:36,lng:120,label:'第2天 · 3',orderLabel:'D2·3',notes:'休息',dayNumber:2}]}
  const {rerender}=render(<AgentDraftLayer draft={value}/>)
  expect(screen.getByTestId('stop-marker')).toHaveTextContent('D2·3')
  expect(screen.getByTestId('stop-marker')).toHaveAttribute('title','第2天 · 3 酒店')
  rerender(<AgentDraftLayer draft={{...value,points:[{...value.points[0],orderLabel:'3'}]}}/>)
  expect(screen.getByTestId('stop-marker')).toHaveTextContent('3')
  renderHook(()=>useAgentDraftGL(map,true,value))
  const data=map.addSource.mock.calls.find(([id])=>id==='agent-draft')?.[1].data
  expect(data.features[0].properties.orderLabel).toBe('D2·3')
  const order=map.addLayer.mock.calls.map(([layer])=>layer).find(layer=>layer.id==='agent-draft-order')
  expect(order.layout['text-field']).toEqual(['get','orderLabel'])
  expect(order.layout['text-allow-overlap']).toBe(true)
})

it('fits a changed day or overview without returning to the previous focused stop',()=>{
  const value={...draft(),focus:'a',viewKey:'day-1',points:[{ref:'a',name:'车站',lat:36,lng:120,label:'第1天 · 1',orderLabel:'1',notes:'',dayNumber:1}]}
  const {rerender}=render(<AgentDraftLayer draft={value}/>)
  expect(map.flyTo).toHaveBeenCalledTimes(1)
  rerender(<AgentDraftLayer draft={{...value,viewKey:'all-days'}}/>)
  expect(map.fitBounds).toHaveBeenCalledTimes(2)
  expect(map.flyTo).toHaveBeenCalledTimes(1)
  rerender(<AgentDraftLayer draft={{...value,viewKey:'all-days',version:'2'}}/>)
  expect(map.flyTo).toHaveBeenCalledTimes(1)
})

it('keeps a sidebar-selected viewport when formal lines change day, then permits the next day fit',()=>{
  const value={...draft(),viewKey:'all-days'}
  const next={...value,viewKey:'day-1'}
  const {rerender}=render(<AgentDraftLayer draft={value}/>)
  map.fitBounds.mockClear()
  rerender(<AgentDraftLayer draft={next} holdViewport/>)
  rerender(<AgentDraftLayer draft={next}/>)
  expect(map.fitBounds).not.toHaveBeenCalled()
  rerender(<AgentDraftLayer draft={{...next,viewKey:'day-2'}}/>)
  expect(map.fitBounds).toHaveBeenCalledTimes(1)
})

it('keeps the same viewport priority for GL formal lines',()=>{
  const value={...draft(),viewKey:'all-days'}
  const next={...value,viewKey:'day-1'}
  const {rerender}=renderHook(({draft,hold})=>useAgentDraftGL(map,true,draft,undefined,hold),{initialProps:{draft:value,hold:false}})
  map.fitBounds.mockClear()
  rerender({draft:next,hold:true})
  rerender({draft:next,hold:false})
  expect(map.fitBounds).not.toHaveBeenCalled()
  rerender({draft:{...next,viewKey:'day-2'},hold:false})
  expect(map.fitBounds).toHaveBeenCalledTimes(1)
})
