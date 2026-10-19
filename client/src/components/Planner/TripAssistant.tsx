import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { gcj02ToWgs84, type AgentPlan } from '@trek/shared'
import { apiClient } from '../../api/client'
import { useTripStore } from '../../store/tripStore'
import { adoptedTransportSegments, plannedRouteSegments, type DraftRouteSegment, type TransportLeg, type RouteStop } from './assistantRoutes'
import './TripAssistant.css'
import {agentApi,messageText,useDurableConversation} from '../../agent/durable'
import AssistantProgress from './AssistantProgress'
import AssistantConfirmations from './AssistantConfirmations'
import {useItineraryRoutes} from './useItineraryRoutes'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { sanitizedMarkdownComponents, sanitizedMarkdownPlugins } from '../shared/markdownSanitize'
import { useServicesStore } from '../../store/servicesStore'
import { useTranslation } from '../../i18n'
import { useNavigate } from 'react-router'

type Activity = AgentPlan['activities'][number]
type Event = { seq: number; kind: string; task_id: string; payload: any }
type Task = { id: string; status: string; pending?: any; error?: any; result?: any; input_revision: number }
type CandidateRecord = { candidate_id: string; candidate_version: number; adopted_at: string | null; plan?: AgentPlan }
type CandidateAdoptionState = { tripId: number; candidateId: string; candidateVersion: number; loaded: boolean; record?: CandidateRecord; error?: string }
export type DraftMap = { points: { ref: string; name: string; lat: number; lng: number; label: string; orderLabel: string; notes: string; dayNumber:number; labelDirection?:'top'|'bottom' }[]; lines: number[][][]; segments?: (DraftRouteSegment & {label:string})[]; formalSegments?: (DraftRouteSegment & {label:string})[]; formalLines?: number[][][]; routePending?:number; routeFailed?:number; focus?: string; adopted?: boolean; version: string; viewKey?:string; padding?: {left:number;right:number} }
const requestId = () => crypto.randomUUID()
const point = (a: Activity) => a.latitude == null || a.longitude == null ? null : a.coordinate_system === 'GCJ02' ? gcj02ToWgs84(a.latitude, a.longitude) : { lat: a.latitude, lng: a.longitude }
const statusText: Record<string, string> = { queued: '准备规划', running: '正在规划，可随时补充要求', stopping: '正在收尾并保存进度', waiting_user: '需要你补充', succeeded: '已回复', stopped:'已停止', failed: '规划暂时中断', budget_stopped: '已到本次预算上限' }

