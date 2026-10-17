import { Type, type AssistantMessage, type ModelThinkingLevel, type ToolResultMessage, type UserMessage } from '@earendil-works/pi-ai';
import {
  AssistantEntry, configure, defineExtension, defineTask, defineTool, hook, LiveDoc, ROOT_CONVERSATION_ID,
  section, ToolTask, wrapTool, type ConversationId, type Cursor, type EntryId, type EntryRecord, type SubmissionId, type DocumentReader, type Harness,
} from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { Subagents, AgentRole } from './subagent-state.ts';

const done = () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }) as const;
const aborted = () => ({ status: 'terminal', outcome: { status: 'aborted' } }) as const;
const background = { ownership: { kind: 'conversation' }, background: true } as const;
const textOf = (message?: AssistantMessage) => (message?.content ?? []).flatMap(c => c.type === 'text' ? [c.text] : []).join('');
const reply = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }] });

type ParentContextText = { source: 'user-message' | 'successful-tool-result' | 'generated-summary' | 'reset-handoff'; text: string; toolName?: string; toolCallId?: string };
type ChildSubagentArgs =
  | { action: 'send_message'; name: 'main'; message: string; kind?: 'question' | 'information' | 'answer'; reply_to?: string }
  | { action: 'read_parent_context'; operation: 'list'; cursor?: string }
  | { action: 'read_parent_context'; operation: 'read'; entry_ids: EntryId[]; offset_chars?: number; limit_chars?: number };

function visibleParentText(entry: EntryRecord): ParentContextText | undefined {
  const text = (message: UserMessage | ToolResultMessage) => typeof message.content === 'string'
    ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  if (entry.kind === 'pi.user') {
    const message = entry.model?.find(item => item.role === 'user') as UserMessage | undefined;
    const content = message && text(message);
    return content ? { source: 'user-message', text: content } : undefined;
  }
  if (entry.kind === 'pi.tool-result') {
    const message = entry.model?.find(item => item.role === 'toolResult') as ToolResultMessage | undefined;
    if (message && !message.isError) {
      const content = text(message);
      return content ? { source: 'successful-tool-result', text: content, toolName: message.toolName, toolCallId: message.toolCallId } : undefined;
    }
    return undefined;
  }
  if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') {
    const message = entry.model?.find(item => item.role === 'user') as UserMessage | undefined;
    const content = message && text(message);
    if (!content) return undefined;
    return { source: entry.kind === 'pi.compaction' ? 'generated-summary' : 'reset-handoff', text: content };
  }
  return undefined;
}

function encodeParentCursor(headId: EntryId | null, tailId: EntryId, after: EntryId) {
  return Buffer.from(JSON.stringify({ headId, tailId, after })).toString('base64url');
}

function codePointLength(text: string) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function codePointSlice(text: string, start: number, end: number) {
  let point = 0;
  let startIndex = text.length;
  for (let index = 0; index < text.length;) {
    if (point === start) startIndex = index;
    if (point === end) return text.slice(startIndex, index);
    const value = text.codePointAt(index)!;
    index += value > 0xffff ? 2 : 1;
    point++;
  }
  return point >= start ? text.slice(startIndex) : '';
}

const Anchor = defineTask<null, { phase: 'done' }, null>({
  name: 'app.subagent-anchor', version: 1, initial: () => ({ phase: 'done' }),
  phases: { done: (_, runtime, context) => runtime.commit(done, context) },
  abort: (_, runtime, context) => runtime.commit(aborted, context),
});

