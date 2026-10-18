import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { AgentRole, Subagents, TravelContext } from '../src/documents.ts';
import { TREK_DELIVERY_INSTRUCTIONS } from '../src/extensions/travel.ts';
import { openRuntime } from '../src/runtime.ts';
import { projectRoot, type Config } from '../src/config.ts';
import { createAgentServer } from '../src/server.ts';

const context = BACKGROUND_CONTEXT;
const textOf = (message: any) => typeof message.content === 'string' ? message.content : message.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');
const answer = (value: string) => fauxAssistantMessage(value);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
async function until(check: () => Promise<boolean>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for native durable state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(route: FauxResponseStep, mcpServers = {}) {
  await mkdir(path.join(projectRoot, '.run/test-c'), { recursive: true });
  const directory = await mkdtemp(path.join(projectRoot, '.run/test-c/runtime-'));
  const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }, { id: 'research', reasoning: true }], tokensPerSecond: 10000 });
  faux.setResponses(Array.from({ length: 100 }, () => route));
  const models = createModels(); models.setProvider(faux.provider);
  const config: Config = { port: 0, host: '127.0.0.1', database: path.join(directory, 'session.sqlite'), cwd: projectRoot,
    skillsDir: path.join(projectRoot, 'agent/skills'), model: { provider: 'faux', modelId: 'main' },
    configuredModels: [{ provider: 'faux', modelId: 'main' }, { provider: 'faux', modelId: 'research' }], thinkingLevel: 'high', mcpServers };
  return { runtime: await openRuntime(config, models), config, models, faux };
}
test('product API keeps health checks and omits developer management endpoints', async () => {
  const server = createAgentServer({ config: {}, mcp: { status: () => ({ connected: true }) } } as any);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    for (const [path, method] of [['/v1/models', 'GET'], ['/v1/tasks', 'GET'], ['/v1/conversations', 'GET'], ['/v1/conversations', 'POST'], ['/v1/conversations/1/config', 'PUT'], ['/v1/mcp/connect', 'POST'], ['/internal/native-shutdown', 'POST']] as const) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 404, `${method} ${path}`);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function mcpFixture() {
  const calls: any[] = [];
  const resourceCalls: any[] = [];
  let gateStarted = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!('id' in rpc)) { response.writeHead(202); response.end(); return; }
    let result: any;
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (rpc.method === 'tools/list') result = { tools: ['get_planning_snapshot', 'gate', 'validate_trip_draft', 'save_planning_candidate'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } })) };
    else if (rpc.method === 'resources/list') {
      resourceCalls.push({ method: rpc.method, params: rpc.params });
      result = { resources: [{ uri: 'guide://fixture', name: 'Fixture guide' }] };
    }
    else if (rpc.method === 'resources/read') {
      resourceCalls.push({ method: rpc.method, params: rpc.params });
      if (rpc.params.uri === 'guide://fixture/missing') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32002, message: 'fixture resource missing' } }));
        return;
      }
      result = { contents: [{ uri: rpc.params.uri, mimeType: 'text/markdown', text: 'complete original' }] };
    }
    else {
      calls.push(rpc.params);
      if (rpc.params.name === 'gate') {
        gateStarted = true;
        await new Promise<void>(resolve => response.once('close', resolve));
        return;
      }
      result = { content: [{ type: 'text', text: 'source evidence' }], structuredContent: { result: 'source evidence' } };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  return { calls, resourceCalls, url, gateStarted: () => gateStarted, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('fixed trip conversations, native input deduplication and concurrent MCP binding', async () => {
  const mcp = await mcpFixture();
  const { runtime } = await fixture(request => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    return last.role === 'toolResult' ? answer('完成') : call('mcp__trek__get_planning_snapshot', {});
  }, { trek: { url: mcp.url } });
  try {
    const [first, again] = await Promise.all([runtime.create(1), runtime.create(1)]);
    assert.equal(first.id, again.id);
    const other = await runtime.create(2);
    const receipts = await Promise.all([runtime.submit(first.id, '青岛', 'same-input'), runtime.submit(other.id, '济南', 'second-input')]);
    await Promise.all(receipts.map(r => runtime.harness.submission(r.submission_id, context).then(s => s!.wait(context))));
    const duplicate = await runtime.submit(first.id, '青岛', 'same-input');
    assert.equal(duplicate.submission_id, receipts[0].submission_id);
    assert.deepEqual(mcp.calls.map(c => c._meta['io.liketrek.agent'].trip_id).sort(), [1, 2]);
    const remote = mcp.calls.find(c => c._meta['io.liketrek.agent'].trip_id === 1);
    assert.equal(remote._meta['io.liketrek.agent'].session_id, String(first.id));
    const agent = await first.agent(context);
    assert.ok(agent.tools.some(tool => tool.name === 'mcp__trek__read_resource'));
    assert.ok(agent.tools.some(tool => tool.name === 'read'));
    const available = [...agent.tools, ...agent.callable, ...agent.deferred].map(tool => tool.name);
    assert.ok(!available.includes('mcp__trek__validate_trip_draft'));
    assert.ok(!available.includes('mcp__trek__save_planning_candidate'));
  } finally { await runtime.close(); await mcp.close(); }
});

test('MCP resource results and errors are recorded in the main TravelContext for main and child calls', async () => {
  const mcp = await mcpFixture();
  const observed: any[] = [];
  let listThenRead = false;
  let missingThenAnswer = false;
  const childUri = 'guide://fixture/child';
  const route: FauxResponseStep = (request, _, __, model) => {
    observed.push(request);
    const last = request.messages.findLast(m => m.role !== 'system')!;
    const text = textOf(last);
    if (model.id === 'research') {
      const childReadReturned = request.messages.some(message => message.role === 'toolResult' && textOf(message).includes(childUri));
      return childReadReturned
        ? answer('child resource read')
        : call('mcp__sources__read_resource', { uri: childUri });
    }
    if (last.role === 'toolResult') {
      if (listThenRead) {
        listThenRead = false;
        return call('mcp__sources__read_resource', { uri: 'guide://fixture/main' });
      }
      if (missingThenAnswer) {
        missingThenAnswer = false;
        return answer('missing resource was handled');
      }
      return answer('resource operation complete');
    }
    if (text.includes('list-and-read')) {
      listThenRead = true;
      return call('mcp__sources__list_resources', { cursor: 'page-2' });
    }
    if (text.includes('missing-resource')) {
      missingThenAnswer = true;
      return call('mcp__sources__read_resource', { uri: 'guide://fixture/missing' });
    }
    if (text.includes('start-child-resource')) {
      return call('subagent', { action: 'spawn_agent', name: 'reader', message: 'read child resource', model: 'faux/research' });
    }
    return answer('done');
  };
  const { runtime } = await fixture(route, { sources: { url: mcp.url } });
  try {
    const main = await runtime.create(1);
    const first = await runtime.submit(main.id, 'list-and-read', 'main-read');
    await (await runtime.harness.submission(first.submission_id, context))!.wait(context);
    const failed = await runtime.submit(main.id, 'missing-resource', 'main-missing');
    await (await runtime.harness.submission(failed.submission_id, context))!.wait(context);
    const childSubmission = await runtime.submit(main.id, 'start-child-resource', 'child-read');
    await (await runtime.harness.submission(childSubmission.submission_id, context))!.wait(context);
    await until(async () => {
      const [state, travel] = await Promise.all([
        runtime.harness.snapshot(Subagents, main.id, context),
        runtime.harness.snapshot(TravelContext, main.id, context),
      ]);
      const childReadReturned = travel?.receipts.some(receipt => {
        const original = receipt.payload.original as any;
        return receipt.kind === 'tool_result' && receipt.payload.remote_name === 'read_resource' &&
          original?.contents?.some((item: any) => item.uri === childUri);
      });
      return state?.agents.reader?.status === 'completed' && childReadReturned === true;
    });
    await runtime.harness.waitForIdle(context);

    const state = (await runtime.harness.snapshot(Subagents, main.id, context))!;
    const childId = state.agents.reader.conversationId;
    const mainTravel = (await runtime.harness.snapshot(TravelContext, main.id, context))!;
    const childTravel = await runtime.harness.snapshot(TravelContext, childId, context);
    const resourceToolCalls = mainTravel.receipts.filter(row => row.kind === 'tool_call' &&
      ['list_resources', 'read_resource'].includes(String(row.payload.name)));
    const resourceResults = mainTravel.receipts.filter(row => row.kind === 'tool_result' &&
      ['list_resources', 'read_resource'].includes(String(row.payload.remote_name)));
    assert.deepEqual(resourceToolCalls.map(row => row.payload.name),
      ['list_resources', 'read_resource', 'read_resource', 'read_resource']);
    assert.deepEqual(resourceResults.map(row => row.payload.success), [true, true, false, true]);
    assert.deepEqual(mcp.resourceCalls.map(call => call.method), ['resources/list', 'resources/read', 'resources/read', 'resources/read']);

    const resultFor = (callId: unknown) => resourceResults.find(row => row.payload.call_id === callId)!.payload as any;
    const listCall = resourceToolCalls[0];
    const mainReadCall = resourceToolCalls[1];
    const missingReadCall = resourceToolCalls[2];
    const childReadCall = resourceToolCalls[3];
    assert.equal(resultFor(listCall.payload.call_id).original.resources[0].uri, 'guide://fixture');
    const mainReadResult = resultFor(mainReadCall.payload.call_id);
    const mainReadOriginal = mainReadResult.original as Record<string, any>;
    const mainArticle = mainReadOriginal.contents[0];
    assert.equal(mainArticle.uri, 'guide://fixture/main');
    assert.equal(mainArticle.text, 'complete original');
    assert.equal(resultFor(missingReadCall.payload.call_id).success, false);
    const childReadOriginal = resultFor(childReadCall.payload.call_id).original as Record<string, any>;
    assert.equal(childReadOriginal.contents[0].uri, childUri);
    assert.equal(childTravel?.receipts.length ?? 0, 0);

    const deliveredResource = observed.some(request => {
      const message = request.messages.findLast((item: any) => item.role === 'toolResult');
      return message && textOf(message).includes('guide://fixture/main') &&
        textOf(message).includes('complete original') && textOf(message).includes('证据引用：tool:');
    });
    assert.equal(deliveredResource, true);
    const deliveredChildResource = observed.some(request => {
      const message = request.messages.findLast((item: any) => item.role === 'toolResult');
      return message && textOf(message).includes(childUri) &&
        textOf(message).includes('complete original') && textOf(message).includes('证据引用：tool:');
    });
    assert.equal(deliveredChildResource, true);
    const failedOutput = observed.map(request => request.messages.findLast((item: any) => item.role === 'toolResult'))
      .find(message => message && textOf(message).includes('fixture resource missing'));
    assert.ok(failedOutput);
    assert.ok(!textOf(failedOutput).includes('证据引用：tool:'));
  } finally { await runtime.close(); await mcp.close(); }
});

test('production runtime keeps TREK delivery in its own default extension', async () => {
  const requests: any[] = [];
  const { runtime } = await fixture(request => { requests.push(request); return answer('production response'); });
  try {
    const main = await runtime.create(9);
    const submission = await runtime.submit(main.id, 'production prompt', 'production-delivery');
    await (await runtime.harness.submission(submission.submission_id, context))!.wait(context);
    assert.ok(requests.length > 0);
    for (const request of requests) {
      const prompt = request.messages.filter((message: any) => message.role === 'system')
        .flatMap((message: any) => [textOf(message), ...Object.values(message.sections ?? {})]).join('\n');
      assert.equal(prompt.split(TREK_DELIVERY_INSTRUCTIONS).length - 1, 1);
      assert.ok(!prompt.includes('EVALUATION_DELIVERY_SENTINEL'));
    }
  } finally { await runtime.close(); }
});

test('isolated child context, configured model override, questions and automatic report delivery', async () => {
  const route: FauxResponseStep = (request, _, __, model) => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    const text = textOf(last);
    if (last.role === 'toolResult') return answer(model.id === 'research' ? '等待主 Agent 的回答' : '已委派或转交');
    if (model.id === 'research') return text.includes('偏好海边') ? answer('海边研究结论与资料入口') :
      call('subagent', { action: 'send_message', name: 'main', kind: 'question', message: '偏好海边还是博物馆？' });
    if (text.includes('delegate')) return call('subagent', { action: 'spawn_agent', name: 'qingdao', message: '研究青岛。交付结论与入口。', model: 'faux/research', thinking_level: 'low' });
    if (text.includes('question')) return call('subagent', { action: 'send_message', name: 'qingdao', kind: 'answer', reply_to: /消息 ([^\]]+)/.exec(text)![1], message: '偏好海边，继续研究。' });
    return answer('主 Agent 已整合研究');
  };
  const { runtime, config, models } = await fixture(route);
  let reopened = false;
  try {
    const main = await runtime.create(4);
    await runtime.submit(main.id, 'delegate；主会话未转交的背景：PRIVATE_CONTEXT_SENTINEL', 'delegate');
    await until(async () => (await runtime.harness.snapshot(Subagents, main.id, context))?.agents.qingdao?.report.includes('海边研究结论') ?? false);
    const state = (await runtime.harness.snapshot(Subagents, main.id, context))!;
    const child = (await runtime.harness.conversation(state.agents.qingdao.conversationId, context))!;
    const agent = await child.agent(context);
    assert.equal(agent.model?.modelId, 'research'); assert.equal(agent.thinkingLevel, 'low');
    const childSubagentParameters = JSON.stringify(agent.tools.find(t => t.name === 'subagent')!.parameters);
    assert.ok(childSubagentParameters.includes('send_message'));
    assert.ok(childSubagentParameters.includes('read_parent_context'));
    assert.ok(state.messages.some(m => m.kind === 'question' && m.answered));
    const history = await child.entries({ order: 'ascending' }, 100, undefined, context);
    assert.ok(!JSON.stringify(history.items).includes('PRIVATE_CONTEXT_SENTINEL'));
    assert.equal((await runtime.harness.snapshot(AgentRole, child.id, context))?.mainId, main.id);
    await runtime.harness.waitForIdle(context);
    await runtime.close(); reopened = true;
    const next = await openRuntime(config, models);
    try { assert.equal((await next.create(4)).id, main.id); assert.equal((await next.harness.snapshot(Subagents, main.id, context))?.agents.qingdao.conversationId, child.id); }
    finally { await next.close(); }
  } finally { if (!reopened) await runtime.close(); }
});