export function useTripAssistant(tripId: number) {
  const days=useTripStore(state=>state.days)
  const activeTripId=useTripStore(state=>state.trip?.id)
  const selectedDayId=useTripStore(state=>state.selectedDayId)
  const storedAssignments=useTripStore(state=>state.assignments)
  const storedPlaces=useTripStore(state=>state.places)
  const [session, setSession] = useState<string>()
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [focus, setFocus] = useState<string>()
  const [candidateAdoption, setCandidateAdoption] = useState<CandidateAdoptionState>()
  const [candidateHistory, setCandidateHistory] = useState<{tripId:number;records:CandidateRecord[]}>()
  const [pageDraft, setPageDraft] = useState<any>()
  const native = useDurableConversation(session)
  useEffect(() => {
    const controller = new AbortController()
    setSession(undefined); setPageDraft(undefined); setCandidateAdoption(undefined); setCandidateHistory(undefined); setSessionLoading(true)
    agentApi.get(`/v1/trips/${tripId}/conversation`, {signal:controller.signal}).then(async ({data}) => {
      if(controller.signal.aborted)return
      setSession(String(data.conversation_id))
      try { const saved=await apiClient.get(`/agent/drafts/${data.conversation_id}`,{signal:controller.signal});if(!controller.signal.aborted)setPageDraft(saved.data) }
      catch (e:any) { if(e.response?.status!==404&&!controller.signal.aborted)setError('草稿读取失败。') }
    }).catch(()=>{if(!controller.signal.aborted)setError('助手连接失败，可以重试。')})
      .finally(()=>{if(!controller.signal.aborted)setSessionLoading(false)})
    return ()=>controller.abort()
  },[tripId])
  const nativeDraft=native.travel?.draft
  const latestDraft=pageDraft&&(!nativeDraft||pageDraft.version>nativeDraft.version)?pageDraft:nativeDraft??pageDraft
  const draft=latestDraft?{seq:latestDraft.version,task_id:session,payload:latestDraft}:undefined
  const candidate=native.travel?.candidate&&(!latestDraft||native.travel.candidate.candidate_version===latestDraft.version+1)?native.travel.candidate:undefined
  const candidateAdoptionMatches=!!candidate&&candidateAdoption?.tripId===tripId&&candidateAdoption.candidateId===candidate.candidate_id&&candidateAdoption.candidateVersion===candidate.candidate_version
  const adoptionReady=!!candidateAdoptionMatches&&candidateAdoption.loaded&&!!candidateAdoption.record
  const adopted=!!candidateAdoptionMatches&&!!candidateAdoption.record?.adopted_at
  const candidateIdentityRef=useRef<{tripId:number;candidateId:string;candidateVersion:number}|undefined>(undefined)
  candidateIdentityRef.current=candidate?{tripId,candidateId:candidate.candidate_id,candidateVersion:candidate.candidate_version}:undefined
  useEffect(() => {
    const controller = new AbortController()
    const candidateId = candidate?.candidate_id
    const candidateVersion = candidate?.candidate_version
    if(candidateId&&candidateVersion!=null)setCandidateAdoption({ tripId, candidateId, candidateVersion, loaded: false })
    else setCandidateAdoption(undefined)
    apiClient.get(`/agent/trips/${tripId}/candidates`, { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      setCandidateHistory({tripId,records:data.candidates})
      if(!candidateId||candidateVersion==null)return
      const record = data.candidates.find((row: CandidateRecord) => row.candidate_id === candidateId && row.candidate_version === candidateVersion)
      setCandidateAdoption({ tripId, candidateId, candidateVersion, loaded: true, record })
    }).catch(() => {
      if (!controller.signal.aborted) {
        setCandidateHistory(undefined)
        if(candidateId&&candidateVersion!=null)setCandidateAdoption({ tripId, candidateId, candidateVersion, loaded: false, error: '采用状态读取失败。' })
      }
    })
    return () => controller.abort()
  }, [tripId, candidate?.candidate_id, candidate?.candidate_version])
  const working=native.running||native.children.some(child=>['running','waiting','stopping'].includes(child.status))
  const task:Task|undefined=session&&(native.entries.length>0||working)?{id:session,status:native.stopState==='stopping'?'stopping':native.stopState==='stopped'?'stopped':working?'running':'succeeded',input_revision:1}:undefined
  const events:Event[]=(native.travel?.receipts??[]).flatMap((row:any)=>{
    const event={...row,task_id:session}
    const capabilities:Record<string,string>={query_routes:'routes',query_transport:'transport',query_places:'places',query_weather:'weather'}
    const capability=capabilities[row.payload.remote_name]
    return row.kind==='tool_result'&&row.payload.success&&capability?[event,{seq:row.seq,task_id:session,kind:'source_available',payload:{capability,source_id:'tool:'+row.payload.call_id,data:row.payload.original}}]:[event]
  })
  if(draft)events.push({seq:draft.seq,kind:'draft_updated',task_id:session!,payload:draft.payload})
  if(candidate)events.push({seq:events.length+1,kind:'candidate_saved',task_id:session!,payload:candidate})
  const activities:Activity[]=candidate?.plan?.activities??draft?.payload.activities??[]
  const current=true
  const plan:AgentPlan|undefined=candidate?.plan??draft?.payload.plan
  const transportLegs:TransportLeg[]=plan?.extensions.transport_legs as TransportLeg[]??draft?.payload.transport_legs??[]
  const accommodations:any[]=(plan?.extensions.native_operations as any[]??Object.values(draft?.payload.extras??{})).filter((op:any)=>op.name==='create_accommodation').map((op:any)=>{
    const args=op.arguments,place=activities.find(a=>(args.place_ref!=null&&a.ref===args.place_ref)||(args.place_id!=null&&a.existing_place_id===args.place_id))
    return {...args,name:place?.name??'住宿地点',ref:place?.ref,dateRange:[days.find(d=>d.id===args.start_day_id)?.date,days.find(d=>d.id===args.end_day_id)?.date].filter(Boolean).join(' — ')}
  })
  const send=async(message:string)=>{
    if(!message.trim()||sessionLoading)return false
    setSending(true);setError('')
    try{await native.send(message);return true}catch{setError('发送失败，请重试。');return false}finally{setSending(false)}
  }
  const edit=async(items:Activity[])=>{
    if(!draft)return false
    const patches=items.flatMap(a=>{
      const prior=activities.find(v=>v.ref===a.ref)
      if(!prior)return []
      const fields=Object.fromEntries(Object.entries(a).filter(([key,value])=>key!=='ref'&&JSON.stringify(value)!==JSON.stringify((prior as any)[key])))
      return Object.keys(fields).length?[{ref:a.ref,...fields}]:[]
    })
    try{
      const {data}=await apiClient.put(`/agent/drafts/${session}`,{base_version:draft.payload.version,patches,
        remove_refs:activities.filter(a=>!items.some(v=>v.ref===a.ref)).map(a=>a.ref),order:items.map(a=>a.ref)})
      setPageDraft(data);return true
    }catch{setError('草稿已发生变化，请读取最新草稿后重试。');return false}
  }
  const baseMap = useMemo(() => {
    // Native places take over after adoption; keep the verified route geometry.
    const selectedDay=activeTripId===tripId?days.find(d=>d.id===selectedDayId)?.day_number:undefined
    const dayLabel=(dayNumber:number)=> (activeTripId===tripId?days.find(d=>d.day_number===dayNumber)?.date:undefined)??`第${dayNumber}天`
    const counts=new Map<number,number>()
    const points = adopted ? [] : activities.flatMap(a => {
      const index=(counts.get(a.day_number)??0)+1;counts.set(a.day_number,index)
      const p = point(a)
      return p&&(selectedDay==null||selectedDay===a.day_number)?[{ ...p, ref: a.ref, name: a.name, dayNumber:a.day_number,
        label: `${dayLabel(a.day_number)} · ${index}`, orderLabel:selectedDay==null?`D${a.day_number}·${index}`:String(index), labelDirection:index%2?'top' as const:'bottom' as const,
        notes: [a.start_time, a.end_time].filter(Boolean).join('–') + ' ' + a.notes }]:[]
    })
    const coincidentOrders = new Map<string,string[]>()
    points.forEach(p => {
      const key=`${p.lat},${p.lng}`
      const labels=coincidentOrders.get(key)??[]
      labels.push(p.orderLabel);coincidentOrders.set(key,labels)
    })
    points.forEach(p => {p.orderLabel=coincidentOrders.get(`${p.lat},${p.lng}`)!.join('\n')})
    const routeIds: string[] = (plan?.extensions?.route_source_ids ?? (plan?.extensions?.map_draft as { route_source_ids?: string[] } | undefined)?.route_source_ids ?? draft?.payload.routes ?? []) as string[]
    // Only actual adoption records authorize reusing route sources. Match them
    // against today's formal graph, so edits and inserted stops break stale edges.
    const adoptedRecords=candidateHistory?.tripId===tripId?candidateHistory.records.filter(row=>row.adopted_at).sort((a,b)=>b.adopted_at!.localeCompare(a.adopted_at!)):[]
    const formalIds = adoptedRecords.flatMap(row=>
      row.plan?.extensions.route_source_ids??(row.plan?.extensions.map_draft as {route_source_ids?:string[]}|undefined)?.route_source_ids??[]) as string[]
    const previewIds = adopted ? [] : routeIds
    const modeLabel:Record<string,string>={walking:'步行',transit:'公共交通',driving:'驾车',train:'铁路示意',flight:'航段示意'}
    const labelSegments=(values:DraftRouteSegment[])=>values
      .filter(s=>selectedDay==null||s.dayNumber===selectedDay).map(s=>({...s,
        label:`${dayLabel(s.dayNumber)} · ${s.fromName} → ${s.toName} · ${modeLabel[s.mode]??s.mode}${s.trainCode?' '+s.trainCode:s.flightCode?' '+s.flightCode:''}${s.durationMinutes?` · 约${s.durationMinutes}分钟`:''}${s.schematic?` · 非实际${s.mode==='flight'?'航路':'轨道'}${s.sourceConfirmed?'':' · 班次信息未核实'}`:''}${s.sourceLabel?' · 来源：'+s.sourceLabel:''}`}))
    const segments=labelSegments(plannedRouteSegments(events,previewIds,adopted?[]:activities,transportLegs))
    const formalStops:RouteStop[]=activeTripId!==tripId?[]:days.flatMap(day=>[...(storedAssignments[String(day.id)]??[])].sort((a,b)=>a.order_index-b.order_index).map(assignment=>{
      const place=storedPlaces.find(p=>p.id===assignment.place_id)??assignment.place
      return {ref:`assignment:${assignment.id}`,day_number:day.day_number,name:place?.name??'',notes:assignment.notes??'',
        latitude:place?.lat??undefined,longitude:place?.lng??undefined,coordinate_system:'WGS84' as const,
        transport_mode:assignment.incoming_leg_transport_mode??place?.transport_mode??undefined}
    }))
    const formalTransfers=adoptedTransportSegments(events,adoptedRecords.flatMap(row=>row.plan?[row.plan]:[]),formalStops)
    const formalSegments=labelSegments([...plannedRouteSegments(events,formalIds.filter(id=>!segments.some(s=>s.sourceId===id)),formalStops)
      .filter(s=>!formalTransfers.some(t=>t.fromRef===s.fromRef&&t.toRef===s.toRef)),...formalTransfers])
    const formalLines=formalSegments.flatMap(s=>s.lines)
    const lines = segments.flatMap(s=>s.lines)
    return { points, lines, segments, formalSegments, formalLines, formalStops, selectedDay, focus, adopted, viewKey:`${tripId}:${session}:${selectedDay??'all'}`,
      version: `${draft?.seq ?? ''}:${candidate?.candidate_version ?? ''}:${adopted}:${selectedDay??'all'}` }
  }, [activities, events, focus, plan, draft, candidate, task?.id, adopted,days,activeTripId,selectedDayId,tripId,session,candidateHistory,storedAssignments,storedPlaces])
  const extraRoutes=useItineraryRoutes(tripId,adopted||!activities.length?baseMap.formalStops:activities,adopted||!activities.length?baseMap.formalSegments:baseMap.segments,baseMap.selectedDay)
  const extraSegments=extraRoutes.segments.map(s=>({...s,label:`第 ${s.dayNumber} 天 · ${s.fromName} → ${s.toName} · ${{walking:'步行',driving:'驾车',transit:'公共交通',transfer:'城际转场示意'}[s.mode]??s.mode}${s.durationMinutes?' · 约'+s.durationMinutes+'分钟':''}${s.schematic?' · 非实际运行路线':''} · 来源：${s.sourceLabel}`}))
  const formal=adopted||!activities.length
  const map={...baseMap,segments:formal?baseMap.segments:[...baseMap.segments,...extraSegments],formalSegments:formal?[...baseMap.formalSegments,...extraSegments]:baseMap.formalSegments,lines:formal?baseMap.lines:[...baseMap.lines,...extraSegments.flatMap(s=>s.lines)],formalLines:formal?[...baseMap.formalLines,...extraSegments.flatMap(s=>s.lines)]:baseMap.formalLines,routePending:extraRoutes.pending,routeFailed:extraRoutes.failed}
  const adopt = async () => {
    if (!candidate || !adoptionReady || adopted || task?.status !== 'succeeded') return
    const identity={tripId,candidateId:candidate.candidate_id,candidateVersion:candidate.candidate_version}
    setSending(true)
    try {
      const { data } = await apiClient.post(`/agent/candidates/${candidate.candidate_id}/adopt`, { operation_id: requestId(), candidate_version: candidate.candidate_version })
      if(useTripStore.getState().trip?.id===tripId) await useTripStore.getState().hydrateActiveTrip(tripId)
      const current=candidateIdentityRef.current
      if(current?.tripId===identity.tripId&&current.candidateId===identity.candidateId&&current.candidateVersion===identity.candidateVersion)
        setCandidateAdoption({ ...identity, loaded: true, record: { ...candidate, adopted_at: data.adopted_at } })
      setCandidateHistory(previous=>previous?.tripId===identity.tripId?{...previous,records:previous.records.map(row=>
        row.candidate_id===identity.candidateId&&row.candidate_version===identity.candidateVersion?{...row,adopted_at:data.adopted_at}:row)}:previous)
    } catch {
      const current=candidateIdentityRef.current
      if(current?.tripId===identity.tripId&&current.candidateId===identity.candidateId&&current.candidateVersion===identity.candidateVersion)
        setError('旅程可能已有变化，请重新核对后采用。')
    }
    finally { setSending(false) }
  }
  const retry=()=>native.resume()
  return {tripId,session,engine:'main' as const,events,task,error:error||candidateAdoption?.error||native.error,sending:sending||sessionLoading,send,edit,
    activities,accommodations,transportLegs,plan,map,setFocus,adopt,adopted,adoptionReady,candidate,retry,current,native}

}

