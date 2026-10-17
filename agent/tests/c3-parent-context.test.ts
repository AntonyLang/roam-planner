import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { AgentRole, Subagents } from '../src/documents.ts';
import { openRuntime } from '../src/runtime.ts';
import { projectRoot, type Config } from '../src/config.ts';

const context = BACKGROUND_CONTEXT;
const textOf = (message: any) => typeof message.content === 'string' ? message.content : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
const answer = (value: string) => fauxAssistantMessage(value);
const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });

async function fixture(route: FauxResponseStep) {
  const directory = await mkdtemp(path.join(projectRoot, '.run/test-c3/runtime-'));
  const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }, { id: 'research', reasoning: true }], tokensPerSecond: 10000 });
  faux.setResponses(Array.from({ length: 100 }, () => route));
  const models = createModels(); models.setProvider(faux.provider);
  const config: Config = { port: 0, host: '127.0.0.1', database: path.join(directory, 'session.sqlite'), cwd: projectRoot,
    skillsDir: path.join(projectRoot, 'agent/skills'), model: { provider: 'faux', modelId: 'main' },
    configuredModels: [{ provider: 'faux', modelId: 'main' }, { provider: 'faux', modelId: 'research' }], thinkingLevel: 'high', mcpServers: {} };
  return openRuntime(config, models);
}

async function submit(runtime: Awaited<ReturnType<typeof openRuntime>>, id: any, content: string, requestId: string) {
  const result = await runtime.submit(id, content, requestId);
  await (await runtime.harness.submission(result.submission_id, context))!.wait(context);
}

