import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { openRuntime } from '../src/runtime.ts';
import { projectRoot, type Config } from '../src/config.ts';

const answer = (value: string) => fauxAssistantMessage(value);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

async function fixture(route: (request: any) => any, mcpServers: Config['mcpServers'] = {}) {
  const runs = path.join(projectRoot, '.run/c2-tool-search');
  await mkdir(runs, { recursive: true });
  const directory = await mkdtemp(path.join(runs, 'runtime-'));
  const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }], tokensPerSecond: 10000 });
  faux.setResponses(Array.from({ length: 100 }, () => route));
  const models = createModels();
  models.setProvider(faux.provider);
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    database: path.join(directory, 'session.sqlite'),
    cwd: projectRoot,
    skillsDir: path.join(projectRoot, 'agent/skills'),
    model: { provider: 'faux', modelId: 'main' },
    configuredModels: [{ provider: 'faux', modelId: 'main' }],
    thinkingLevel: 'high',
    mcpServers,
  };
  const runtime = await openRuntime(config, models, {
    disableLocalRead: true,
    disableSubagents: true,
    includeSkillCatalog: false,
  });
  return { runtime, faux };
}

let nextTestTripId = 1;
async function submit(runtime: Awaited<ReturnType<typeof openRuntime>>, content: string, requestId: string) {
  const submission = await runtime.submit((await runtime.create(nextTestTripId++)).id, content, requestId);
  await (await runtime.harness.submission(submission.submission_id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
}

function toolsIn(request: any) {
  return getCurrentTools(request.messages).map(tool => tool.name);
}

test('empty deferred catalog omits tool_search from the actual model request', async () => {
  const requests: string[][] = [];
  const { runtime } = await fixture(request => {
    requests.push(toolsIn(request));
    return answer('done');
  });
  try {
    await submit(runtime, 'simple request', 'empty-catalog');
    assert.equal(requests.length, 1);
    assert.ok(!requests[0].includes('tool_search'));
  } finally {
    await runtime.close();
  }
});

async function mcpFixture() {
  const toolsCalled: string[] = [];
  let ready = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!('id' in rpc)) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (rpc.method === 'initialize' && !ready) {
      response.writeHead(503);
      response.end('fixture is offline');
      return;
    }
    let result: any;
    if (rpc.method === 'initialize') {
      result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    } else if (rpc.method === 'tools/list') {
      result = { tools: [{ name: 'lookup_guide', description: 'Look up a travel guide by topic.', inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } }] };
    } else if (rpc.method === 'tools/call') {
      toolsCalled.push(rpc.params.name);
      result = { content: [{ type: 'text', text: 'guide found' }] };
    } else {
      result = {};
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  return {
    url,
    toolsCalled,
    setReady: () => { ready = true; },
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test('direct benchmark MCP tools remain offered and callable without tool_search', async () => {
  const mcp = await mcpFixture();
  mcp.setReady();
  const requests: string[][] = [];
  const { runtime } = await fixture(request => {
    requests.push(toolsIn(request));
    const last = request.messages.findLast((message: any) => message.role !== 'system');
    if (last.role === 'toolResult') return answer('guide reply');
    return call('mcp__benchmark__lookup_guide', { topic: 'coast' });
  }, { benchmark: { url: mcp.url } });
  try {
    const conversation = await runtime.create(1);
    const submission = await runtime.submit(conversation.id, 'look up a guide', 'direct-benchmark-tool');
    await (await runtime.harness.submission(submission.submission_id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);

    assert.equal(runtime.mcp.status().benchmark.connected, true);
    assert.ok(requests[0].includes('mcp__benchmark__lookup_guide'));
    assert.ok(!requests[0].includes('tool_search'));
    assert.deepEqual(mcp.toolsCalled, ['lookup_guide']);
  } finally {
    await runtime.close();
    await mcp.close();
  }
});

test('explicit reconnect restores tool search and loads a real deferred MCP tool', async () => {
  const mcp = await mcpFixture();
  const requests: string[][] = [];
  const { runtime } = await fixture(request => {
    const names = toolsIn(request);
    requests.push(names);
    const last = request.messages.findLast((message: any) => message.role !== 'system');
    if (last.role === 'user' && String(last.content).includes('before reconnect')) return answer('offline reply');
    if (last.role === 'toolResult' && last.toolName === 'tool_search') return call('mcp__trek__lookup_guide', { topic: 'coast' });
    if (last.role === 'toolResult' && last.toolName === 'mcp__trek__lookup_guide') return answer('guide reply');
    return call('tool_search', { query: 'guide' });
  }, { trek: { url: mcp.url } });
  try {
    const conversation = await runtime.create(1);
    const offline = await runtime.submit(conversation.id, 'before reconnect', 'before-reconnect');
    await (await runtime.harness.submission(offline.submission_id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
    assert.equal(runtime.mcp.status().trek.connected, false);
    assert.ok(!requests[0].includes('tool_search'));

    mcp.setReady();
    await runtime.mcp.connect();
    assert.equal(runtime.mcp.status().trek.connected, true);
    const online = await runtime.submit(conversation.id, 'look up a guide', 'after-reconnect');
    await (await runtime.harness.submission(online.submission_id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);

    assert.ok(requests[1].includes('tool_search'));
    assert.ok(requests[2].includes('mcp__trek__lookup_guide'));
    assert.deepEqual(mcp.toolsCalled, ['lookup_guide']);
  } finally {
    await runtime.close();
    await mcp.close();
  }
});