export function TripAssistant({ agent }: { agent: ReturnType<typeof useTripAssistant> }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const needsModelSetup = useServicesStore(s => s.config?.needs_setup ?? false)
  const [text, setText] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const followed = useRef(true)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  const scrollToLatest = () => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight
    followed.current = true; setAwayFromBottom(false)
  }
  useEffect(() => { if (followed.current && body.current) body.current.scrollTop = body.current.scrollHeight }, [agent.native.entries.length, agent.native.outbox, agent.native.tools, agent.native.partial, agent.task?.status])
  useEffect(() => { setText(''); followed.current = true; setAwayFromBottom(false) }, [agent.session])
  const messages=agent.native.entries.flatMap(entry=>entry.model?.[0]&&['pi.user','pi.assistant'].includes(entry.kind)?
    [{key:entry.id,role:entry.model[0].role,text:messageText(entry.model[0])}].filter(m=>m.text):[])
  const canSend=!needsModelSetup&&!agent.sending&&!!text.trim()&&agent.native.stopState!=='stopping'
  const active=agent.native.running||agent.native.children.some(child=>['running','waiting','stopping'].includes(child.status))
  const partialText=messageText(agent.native.partial)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSend) return
    const value = text
    setText(''); scrollToLatest(); composer.current?.focus()
    if (!await agent.send(value)) setText(current => current || value)
  }
  return <section className="trip-assistant" aria-label="旅程规划助手">
    <div className="assistant-heading"><strong>一起规划这趟旅行</strong><small>地点、路线和安排会同步显示在地图上</small></div>
    <div className="assistant-body" ref={body} onScroll={() => { const el=body.current; if(el) { followed.current=el.scrollHeight-el.scrollTop-el.clientHeight<80; setAwayFromBottom(!followed.current) } }}>
      {!messages.length && !agent.native.outbox?.length && <div className="assistant-empty"><strong>从你的旅行想法开始</strong><p>告诉我目的地、同行人数和偏好。我会结合这趟旅程的日期与已有安排来规划。</p><div className="assistant-starters">{['帮我安排每天的路线，节奏轻松一些','先看看现有安排，有哪些需要调整？'].map(prompt=><button key={prompt} type="button" onClick={()=>{setText(prompt);composer.current?.focus()}}>{prompt}</button>)}</div></div>}
      {messages.map(m=><div key={m.key} className={`assistant-message ${m.role==='user'?'from-user':'from-assistant'}`}><small className="assistant-speaker">{m.role==='user'?'你':'旅行助手'}</small>{m.role==='user'?<div className="assistant-message-text">{m.text}</div>:<AssistantMarkdown text={m.text}/>}</div>)}
      {(agent.native.outbox??[]).map(message=><div key={message.requestId} className="assistant-message from-user"><small className="assistant-speaker">你</small><div className="assistant-message-text">{message.text}</div><small className="assistant-delivery" role="status">{{sending:'正在发送…',queued:'已送达，等待当前步骤结束',accepted:'已送达，已加入规划',failed:'未发送成功，内容已保留'}[message.status]}{message.status==='failed'&&<button type="button" onClick={()=>void agent.native.retryMessage(message.requestId).catch(()=>{})}>重试发送</button>}</small></div>)}
      <AssistantProgress entries={agent.native.entries} tools={agent.native.tools} partial={agent.native.partial} children={agent.native.children}
        active={active||agent.sending||!!agent.native.outbox?.some(message=>message.status!=='failed')} stopping={agent.native.stopState==='stopping'}
        count={agent.activities.length} onSupplement={value=>{setText(current=>current?current+'\n'+value:value);composer.current?.focus()}}/>
      {partialText&&<div className="assistant-message from-assistant"><small className="assistant-speaker">旅行助手</small><AssistantMarkdown text={partialText}/></div>}
      {agent.task && <div className="assistant-progress" role="status">{statusText[agent.task.status] ?? agent.task.status}</div>}
      <AssistantConfirmations tripId={agent.tripId} stays={agent.accommodations} unknowns={agent.plan?.unknowns??[]} onFocus={agent.setFocus}/>
      {agent.candidate && agent.task?.status === 'succeeded' && agent.adoptionReady && !agent.adopted && <button className="assistant-adopt" disabled={agent.sending} onClick={agent.adopt}>采用到旅程</button>}
      {agent.adopted && <p>已更新旅程，可以在每日安排和地图中继续编辑。</p>}
      {agent.native.stopState==='stopped' && <button onClick={agent.retry}>保留已有结果并继续</button>}
      {agent.error && <p role="alert">{agent.error}</p>}
    </div>
    {awayFromBottom&&<button type="button" className="assistant-latest" onClick={scrollToLatest}>↓ 回到最新消息</button>}
    {needsModelSetup && <div className="mx-3 mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-content-secondary" role="alert">
      <p>{t('services.planningBlocked')}</p>
      <button type="button" onClick={() => navigate('/services')} className="mt-2 font-semibold text-content underline underline-offset-2">{t('services.openConfiguration')}</button>
    </div>}
    <form onSubmit={submit} className="assistant-compose">
      <textarea ref={composer} aria-label="旅行要求或修改意见" value={text} disabled={needsModelSetup} onChange={e => setText(e.target.value)} onKeyDown={e=>{
        if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&e.keyCode!==229){e.preventDefault();if(canSend)e.currentTarget.form?.requestSubmit()}
      }} placeholder={active ? '随时补充，助手会接着处理…' : '聊聊你的旅行想法…'} rows={3} />
      <div className="assistant-compose-actions"><span>Enter 发送 · Shift+Enter 换行</span><div>{active&&<button className="assistant-stop" type="button" disabled={agent.native.stopState==='stopping'} onClick={agent.native.stop}>{agent.native.stopState==='stopping'?'正在收尾':'停止'}</button>}<button type="submit" disabled={!canSend}>{agent.sending?'发送中…':active?'补充要求':'发送'}</button></div></div>
    </form>
  </section>
}

