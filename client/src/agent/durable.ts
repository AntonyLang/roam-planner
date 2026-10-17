import axios from 'axios';
import { useEffect, useState } from 'react';

export const agentApi = axios.create({ baseURL: '/agent-api', timeout: 15000 });
export type NativeMessage = { role: string; content: string | any[]; [key: string]: any };
export type NativeEntry = { id: number; kind: string; model?: NativeMessage[]; data?: any; byTaskId?: number };
export type ChildAgent = { name: string; conversationId: number; task: string; status: string; report: string; summary: string; summaryComplete: boolean };
export const messageText = (message?: NativeMessage) => typeof message?.content === 'string' ? message.content :
  (message?.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');

function mergeEntries(prior: NativeEntry[], incoming: NativeEntry[]) {
  const entries = new Map(prior.map(entry => [entry.id, entry]));
  for (const entry of incoming) entries.set(entry.id, entry);
  return [...entries.values()].sort((a, b) => a.id - b.id);
}

export function useDurableConversation(id?: string, base = '/agent-api') {
  const [entries, setEntries] = useState<NativeEntry[]>([]);
  const [partial, setPartial] = useState<NativeMessage>();
  const [running, setRunning] = useState(false);
  const [tools, setTools] = useState<any[]>([]);
  const [children, setChildren] = useState<ChildAgent[]>([]);
  const [stopState, setStopState] = useState('running');
  const [agentConfig, setAgentConfig] = useState<{ model?: { provider: string; modelId: string }; thinkingLevel?: string }>();
  const [travel, setTravel] = useState<any>();
  const [error, setError] = useState('');
  useEffect(() => {
    setEntries([]); setPartial(undefined); setTools([]); setChildren([]); setTravel(undefined); setAgentConfig(undefined); setStopState('running'); setRunning(false); setError('');
    if (!id) return;
    const abort = new AbortController();
    const loadHistory = async () => {
      let cursor: unknown;
      do {
        const { data } = await axios.get(`${base}/v1/conversations/${id}/entries`, {
          params: cursor ? { cursor: JSON.stringify(cursor) } : {}, signal: abort.signal,
        });
        if(abort.signal.aborted)return;
        setEntries(prior => mergeEntries(prior, data.items)); cursor = data.next;
      } while (cursor && !abort.signal.aborted);
    };
    void loadHistory().catch(() => { if (!abort.signal.aborted) setError('无法读取会话历史'); });
    const events = new EventSource(`${base}/v1/conversations/${id}/events`);
    events.addEventListener('open', () => setError(''));
    events.addEventListener('session', event => {
      const batch = JSON.parse((event as MessageEvent).data).events;
      for (const item of batch) {
        if (item.type === 'snapshot') {
          setEntries(prior => mergeEntries(prior, item.entries)); setRunning(!!item.run);
          setPartial(item.generation?.message); setTools(item.tools); setAgentConfig(item.agent);
        } else if (item.type === 'message_end' || item.type === 'entry_appended') {
          setEntries(prior => mergeEntries(prior, [item.entry]));
          if (item.entry.model?.[0]?.role === 'assistant') setPartial(undefined);
        } else if (item.type === 'run_start') setRunning(true);
        else if (item.type === 'run_end') { setRunning(false); setPartial(undefined); }
        else if (item.type === 'message_start' && item.message.role === 'assistant') setPartial(item.message);
        else if (item.type === 'message_update') setPartial(prior => {
          let current = prior ?? { role: 'assistant', content: [] };
          let content = typeof current.content === 'string' ? [{ type: 'text', text: current.content }] : [...current.content];
          for (const change of item.changes) {
            if (change.type === 'message') { current = change.message; content = [...current.content as any[]]; }
            else if (change.type === 'block' || change.type.endsWith('_start')) content[change.contentIndex] = { ...change.block };
            else if (change.type === 'text_delta' || change.type === 'thinking_delta') {
              const key = change.type === 'text_delta' ? 'text' : 'thinking';
              content[change.contentIndex] = { ...content[change.contentIndex], [key]: (content[change.contentIndex]?.[key] ?? '') + change.delta };
            }
          }
          return { ...current, content };
        });
        else if (item.type === 'tool_execution_start') setTools(prior => [...prior, { callId: item.toolCallId, name: item.toolName, arguments: item.args, status: 'running' }]);
        else if (item.type === 'tool_execution_end') setTools(prior => prior.filter(tool => tool.callId !== item.toolCallId));
        else if (item.type === 'task_failed') setError(item.message);
        else if (item.type === 'agent_changed') setAgentConfig(item.agent);
      }
    });
    events.addEventListener('subagents', event => {
      const state = JSON.parse((event as MessageEvent).data).state;
      setStopState(state?.stopState ?? 'running');
      setChildren(Object.entries(state?.agents ?? {}).map(([name, record]) => ({ name, ...record as object }) as ChildAgent));
    });
    events.addEventListener('travel', event => setTravel(JSON.parse((event as MessageEvent).data).state));
    events.onerror = () => setError('会话连接已断开，正在重新连接；后台工作继续。');
    return () => { abort.abort(); events.close(); };
  }, [id, base]);
  const send = async (message: string) => {
    await axios.post(`${base}/v1/conversations/${id}/messages`, { message, request_id: crypto.randomUUID() });
  };
  const stop = async () => { try { await axios.post(`${base}/v1/conversations/${id}/stop`); } catch { setError('停止命令未送达，请重试。'); } };
  const resume = async () => { try { await axios.post(`${base}/v1/conversations/${id}/continue`, { request_id: crypto.randomUUID() }); } catch { setError('继续命令未送达，请重试。'); } };
  return { entries, partial, running, tools, children, stopState, agentConfig, travel, error, send, stop, resume };
}
