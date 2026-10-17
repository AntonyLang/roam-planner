import {describe,it,expect,vi} from 'vitest'
import {readSessionEvents} from './sessionEvents'
import {conversationItems} from './assistantConversation'

describe('durable live session display',()=>{
  it('reads split UTF-8 and CRLF SSE boundaries without polling or dropping events',async()=>{
    const bytes=new TextEncoder().encode('id: 1\r\nevent: model_delta\r\ndata: {"seq":1,"text":"回复"}\r\n\r\nid: 2\ndata: {"seq":2}\n\n')
    const stream=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close()}})
    const api:any={get:vi.fn(async()=>({data:stream}))},events:any[]=[]
    await readSessionEvents(api,'/v1/events',new AbortController().signal,event=>events.push(event))
    expect(events).toEqual([{seq:1,text:'回复'},{seq:2}])
    expect(api.get).toHaveBeenCalledOnce()
  })
  it('keeps reasoning and incomplete content then deduplicates the final reply',()=>{
    const rows:any[]=[{seq:1,kind:'model_input',task_id:'t',payload:{call_id:'m',role:'main'}},{seq:2,kind:'model_delta',task_id:'t',payload:{call_id:'m',role:'main',content:'第一行\n',reasoning_content:'提供方文本'}},{seq:3,kind:'model_delta',task_id:'t',payload:{call_id:'m',role:'main',content:'第二行'}},{seq:4,kind:'model_stream_ended',task_id:'t',payload:{call_id:'m',status:'interrupted'}}]
    const partial=conversationItems(rows)
    expect(partial.find(x=>x.kind==='message')).toMatchObject({text:'第一行\n第二行',streamStatus:'interrupted'})
    expect(partial.find(x=>x.kind==='activity')?.events?.some(x=>x.payload.reasoning_content==='提供方文本')).toBe(true)
    rows.push({seq:5,kind:'assistant_message',payload:{model_message_id:'m',content:'第一行\n第二行'}})
    expect(conversationItems(rows).filter(x=>x.kind==='message')).toHaveLength(1)
  })
})
