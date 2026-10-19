import {act,renderHook,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {useItineraryRoutes} from './useItineraryRoutes'
import type {RouteStop} from './assistantRoutes'
const api=vi.hoisted(()=>({post:vi.fn()}))
vi.mock('../../api/client',()=>({apiClient:api}))
const stop=(ref:string,lng:number,day=1):RouteStop=>({ref,name:ref,day_number:day,notes:'',latitude:31.3,longitude:lng,coordinate_system:'WGS84',transport_mode:'walking'})
it('queries exact final adjacent endpoints, draws returned roads, and reuses unchanged geometry after revision',async()=>{
  api.post.mockResolvedValue({data:{source:{type:'amap'},result:{duration_s:600,geometry:{coordinate_system:'WGS84',coordinates:[[[120.6,31.3],[120.605,31.303],[120.61,31.3]]]}}}})
  const {result,rerender}=renderHook(({stops})=>useItineraryRoutes(900,stops,[],1),{initialProps:{stops:[stop('a',120.6),stop('b',120.61),stop('c',120.7,2)]}})
  await waitFor(()=>expect(result.current.pending).toBe(0))
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(api.post.mock.calls[0][1]).toMatchObject({origin:{longitude:120.6,coordinate_system:'WGS84'},destination:{longitude:120.61}})
  expect(result.current.segments[0].lines[0]).toHaveLength(3)
  rerender({stops:[stop('renamed-a',120.6),stop('renamed-b',120.61)]})
  await waitFor(()=>expect(result.current.segments[0].fromRef).toBe('renamed-a'))
  expect(api.post).toHaveBeenCalledTimes(1)
})
it('keeps cross-city transfers schematic and never asks a road provider to draw a train or sea journey',async()=>{
  api.post.mockClear()
  const {result}=renderHook(()=>useItineraryRoutes(901,[stop('上海',121.5),stop('苏州',120.6)],[],1))
  await waitFor(()=>expect(result.current.segments).toHaveLength(1))
  expect(result.current.segments[0]).toMatchObject({mode:'transfer',schematic:true})
  expect(api.post).not.toHaveBeenCalled()
})
it('falls back to a labelled straight connector when the real road query fails',async()=>{
  api.post.mockRejectedValueOnce(new Error('upstream unavailable'))
  const {result}=renderHook(()=>useItineraryRoutes(902,[stop('出发',120.2),stop('到达',120.21)],[],1))
  await waitFor(()=>expect(result.current.pending).toBe(0))
  expect(result.current.failed).toBe(1)
  expect(result.current.segments[0]).toMatchObject({schematic:true,sourceLabel:'直线示意，路网路线暂不可用',lines:[[[120.2,31.3],[120.21,31.3]]]})
})
