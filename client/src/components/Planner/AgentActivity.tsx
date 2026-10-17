import React,{useEffect,useRef,useState} from 'react'
import {activityRows,type ConversationEvent} from './assistantConversation'
export default function AgentActivity({events,active}:{events:ConversationEvent[];active:boolean}){
  const [open,setOpen]=useState(active)
  useEffect(()=>setOpen(active),[active])
  const rows=activityRows(events,active)
  const reasoning=events.filter(event=>event.kind==='model_delta' && ['plan','main','chat'].includes(event.payload.role)).map(event=>event.payload.reasoning_content || '').join('')
  const interrupted=events.some(event=>event.kind==='model_stream_ended' && event.payload.status==='interrupted')
  const window=useRef<HTMLDivElement>(null),follow=useRef(true)
  useEffect(()=>{if(open&&follow.current&&window.current)window.current.scrollTop=window.current.scrollHeight},[open,events.length])
  if(!rows.length&&!reasoning)return null
  return <details className="assistant-activity" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>{active?'正在处理…':'查看执行过程'} · {rows.length} 项活动{interrupted?' · 回复未完成':''}</summary>
    <div className="assistant-activity-window" ref={window} role="log" aria-label="规划执行进度" onScroll={()=>{const el=window.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<40}}>
      {rows.map(row=><div className="assistant-activity-row" key={row.key}><span>{row.text}</span><small>{row.status}{row.elapsed!=null?` · ${row.elapsed.toFixed(1)} 秒`:''}</small></div>)}
      {reasoning && <div className="assistant-reasoning" aria-label="模型返回的思考文本">{reasoning}</div>}
    </div>
  </details>
}
