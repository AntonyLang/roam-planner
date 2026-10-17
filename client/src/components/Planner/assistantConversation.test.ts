import {expect,it} from 'vitest'
import {conversationItems,activityRows} from './assistantConversation'
it('retains every question, answer and assistant turn after pending is cleared',()=>{
  const events=[{seq:1,kind:'user_message',payload:{input:{message:'旅行要求'}}},{seq:2,kind:'task_status',payload:{status:'waiting_user',pending:{decision_id:'d1',question:'从哪里出发？'}}},{seq:3,kind:'user_answer',payload:{answer:'上海'}},{seq:4,kind:'assistant_message',payload:{stage:'main',content:'我会先核查交通。'}},{seq:5,kind:'task_status',payload:{status:'waiting_user',pending:{decision_id:'d2',question:'请确认方向'}}},{seq:6,kind:'user_answer',payload:{answer:'同意'}},{seq:7,kind:'assistant_message',payload:{stage:'completed',content:'第一天\n第二天'}}]
  const result=conversationItems(events)
  expect(result.map(i=>i.text)).toEqual(['旅行要求','从哪里出发？','上海','我会先核查交通。','请确认方向','同意','第一天\n第二天'])
})
it('closes historical activity groups while retaining stable identities and tool outcomes',()=>{
  const events=[{seq:1,task_id:'t',kind:'tool_call',payload:{call_id:'c',name:'search_xhs'}},{seq:2,task_id:'t',kind:'tool_result',payload:{call_id:'c',success:true,elapsed_seconds:2}},{seq:3,kind:'assistant_message',payload:{stage:'completed',content:'结果'}},{seq:4,task_id:'t',kind:'model_input',payload:{call_id:'m',role:'main'}}]
  const result=conversationItems(events)
  expect(result[0].finished).toBe(true);expect(result[2].finished).toBe(false)
  expect(activityRows(result[0].events!,false)).toEqual([{key:'tool:c:0',text:'搜索旅行攻略',status:'完成',elapsed:2}])
})