async function until(check: () => Promise<boolean>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for durable subagent state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function entries(runtime: Awaited<ReturnType<typeof openRuntime>>, id: any) {
  return (await runtime.storage.scanEntries({ conversationId: id, order: 'ascending' }, 200, undefined, context)).items;
}

test('child lists bounded context, pages older facts, and reads only selected text after a parent update', async () => {
  const longFact = `EARLY_CONSTRAINT_SENTINEL:${'😀'.repeat(340)}`;
  const latestFact = 'LATEST_PARENT_UPDATE_SENTINEL: 预算上限仍为 633 元。';
  const toolFact = 'SUCCESSFUL_TOOL_RESULT_SENTINEL: source table verified.';
  const toolFile = path.join(projectRoot, '.run/test-c3/parent-tool-result.txt');
  await mkdir(path.dirname(toolFile), { recursive: true });
  await writeFile(toolFile, toolFact, 'utf8');

  let releaseFirstPage!: () => void;
  let sawFirstPage!: () => void;
  const firstPageGate = new Promise<void>(resolve => { releaseFirstPage = resolve; });
  const firstPageReady = new Promise<void>(resolve => { sawFirstPage = resolve; });
  let pauseFirstPage = true;
  let earlyId: number | undefined;
  let latestId: number | undefined;
  let toolResultId: number | undefined;
  let summaryId: number | undefined;
  const listPages: any[] = [];
  const readPages: any[] = [];
  const childRequests: any[] = [];

  const route: FauxResponseStep = async (request, _, __, model) => {
    const last: any = request.messages.findLast(message => message.role !== 'system')!;
    const text = textOf(last);
    if (model.id === 'research') {
      childRequests.push(request);
      if (last.role !== 'toolResult') return call('subagent', { action: 'read_parent_context', operation: 'list' });
      if (last.toolName !== 'subagent') return answer('Child context read complete.');
      const result = JSON.parse(text);
      if (Array.isArray(result.entries) && Object.hasOwn(result, 'next_cursor')) {
        listPages.push(result);
        if (pauseFirstPage) {
          pauseFirstPage = false;
          sawFirstPage();
          await firstPageGate;
        }
        for (const entry of result.entries) {
          if (entry.preview.includes('EARLY_CONSTRAINT_SENTINEL')) earlyId = entry.entry_id;
          if (entry.preview.includes('LATEST_PARENT_UPDATE_SENTINEL')) latestId = entry.entry_id;
          if (entry.preview.includes('SUCCESSFUL_TOOL_RESULT_SENTINEL')) toolResultId = entry.entry_id;
        }
        if (earlyId && latestId && toolResultId && summaryId) {
          return call('subagent', { action: 'read_parent_context', operation: 'read', entry_ids: [earlyId, latestId, toolResultId, summaryId], limit_chars: 128 });
        }
        if (result.next_cursor) return call('subagent', { action: 'read_parent_context', operation: 'list', cursor: result.next_cursor });
        throw new Error('Expected parent-context catalog to include the requested visible facts');
      }
      if (Array.isArray(result.entries) && Array.isArray(result.unavailable_entry_ids)) {
        readPages.push(result);
        const early = result.entries.find((entry: any) => entry.entry_id === earlyId);
        if (early?.next_offset_chars !== null && early?.next_offset_chars !== undefined) {
          return call('subagent', { action: 'read_parent_context', operation: 'read', entry_ids: [earlyId], offset_chars: early.next_offset_chars, limit_chars: 128 });
        }
        return answer('Parent context was read in bounded pages.');
      }
      return answer('Unexpected context response.');
    }
    if (last.role === 'toolResult' && last.toolName === 'read') return answer('Read fixture loaded.');
    if (text.includes('seed-tool-result')) return call('read', { path: '.run/test-c3/parent-tool-result.txt' });
    if (text.includes('start-child')) return call('subagent', { action: 'spawn_agent', name: 'context_reader', message: 'Find the early constraint and latest user update; read the successful source result.', model: 'faux/research' });
    return answer('Stored.');
  };
  const runtime = await fixture(route);
  try {
    const main = await runtime.create(1);
    const mainAgent = await main.agent(context);
    const mainSchema = JSON.stringify(mainAgent.tools.find(tool => tool.name === 'subagent')!.parameters);
    assert.ok(!mainSchema.includes('read_parent_context'), 'the main role keeps its existing subagent schema');

    await submit(runtime, main.id, 'seed-tool-result', 'seed-tool-result');
    const toolEntry = (await entries(runtime, main.id)).find(entry => entry.kind === 'pi.tool-result' &&
      entry.model?.some((message: any) => message.role === 'toolResult' && message.toolName === 'read' && !message.isError));
    assert.ok(toolEntry, 'the fixture created a real successful local read result');
    toolResultId = toolEntry!.id;
    const seedInput = (await entries(runtime, main.id)).find(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('seed-tool-result'))!;

    const seed = await runtime.harness.commit(async tx => {
      await tx.appendEntry(main.id, { kind: 'pi.system', model: [{ role: 'system', content: 'SYSTEM_PRIVATE_SENTINEL', timestamp: Date.now() }] });
      await tx.appendEntry(main.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([fauxThinking('THINKING_PRIVATE_SENTINEL'), fauxText('acknowledged')])] });
      await tx.appendEntry(main.id, { kind: 'app.agent-message', model: [{ role: 'user', content: 'APP_MESSAGE_PRIVATE_SENTINEL', timestamp: Date.now() }] });
      await tx.appendEntry(main.id, { kind: 'app.agent-report', model: [{ role: 'user', content: 'APP_REPORT_PRIVATE_SENTINEL', timestamp: Date.now() }] });
      const activeStartId = seedInput.id;
      for (let index = 0; index < 16; index++) {
        await tx.appendEntry(main.id, { kind: 'pi.user', model: [{ role: 'user', content: `older filler ${index}`, timestamp: Date.now() }] });
      }
      const early = await tx.appendEntry(main.id, { kind: 'pi.user', model: [{ role: 'user', content: longFact, timestamp: Date.now() }] });
      for (let index = 0; index < 15; index++) {
        await tx.appendEntry(main.id, { kind: 'pi.user', model: [{ role: 'user', content: `later filler ${index}`, timestamp: Date.now() }] });
      }
      const summary = await tx.appendEntry(main.id, { kind: 'pi.compaction', head: activeStartId,
        model: [{ role: 'user', content: 'GENERATED_SUMMARY_SENTINEL: retained parent constraints.', timestamp: Date.now() }] });
      return { earlyId: early.id, summaryId: summary.id };
    }, context);
    earlyId = seed.earlyId;
    summaryId = seed.summaryId;

    const started = await runtime.submit(main.id, 'start-child', 'start-context-reader');
    await (await runtime.harness.submission(started.submission_id, context))!.wait(context);
    await firstPageReady;
    await submit(runtime, main.id, latestFact, 'latest-parent-update');
    releaseFirstPage();

    await until(async () => (await runtime.harness.snapshot(Subagents, main.id, context))?.agents.context_reader?.status === 'completed');
    await runtime.harness.waitForIdle(context);

    const childId = (await runtime.harness.snapshot(Subagents, main.id, context))!.agents.context_reader.conversationId;
    const child = (await runtime.harness.conversation(childId, context))!;
    const childParameters: any = (await child.agent(context)).tools.find(tool => tool.name === 'subagent')!.parameters;
    assert.equal(childParameters.type, 'object', 'provider schema converters receive a root object');
    assert.ok(childParameters.properties.action && childParameters.properties.operation && childParameters.properties.entry_ids);
    const childSchema = JSON.stringify(childParameters);
    assert.ok(childSchema.includes('send_message'));
    assert.ok(childSchema.includes('read_parent_context'));
    assert.ok(childRequests.length > 0);
    const initialChildPrompt = JSON.stringify(childRequests[0].messages);
    for (const secret of [longFact, latestFact, toolFact, 'GENERATED_SUMMARY_SENTINEL', 'SYSTEM_PRIVATE_SENTINEL', 'THINKING_PRIVATE_SENTINEL', 'APP_MESSAGE_PRIVATE_SENTINEL', 'APP_REPORT_PRIVATE_SENTINEL']) {
      assert.ok(!initialChildPrompt.includes(secret), `parent material is not copied into the initial child prompt: ${secret.slice(0, 32)}`);
    }
    assert.ok(listPages.length >= 4, 'catalog pagination reaches entries beyond the first page and restarts after a parent update');
    assert.ok(listPages.every(page => !JSON.stringify(page).includes(longFact)), 'the catalog exposes previews, not complete user bodies');
    assert.ok(listPages.flatMap(page => page.entries).every((entry: any) => !['pi.system', 'pi.assistant', 'app.agent-message', 'app.agent-report'].includes(entry.kind)));
    assert.ok(listPages.flatMap(page => page.entries).some((entry: any) => entry.kind === 'pi.tool-result' && entry.tool_name === 'read' && entry.is_error === false));
    assert.ok(listPages.flatMap(page => page.entries).some((entry: any) => entry.entry_id === summaryId && entry.source === 'generated-summary'));
    const earlyChunks = readPages.flatMap(page => page.entries).filter((entry: any) => entry.entry_id === earlyId).sort((a: any, b: any) => a.offset_chars - b.offset_chars);
    assert.ok(earlyChunks.length >= 2, 'large parent text is continued by character offset');
    assert.equal(earlyChunks.map((entry: any) => entry.text).join(''), longFact);
    assert.ok(readPages.flatMap(page => page.entries).some((entry: any) => entry.entry_id === toolResultId && entry.source === 'successful-tool-result' && entry.text === toolFact));
    assert.ok(readPages.flatMap(page => page.entries).some((entry: any) => entry.entry_id === latestId && entry.text === latestFact));
    assert.ok(readPages.flatMap(page => page.entries).some((entry: any) => entry.entry_id === summaryId && entry.source === 'generated-summary' && entry.text === 'GENERATED_SUMMARY_SENTINEL: retained parent constraints.'));
    assert.equal((await runtime.harness.snapshot(AgentRole, childId, context))?.mainId, main.id);
  } finally {
    releaseFirstPage();
    await runtime.close();
  }
});

