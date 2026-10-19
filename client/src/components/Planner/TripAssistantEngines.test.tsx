import {act,fireEvent,render,renderHook,screen,waitFor} from '../../../tests/helpers/render'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {TripAssistant,useTripAssistant} from './TripAssistant'
import {useTripStore} from '../../store/tripStore'

const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),put:vi.fn()}))
const agent=vi.hoisted(()=>({get:vi.fn(),send:vi.fn(),stop:vi.fn(),resume:vi.fn(),travel:undefined as any,entries:[] as any[]}))
let candidateRows:any[]=[]
vi.mock('../../api/client',()=>({apiClient:api}))
vi.mock('../../agent/durable',()=>({
  agentApi:{get:agent.get},messageText:()=>'',
  useDurableConversation:(id?:string)=>({entries:agent.entries,tools:[],children:[],running:false,stopState:'running',error:'',
    travel:id?agent.travel:undefined,send:agent.send,stop:agent.stop,resume:agent.resume}),
}))
beforeEach(()=>{
  useTripStore.setState({trip:null,days:[],selectedDayId:null,assignments:{},places:[]})
  api.get.mockReset();api.post.mockReset();agent.get.mockReset();agent.send.mockReset()
  candidateRows=[]
  api.get.mockImplementation((path:string)=>path.includes('/candidates')
    ?Promise.resolve({data:{candidates:candidateRows}})
    :path.includes('/confirmations')?Promise.resolve({data:{keys:[]}})
    :Promise.resolve({data:{version:0,activities:[]}}))
  agent.get.mockImplementation(async(path:string)=>({data:{conversation_id:Number(/trips\/(\d+)/.exec(path)![1])+100}}))
  agent.send.mockResolvedValue(undefined)
  agent.entries=[]
  agent.travel={draft:{version:1,activities:[{ref:'a',name:'栈桥',day_number:1,latitude:36,longitude:120,coordinate_system:'WGS84',notes:''}]},receipts:[]}
})
afterEach(()=>vi.restoreAllMocks())

function plan(){
  return {activities:[
    {ref:'a',name:'栈桥',day_number:1,latitude:36,longitude:120,coordinate_system:'WGS84',transport_mode:'walking',notes:''},
    {ref:'b',name:'五四广场',day_number:1,latitude:36,longitude:120.01,coordinate_system:'WGS84',transport_mode:'walking',notes:''},
  ],extensions:{}}
}
function candidate(id:string,version:number,routePlan=plan()){
  return {candidate_id:id,candidate_version:version,plan:routePlan,review:{},status:'saved'}
}
function deferred<T>(){
  let resolve!:(value:T)=>void
  const promise=new Promise<T>(r=>{resolve=r})
  return {promise,resolve}
}
function adoptedRoadFixture(adopted=true){
  const routePlan=plan()
  routePlan.extensions={route_source_ids:['tool:road']}
  const saved=candidate('candidate-3',6,routePlan)
  candidateRows=[{...saved,adopted_at:adopted?'2026-10-18T10:00:00.000Z':null}]
  const places=routePlan.activities.map((a,i)=>({id:i+1,name:a.name,lat:a.latitude,lng:a.longitude,transport_mode:a.transport_mode}))
  const assignments={'10':places.map((p,i)=>({id:i+11,day_id:10,place_id:p.id,order_index:i,incoming_leg_transport_mode:'walking',notes:''}))}
  useTripStore.setState({trip:{id:3} as any,days:[{id:10,day_number:1},{id:20,day_number:2}] as any,places:places as any,assignments:assignments as any})
  agent.travel={draft:{version:5,activities:routePlan.activities},candidate:saved,receipts:[{seq:1,kind:'tool_result',payload:{
    call_id:'road',remote_name:'query_routes',success:true,original:{coordinate_system:'WGS84',result:{mode:'walking',origin:'120,36',destination:'120.01,36',duration_s:600,
      geometry:{type:'MultiLineString',coordinate_system:'WGS84',coordinates:[[[120,36],[120.005,36.002],[120.01,36]]]}}}}}]}
  return {places,assignments}
}
function Planner({tripId}:{tripId:number}){
  const state=useTripAssistant(tripId)
  return <><TripAssistant agent={state}/><output data-testid="adopted">{String(state.adopted)}</output>
    <output data-testid="candidate-id">{state.candidate?.candidate_id??'none'}</output></>
}