type ReportInput = { mainId: ConversationId; name: string; childId: ConversationId; message: string; messageId: string; kind: string; replyTo: string | null };
const Reporter = defineTask<ReportInput, { phase: 'deliver' } | { phase: 'report'; report: string | null }, null>({
  name: 'app.subagent-reporter', version: 1, initial: () => ({ phase: 'deliver' }),
  phases: {
    deliver: async (task, runtime, context) => {
      const child = (await runtime.conversation(task.input.childId, context))!;
      const submission = await child.submit({ type: 'input', content: `[主 Agent ${task.input.kind}，消息 ${task.input.messageId}${task.input.replyTo ? `，回复 ${task.input.replyTo}` : ''}]\n${task.input.message}`, whenBusy: 'steer',
        requestId: `delegate:${task.id}`, entry: { kind: 'app.agent-message', data: {
          messageId: task.input.messageId, from: 'main', to: task.input.name, kind: task.input.kind, replyTo: task.input.replyTo,
        } } }, context);
      const settled = await submission.wait(context);
      await runtime.commit(async tx => {
        const state = await tx.doc(Subagents, task.input.mainId);
        const record = state.agents[task.input.name];
        let report: string | null = null;
        if (settled.status === 'done' && settled.type === 'input' && !record.reported.includes(settled.answer)) {
          record.reported.push(settled.answer);
          const entry = await tx.entry(AssistantEntry, settled.answer);
          report = textOf(entry?.model?.[0] as AssistantMessage);
          record.report = report;
          if (record.status === 'stopping') record.summary = report;
          else if (record.status !== 'stopped') record.status = state.messages.some(m => m.from === task.input.name && m.kind === 'question' && !m.answered) ? 'waiting' : 'completed';
        } else if (settled.status === 'unanswered' && settled.reason !== 'aborted') {
          record.status = 'failed'; record.report = `研究中断：${settled.reason}`; report = record.report;
        }
        return { status: 'running', checkpoint: { phase: 'report', report } } as const;
      }, context);
    },
    report: async (task, runtime, context) => {
      const state = await runtime.snapshot(Subagents, task.input.mainId, context);
      if (task.state.checkpoint.report && state?.stopState === 'running' && !['stopping', 'stopped'].includes(state.agents[task.input.name].status)) {
        const main = (await runtime.conversation(task.input.mainId, context))!;
        await main.submit({ type: 'input', whenBusy: 'steer', requestId: `report:${task.id}`,
          content: `[子 Agent ${task.input.name} 的研究结果]\n${task.state.checkpoint.report}`,
          entry: { kind: 'app.agent-report', data: { from: task.input.name, conversationId: task.input.childId } } }, context);
      }
      await runtime.commit(done, context);
    },
  },
  abort: (_, runtime, context) => runtime.commit(aborted, context),
});

type StopInput = { mainId: ConversationId; names: string[]; whole: boolean; deadline: number };
type StopState = { phase: 'summarize' } | { phase: 'stop'; submissions: Record<string, SubmissionId> };
export const StopAgents = defineTask<StopInput, StopState, null>({
  name: 'app.stop-agents', version: 1, initial: () => ({ phase: 'summarize' }),
  phases: {
    summarize: async (task, runtime, context) => {
      const state = await runtime.snapshot(Subagents, task.input.mainId, context);
      const main = (await runtime.conversation(task.input.mainId, context))!;
      if (task.input.whole) await main.abort(context);
      const submissions: Record<string, SubmissionId> = {};
      for (const name of task.input.names) {
        const child = (await runtime.conversation(state!.agents[name].conversationId, context))!;
        const result = await child.submit({ type: 'input', whenBusy: 'steer', requestId: `stop-summary:${task.id}:${name}`,
          content: '收到停止命令。停止新增调研，仅用已有上下文最简明地总结：已完成的工作和关键结论；未完成或待答事项；资料引用和继续所需的下一步。输出摘要后结束。',
          entry: { kind: 'app.stop-request', data: { from: 'main', name } } }, context);
        submissions[name] = result.id;
      }
      await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'stop', submissions } }), context);
    },
    stop: async (task, runtime, context) => {
      const state = await runtime.snapshot(Subagents, task.input.mainId, context);
      await Promise.all(task.input.names.map(async name => {
        const child = (await runtime.conversation(state!.agents[name].conversationId, context))!;
        // A native conversation handle waits for ordinary work; the persisted deadline bounds cleanup after restarts.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([child.waitForIdle(context), new Promise<void>(resolve => {
          timer = setTimeout(resolve, Math.max(0, task.input.deadline - Date.now()));
        })]).finally(() => { if (timer) clearTimeout(timer); });
        await child.abort(context, { background: true });
      }));
      // This task belongs to the control conversation, so it can abort the main background scope without joining itself.
      if (task.input.whole) await (await runtime.conversation(task.input.mainId, context))!.abort(context, { background: true });
      await runtime.commit(async tx => {
        const records = await tx.doc(Subagents, task.input.mainId);
        for (const name of task.input.names) {
          const child = records.agents[name];
          const summary = await tx.submissionByRequest(child.conversationId, `stop-summary:${task.id}:${name}`);
          child.summaryComplete = summary?.status === 'done';
          const rows = await tx.scanEntries({ conversationId: child.conversationId, order: 'descending' }, 1);
          const entry = rows.items[0];
          if (entry?.kind === 'pi.assistant') child.summary = textOf(entry.model?.[0] as AssistantMessage);
          child.status = 'stopped';
        }
        if (task.input.whole) records.stopState = 'stopped';
        return done();
      }, context);
    },
  },
  abort: (_, runtime, context) => runtime.commit(aborted, context),
});