test('parent-scoped reads preserve visible fork ancestors and reject unrelated conversations', async () => {
  let ancestorId = 0;
  let unrelatedId = 0;
  let listResult: any;
  let readResult: any;
  const route: FauxResponseStep = (request, _, __, model) => {
    const last: any = request.messages.findLast(message => message.role !== 'system')!;
    const text = textOf(last);
    if (model.id === 'research') {
      if (last.role !== 'toolResult') return call('subagent', { action: 'read_parent_context', operation: 'list' });
      if (last.toolName !== 'subagent') return answer('Fork context checked.');
      const result = JSON.parse(text);
      if (Array.isArray(result.entries) && Object.hasOwn(result, 'next_cursor')) {
        listResult = result;
        return call('subagent', { action: 'read_parent_context', operation: 'read', entry_ids: [ancestorId, unrelatedId], limit_chars: 256 });
      }
      readResult = result;
      return answer('Fork context checked.');
    }
    if (text.includes('start-child')) return call('subagent', { action: 'spawn_agent', name: 'fork_reader', message: 'Read the visible ancestor fact.', model: 'faux/research' });
    if (text.includes('FORK_ANCESTOR_FACT')) return fauxAssistantMessage([fauxThinking('THINKING_PRIVATE_SENTINEL'), fauxText('Acknowledged.')]);
    return answer('Stored.');
  };
  const runtime = await fixture(route);
  try {
    const source = await runtime.create(1);
    await runtime.harness.commit(tx => tx.appendEntry(source.id, { kind: 'pi.system', model: [{ role: 'system', content: 'SYSTEM_PRIVATE_SENTINEL', timestamp: Date.now() }] }), context);
    await submit(runtime, source.id, 'FORK_ANCESTOR_FACT: keep this boundary.', 'fork-ancestor');
    const sourceEntries = await entries(runtime, source.id);
    const ancestor = sourceEntries.find(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('FORK_ANCESTOR_FACT'))!;
    const assistant = sourceEntries.findLast(entry => entry.kind === 'pi.assistant')!;
    ancestorId = ancestor.id;

    const unrelated = await runtime.create(2);
    await submit(runtime, unrelated.id, 'UNRELATED_PRIVATE_FACT', 'unrelated-fact');
    unrelatedId = (await entries(runtime, unrelated.id)).find(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('UNRELATED_PRIVATE_FACT'))!.id;

    const fork = await (await runtime.harness.conversation(source.id, context))!.fork(assistant.id, { ownership: { kind: 'ownerless' } }, context);
    const forkHistory = await runtime.storage.scanEntries({ conversationId: fork.id, order: 'ascending' }, 100, undefined, context);
    const forkAncestor = forkHistory.items.find(entry => entry.id === ancestor.id);
    assert.ok(forkAncestor, 'fork-aware parent scan includes the visible ancestor row');
    assert.notEqual(forkAncestor!.conversationId, fork.id, 'ancestor source provenance remains intact');
    await submit(runtime, fork.id, 'start-child', 'fork-child');
    await until(async () => (await runtime.harness.snapshot(Subagents, fork.id, context))?.agents.fork_reader?.status === 'completed');
    await runtime.harness.waitForIdle(context);

    assert.ok(listResult.entries.some((entry: any) => entry.entry_id === ancestor.id && entry.conversation_id === source.id));
    assert.ok(listResult.entries.every((entry: any) => entry.kind !== 'pi.system' && entry.kind !== 'pi.assistant'));
    assert.ok(!JSON.stringify(listResult).includes('SYSTEM_PRIVATE_SENTINEL'));
    assert.ok(!JSON.stringify(listResult).includes('THINKING_PRIVATE_SENTINEL'));
    assert.deepEqual(readResult.entries.map((entry: any) => entry.entry_id), [ancestor.id]);
    assert.equal(readResult.entries[0].conversation_id, source.id);
    assert.deepEqual(readResult.unavailable_entry_ids, [unrelatedId]);
    assert.ok(!JSON.stringify(readResult).includes('UNRELATED_PRIVATE_FACT'));
  } finally { await runtime.close(); }
});