it('labels stops by date and filters the map using the native selected day',async()=>{
  useTripStore.setState({trip:{id:3} as any,days:[{id:10,day_number:1,date:'2026-10-12'},{id:11,day_number:2,date:'2026-10-13'}] as any})
  agent.travel={draft:{version:1,activities:[
      {ref:'a',name:'栈桥',day_number:1,latitude:36,longitude:120,coordinate_system:'WGS84',notes:''},
      {ref:'b',name:'八大关',day_number:2,latitude:36.1,longitude:120.1,coordinate_system:'WGS84',notes:''},
    ]},receipts:[]}
  const {result,unmount}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.map.points).toHaveLength(2))
  expect(result.current.map.points.map(p=>p.label)).toEqual(['2026-10-12 · 1','2026-10-13 · 1'])
  expect(result.current.map.points.map(p=>p.orderLabel)).toEqual(['D1·1','D2·1'])
  const initialKey=result.current.map.viewKey
  act(()=>useTripStore.setState({selectedDayId:11}))
  expect(result.current.map.points.map(p=>p.name)).toEqual(['八大关'])
  expect(result.current.map.points.map(p=>p.orderLabel)).toEqual(['1'])
  expect(result.current.map.viewKey).not.toBe(initialKey)
  act(()=>useTripStore.setState({selectedDayId:null}))
  expect(result.current.map.points).toHaveLength(2)
  unmount()
})

it('uses the fixed trip conversation and sends additions to the main Agent',async()=>{
  const {result,unmount}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.session).toBe('103'))
  expect(result.current.map.points[0].name).toBe('栈桥')
  await act(async()=>{await result.current.send('修改这版草稿')})
  expect(agent.send).toHaveBeenCalledWith('修改这版草稿')
  expect(api.post.mock.calls.filter(([path])=>path.includes('/adopt'))).toHaveLength(0)
  unmount()
})

it('keeps rail order when a stop has no coordinates and shows every coincident visit number',async()=>{
  useTripStore.setState({trip:{id:3} as any,days:[{id:10,day_number:1},{id:11,day_number:2}] as any})
  const located={latitude:36,longitude:120,coordinate_system:'WGS84',notes:''}
  agent.travel={draft:{version:1,activities:[
    {ref:'a',name:'酒店',day_number:1,...located},
    {ref:'b',name:'待选午餐',day_number:1,notes:''},
    {ref:'c',name:'返回酒店',day_number:1,...located},
    {ref:'d',name:'酒店早餐',day_number:2,...located},
  ]},receipts:[]}
  const {result,unmount}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.map.points).toHaveLength(3))
  expect(result.current.map.points[0].orderLabel).toBe('D1·1\nD1·3\nD2·1')
  act(()=>useTripStore.setState({selectedDayId:10}))
  expect(result.current.map.points.map(p=>p.orderLabel)).toEqual(['1\n3','1\n3'])
  unmount()
})

it('opens the new trip main conversation when the selected trip changes',async()=>{
  const {result,rerender,unmount}=renderHook(({tripId})=>useTripAssistant(tripId),{initialProps:{tripId:3}})
  await waitFor(()=>expect(result.current.activities).toHaveLength(1))
  rerender({tripId:4})
  await waitFor(()=>expect(result.current.session).toBe('104'))
  expect(agent.get).toHaveBeenCalledWith('/v1/trips/4/conversation',expect.objectContaining({signal:expect.any(AbortSignal)}))
  expect(api.get).toHaveBeenLastCalledWith('/agent/drafts/104',expect.anything())
  unmount()
})

