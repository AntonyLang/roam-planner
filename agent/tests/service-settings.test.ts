import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';
import { serviceSettings } from '../src/service-settings.ts';
import { createServer } from 'node:http';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openRuntime } from '../src/runtime.ts';

test('remote configuration refresh preserves catalog identity, clears old keys and keeps cached settings during outages', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'roam-settings-'));
  const oldFetch = globalThis.fetch;
  try {
    const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'offline-token');
    const config = { ...loadConfig(), serviceTokenFile: tokenFile, serviceSettingsUrl: 'http://settings.example/agent' };
    const catalog = config.configuredModels;
    let revision = 1, calls = 0, fail = false;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal((options?.headers as Record<string, string>)['x-roam-service-token'], 'offline-token');
      if (fail) throw new Error('offline');
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ revision, base_url: 'https://custom.example/v1', model_id: 'custom-model', thinking_level: 'low', api_key: revision === 1 ? 'saved-fixture' : '' }));
    };
    const refresh = serviceSettings(config);
    assert.deepEqual(await Promise.all([refresh(), refresh()]), [true, true]); assert.equal(calls, 1);
    assert.equal(config.configuredModels, catalog);
    assert.equal(config.model.modelId, 'custom-model'); assert.equal(config.apiKey, 'saved-fixture');
    assert.equal(await refresh(), false);
    revision = 2; assert.equal(await refresh(), true); assert.equal(config.apiKey, '');
    fail = true; assert.equal(await refresh(), false); assert.equal(config.baseUrl, 'https://custom.example/v1');
    assert.equal(config.apiKey, '');
  } finally { globalThis.fetch = oldFetch; await rm(directory, { recursive: true, force: true }); }
});

test('first boot needs no key, then model/key/catalog changes take effect in the same durable conversation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'roam-runtime-config-'));
  const tokenFile = path.join(directory, 'token'); await writeFile(tokenFile, 'offline-token');
  let revision = 0, base = '';
  const calls: { model: string; key: string; tools: string }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/settings') {
      assert.equal(request.headers['x-roam-service-token'], 'offline-token');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ revision, base_url: base + '/v1', model_id: 'custom-' + revision,
        thinking_level: 'low', api_key: revision ? 'fixture-key-' + revision : '' }));
      return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ model: input.model, key: String(request.headers.authorization), tools: JSON.stringify(input.tools) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', content: 'response ' + input.model }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }])
      response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, ...choice }] }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  try {
    runtime = await openRuntime({ ...loadConfig(), database: path.join(directory, 'session.sqlite'), mcpServers: {},
      serviceSettingsUrl: base + '/settings', serviceTokenFile: tokenFile }, undefined, { disableRetries: true });
    const conversation = await runtime.create(1);
    await assert.rejects(runtime.submit(conversation.id, 'ping', 'no-key'), { code: 'MODEL_NOT_CONFIGURED' });
    for (revision = 1; revision <= 2; revision++) {
      const receipt = await runtime.submit(conversation.id, '继续', 'turn-' + revision);
      await (await runtime.harness.submission(receipt.submission_id, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
      assert.equal((await runtime.create(1)).id, conversation.id);
    }
    assert.deepEqual(calls.map(({ model, key }) => ({ model, key })), [
      { model: 'custom-1', key: 'Bearer fixture-key-1' }, { model: 'custom-2', key: 'Bearer fixture-key-2' },
    ]);
    assert.ok(calls[1].tools.includes('deepseek/custom-2'));
    assert.ok(!calls[1].tools.includes('deepseek/custom-0'));
  } finally {
    await runtime?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