export async function listAgentStates(reader: DocumentReader, mainId: ConversationId, context: Context, name?: string) {
  const state = await reader.snapshot(Subagents, mainId, context);
  const agents = await Promise.all(Object.entries(state?.agents ?? {}).filter(([key]) => name === undefined || key === name).map(async ([name, child]) => {
    const live = await reader.snapshot(LiveDoc, child.conversationId, context);
    return { name, ...child, active: !!live?.run, status: live?.run && !['stopping', 'stopped', 'waiting'].includes(child.status) ? 'running' : child.status };
  }));
  return { stopState: state?.stopState ?? 'running', agents, messages: (state?.messages ?? []).filter(message => name === undefined || message.from === name || message.to === name) };
}

export async function requestStop(harness: Harness, mainId: ConversationId, context = BACKGROUND_CONTEXT, names?: string[]) {
  return harness.commit(async tx => {
    const state = await tx.doc(Subagents, mainId);
    if (!names && state.stopState !== 'running') return state.stopTaskId;
    const targets = names ?? Object.keys(state.agents).filter(name => !['completed', 'stopped', 'failed'].includes(state.agents[name].status));
    if (!names) state.stopState = 'stopping';
    for (const name of targets) state.agents[name].status = 'stopping';
    const id = await tx.createTask(StopAgents, { mainId, names: targets, whole: !names, deadline: Date.now() + 10000 },
      { ...background, conversationId: ROOT_CONVERSATION_ID });
    if (!names) state.stopTaskId = id;
    for (const name of targets) state.agents[name].stopTaskId = id;
    return id;
  }, context);
}

