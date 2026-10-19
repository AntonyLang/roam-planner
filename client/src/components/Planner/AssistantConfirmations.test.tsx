import {fireEvent,render,screen,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import AssistantConfirmations from './AssistantConfirmations'
const api=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}))
vi.mock('../../api/client',()=>({apiClient:api}))
it('shows open cards, dismisses only the confirmed content, and restores its state on reload',async()=>{
  const keys:string[]=[]
  api.get.mockImplementation(async()=>({data:{keys:[...keys]}}))
  api.post.mockImplementation(async(_path,{key})=>{keys.push(key);return {data:{confirmed:true}}})
  const props={tripId:3,stays:[{name:'汉庭',dateRange:'10/20 — 10/22',notes:'三人一间双床房'}],unknowns:['需确认第三人入住费用'],onFocus:vi.fn()}
  const view=render(<AssistantConfirmations {...props}/>)
  await waitFor(()=>expect(api.get).toHaveBeenCalled())
  expect(screen.getByText('三人一间双床房')).toBeVisible()
  expect(view.container.querySelector('details')).toBeNull()
  fireEvent.click(screen.getAllByRole('button',{name:'已确认'})[0])
  await waitFor(()=>expect(screen.queryByText('三人一间双床房')).toBeNull())
  expect(screen.getByText('需确认第三人入住费用')).toBeVisible()
  view.unmount();render(<AssistantConfirmations {...props}/>)
  await waitFor(()=>expect(screen.queryByText('三人一间双床房')).toBeNull())
  expect(screen.getByText('需确认第三人入住费用')).toBeVisible()
})