test('child inherits the main model, thinking level, workspace and MCP tools by default', async () => {
  const mcp = await mcpFixture();
  const { runtime } = await fixture(request => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    return last.role !== 'toolResult' && textOf(last) === 'start'
      ? call('subagent', { action: 'spawn_agent', name: 'inherited', message: '研究青岛' }) : answer('完成研究。');
  }, { sources: { url: mcp.url } });
  try {
    const main = await runtime.create(1);
    await main.configure({ thinkingLevel: 'low' }, context);
    await runtime.submit(main.id, 'start', 'start');
    await until(async () => (await runtime.harness.snapshot(Subagents, main.id, context))?.agents.inherited?.status === 'completed');
    const childId = (await runtime.harness.snapshot(Subagents, main.id, context))!.agents.inherited.conversationId;
    const child = (await runtime.harness.conversation(childId, context))!;
    const childAgent = await child.agent(context), mainAgent = await main.agent(context);
    assert.deepEqual(childAgent.model, mainAgent.model); assert.equal(childAgent.thinkingLevel, 'low');
    assert.equal(childAgent.cwd, mainAgent.cwd);
    assert.deepEqual(childAgent.tools.map(t => t.name).sort(), mainAgent.tools.map(t => t.name).sort());
  } finally { await runtime.close(); await mcp.close(); }
});