it('resolves a queried hotel reference instead of matching missing native IDs',async()=>{
  agent.travel={draft:{version:1,activities:[
      {ref:'station',name:'青岛站',day_number:1}, {ref:'hotel',name:'查询结果中的酒店',day_number:1},
    ],plan:{extensions:{native_operations:[{name:'create_accommodation',arguments:{place_ref:'hotel'}}]}}},receipts:[]}
  const {result,unmount}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.accommodations).toHaveLength(1))
  expect(result.current.accommodations[0]).toMatchObject({name:'查询结果中的酒店',ref:'hotel'})
  unmount()
})

it('restores the adopted state for the exact saved version on reload without offering another adoption',async()=>{
  const routePlan=plan(), saved=candidate('candidate-3',6,routePlan)
  agent.entries=[{id:1,kind:'pi.assistant',model:[{role:'assistant',content:'规划完成'}]}]
  agent.travel={draft:{version:5,activities:routePlan.activities},candidate:saved,receipts:[]}
  candidateRows=[{...saved,adopted_at:'2026-10-18T10:00:00.000Z'}]
  render(<Planner tripId={3}/>)
  await waitFor(()=>expect(screen.getByTestId('adopted')).toHaveTextContent('true'))
  expect(screen.queryByRole('button',{name:'采用到旅程'})).not.toBeInTheDocument()
  expect(screen.getByText('已更新旅程，可以在每日安排和地图中继续编辑。')).toBeInTheDocument()
  expect(api.post.mock.calls.filter(([path])=>path.includes('/adopt'))).toHaveLength(0)
})

it('restores adopted road geometry from actual records and the current formal graph without a journal event',async()=>{
  const {assignments}=adoptedRoadFixture()
  const {result,rerender}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.map.formalSegments).toHaveLength(1))
  expect(result.current.map.lines).toHaveLength(0)
  expect(result.current.map.formalSegments?.[0]).toMatchObject({fromRef:'assignment:11',toRef:'assignment:12',mode:'walking'})
  expect(result.current.events.some(e=>e.kind==='trip_changed')).toBe(false)
  act(()=>useTripStore.setState({assignments:{'10':assignments['10'].map(a=>({...a,notes:'只修改说明',assignment_time:'12:00'}))} as any}))
  expect(result.current.map.formalSegments).toHaveLength(1)
  // Starting the next draft must not erase the route already adopted into TREK.
  agent.travel={...agent.travel,draft:{version:6,activities:[]}}
  rerender()
  await waitFor(()=>expect(result.current.candidate).toBeUndefined())
  await waitFor(()=>expect(result.current.map.formalSegments).toHaveLength(1))
  act(()=>useTripStore.setState({selectedDayId:20}))
  expect(result.current.map.formalSegments).toHaveLength(0)
})

it.each(['coordinates','order','mode','unlocated-stop'] as const)('removes adopted road geometry when the formal %s changes',async(change)=>{
  const {places,assignments}=adoptedRoadFixture()
  const {result}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.map.formalSegments).toHaveLength(1))
  act(()=>{
    if(change==='coordinates')useTripStore.setState({places:places.map(p=>p.id===2?{...p,lat:36.1}:p) as any})
    if(change==='order')useTripStore.setState({assignments:{'10':assignments['10'].map(a=>({...a,order_index:1-a.order_index}))} as any})
    if(change==='mode')useTripStore.setState({assignments:{'10':assignments['10'].map(a=>a.id===12?{...a,incoming_leg_transport_mode:'driving'}:a)} as any})
    if(change==='unlocated-stop')useTripStore.setState({assignments:{'10':[assignments['10'][0],{id:13,day_id:10,place_id:3,order_index:.5},assignments['10'][1]]} as any})
  })
  expect(result.current.map.formalSegments).toHaveLength(0)
})