function AssistantMarkdown({text}:{text:string}) {
  return <div className="assistant-markdown"><Markdown remarkPlugins={[remarkGfm,remarkBreaks]} rehypePlugins={sanitizedMarkdownPlugins} components={sanitizedMarkdownComponents}>{text}</Markdown></div>
}

export function AgentDayPreview({agent,dayNumber,onFocus}: {agent:ReturnType<typeof useTripAssistant>;dayNumber:number;onFocus?:()=>void}) {
  const [dragRef,setDragRef]=useState<string>()
  const items=agent.activities.filter(a=>a.day_number===dayNumber)
  if (!items.length || agent.adopted) return null
  const disabled=agent.sending || agent.task?.status==='waiting_user'
  const move=(from:string,to:string) => {
    const all=[...agent.activities], source=all.findIndex(a=>a.ref===from), target=all.findIndex(a=>a.ref===to)
    if(source<0 || target<0 || all[source].day_number!==all[target].day_number) return
    const [item]=all.splice(source,1); all.splice(target,0,item); void agent.edit(all)
  }
  return <div className="agent-day-preview" aria-label={`第${dayNumber}天规划草稿`}>
    <small>{agent.candidate ? '候选已保存，待采用' : '规划草稿'} · 可点击定位和修改</small>
    {items.map((a,index)=><article key={a.ref} draggable={!disabled} onDragStart={e=>{e.stopPropagation();e.dataTransfer.setData('application/x-trek-agent-ref',a.ref);setDragRef(a.ref)}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();e.stopPropagation();if(dragRef)move(dragRef,a.ref);setDragRef(undefined)}}>
      <button className="agent-preview-name" onClick={()=>{agent.setFocus(a.ref);onFocus?.()}}>{index+1}. {a.name}</button>
      <div className="agent-preview-controls"><input aria-label={`${a.name}草稿开始时间`} type="time" key={a.start_time} defaultValue={a.start_time??''} disabled={disabled} onBlur={e=>{if(e.target.value && e.target.value!==a.start_time)void agent.edit(agent.activities.map(v=>v.ref===a.ref?{...v,start_time:e.target.value}:v))}} /><span>—</span><input aria-label={`${a.name}草稿结束时间`} type="time" key={a.end_time} defaultValue={a.end_time??''} disabled={disabled} onBlur={e=>{if(e.target.value && e.target.value!==a.end_time)void agent.edit(agent.activities.map(v=>v.ref===a.ref?{...v,end_time:e.target.value}:v))}} /><button disabled={disabled||index===0} aria-label={`上移${a.name}`} onClick={()=>move(a.ref,items[index-1].ref)}>↑</button><button disabled={disabled} aria-label={`删除草稿${a.name}`} onClick={()=>agent.edit(agent.activities.filter(v=>v.ref!==a.ref))}>×</button></div>
      <details><summary>{a.cost!=null?`预计 ${a.cost} ${a.currency} · `:''}安排说明</summary><p>{a.notes}</p></details>
    </article>)}
  </div>
}
