import { defineDoc, type ConversationId, type EntryId, type TaskId } from '@earendil-works/pi-durable';

export const AgentRole=defineDoc<{mainId:ConversationId|null;name:string|null}>({
  kind:'app.agent-role',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({mainId:null,name:null}),
});

export type Child = {
  conversationId: ConversationId; task: string; status: string; reported: EntryId[];
  report: string; summary: string; reporters: TaskId[];
  summaryComplete: boolean; stopTaskId: TaskId | null;
};
export type AgentMessage = {
  id: string; from: string; to: string; kind: string; text: string; replyTo: string | null; answered: boolean;
};
export const Subagents = defineDoc<{
  stopState: 'running' | 'stopping' | 'stopped'; agents: Record<string, Child>; messages: AgentMessage[];
  stopTaskId: TaskId | null;
}>({
  kind: 'app.subagents', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ stopState: 'running', agents: {}, messages: [], stopTaskId: null }),
});
