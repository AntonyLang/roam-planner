import { useEffect, useState } from 'react'
import type { ChildAgent, NativeEntry, NativeMessage } from '../../agent/durable'
import SubagentList from './SubagentList'

function toolLabel(name: string, args: Record<string, any> = {}) {
  const tool = name.split('__').slice(-1)[0]
  const labels: Record<string, string> = {
    web_search: '查找旅行资料', web_fetch: '核实网页原文', query_places: '定位地点', query_venues: '比较景点与餐饮住宿',
    query_routes: '核对实际转场路线', query_transport: '核实铁路班次', query_weather: '查看目的地天气',
    prepare_trip_draft: '整理行程草稿', apply_trip_draft_changes: '更新每日安排', save_trip_draft_candidate: '保存本次方案',
    get_planning_snapshot: '核对已有行程', get_trip_draft: '读取当前草稿', subagent: '安排并行研究', read: '整理规划步骤',
  }
  const detail = tool === 'query_transport' ? [args.from_station, args.to_station].filter(Boolean).join(' → ')
    : typeof args.query === 'string' ? args.query : ''
  return { label: labels[tool] ?? '处理旅行资料', detail }
}

export default function AssistantProgress({ entries, tools, partial, children, active, stopping, count, onSupplement }: {
  entries: NativeEntry[]; tools: any[]; partial?: NativeMessage; children: ChildAgent[];
  active: boolean; stopping: boolean; count: number; onSupplement: (text: string) => void;
}) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
    if (!active) return
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [active])
  const boundary = entries.map(entry=>entry.kind).lastIndexOf('pi.user')
  const turn = entries.slice(boundary + 1)
  const calls = new Map(entries.flatMap(entry => (entry.model ?? []).flatMap(message =>
    Array.isArray(message.content) ? message.content.filter(part => part.type === 'toolCall').map(part => [part.id, part] as const) : [])))
  const completed = turn.flatMap(entry => (entry.model ?? []).filter(message => message.role === 'toolResult'))
  const current = tools.filter(tool => tool.status !== 'done').map(tool => ({ ...toolLabel(tool.name, tool.arguments ?? calls.get(tool.callId)?.arguments), key: tool.callId }))
  const recent = completed.slice(-3).map(message => ({ ...toolLabel(message.toolName, calls.get(message.toolCallId)?.arguments), key: message.toolCallId, failed: message.isError }))
  const researching = children.filter(child => ['running', 'waiting', 'stopping'].includes(child.status)).length
  const thinking = Array.isArray(partial?.content) && partial.content.some(part => part.type === 'thinking')
  const title = stopping ? '正在收尾并保存进度' : current[0]?.label ?? (researching ? `${researching} 项研究正在进行` : thinking || completed.length ? '正在整合资料与安排' : '正在理解这次旅行要求')
  if (!active && !children.length) return null
  return <section className="assistant-live" aria-label="规划进度">
    {active && <>
      <div className="assistant-live-heading"><span className="assistant-live-dot" /><strong aria-live="polite">{title}</strong><time>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time></div>
      <div className="assistant-live-counts">已完成 {completed.length} 项处理{count > 0 ? ` · 草稿 ${count} 个安排` : ''}</div>
      <div className="assistant-live-steps" role="log" aria-label="最近规划活动">
        {recent.map(row => <div key={row.key}><span>{row.failed ? '待补查' : '✓'}</span><div>{row.label}{row.detail && <small>{row.detail}</small>}</div></div>)}
        {current.map(row => <div key={row.key}><span className="assistant-live-dot" /><div>{row.label}{row.detail && <small>{row.detail}</small>}</div></div>)}
      </div>
      <p>可以随时补充；助手会在当前步骤结束后接着处理。</p>
      <div className="assistant-live-actions">{['补充预算', '调整节奏', '说明住宿偏好'].map(text => <button key={text} type="button" onClick={() => onSupplement(text + '：')}>{text}</button>)}</div>
    </>}
    {children.length > 0 && <details open={active}><summary>研究任务 · {children.filter(child => child.status === 'completed').length}/{children.length} 已完成</summary><SubagentList agents={children} /></details>}
  </section>
}