test('the child receives the main question ID and associates its answer', async () => {
  const { runtime } = await fixture((request, _, __, model) => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    const text = textOf(last);
    if (last.role === 'toolResult') return answer(model.id === 'research' ? '补充报告完成' : '已发送问题');
    if (model.id === 'research') return text.includes('[主 Agent question')
      ? call('subagent', { action: 'send_message', name: 'main', kind: 'answer', reply_to: /消息 ([^\]]+)/.exec(text)![1], message: '对应市南区章节。' }) : answer('初步研究完成');
    if (text === 'start') return call('subagent', { action: 'spawn_agent', name: 'reader', message: '研究章节', model: 'faux/research' });
    return text.includes('初步研究完成')
      ? call('subagent', { action: 'send_message', name: 'reader', kind: 'question', message: '对应哪个章节？请关联回答这条问题。' }) : answer('已收到补充。');
  });
  try {
    const main = await runtime.create(1); await runtime.submit(main.id, 'start', 'start');
    await until(async () => (await runtime.harness.snapshot(Subagents, main.id, context))?.messages.some(m => m.from === 'main' && m.kind === 'question' && m.answered) ?? false);
    await runtime.harness.waitForIdle(context);
    const messages = (await runtime.harness.snapshot(Subagents, main.id, context))!.messages;
    const question = messages.find(m => m.from === 'main' && m.kind === 'question')!;
    assert.ok(messages.some(m => m.from === 'reader' && m.kind === 'answer' && m.replyTo === question.id));
  } finally { await runtime.close(); }
});