export function createSubagentExtensions(allowedModels: { provider: string; modelId: string }[]) {
  const parameters = Type.Object({
    action: Type.Union(['spawn_agent', 'send_message', 'list_agents', 'stop_agent'].map(value => Type.Literal(value))),
    name: Type.Optional(Type.String()), message: Type.Optional(Type.String()),
    kind: Type.Optional(Type.Union([Type.Literal('question'), Type.Literal('information'), Type.Literal('answer')])),
    reply_to: Type.Optional(Type.String()),
    model: Type.Optional(Type.Union(allowedModels.map(model => Type.Literal(`${model.provider}/${model.modelId}`)))),
    thinking_level: Type.Optional(Type.Union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].map(v => Type.Literal(v)))),
  });
  const tool = defineTool({
    name: 'subagent', parameters, replay: 'unsafe',
    description: '委派独立上下文的后台研究、发送消息、列举状态或停止。spawn_agent 提供名称、任务、约束、已有结论、资料入口与交付要求；模型和思考级别可选，默认继承。send_message 接收者 name 为子 Agent 名称，子 Agent 向主 Agent 发消息使用 main；提问用 kind=question，回答可带 reply_to。发送只等待投递，完成报告自动回送。',
    execute: async (args, api, context) => {
      const identity = await api.snapshot(AgentRole, api.conversationId, context);
      const mainId = identity?.mainId ?? api.conversationId;
      if (args.action === 'list_agents') return reply(await listAgentStates(api, mainId, context, args.name));
      if (args.action === 'stop_agent') {
        const state = await api.snapshot(Subagents, mainId, context);
        if (!args.name || !state?.agents[args.name]) throw new Error('Unknown child Agent name');
        await api.commit(async tx => {
          const state = await tx.doc(Subagents, mainId);
          if (state.agents[args.name!].status === 'stopping') return;
          state.agents[args.name!].status = 'stopping';
          state.agents[args.name!].stopTaskId = await tx.createTask(StopAgents, { mainId, names: [args.name!], whole: false, deadline: Date.now() + 10000 },
            { ...background, conversationId: ROOT_CONVERSATION_ID });
        }, context);
        return reply({ name: args.name, status: 'stopping' });
      }
      if (identity?.mainId) {
        const childArgs = args as unknown as ChildSubagentArgs;
        const state = await api.snapshot(Subagents, identity.mainId, context);
        const childName = identity.name;
        if (!childName || state?.agents[childName]?.conversationId !== api.conversationId) throw new Error('Subagent is not linked to this parent');
        if (childArgs.action === 'read_parent_context') {
          if (childArgs.operation === 'list') {
            const requestedCursor = childArgs.cursor
              ? JSON.parse(Buffer.from(childArgs.cursor, 'base64url').toString('utf8')) as { headId: EntryId | null; tailId: EntryId; after: EntryId }
              : undefined;
            return reply(await api.commit(async tx => {
              const parentState = await tx.doc(Subagents, identity.mainId!);
              if (parentState.agents[childName]?.conversationId !== api.conversationId) throw new Error('Subagent is not linked to this parent');
              const tail = (await tx.scanEntries({ conversationId: identity.mainId!, order: 'descending' }, 1)).items[0];
              if (!tail) return { entries: [], next_cursor: null };
              const head = await tx.latestHeadMarker(identity.mainId!);
              const headId = head?.id ?? null;
              const lowerBound = head?.head ?? 0;
              const afterIsBounded = requestedCursor !== undefined && requestedCursor.after >= lowerBound && requestedCursor.after <= requestedCursor.tailId;
              let userAdded = false;
              if (requestedCursor && requestedCursor.tailId < tail.id) {
                const newRange = { conversationId: identity.mainId!, order: 'ascending' as const, minEntryId: (requestedCursor.tailId + 1) as EntryId, maxEntryId: tail.id };
                let deltaCursor: Cursor | undefined;
                do {
                  const page = await tx.scanEntries(newRange, 100, deltaCursor);
                  userAdded = page.items.some(entry => entry.kind === 'pi.user');
                  deltaCursor = page.next;
                } while (deltaCursor && !userAdded);
              }
              const snapshotMatches = requestedCursor?.headId === headId && requestedCursor.tailId <= tail.id && afterIsBounded && !userAdded;
              const snapshotTailId = snapshotMatches ? requestedCursor!.tailId : tail.id;
              let cursor: Cursor | undefined = snapshotMatches ? { after: requestedCursor!.after, order: 'ascending' } : undefined;
              const query = {
                conversationId: identity.mainId!, order: 'ascending' as const,
                ...(head ? { minEntryId: head.head } : {}), maxEntryId: snapshotTailId,
              };
              const entries: Array<Record<string, unknown>> = [];
              const add = (entry: EntryRecord) => {
                const visible = visibleParentText(entry);
                if (!visible) return;
                entries.push({
                  entry_id: entry.id, conversation_id: entry.conversationId, kind: entry.kind, source: visible.source,
                  ...(visible.toolName ? { tool_name: visible.toolName, tool_call_id: visible.toolCallId, is_error: false } : {}),
                  character_count: codePointLength(visible.text), preview: codePointSlice(visible.text, 0, 120),
                });
              };
              if (!snapshotMatches && head) add(head);
              let nextAfter: EntryId | undefined;
              let hasMore = false;
              while (entries.length < 12) {
                const page = await tx.scanEntries(query, 48, cursor);
                if (!page.items.length) break;
                let reachedPageSize = false;
                for (let index = 0; index < page.items.length; index++) {
                  const entry = page.items[index]!;
                  cursor = { after: entry.id, order: 'ascending' };
                  if (entry.head === undefined) add(entry);
                  if (entries.length === 12) {
                    nextAfter = entry.id;
                    hasMore = index < page.items.length - 1 || page.next !== undefined;
                    reachedPageSize = true;
                    break;
                  }
                }
                if (reachedPageSize || !page.next) break;
                cursor = page.next;
              }
              return {
                entries,
                next_cursor: hasMore && nextAfter !== undefined ? encodeParentCursor(headId, snapshotTailId, nextAfter) : null,
              };
            }, context));
          }
          if (childArgs.operation !== 'read') throw new Error('read_parent_context operation must be list or read');
          if (!childArgs.entry_ids?.length) throw new Error('entry_ids are required for a parent-context read');
          const offset = childArgs.offset_chars ?? 0;
          const limit = childArgs.limit_chars ?? 2000;
          return reply(await api.commit(async tx => {
            const parentState = await tx.doc(Subagents, identity.mainId!);
            if (parentState.agents[childName]?.conversationId !== api.conversationId) throw new Error('Subagent is not linked to this parent');
            const head = await tx.latestHeadMarker(identity.mainId!);
            const tail = (await tx.scanEntries({ conversationId: identity.mainId!, order: 'descending' }, 1)).items[0];
            const entries: Array<Record<string, unknown>> = [];
            const unavailable: EntryId[] = [];
            for (const id of childArgs.entry_ids) {
              const inRange = !!tail && id <= tail.id && (head === undefined || id >= head.head);
              const entry = head?.id === id ? head : inRange
                ? (await tx.scanEntries({ conversationId: identity.mainId!, minEntryId: id, maxEntryId: id, order: 'ascending' }, 1)).items[0]
                : undefined;
              const visible = entry && (entry.head === undefined || entry.id === head?.id) ? visibleParentText(entry) : undefined;
              if (!entry || !visible) {
                unavailable.push(id);
                continue;
              }
              const total = codePointLength(visible.text);
              const start = Math.min(offset, total);
              const end = Math.min(offset + limit, total);
              const page = codePointSlice(visible.text, start, end);
              entries.push({
                entry_id: entry.id, conversation_id: entry.conversationId, kind: entry.kind, source: visible.source,
                ...(visible.toolName ? { tool_name: visible.toolName, tool_call_id: visible.toolCallId, is_error: false } : {}),
                offset_chars: offset, total_characters: total, text: page,
                next_offset_chars: end < total ? end : null,
              });
            }
            return { entries, unavailable_entry_ids: unavailable };
          }, context));
        }
        if (!childArgs.message || !childArgs.name) throw new Error('name and message are required');
        const id = `message:${api.taskId}`;
        let active = true;
        await api.commit(async tx => {
          const state = await tx.doc(Subagents, identity.mainId!);
          state.messages.push({ id, from: childName, to: 'main', kind: childArgs.kind ?? 'information', text: childArgs.message, replyTo: childArgs.reply_to ?? null, answered: false });
          if (childArgs.reply_to) {
            const question = state.messages.find(m => m.id === childArgs.reply_to && m.from === 'main' && m.to === childName);
            if (question) question.answered = true;
          }
          active = state.stopState === 'running' && !['stopping','stopped'].includes(state.agents[childName].status);
          if (active && childArgs.kind === 'question') state.agents[childName].status = 'waiting';
          if (!active) await tx.appendEntry(identity.mainId!, { kind: 'app.agent-message', data: { from: childName, messageId: id, text: childArgs.message } });
        }, context);
        if (active) await (await api.conversation(identity.mainId!, context))!.submit({ type: 'input', content: `[子 Agent ${childName} ${childArgs.kind ?? 'information'}，消息 ${id}${childArgs.reply_to ? `，回复 ${childArgs.reply_to}` : ''}]\n${childArgs.message}`,
          requestId: `agent-message:${id}`, whenBusy: 'steer', entry: { kind: 'app.agent-message', data: { from: childName, messageId: id, kind: childArgs.kind ?? 'information' } } }, context);
        return reply({ message_id: id, accepted: true });
      }
      if (!args.message || !args.name) throw new Error('name and message are required');
      const id = `message:${api.taskId}`;
      await api.commit(async tx => {
        const state = await tx.doc(Subagents, mainId);
        if (state.stopState !== 'running') throw new Error('Planning is stopped; resume before delegating');
        if (args.action === 'spawn_agent') {
          if (state.agents[args.name!]) throw new Error('Name already exists; send_message to continue its conversation');
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } });
          const model = args.model ? allowedModels.find(m => `${m.provider}/${m.modelId}` === args.model)! : undefined;
          await configure(tx, child.id, { extensions: { add: [childRole] },
            ...(model ? { model } : {}), ...(args.thinking_level ? { thinkingLevel: args.thinking_level as ModelThinkingLevel } : {}),
            instructions: `你是研究子 Agent ${args.name}，主 Agent 会话 ${mainId}。按委派要求独立研究和交付；任务资料足够时直接处理，需要核验或补充原始依据时再用 subagent.read_parent_context 按需列表/读取。仍缺资料时用 subagent.send_message 向 main 提问，不猜未提供的文件或数据路径。完成报告由程序回送。` });
          const role = await tx.doc(AgentRole, child.id);
          role.mainId = mainId; role.name = args.name!;
          state.agents[args.name!] = { conversationId: child.id, task: args.message!, status: 'running', reported: [], report: '', summary: '', reporters: [], summaryComplete: false, stopTaskId: null };
        }
        const record = state.agents[args.name!];
        if (!record) throw new Error('Unknown child Agent name');
        record.status = 'running';
        state.messages.push({ id, from: 'main', to: args.name!, kind: args.kind ?? 'information', text: args.message!, replyTo: args.reply_to ?? null, answered: false });
        if (args.reply_to) {
          const question = state.messages.find(m => m.id === args.reply_to && m.from === args.name);
          if (question) question.answered = true;
        }
        const reporter = await tx.createTask(Reporter, { mainId, name: args.name!, childId: record.conversationId,
          message: args.message!, messageId: id, kind: args.kind ?? 'information', replyTo: args.reply_to ?? null }, background);
        record.reporters.push(reporter);
      }, context);
      return reply({ name: args.name, message_id: id, accepted: true });
    },
  });
  const childParameters = Type.Object({
    action: Type.Union([Type.Literal('send_message'), Type.Literal('read_parent_context')]),
    operation: Type.Optional(Type.Union([Type.Literal('list'), Type.Literal('read')])),
    name: Type.Optional(Type.Literal('main')), message: Type.Optional(Type.String()),
    kind: Type.Optional(Type.Union([Type.Literal('question'), Type.Literal('information'), Type.Literal('answer')])),
    reply_to: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()),
    entry_ids: Type.Optional(Type.Array(Type.Integer(), { minItems: 1, maxItems: 4 })),
    offset_chars: Type.Optional(Type.Integer({ minimum: 0 })), limit_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  });
  const childRole = defineExtension({ name: 'subagent-role', wraps: [wrapTool(tool, original => ({ ...original,
    description: '你是子 Agent。只能使用 send_message（必填 name="main" 与 message）或 read_parent_context（operation=list 可选 cursor；operation=read 必填 entry_ids，可选字符分页）；不能创建其他子 Agent。提问用 kind=question，回答用 kind=answer 和 reply_to 关联问题消息 ID。',
    // This child-role root object keeps properties visible to provider schema converters while narrowing available actions.
    parameters: childParameters as unknown as typeof parameters,
  }))] });
  const extension = defineExtension({ name: 'subagent', tools: [tool], tasks: [Anchor, Reporter, StopAgents],
    sections: [section('subagent-state', async (input, context) => {
      const role = await input.read.snapshot(AgentRole, input.conversationId, context);
      if (role?.mainId) return undefined;
      const state = await input.read.snapshot(Subagents, input.conversationId, context);
      return state ? JSON.stringify({ stopState: state.stopState, pending_questions: state.messages.filter(m => m.kind === 'question' && !m.answered), agents: Object.fromEntries(Object.entries(state.agents).map(([name, child]) => [name,
        { conversationId: child.conversationId, status: child.status, task: child.task, summary: child.summary }])) }) : undefined;
    })],
    hooks: [hook(ToolTask, { beforeTool: async (call, api, context) => {
      const role = await api.snapshot(AgentRole, api.conversationId, context);
      const state = await api.snapshot(Subagents, role?.mainId ?? api.conversationId, context);
      if (role?.mainId && state?.agents[role.name!]?.status === 'stopping') return { block: '正在停止。仅用已有上下文输出最简明进度摘要。' };
      if (!role?.mainId && state?.stopState !== undefined && state.stopState !== 'running') return { block: '规划已停止，等待用户主动继续。' };
    } })],
  });
  return { extension, childRole };
}
