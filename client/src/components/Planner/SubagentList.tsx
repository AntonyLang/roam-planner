import type { ChildAgent } from '../../agent/durable';

const labels: Record<string, string> = { running: '研究中', waiting: '等待回复', stopping: '正在收尾', stopped: '已停止', completed: '已完成', failed: '中断' };
export default function SubagentList({ agents, onOpen }: { agents: ChildAgent[]; onOpen?: (id: string) => void }) {
  if (!agents.length) return null;
  return <details className="assistant-subagents"><summary>子任务 · {agents.length}</summary>
    {agents.map(agent => <details key={agent.conversationId}><summary>{agent.name} · {labels[agent.status] ?? agent.status}</summary>
      <p>{agent.task}</p>{agent.report && <div className="assistant-message-text">{agent.report}</div>}
      {agent.status === 'stopped' && <div className="assistant-message-text">停止进度{agent.summaryComplete?'':'（摘要未完成，保留已记录进度）'}：{agent.summary || agent.report}</div>}
      {onOpen && <button onClick={() => onOpen(String(agent.conversationId))}>查看子会话</button>}
    </details>)}
  </details>;
}
