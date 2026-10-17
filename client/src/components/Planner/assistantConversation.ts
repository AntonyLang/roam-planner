export type ConversationEvent={seq:number;kind:string;task_id?:string;payload:any;created_at?:string}
export type ConversationItem={key:string;kind:'message'|'question'|'activity';role?:'user'|'assistant';text?:string;pending?:any;events?:ConversationEvent[];taskId?:string;finished?:boolean;streamStatus?:'live'|'interrupted'}
const activityKinds=new Set(['progress','tool_call','tool_result','tool_error','model_input','model_result','model_error','cache_hit','graph_node_started','graph_node_completed','model_delta','model_stream_started','model_stream_ended'])

export function conversationItems(events:ConversationEvent[]):ConversationItem[]{
  const items:ConversationItem[]=[], decisions=new Set<string>(), messages=new Set<string>()
  for(const e of [...events].sort((a,b)=>a.seq-b.seq)){
    const p=e.payload
    if(e.kind==='user_message'||e.kind==='user_answer'){
      const text=p.content??p.answer??p.input?.message
      if(text)items.push({key:`event:${e.seq}`,kind:'message',role:'user',text})
    }else if(e.kind==='assistant_message'&&!['review','router','compaction'].includes(p.stage)){
      const text=p.content
      if(!text)continue
      const identity=p.model_message_id
      if(identity&&messages.has(identity))continue
      if(identity)messages.add(identity)
      const last=items[items.length-1]
      if(last?.kind==='message'&&last.role==='assistant'&&!last.streamStatus&&last.text===text)continue
      items.push({key:`event:${e.seq}`,kind:'message',role:'assistant',text})
    }else if(e.kind==='model_delta' && !['review','router','compaction'].includes(p.role)){
      const key=`stream:${p.call_id}:${p.attempt??0}`
      if(p.content){
        let item=items.find(item=>item.key===key)
        if(!item){item={key,kind:'message',role:'assistant',text:'',taskId:e.task_id,streamStatus:'live'};items.push(item)}
        item.text+=p.content
      }
      // Keep one activity window per call while content and reasoning arrive together.
      const activity=items.find(item=>item.kind==='activity'&&item.events?.some(event=>event.payload.call_id===p.call_id))
      if(activity)activity.events!.push(e)
      else items.push({key:`activity:${e.seq}`,kind:'activity',events:[e],taskId:e.task_id})
    }else if(e.kind==='model_stream_ended'){
      const item=items.find(item=>item.key===`stream:${p.call_id}:${p.attempt??0}`)
      if(item&&p.status==='interrupted')item.streamStatus='interrupted'
      const activity=items.find(item=>item.kind==='activity'&&item.events?.some(event=>event.payload.call_id===p.call_id))
      if(activity)activity.events!.push(e)
    }else if(e.kind==='task_status'&&p.status==='waiting_user'&&p.pending){
      const pending=p.pending
      if(decisions.has(pending.decision_id))continue
      decisions.add(pending.decision_id)
      items.push({key:`question:${pending.decision_id}`,kind:'question',role:'assistant',text:pending.question,pending,taskId:e.task_id})
    }else if(activityKinds.has(e.kind)){
      const last=items[items.length-1]
      if(last?.kind==='activity'&&last.taskId===e.task_id)last.events!.push(e)
      else items.push({key:`activity:${e.seq}`,kind:'activity',events:[e],taskId:e.task_id})
    }
  }
  // Keep live text while it is arriving, then use the completed message once.
  const completed=new Set(events.filter(event=>event.kind==='assistant_message' && event.payload.model_message_id).map(event=>event.payload.model_message_id))
  for(let index=items.length-1;index>=0;index--){if(items[index].key.startsWith('stream:') && completed.has(items[index].key.split(':')[1]))items.splice(index,1)}
  // A question or an answer after a group closes that group, even when the
  // same task later resumes; its old activity window stays in the history.
  let finished=false
  for(let i=items.length-1;i>=0;i--){items[i].finished=finished;if(items[i].kind==='question'||items[i].kind==='message'&&items[i].streamStatus!=='live')finished=true}
  return items
}

const labels:Record<string,string>={query_places:'核实地点和车站',query_venues:'寻找住宿或餐饮候选',query_routes:'核查市内接驳路线',query_transport:'查询铁路班次',query_weather:'查询天气',search_xhs:'搜索旅行攻略',read_xhs_note:'阅读攻略正文',get_trip_summary:'读取当前旅程',get_planning_snapshot:'核对旅程状态',list_places:'读取已有地点',prepare_trip_draft:'准备行程草稿',apply_trip_draft_changes:'更新地图和安排',validate_trip_draft:'校验行程',save_planning_candidate:'保存核对后的方案',load_skill:'读取旅行规划方法',request_user_input:'准备待确认问题'}
const roleLabels:Record<string,string>={plan:'整理需求与规划',main:'整理需求与规划',review:'独立复核方案',router:'理解本次需求',chat:'准备回答',compaction:'整理会话上下文'}
export function activityRows(events:ConversationEvent[],active:boolean){
  const rows:{key:string;text:string;status:string;elapsed?:number}[]=[],calls=new Map<string,typeof rows[number]>()
  for(const e of events){
    const p=e.payload,key=`${e.kind.startsWith('model')?'model':'tool'}:${p.call_id}:${p.attempt??0}`
    if(e.kind==='tool_call'||e.kind==='model_input'){
      const row={key,text:e.kind==='tool_call'?(labels[p.remote_name??p.name]??'执行查询或操作'):(roleLabels[p.role]??'准备下一步'),status:active?'进行中':'未记录完成'}
      rows.push(row);calls.set(key,row)
    }else if(['tool_result','tool_error','model_result','model_error'].includes(e.kind)){
      const row=calls.get(key)
      if(row){row.status=e.kind.endsWith('error')||p.success===false?'未完成':'完成';row.elapsed=p.elapsed_seconds}
    }else if(e.kind==='progress'&&p.message)rows.push({key:`progress:${e.seq}`,text:p.message,status:'进度'})
    else if(e.kind==='cache_hit')rows.push({key:`cache:${e.seq}`,text:'复用仍有效的查询结果',status:'缓存'})
  }
  return rows
}