it('does not promote a saved but unadopted route into the formal map',async()=>{
  adoptedRoadFixture(false)
  const {result}=renderHook(()=>useTripAssistant(3))
  await waitFor(()=>expect(result.current.adoptionReady).toBe(true))
  expect(result.current.map.segments).toHaveLength(1)
  expect(result.current.map.formalSegments).toHaveLength(0)
})

it('uses the current candidate version and lets a newer draft return to editable preview',async()=>{
  const old=candidate('candidate-3',6)
  agent.entries=[{id:1,kind:'pi.assistant',model:[{role:'assistant',content:'规划完成'}]}]
  agent.travel={draft:{version:5,activities:old.plan.activities},candidate:old,receipts:[]}
  candidateRows=[{...old,adopted_at:'2026-10-18T10:00:00.000Z'}]
  const view=render(<Planner tripId={3}/>)
  await waitFor(()=>expect(screen.getByTestId('adopted')).toHaveTextContent('true'))

  const next=candidate('candidate-3',7)
  const other=candidate('other-candidate',7)
  agent.travel={draft:{version:6,activities:next.plan.activities},candidate:next,receipts:[]}
  candidateRows=[{...old,adopted_at:'2026-10-18T10:00:00.000Z'},
    {...other,adopted_at:'2026-10-18T10:00:00.000Z'},next]
  view.rerender(<Planner tripId={3}/>)
  await waitFor(()=>expect(screen.getByTestId('adopted')).toHaveTextContent('false'))
  expect(screen.getByRole('button',{name:'采用到旅程'})).toBeInTheDocument()
  expect(screen.queryByText(/候选行程/)).not.toBeInTheDocument()

  agent.travel={draft:{version:7,activities:next.plan.activities.map((item:any)=>({...item,notes:'我刚编辑的草稿'}))},candidate:next,receipts:[]}
  view.rerender(<Planner tripId={3}/>)
  await waitFor(()=>expect(screen.getByTestId('candidate-id')).toHaveTextContent('none'))
  expect(screen.getByTestId('adopted')).toHaveTextContent('false')
  expect(screen.queryByRole('button',{name:'采用到旅程'})).not.toBeInTheDocument()
  expect(screen.queryByText('我刚编辑的草稿')).not.toBeInTheDocument()
  expect(screen.queryByText(/行程草稿/)).not.toBeInTheDocument()
  expect(api.post.mock.calls.filter(([path])=>path.includes('/adopt'))).toHaveLength(0)
})

