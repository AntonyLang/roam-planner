import React from 'react'
import {render,renderHook,screen} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {AgentDraftLayer,useAgentDraftGL} from './AgentDraftLayer'
import type {DraftMap} from '../Planner/TripAssistant'

const map=vi.hoisted(()=>({getContainer:()=>document.createElement('div'),invalidateSize:vi.fn(),fitBounds:vi.fn(),flyTo:vi.fn(),
  resize:vi.fn(),isStyleLoaded:()=>true,getSource:vi.fn(),addSource:vi.fn(),getLayer:()=>undefined,addLayer:vi.fn(),
  setFilter:vi.fn(),setPaintProperty:vi.fn(),setLayoutProperty:vi.fn(),on:vi.fn(),off:vi.fn()}))
vi.mock('react-leaflet',()=>({useMap:()=>map,CircleMarker:()=>null,Tooltip:()=>null,Popup:()=>null,
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
