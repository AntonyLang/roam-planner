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