test('child schema prevents nested spawning', async () => {
  const { runtime } = await fixture((request, _, __, model) => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    if (last.role === 'toolResult') return answer('已处理工具结果');
    if (model.id === 'research') return call('subagent', { action: 'spawn_agent', name: 'nested', message: '不应被执行' });
    return textOf(last).includes('start') ? call('subagent', { action: 'spawn_agent', name: 'reader', message: '研究', model: 'faux/research' }) : answer('收到报告');
  });
  try {
    const main = await runtime.create(1); await runtime.submit(main.id, 'start', 'start');
    await until(async () => (await runtime.harness.snapshot(Subagents, main.id, context))?.agents.reader?.status === 'completed');
    const state = (await runtime.harness.snapshot(Subagents, main.id, context))!;
    assert.deepEqual(Object.keys(state.agents), ['reader']);
    const child = (await runtime.harness.conversation(state.agents.reader.conversationId, context))!;
    const entries = await child.entries({ order: 'ascending' }, 100, undefined, context);
    assert.ok(entries.items.some(e => e.model?.[0]?.role === 'toolResult' && e.model[0].isError));
  } finally { await runtime.close(); }
});

test('cooperative stop saves the child summary without waking the stopped main', async () => {
  let mainCalls = 0;
  const { runtime } = await fixture((request, _, __, model) => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    if (model.id === 'research') {
      if (textOf(last).includes('收到停止命令')) return answer('已完成海边资料筛选；待确认偏好；继续读取 guide://fixture。');
      return last.role === 'toolResult' ? answer('等待主 Agent 回答') : call('subagent', { action: 'send_message', name: 'main', kind: 'question', message: '请确认偏好。' });
    }
    mainCalls++;
    return last.role !== 'toolResult' && textOf(last) === 'start'
      ? call('subagent', { action: 'spawn_agent', name: 'coast', message: '研究海边', model: 'faux/research' }) : answer('等待用户补充。');
  });
  try {
    const main = await runtime.create(1); await runtime.submit(main.id, 'start', 'start');
    await until(async () => {
      const child = (await runtime.harness.snapshot(Subagents, main.id, context))?.agents.coast;
      return child?.status === 'waiting' && child.reported.length > 0;
    });
    await runtime.harness.waitForIdle(context);
    const before = mainCalls;
    const stop = await runtime.stop(main.id); await runtime.harness.waitForTask(stop!, context);
    const state = (await runtime.harness.snapshot(Subagents, main.id, context))!;
    assert.equal(state.agents.coast.summaryComplete, true);
    assert.match(state.agents.coast.summary, /已完成海边资料筛选/);
    assert.equal(state.stopState, 'stopped'); assert.equal(mainCalls, before);
  } finally { await runtime.close(); }
});

