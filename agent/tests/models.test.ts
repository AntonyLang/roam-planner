import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { configuredModels } from '../src/models.ts';
import { loadConfig } from '../src/config.ts';

test('configured native model calls the relay URL and exact alias with its configured credential', async () => {
  const original = { url: process.env.DEEPSEEK_BASE_URL, key: process.env.DEEPSEEK_API_KEY };
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer offline-relay-fixture');
    assert.equal(input.model, 'deepseek-v4.1-flash');
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'relay works' }, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }) + '\n\n'
      + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    process.env.DEEPSEEK_API_KEY = 'offline-relay-fixture';
    const config = loadConfig();
    const models = configuredModels({ ...config, configuredModels: [{ provider: 'deepseek', modelId: 'deepseek-v4.1-flash' }] });
    assert.ok(models.getModels('deepseek').every(model => model.baseUrl === process.env.DEEPSEEK_BASE_URL));
    const result = await models.completeSimple(models.getModel('deepseek', 'deepseek-v4.1-flash')!, {
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    }, { maxTokens: 16, reasoning: 'off' });
    assert.equal(result.stopReason, 'stop');
    assert.equal(calls, 1);
    assert.ok(result.content.some(block => block.type === 'text' && block.text === 'relay works'));
  } finally {
    for (const [name, value] of [['DEEPSEEK_BASE_URL', original.url], ['DEEPSEEK_API_KEY', original.key]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
