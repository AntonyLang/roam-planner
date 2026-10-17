import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, configure, Harness, type ConversationId, type Extension, defineExtension, watchEvents } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import { createReadTool } from '@earendil-works/pi-durable/tools';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createTrekDeliveryExtension, createTravelExtension, invokeTravelMcp, travelCoreTools } from './extensions/travel.ts';
import { TravelContext, TravelIndex, Subagents, AgentRole } from './documents.ts';
import { createSubagentExtensions, listAgentStates, requestStop } from './extensions/subagent.ts';
import { createMcpConnections } from './extensions/mcp.ts';
import { configuredModels } from './models.ts';
import type { Config } from './config.ts';

export type RuntimeOptions = {
  deliveryExtension?: Extension;
  disableLocalRead?: boolean;
  disableSubagents?: boolean;
  disableRetries?: boolean;
  includeSkillCatalog?: boolean;
  includeMcpTool?: (server: string, remoteName: string) => boolean;
  signal?: AbortSignal;
  onTravelReceipts?: (receipts: readonly unknown[]) => void | Promise<void>;
};

export async function openRuntime(config: Config, providedModels?: Models, options: RuntimeOptions = {}) {
  const context = BACKGROUND_CONTEXT;
  const registry = createRegistry();
  const { extension, childRole } = createSubagentExtensions(config.configuredModels);
  registry.install(extension); registry.install(childRole);
  const localReadExtension = defineExtension({ name: 'local-read', tools: [createReadTool()] });
  registry.install(localReadExtension);
  const emptyToolSearchExtension = defineExtension({ name: 'tool-search', tools: [] });
  registry.install(emptyToolSearchExtension);
  registry.install(createTravelExtension(config.skillsDir, { includeCatalog: options.includeSkillCatalog !== false }));
  registry.install(options.deliveryExtension ?? createTrekDeliveryExtension());
  const mcpConnections=createMcpConnections(config.mcpServers,registry,{invoke:(server,tool,args,api,callContext,call)=>
    invokeTravelMcp(server,tool,args,api,callContext,call,options.onTravelReceipts),
    defer:(server,tool)=>server==='trek'&&!travelCoreTools.has(tool.name),
    include:(server,tool)=>!(server==='trek'&&['save_planning_candidate','validate_trip_draft'].includes(tool.name))
      && (options.includeMcpTool?.(server,tool.name) ?? true),
    signal: options.signal,
  });
  let toolSearchEnabled = false;
  const syncToolSearch = () => {
    const enabled = registry.snapshot().tools().some(({ tool }) => tool.deferred === true);
    if (enabled === toolSearchEnabled) return;
    registry.install(enabled ? createToolSearchExtension() : emptyToolSearchExtension);
    toolSearchEnabled = enabled;
  };
  const mcp = {
    ...mcpConnections,
    connect: async () => {
      await mcpConnections.connect();
      syncToolSearch();
    },
  };
  await mkdir(path.dirname(config.database), { recursive: true });
  const storage = await openNodeSqliteStorage(config.database);
  const models = providedModels ?? configuredModels(config);
  const harness = await Harness.open(storage, {
    models, registry,
    ...(options.disableRetries ? { settings: { retry: { enabled: false, maxRetries: 0 }, stream: { maxRetries: 0 } } } : {}),
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? config.cwd }),
  }, context);
  await harness.root(context, { agent: { model: config.model, cwd: config.cwd } });
  await mcp.connect();
  harness.resume();

  async function create(tripId: number) {
    const id = await harness.commit(async tx => {
      const index = await tx.doc(TravelIndex);
      if (index.trips[String(tripId)]) return index.trips[String(tripId)];
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await configure(tx, conversation.id, { model: config.model, thinkingLevel: config.thinkingLevel, cwd: config.cwd,
        extensions: { remove: [
          ...(options.disableLocalRead ? [localReadExtension] : []),
          ...(options.disableSubagents ? [extension, childRole] : [childRole]),
        ] }, instructions: `你是持续主 Agent。会话 ${conversation.id}，固定对应 TREK 旅程 ${tripId}。草稿绑定由运行程序传递；使用 get_planning_snapshot 获取旅程最新信息，按任务需要 prepare_trip_draft。` });
      const data = await tx.doc(TravelContext, conversation.id); data.tripId = tripId;
      await tx.doc(Subagents, conversation.id);
      index.trips[String(tripId)] = conversation.id;
      return conversation.id;
    }, context);
    return (await harness.conversation(id, context))!;
  }
  async function submit(id: ConversationId, content: string, requestId: string) {
    const conversation = (await harness.conversation(id, context))!;
    if ((await harness.snapshot(AgentRole,id,context))?.mainId) throw new Error('请通过主 Agent 转交对子 Agent 的输入。');
    const existing = await storage.submissionByRequest(id, requestId, context);
    if (existing) return { conversation_id: id, submission_id: existing.id, ...existing };
    await mcp.connect();
    await harness.commit(async tx => {
      const state = await tx.doc(Subagents, id); state.stopState = 'running';
      const data = await tx.doc(TravelContext, id);
      data.inputRevision++;
      data.receipts.push({ seq: data.receipts.length + 1, kind: 'user_message', payload: { message: content } });
    }, context);
    const submission = await conversation.submit({ type: 'input', content, requestId, whenBusy: 'steer' }, context);
    return { conversation_id: id, submission_id: submission.id, ...(await submission.status(context)) };
  }
  async function state(id: ConversationId) {
    const stream = await watchEvents(harness, id, context);
    const snapshot = stream.snapshot;
    await stream.stop();
    return { conversation_id: id, snapshot, travel: await harness.snapshot(TravelContext, id, context),
      subagents: await listAgentStates(harness, id, context) };
  }
  return { harness, storage, config, models, mcp, create, submit, state, stop: async (id: ConversationId) => {
    const role=await harness.snapshot(AgentRole,id,context);
    return requestStop(harness,role?.mainId??id,context,role?.mainId?[role.name!]:undefined);
  },
    close: async () => { await harness.close(context); await mcp.close(); } };
}
export type TravelRuntime = Awaited<ReturnType<typeof openRuntime>>;