test('stopping reaches background children; disconnected SSE observers do not stop execution', async () => {
  const mcp = await mcpFixture(); let mainCalls = 0;
  const { runtime } = await fixture((request, _, __, model) => {
    const last = request.messages.findLast(m => m.role !== 'system')!;
    if (model.id === 'main') mainCalls++;
    if (last.role === 'toolResult') return answer('已启动研究');
    if (model.id === 'research') return call('mcp__sources__gate', {});
    return textOf(last).includes('start') ? call('subagent', { action: 'spawn_agent', name: 'background', message: '持续研究', model: 'faux/research' }) : answer('主 Agent 继续处理');
  }, { sources: { url: mcp.url } });
  const server = createAgentServer(runtime);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const main = await runtime.create(1); await runtime.submit(main.id, 'start', 'start');
    await until(async () => mcp.gateStarted());
    const controller = new AbortController();
    const stream = await fetch(`${base}/v1/conversations/${main.id}/events`, { signal: controller.signal });
    assert.match(new TextDecoder().decode((await stream.body!.getReader().read()).value), /snapshot/);
    controller.abort();
    assert.equal((await runtime.harness.snapshot(Subagents, main.id, context))?.stopState, 'running');
    const stop = await runtime.stop(main.id);
    assert.equal(await runtime.stop(main.id), stop);
    await runtime.harness.waitForTask(stop!, context);
    const count = mainCalls;
    const state = (await runtime.harness.snapshot(Subagents, main.id, context))!;
    assert.equal(state.stopState, 'stopped'); assert.equal(state.agents.background.status, 'stopped');
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(mainCalls, count);
    const continued = await runtime.submit(main.id, '继续处理已有进度', 'continue');
    await (await runtime.harness.submission(continued.submission_id, context))!.wait(context);
    assert.equal((await runtime.harness.snapshot(Subagents, main.id, context))?.stopState, 'running');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await runtime.close(); await mcp.close(); }
});
