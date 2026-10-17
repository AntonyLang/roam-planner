import { defineDoc, type ConversationId } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';

export const TravelIndex = defineDoc<{ trips: Record<string, ConversationId> }>({
  kind: 'travel.conversations', version: 1, scope: 'session', initial: () => ({ trips: {} }),
});

export const TravelContext = defineDoc<{
  tripId: number | null; inputRevision: number;
  receipts: { seq: number; kind: string; payload: Record<string, JsonValue> }[];
  draft: JsonValue | null; candidate: JsonValue | null;
}>({
  kind: 'travel.context', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ tripId: null, inputRevision: 0, receipts: [], draft: null, candidate: null }),
});

export { AgentRole,Subagents } from './extensions/subagent-state.ts';
