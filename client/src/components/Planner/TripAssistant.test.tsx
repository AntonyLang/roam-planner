import { fireEvent, render, screen, waitFor } from '../../../tests/helpers/render'
import { expect, it, vi, beforeEach } from 'vitest'
import {http,HttpResponse} from 'msw'
import {server} from '../../../tests/helpers/msw/server'
beforeEach(()=>server.use(http.get('/api/agent/trips/:id/confirmations',()=>HttpResponse.json({keys:[]}))))
import { TripAssistant, type useTripAssistant } from './TripAssistant'

function fixture() {
  return {
    tripId: 7, session: '7', activities: [], accommodations: [], adopted: false, sending: false,
    send: vi.fn().mockResolvedValue(true),
    native: { entries: [], tools: [], children: [], stopState: 'running', running: false, stop: vi.fn() },
  } as unknown as ReturnType<typeof useTripAssistant>
}

it('renders planning Markdown as readable tables and links while keeping user text literal', () => {
  const agent = fixture()
  agent.native.entries = [
    { id: 1, kind: 'pi.user', model: [{ role: 'user', content: '**我的偏好**' }] },
    { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: '## 每日安排\n\n| 日期 | 地点 |\n| --- | --- |\n| 第一天 | 青岛 |\n\n[来源](https://example.com)' }] },
  ]
  render(<TripAssistant agent={agent} />)
  expect(screen.getByRole('heading', { name: '每日安排' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: '青岛' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '来源' })).toHaveAttribute('target', '_blank')
  expect(screen.getByText('**我的偏好**')).toBeInTheDocument()
})

it('keeps composition and Shift+Enter local, sends with Enter and clears only the submitted text', async () => {
  const agent = fixture()
  render(<TripAssistant agent={agent} />)
  const input = screen.getByRole('textbox', { name: '旅行要求或修改意见' })
  fireEvent.change(input, { target: { value: '少走路' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(agent.send).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(agent.send).toHaveBeenCalledWith('少走路'))
  await waitFor(() => expect(input).toHaveValue(''))
})

it('preserves a failed message, lets the user steer background research, and shows stopping distinctly', async () => {
  const agent = fixture()
  agent.native.children = [{ name: '交通', conversationId: 8, status: 'running', task: '查车次', report: '', summary: '', summaryComplete: false }]
  vi.mocked(agent.send).mockResolvedValue(false)
  const { rerender } = render(<TripAssistant agent={agent} />)
  const input = screen.getByRole('textbox', { name: '旅行要求或修改意见' })
  fireEvent.change(input, { target: { value: '改坐火车' } })
  fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
  await waitFor(() => expect(agent.send).toHaveBeenCalledWith('改坐火车'))
  expect(input).toHaveValue('改坐火车')
  fireEvent.click(screen.getByRole('button', { name: '停止' }))
  expect(agent.native.stop).toHaveBeenCalledOnce()
  agent.native.stopState = 'stopping'
  rerender(<TripAssistant agent={{ ...agent }} />)
  expect(screen.getByRole('button', { name: '正在收尾' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '补充要求' })).toBeDisabled()
})

it('offers a return to latest messages without pulling readers away from earlier history', () => {
  const agent = fixture()
  const { container, rerender } = render(<TripAssistant agent={agent} />)
  const body = container.querySelector('.assistant-body') as HTMLElement
  Object.defineProperties(body, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } })
  body.scrollTop = 200
  fireEvent.scroll(body)
  agent.native.partial = { role: 'assistant', content: '新的安排' }
  rerender(<TripAssistant agent={{ ...agent }} />)
  expect(body.scrollTop).toBe(200)
  fireEvent.click(screen.getByRole('button', { name: /回到最新消息/ }))
  expect(body.scrollTop).toBe(1000)
  expect(screen.queryByRole('button', { name: /回到最新消息/ })).not.toBeInTheDocument()
})

it('fills a starter without sending it and clears unsent text when switching trips', () => {
  const agent = fixture()
  const { rerender } = render(<TripAssistant agent={agent} />)
  fireEvent.click(screen.getByRole('button', { name: '帮我安排每天的路线，节奏轻松一些' }))
  expect(screen.getByRole('textbox')).toHaveValue('帮我安排每天的路线，节奏轻松一些')
  expect(agent.send).not.toHaveBeenCalled()
  rerender(<TripAssistant agent={{ ...agent, session: '8' }} />)
  expect(screen.getByRole('textbox')).toHaveValue('')
})
