import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '@earendil-works/pi-durable';
import type { McpServerDefinition } from '../src/config.ts';
import { createMcpConnections } from '../src/extensions/mcp.ts';

const endpoint = 'http://mcp-fixture.invalid/mcp';

function deferred() {
  let resolve!: (value?: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}

function rpcResponse(request: Record<string, any>, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observed<T>(promise: Promise<T>) {
  return promise.then(
    value => ({ state: 'fulfilled' as const, value }),
    error => ({ state: 'rejected' as const, error }),
  );
}

async function fixture(options: { signal?: AbortSignal; sse?: boolean; servers?: Record<string, McpServerDefinition>; invoke?: (server: string, tool: any, args: Record<string, unknown>, api: unknown, context: unknown, call: (metadata?: Record<string, unknown>) => Promise<any>) => Promise<any> } = {}) {
  const originalFetch = globalThis.fetch;
  const servers = options.servers ?? { probe: { url: endpoint } };
  const serverByUrl = new Map(Object.entries(servers).map(([name, definition]) => [definition.url, name]));
  const calls: Array<Record<string, any>> = [];
  const blockedUrls: string[] = [];
  const pending = new Map<string, Record<string, any>>();
  const starts = new Map<string, ReturnType<typeof deferred>>();
  const streamReads = new Map<string, ReturnType<typeof deferred>>();
  const cancelWaiters = new Map<string, ReturnType<typeof deferred>>();
  const startFor = (key: string) => {
    let value = starts.get(key);
    if (!value) { value = deferred(); starts.set(key, value); }
    return value;
  };
  const streamReadFor = (key: string) => {
    let value = streamReads.get(key);
    if (!value) { value = deferred(); streamReads.set(key, value); }
    return value;
  };
  const streamResponse = (key: string, record: Record<string, any>, includeEventId: boolean) => {
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let sentEventId = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; record.bodyController = controller; },
      pull(controller) {
        if (includeEventId && !sentEventId) {
          sentEventId = true;
          controller.enqueue(new TextEncoder().encode('id: event-1\n\n'));
          return;
        }
        streamReadFor(key).resolve(record);
      },
      cancel() { record.bodyCancelled = true; },
    }, { highWaterMark: 0 });
    record.settledBy = 'response headers';
    record.failBody = (error: Error) => {
      try { bodyController.error(error); } catch { /* the body already ended */ }
    };
    record.respond = () => {
      try { bodyController.close(); } catch { /* the body already ended */ }
      pending.delete(key);
    };
    pending.set(key, record);
    const abort = () => {
      record.abortObserved = true;
      pending.delete(key);
      record.failBody(new DOMException('The operation was aborted.', 'AbortError'));
    };
    record.signal?.addEventListener('abort', abort, { once: true });
    if (record.signal?.aborted) abort();
    startFor(key).resolve(record);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const server = serverByUrl.get(url);
    if (!server) {
      blockedUrls.push(url);
      throw new Error('Fixture blocked a non-local MCP fetch URL');
    }
    const body = typeof init.body === 'string' ? init.body : init.body ? await new Response(init.body).text() : '';
    const request = body ? JSON.parse(body) : {};
    const method = (request.method ?? init.method ?? 'GET') as string;
    const params = request.params ?? {};
    const localKey = method === 'tools/call' ? `tool:${params.arguments?.label}`
      : method === 'resources/list' ? 'resources:list'
        : method === 'resources/read' ? `resources:read:${params.uri}`
          : method === 'GET' && options.sse ? 'stream:resume' : undefined;
    const key = localKey ? server === 'probe' ? localKey : `${server}:${localKey}` : undefined;
    const record: Record<string, any> = {
      url, server, method: init.method ?? 'GET', rpcMethod: method, id: request.id ?? null,
      params, signal: init.signal, signalPresent: init.signal instanceof AbortSignal,
      signalAbortedAtStart: init.signal?.aborted ?? null, abortObserved: false, key,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    calls.push(record);

    if (method === 'initialize') return rpcResponse(request, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'e7-cancel-fixture', version: '1' },
    });
    if (method === 'tools/list') return rpcResponse(request, { tools: [{
      name: 'cancel_probe',
      description: 'Offline cancellation test tool.',
      inputSchema: {
        type: 'object',
        properties: { label: { type: 'string', enum: ['A', 'B', 'C'] } },
        required: ['label'],
        additionalProperties: false,
      },
    }] });
    if (method === 'GET' && options.sse) return streamResponse(key!, record, false);
    if (!Object.hasOwn(request, 'id')) {
      if (method === 'notifications/cancelled') cancelWaiters.get(`${server}:${params.requestId}`)?.resolve(record);
      return new Response(null, { status: 202 });
    }
    if (!key) throw new Error(`Fixture received unsupported JSON-RPC request ${method}`);
    if (options.sse && method === 'tools/call' && params.arguments?.label === 'A') return streamResponse(key!, record, true);

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (kind: 'response' | 'abort', value: Response | Error) => {
        if (settled) return;
        settled = true;
        record.settledBy = kind;
        pending.delete(key);
        if (kind === 'abort') reject(value);
        else resolve(value as Response);
      };
      record.respond = (result: unknown) => finish('response', rpcResponse(request, result));
      pending.set(key, record);
      startFor(key).resolve(record);
      const signal = init.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          if (settled) return;
          record.abortObserved = true;
          finish('abort', new DOMException('The operation was aborted.', 'AbortError'));
        }, { once: true });
        if (signal.aborted) {
          record.abortObserved = true;
          finish('abort', new DOMException('The operation was aborted.', 'AbortError'));
        }
      }
    });
  };

  const registry = createRegistry();
  const connections = createMcpConnections(servers, registry, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.invoke ? { invoke: options.invoke } : {}),
  });
  try {
    await connections.connect();
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
  return {
    registry, calls, blockedUrls, pending, starts,
    cancellationFor: (requestId: number, server = 'probe') => {
      const key = `${server}:${requestId}`;
      let value = cancelWaiters.get(key);
      if (!value) { value = deferred(); cancelWaiters.set(key, value); }
      return value.promise as Promise<Record<string, any>>;
    },
    start: async (key: string) => within(startFor(key).promise as Promise<Record<string, any>>, key),
    streamRead: async (key: string) => streamReadFor(key).promise as Promise<Record<string, any>>,
    shutdown: () => connections.close(),
    close: async () => {
      for (const [key, record] of [...pending]) {
        const result = key.startsWith('resources:list')
          ? { resources: [] }
          : key.startsWith('resources:read:')
            ? { contents: [] }
            : { content: [{ type: 'text', text: `fixture cleanup ${key}` }] };
        record.respond(result);
      }
      try {
        await connections.close();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  };
}

function registeredTool(registry: ReturnType<typeof createRegistry>, name: string) {
  const entry = registry.snapshot().tools().find(({ tool }) => tool.name === name);
  assert.ok(entry, `Missing registered tool ${name}`);
  return entry.tool;
}

test('one tool abort reaches only its fetch, preserves metadata, and leaves the concurrent call and runtime signal intact', async () => {
  const runtimeController = new AbortController();
  const metadataA = { trace: 'A', nested: { source: 'caller' } };
  const metadataB = { trace: 'B', nested: { source: 'caller' } };
  const originalMetadataA = structuredClone(metadataA);
  const originalMetadataB = structuredClone(metadataB);
  const metadataByLabel = { A: metadataA, B: metadataB, C: { trace: 'C' } };
  const f = await fixture({
    signal: runtimeController.signal,
    invoke: async (_server, remote, args, _api, _context, call) => {
      const result = await call(metadataByLabel[args.label as keyof typeof metadataByLabel]);
      return { output: [], isError: result.isError === true, details: result.structuredContent ?? null };
    },
  });
  try {
    const tool = registeredTool(f.registry, 'mcp__probe__cancel_probe');
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const outcomeA = observed(tool.execute({ label: 'A' }, {}, { abortSignal: controllerA.signal }));
    const outcomeB = observed(tool.execute({ label: 'B' }, {}, { abortSignal: controllerB.signal }));
    const [fetchA, fetchB] = await Promise.all([f.start('tool:A'), f.start('tool:B')]);
    const cancellation = f.cancellationFor(fetchA.id);
    const metaOnWireA = fetchA.params._meta?.['io.liketrek.agent'];
    const metaOnWireB = fetchB.params._meta?.['io.liketrek.agent'];
    assert.deepEqual(metaOnWireA, originalMetadataA);
    assert.deepEqual(metaOnWireB, originalMetadataB);
    assert.equal(Object.hasOwn(metaOnWireA, 'signal'), false);
    assert.deepEqual(metadataA, originalMetadataA);
    assert.deepEqual(metadataB, originalMetadataB);
    assert.equal(fetchA.signalAbortedAtStart, false);
    assert.equal(fetchB.signalAbortedAtStart, false);

    controllerA.abort();
    const [resultA, cancelled] = await Promise.all([within(outcomeA, 'A client call'), within(cancellation, 'A cancellation notification')]);
    assert.equal(resultA.state, 'rejected');
    assert.equal(resultA.error.name, 'AbortError');
    assert.equal(fetchA.signal.aborted, true);
    assert.equal(fetchA.abortObserved, true);
    assert.equal(cancelled.rpcMethod, 'notifications/cancelled');
    assert.equal(cancelled.params.requestId, fetchA.id);
    assert.equal(cancelled.signal.aborted, false);
    assert.notEqual(cancelled.signal, fetchA.signal);

    assert.equal(controllerB.signal.aborted, false);
    assert.equal(fetchB.signal.aborted, false);
    assert.equal(f.pending.has('tool:B'), true);
    fetchB.respond({ content: [{ type: 'text', text: 'fixture B complete' }] });
    const resultB = await within(outcomeB, 'B client call');
    assert.equal(resultB.state, 'fulfilled');
    assert.equal(resultB.value.isError, false);
    assert.equal(fetchB.signal.aborted, true);
    assert.equal(fetchB.abortObserved, false);
    assert.equal(fetchB.settledBy, 'response');

    const controllerC = new AbortController();
    const outcomeC = observed(tool.execute({ label: 'C' }, {}, { abortSignal: controllerC.signal }));
    const fetchC = await f.start('tool:C');
    runtimeController.abort();
    const resultC = await within(outcomeC, 'runtime-global cancellation');
    assert.equal(controllerC.signal.aborted, false);
    assert.equal(fetchC.signal.aborted, true);
    assert.equal(fetchC.abortObserved, true);
    assert.equal(resultC.state, 'rejected');
    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('pi-mcp internal request timeout aborts only its active fetch and leaves cancellation notification and concurrent work live', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture({
    invoke: async (_server, _remote, _args, _api, _context, call) => {
      const result = await call();
      return { output: [], isError: result.isError === true, details: result.structuredContent ?? null };
    },
  });
  try {
    const tool = registeredTool(f.registry, 'mcp__probe__cancel_probe');
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const outcomeA = observed(tool.execute({ label: 'A' }, {}, { abortSignal: controllerA.signal }));
    const outcomeB = observed(tool.execute({ label: 'B' }, {}, { abortSignal: controllerB.signal }));
    const [fetchA, fetchB] = await Promise.all([f.start('tool:A'), f.start('tool:B')]);
    const cancellation = f.cancellationFor(fetchA.id);

    await t.mock.timers.tick(29_999);
    assert.equal(fetchA.signal.aborted, false);
    assert.equal(fetchB.signal.aborted, false);
    fetchB.respond({ content: [{ type: 'text', text: 'fixture B complete' }] });
    const resultB = await outcomeB;
    assert.equal(resultB.state, 'fulfilled');
    assert.equal(resultB.value.isError, false);
    assert.equal(fetchB.signal.aborted, true);
    assert.equal(fetchB.abortObserved, false);
    assert.equal(fetchB.settledBy, 'response');

    await t.mock.timers.tick(1);

    const [resultA, cancelled] = await Promise.all([outcomeA, cancellation]);
    assert.equal(resultA.state, 'rejected');
    assert.match(resultA.error.message, /MCP request timed out after 30000ms/);
    assert.equal(fetchA.signal.aborted, true);
    assert.equal(fetchA.abortObserved, true);
    assert.equal(cancelled.rpcMethod, 'notifications/cancelled');
    assert.equal(cancelled.params.requestId, fetchA.id);
    assert.equal(cancelled.signal.aborted, false);
    assert.notEqual(cancelled.signal, fetchA.signal);

    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('server requestTimeoutMs changes only that server and permits a request to run past the default deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture({ servers: {
    fast: { url: 'http://mcp-fixture.invalid/fast' },
    slow: { url: 'http://mcp-fixture.invalid/slow', requestTimeoutMs: 60_000 },
  } });
  try {
    const fastTool = registeredTool(f.registry, 'mcp__fast__cancel_probe');
    const slowTool = registeredTool(f.registry, 'mcp__slow__cancel_probe');
    const fastOutcome = observed(fastTool.execute({ label: 'A' }, {}, { abortSignal: new AbortController().signal }));
    const slowOutcome = observed(slowTool.execute({ label: 'A' }, {}, { abortSignal: new AbortController().signal }));
    const [fastFetch, slowFetch] = await Promise.all([f.start('fast:tool:A'), f.start('slow:tool:A')]);
    const fastCancellation = f.cancellationFor(fastFetch.id, 'fast');
    const slowCancellation = f.cancellationFor(slowFetch.id, 'slow');

    await t.mock.timers.tick(30_000);

    const [fastResult, fastCancelled] = await Promise.all([fastOutcome, fastCancellation]);
    assert.equal(fastResult.state, 'rejected');
    assert.match(fastResult.error.message, /MCP request timed out after 30000ms/);
    assert.equal(fastFetch.signal.aborted, true);
    assert.equal(fastCancelled.server, 'fast');
    assert.equal(fastCancelled.rpcMethod, 'notifications/cancelled');
    assert.equal(fastCancelled.signal.aborted, false);
    assert.equal(slowFetch.signal.aborted, false);
    assert.equal(f.pending.has('slow:tool:A'), true);

    await t.mock.timers.tick(30_000);

    const [slowResult, slowCancelled] = await Promise.all([slowOutcome, slowCancellation]);
    assert.equal(slowResult.state, 'rejected');
    assert.match(slowResult.error.message, /MCP request timed out after 60000ms/);
    assert.equal(slowFetch.signal.aborted, true);
    assert.equal(slowCancelled.server, 'slow');
    assert.equal(slowCancelled.rpcMethod, 'notifications/cancelled');
    assert.equal(slowCancelled.signal.aborted, false);
    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('server requestTimeoutMs 0 preserves pi-mcp no-timer behavior', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture({ servers: { untimed: { url: 'http://mcp-fixture.invalid/untimed', requestTimeoutMs: 0 } } });
  try {
    const tool = registeredTool(f.registry, 'mcp__untimed__cancel_probe');
    const outcome = observed(tool.execute({ label: 'A' }, {}, { abortSignal: new AbortController().signal }));
    const fetchCall = await f.start('untimed:tool:A');
    await t.mock.timers.tick(120_000);
    assert.equal(fetchCall.signal.aborted, false);
    assert.equal(f.pending.has('untimed:tool:A'), true);

    fetchCall.respond({ content: [{ type: 'text', text: 'completed without a request timer' }] });
    const result = await outcome;
    assert.equal(result.state, 'fulfilled');
    assert.notEqual(result.value.isError, true);
    assert.equal(fetchCall.settledBy, 'response');
    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('pi-mcp internal request timeout aborts resource list and read fetches while preserving resource error results', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const operation of [
    { name: 'mcp__probe__list_resources', args: {}, key: 'resources:list' },
    { name: 'mcp__probe__read_resource', args: { uri: 'fixture://resource/one' }, key: 'resources:read:fixture://resource/one' },
  ]) {
    const f = await fixture();
    try {
      const tool = registeredTool(f.registry, operation.name);
      const outcome = observed(tool.execute(operation.args, {}, { abortSignal: new AbortController().signal }));
      const fetchCall = await f.start(operation.key);
      const cancellation = f.cancellationFor(fetchCall.id);

      await t.mock.timers.tick(30_000);

      const [result, cancelled] = await Promise.all([outcome, cancellation]);
      assert.equal(result.state, 'fulfilled');
      assert.equal(result.value.isError, true);
      assert.equal(fetchCall.signal.aborted, true);
      assert.equal(fetchCall.abortObserved, true);
      assert.equal(cancelled.rpcMethod, 'notifications/cancelled');
      assert.equal(cancelled.params.requestId, fetchCall.id);
      assert.equal(cancelled.signal.aborted, false);
      assert.equal(f.blockedUrls.length, 0);
    } finally {
      await f.close();
    }
  }
});

test('server requestTimeoutMs also applies to resource list and read requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture({ servers: {
    library: { url: 'http://mcp-fixture.invalid/library', requestTimeoutMs: 60_000 },
  } });
  try {
    const operations = [
      { name: 'mcp__library__list_resources', args: {}, key: 'library:resources:list' },
      { name: 'mcp__library__read_resource', args: { uri: 'fixture://resource/one' }, key: 'library:resources:read:fixture://resource/one' },
    ];
    const calls = operations.map(operation => {
      const tool = registeredTool(f.registry, operation.name);
      return observed(tool.execute(operation.args, {}, { abortSignal: new AbortController().signal }));
    });
    const fetches = await Promise.all(operations.map(operation => f.start(operation.key)));
    const cancellations = fetches.map(fetchCall => f.cancellationFor(fetchCall.id, 'library'));

    await t.mock.timers.tick(30_000);
    assert.ok(fetches.every(fetchCall => fetchCall.signal.aborted === false));

    await t.mock.timers.tick(30_000);
    const results = await Promise.all(calls);
    const cancelled = await Promise.all(cancellations);
    for (let index = 0; index < operations.length; index++) {
      assert.equal(results[index].state, 'fulfilled');
      assert.equal(results[index].value.isError, true);
      assert.equal(fetches[index].signal.aborted, true);
      assert.equal(fetches[index].abortObserved, true);
      assert.equal(cancelled[index].rpcMethod, 'notifications/cancelled');
      assert.equal(cancelled[index].params.requestId, fetches[index].id);
      assert.equal(cancelled[index].signal.aborted, false);
    }
    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('pi-mcp internal timeout aborts the matching SSE response and its Last-Event-ID resume fetch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture({ sse: true });
  try {
    const tool = registeredTool(f.registry, 'mcp__probe__cancel_probe');
    const outcome = observed(tool.execute({ label: 'A' }, {}, { abortSignal: new AbortController().signal }));
    const initial = await f.start('tool:A');
    const cancellation = f.cancellationFor(initial.id);

    await f.streamRead('tool:A');
    initial.failBody(new TypeError('fixture SSE connection dropped'));
    await new Promise<void>(resolve => setImmediate(resolve));
    await t.mock.timers.tick(1_000);

    const resumed = await f.start('stream:resume');
    assert.equal(resumed.rpcMethod, 'GET');
    assert.equal(resumed.headers['last-event-id'], 'event-1');
    assert.equal(resumed.signalAbortedAtStart, false);

    await t.mock.timers.tick(29_000);

    const [result, cancelled] = await Promise.all([outcome, cancellation]);
    assert.equal(result.state, 'rejected');
    assert.match(result.error.message, /MCP request timed out after 30000ms/);
    assert.equal(initial.signal.aborted, true);
    assert.equal(initial.abortObserved, true);
    assert.equal(resumed.signal.aborted, true);
    assert.equal(resumed.abortObserved, true);
    assert.equal(cancelled.rpcMethod, 'notifications/cancelled');
    assert.equal(cancelled.params.requestId, initial.id);
    assert.equal(cancelled.signal.aborted, false);
    assert.equal(f.calls.filter(call => call.rpcMethod === 'GET').length, 1);
    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('closing the shared MCP connection aborts its in-flight request fetch', async () => {
  const f = await fixture();
  try {
    const tool = registeredTool(f.registry, 'mcp__probe__cancel_probe');
    const outcome = observed(tool.execute({ label: 'A' }, {}, { abortSignal: new AbortController().signal }));
    const fetchCall = await f.start('tool:A');

    await f.shutdown();

    const result = await outcome;
    assert.equal(result.state, 'rejected');
    assert.equal(fetchCall.signal.aborted, true);
    assert.equal(fetchCall.abortObserved, true);
    assert.equal(f.blockedUrls.length, 0);
  } finally {
    await f.close();
  }
});

test('resource list and read use their own context signal and retain the existing error-result shape', async () => {
  for (const operation of [
    { name: 'mcp__probe__list_resources', args: {}, key: 'resources:list' },
    { name: 'mcp__probe__read_resource', args: { uri: 'fixture://resource/one' }, key: 'resources:read:fixture://resource/one' },
  ]) {
    const f = await fixture();
    try {
      const tool = registeredTool(f.registry, operation.name);
      const controller = new AbortController();
      const outcome = observed(tool.execute(operation.args, {}, { abortSignal: controller.signal }));
      const fetchCall = await f.start(operation.key);
      controller.abort();
      const result = await within(outcome, `${operation.key} result`);
      assert.equal(controller.signal.aborted, true);
      assert.equal(fetchCall.signalAbortedAtStart, false);
      assert.equal(fetchCall.signal.aborted, true);
      assert.equal(fetchCall.abortObserved, true);
      assert.equal(result.state, 'fulfilled');
      assert.equal(result.value.isError, true);
      assert.equal(f.blockedUrls.length, 0);
    } finally {
      await f.close();
    }
  }
});