it('does not let a successful adoption response overwrite a newer candidate version',async()=>{
  useTripStore.setState({trip:{id:3} as any})
  const hydrate=vi.spyOn(useTripStore.getState(),'hydrateActiveTrip').mockResolvedValue(undefined)
  const old=candidate('candidate-3',6), next=candidate('candidate-3',7), post=deferred<any>()
  agent.entries=[{id:1,kind:'pi.assistant',model:[{role:'assistant',content:'规划完成'}]}]
  agent.travel={draft:{version:5,activities:old.plan.activities},candidate:old,receipts:[]}
  candidateRows=[{...old,adopted_at:null}]
  api.post.mockReturnValue(post.promise)
  const view=render(<Planner tripId={3}/> )
  await waitFor(()=>expect(screen.getByRole('button',{name:'采用到旅程'})).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button',{name:'采用到旅程'}))
  expect(api.post).toHaveBeenCalledWith('/agent/candidates/candidate-3/adopt',expect.objectContaining({candidate_version:6}))

  agent.travel={draft:{version:6,activities:next.plan.activities},candidate:next,receipts:[]}
  candidateRows=[{...old,adopted_at:null},{...next,adopted_at:null}]
  view.rerender(<Planner tripId={3}/> )
  await waitFor(()=>expect(screen.getByRole('button',{name:'采用到旅程'})).toBeInTheDocument())
  await act(async()=>post.resolve({data:{adopted_at:'2026-10-18T10:00:00.000Z'}}))

  expect(screen.getByTestId('candidate-id')).toHaveTextContent('candidate-3')
  expect(screen.getByTestId('adopted')).toHaveTextContent('false')
  expect(screen.getByRole('button',{name:'采用到旅程'})).toBeEnabled()
  expect(hydrate).toHaveBeenCalledWith(3)
})

it('does not hydrate the previous trip or replace current status when adoption resolves after a trip switch',async()=>{
  useTripStore.setState({trip:{id:3} as any})
  const hydrate=vi.spyOn(useTripStore.getState(),'hydrateActiveTrip').mockResolvedValue(undefined)
  const previous=candidate('trip-3-candidate',1), current=candidate('trip-4-candidate',1), post=deferred<any>()
  agent.entries=[{id:1,kind:'pi.assistant',model:[{role:'assistant',content:'规划完成'}]}]
  agent.travel={draft:{version:0,activities:previous.plan.activities},candidate:previous,receipts:[]}
  candidateRows=[{...previous,adopted_at:null}]
  api.post.mockReturnValue(post.promise)
  const view=render(<Planner tripId={3}/> )
  await waitFor(()=>expect(screen.getByRole('button',{name:'采用到旅程'})).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button',{name:'采用到旅程'}))

  act(()=>useTripStore.setState({trip:{id:4} as any}))
  agent.travel={draft:{version:0,activities:current.plan.activities},candidate:current,receipts:[]}
  candidateRows=[{...current,adopted_at:null}]
  view.rerender(<Planner tripId={4}/> )
  await waitFor(()=>expect(screen.getByTestId('candidate-id')).toHaveTextContent('trip-4-candidate'))
  await waitFor(()=>expect(screen.getByRole('button',{name:'采用到旅程'})).toBeInTheDocument())
  await act(async()=>post.resolve({data:{adopted_at:'2026-10-18T10:00:00.000Z'}}))

  expect(screen.getByTestId('candidate-id')).toHaveTextContent('trip-4-candidate')
  expect(screen.getByTestId('adopted')).toHaveTextContent('false')
  expect(screen.getByRole('button',{name:'采用到旅程'})).toBeEnabled()
  expect(hydrate).not.toHaveBeenCalled()
})

it('does not let an older trip candidate-list response replace the new trip status',async()=>{
  const tripThree=candidate('trip-3-candidate',1), tripFour=candidate('trip-4-candidate',1)
  agent.entries=[{id:1,kind:'pi.assistant',model:[{role:'assistant',content:'规划完成'}]}]
  agent.travel={draft:{version:0,activities:tripThree.plan.activities},candidate:tripThree,receipts:[]}
  let resolveTripThree!:(value:any)=>void
  api.get.mockImplementation((path:string)=>{
    if(path==='/agent/trips/3/candidates')return new Promise(resolve=>{resolveTripThree=resolve})
    if(path==='/agent/trips/4/candidates')return Promise.resolve({data:{candidates:[tripFour]}})
    return Promise.resolve({data:{version:0,activities:[]}})
  })
  const view=render(<Planner tripId={3}/>)
  await waitFor(()=>expect(api.get).toHaveBeenCalledWith('/agent/trips/3/candidates',expect.objectContaining({signal:expect.any(AbortSignal)})))

  agent.travel={draft:{version:0,activities:tripFour.plan.activities},candidate:tripFour,receipts:[]}
  view.rerender(<Planner tripId={4}/>)
  await waitFor(()=>expect(screen.getByTestId('candidate-id')).toHaveTextContent('trip-4-candidate'))
  await waitFor(()=>expect(screen.getByRole('button',{name:'采用到旅程'})).toBeInTheDocument())

  await act(async()=>resolveTripThree({data:{candidates:[{...tripThree,adopted_at:'2026-10-18T10:00:00.000Z'}]}}))
  expect(screen.getByTestId('adopted')).toHaveTextContent('false')
  expect(screen.getByTestId('candidate-id')).toHaveTextContent('trip-4-candidate')
})
