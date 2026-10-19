import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDurableConversation } from './durable';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { ...http, create: () => http } }));
class Events {
  static opened: Events[] = [];
  listeners = new Map<string, (event: any) => void>();
  close = vi.fn();
  onerror?: () => void;
  constructor(public url: string) { Events.opened.push(this); }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
  emit(name: string, value: any) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
}
beforeEach(() => { http.get.mockReset(); http.post.mockReset(); Events.opened = []; vi.stubGlobal('EventSource', Events); });
afterEach(() => vi.unstubAllGlobals());

it('echoes steering input immediately, correlates its queued entry, and retries the same request identity',async()=>{
  http.get.mockResolvedValue({data:{items:[]}});
  let finish!:(value:any)=>void;
  http.post.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
  const {result}=renderHook(()=>useDurableConversation('8'));
  await waitFor(()=>expect(Events.opened).toHaveLength(1));
  let sending!:Promise<void>;
  act(()=>{sending=result.current.send('午后要休息','request-one')});
  expect(result.current.outbox).toEqual([{requestId:'request-one',text:'午后要休息',status:'sending'}]);
  await act(async()=>{finish({data:{status:'queued'}});await sending});
  expect(result.current.outbox[0].status).toBe('queued');
  act(()=>Events.opened[0].emit('session',{events:[{type:'submission',record:{requestId:'request-one',status:'done',entry:51}},{type:'entry_appended',entry:{id:51,kind:'pi.user',model:[{role:'user',content:'午后要休息'}]}}]}));
  await waitFor(()=>expect(result.current.outbox).toHaveLength(0));
  expect(result.current.entries).toHaveLength(1);
  http.post.mockRejectedValueOnce(new Error('offline'));
  await act(async()=>{await result.current.send('预算 5000','request-two').catch(()=>{})});
  expect(result.current.outbox[0]).toMatchObject({text:'预算 5000',status:'failed'});
  http.post.mockResolvedValueOnce({data:{status:'queued'}});
  await act(async()=>{await result.current.retryMessage('request-two')});
  expect(http.post.mock.calls.slice(-2).map(call=>call[1])).toEqual([{message:'预算 5000',request_id:'request-two'},{message:'预算 5000',request_id:'request-two'}]);
  expect(result.current.outbox).toHaveLength(1);
});

it('merges paginated history with native snapshots by numeric IDs and applies live updates', async () => {
  http.get.mockImplementation(async (_: string, config: any) => config.params.cursor
    ? { data: { items: [{ id: 12, kind: 'pi.user', model: [{ role: 'user', content: '后续要求' }] }] } }
    : { data: { items: [{ id: 2, kind: 'pi.user', model: [{ role: 'user', content: '青岛观光' }] }], next: { id: 2 } } });
  const { result, unmount } = renderHook(() => useDurableConversation('7'));
  await waitFor(() => expect(result.current.entries).toHaveLength(2));
  const events = Events.opened[0];
  act(() => events.emit('session', { events: [{ type: 'snapshot', entries: [{ id: 12, kind: 'pi.user' }], run: { inputs: [1] }, tools: [] }] }));
  expect(result.current.entries.map(entry => entry.id)).toEqual([2, 12]);
  expect(result.current.running).toBe(true);
  act(() => events.emit('session', { events: [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: '' } }, { type: 'text_delta', contentIndex: 0, delta: '按区域研究' }] },
  ] }));
  expect(result.current.partial?.content).toEqual([{ type: 'text', text: '按区域研究' }]);
  act(() => events.emit('subagents', { state: { stopState: 'running', agents: { coast: { conversationId: 8, status: 'running' } } } }));
  expect(result.current.children[0].conversationId).toBe(8);
  act(() => events.emit('session', { events: [{ type: 'message_end', entry: { id: 20, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '研究完成' }] }] } }, { type: 'run_end' }] }));
  expect(result.current.entries.map(entry => entry.id)).toEqual([2, 12, 20]);
  expect(result.current.partial).toBeUndefined(); expect(result.current.running).toBe(false);
  unmount(); expect(events.close).toHaveBeenCalled(); expect(http.post).not.toHaveBeenCalled();
});
