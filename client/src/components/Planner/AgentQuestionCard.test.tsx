import React from 'react'
import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import AgentQuestionCard from './AgentQuestionCard'
const pending={decision_id:'d',question:'请补充',questions:[{id:'pace',title:'旅行节奏',options:[{id:'easy',label:'轻松',description:'少量景点'},{id:'busy',label:'紧凑'}]},{id:'food',title:'饮食要求',options:[]}]}
it('requires explicit answers and submits options together with custom text',async()=>{
  const send=vi.fn().mockResolvedValue(true)
  render(<AgentQuestionCard pending={pending} active busy={false} onAnswer={send}/> )
  expect(screen.getByRole('button',{name:'提交回答'})).toBeDisabled()
  fireEvent.click(screen.getByLabelText(/轻松/))
  fireEvent.change(screen.getByLabelText('饮食要求自己输入'),{target:{value:'不吃辣'}})
  fireEvent.click(screen.getByRole('button',{name:'提交回答'}))
  await waitFor(()=>expect(send).toHaveBeenCalledWith('旅行节奏：轻松\n饮食要求：不吃辣',undefined,[{question_id:'pace',option_id:'easy',text:'轻松'},{question_id:'food',option_id:null,text:'不吃辣'}]))
})
it('retains an old confirmation without leaving active approval controls',()=>{
  render(<AgentQuestionCard pending={{decision_id:'d',question:'确认大方向',choices:['approve','decline']}} active={false} busy={false} onAnswer={vi.fn()}/> )
  expect(screen.getByText('确认大方向')).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
it('keeps explicit approval controls when an empty question array is present',async()=>{
  const send=vi.fn().mockResolvedValue(true)
  render(<AgentQuestionCard pending={{decision_id:'d',question:'确认方案',questions:[],choices:['approve','decline']}} active busy={false} onAnswer={send}/> )
  fireEvent.click(screen.getByLabelText('同意'))
  fireEvent.click(screen.getByRole('button',{name:'提交回答'}))
  await waitFor(()=>expect(send).toHaveBeenCalledWith('同意','approve',undefined))
})