test('reset handoff is readable while pre-reset parent entries are unavailable', async () => {
  let preResetId = 0;
  let resetId = 0;
  let listResult: any;
  let readResult: any;
  const route: FauxResponseStep = (request, _, __, model) => {
    const last: any = request.messages.findLast(message => message.role !== 'system')!;
    const text = textOf(last);
    if (model.id === 'research') {
      if (last.role !== 'toolResult') return call('subagent', { action: 'read_parent_context', operation: 'list' });
      if (last.toolName !== 'subagent') return answer('Reset context checked.');
      const result = JSON.parse(text);
      if (Array.isArray(result.entries) && Object.hasOwn(result, 'next_cursor')) {
        listResult = result;
        return call('subagent', { action: 'read_parent_context', operation: 'read', entry_ids: [preResetId, resetId], limit_chars: 256 });
      }
      readResult = result;
      return answer('Reset context checked.');
    }
    if (text.includes('start-child')) return call('subagent', { action: 'spawn_agent', name: 'reset_reader', message: 'Read the current handoff.', model: 'faux/research' });
    return answer('Stored.');
  };
  const runtime = await fixture(route);
  try {
    const main = await runtime.create(1);
    await submit(runtime, main.id, 'PRE_RESET_PRIVATE_FACT', 'before-reset');
    preResetId = (await entries(runtime, main.id)).find(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('PRE_RESET_PRIVATE_FACT'))!.id;
    await (await runtime.harness.conversation(main.id, context))!.reset('VISIBLE_RESET_HANDOFF', context);
    const resetEntry = (await entries(runtime, main.id)).findLast(entry => entry.kind === 'pi.reset')!;
    resetId = resetEntry.id;
    await submit(runtime, main.id, 'start-child', 'after-reset');
    await until(async () => (await runtime.harness.snapshot(Subagents, main.id, context))?.agents.reset_reader?.status === 'completed');
    await runtime.harness.waitForIdle(context);

    assert.ok(listResult.entries.some((entry: any) => entry.entry_id === resetId && entry.source === 'reset-handoff'));
    assert.ok(!JSON.stringify(listResult).includes('PRE_RESET_PRIVATE_FACT'));
    assert.deepEqual(readResult.entries.map((entry: any) => entry.entry_id), [resetId]);
    assert.deepEqual(readResult.unavailable_entry_ids, [preResetId]);
    assert.equal(readResult.entries[0].text, 'VISIBLE_RESET_HANDOFF');
  } finally { await runtime.close(); }
});
