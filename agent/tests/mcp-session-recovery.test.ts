import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '@earendil-works/pi-durable';
import type { McpServerDefinition } from '../src/config.ts';
import { createMcpConnections } from '../src/extensions/mcp.ts';

const endpoint = 'http://mcp-session-fixture.invalid/mcp';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function rpcResponse(request: Record<string, any>, result: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function responseWhenLive<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2500); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type RequestRecord = {
  method: string;
  rpcMethod: string;
  request: Record<string, any>;
  params: Record<string, any>;
  session: string | null;
  signal?: AbortSignal;
};

async function fixture(options: {
  signal?: AbortSignal;
  handle: (record: RequestRecord) => Promise<Response> | Response;
}): Promise<{
  registry: ReturnType<typeof createRegistry>;
  calls: RequestRecord[];
  installs: () => number;
  status: () => Record<string, { connected: boolean; error: string | null }>;
  connect: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const originalFetch = globalThis.fetch;
  const calls: RequestRecord[] = [];
  const registry = createRegistry();
  let installCount = 0;
  const wrappedRegistry = new Proxy(registry, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'install') return (extension: unknown) => {
        installCount += 1;
        return (value as (extension: unknown) => unknown).call(target, extension);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  globalThis.fetch = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? init.body : '';
    const request = body ? JSON.parse(body) : {};
    const record: RequestRecord = {
      method: init.method ?? 'POST',
      rpcMethod: request.method ?? init.method ?? 'GET',
      request,
      params: request.params ?? {},
      session: new Headers(init.headers).get('mcp-session-id'),
      signal: init.signal,
    };
    assert.equal(String(input), endpoint);
    calls.push(record);
    return responseWhenLive(Promise.resolve(options.handle(record)), init.signal);
  };
  const connections = createMcpConnections({ probe: { url: endpoint } as McpServerDefinition }, wrappedRegistry as any, {
    ...(options.signal ? { signal: options.signal } : {}),
    invoke: async (_server, _tool, args, _api, _context, call) => {
      const result = await call({ trace: String(args.label ?? args.uri ?? 'resource') });
      return { output: [], isError: result.isError === true, details: result.structuredContent ?? result.content };
    },
  });
  try {
    await connections.connect();
  } catch (error) {
    globalThis.fetch = originalFetch;
    throw error;
  }
  return {
    registry,
    calls,
    installs: () => installCount,
    status: () => connections.status(),
    connect: () => connections.connect(),
    close: async () => {
      try { await connections.close(); }
      finally { globalThis.fetch = originalFetch; }
    },
  };
}

function defaultHandler() {
  let sessionNumber = 0;
  return (record: RequestRecord): Response => {
    if (record.method === 'DELETE') return new Response(null, { status: 200 });
    if (record.rpcMethod === 'initialize') {
      sessionNumber += 1;
      return rpcResponse(record.request, {
        protocolVersion: record.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'session-fixture', version: '1' },
      }, { 'mcp-session-id': `session-${sessionNumber}` });
    }
    if (record.rpcMethod === 'notifications/initialized') return new Response(null, { status: 202 });
    if (record.rpcMethod === 'tools/list') return rpcResponse(record.request, { tools: [{
      name: 'write_probe', description: 'Session recovery write probe.',
      inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
    }] });
    if (record.rpcMethod === 'tools/call') return rpcResponse(record.request, { content: [{ type: 'text', text: 'ok' }] });
    if (record.rpcMethod === 'resources/list') return rpcResponse(record.request, { resources: [{ uri: 'fixture://resource/one', name: 'one' }] });
    if (record.rpcMethod === 'resources/read') return rpcResponse(record.request, { contents: [{ uri: record.params.uri, text: 'resource text' }] });
    throw new Error(`Unsupported fixture request ${record.rpcMethod}`);
  };
}

function findTool(registry: ReturnType<typeof createRegistry>, name: string) {
  const entry = registry.snapshot().tools().find(({ tool }) => tool.name === name);
  assert.ok(entry, `Missing registered tool ${name}`);
  return entry.tool as any;
}

function executeTool(registry: ReturnType<typeof createRegistry>, label: string, signal = new AbortController().signal) {
  return findTool(registry, 'mcp__probe__write_probe').execute({ label }, {}, { abortSignal: signal });
}

test('a session-expired write is retried once on a fresh initialized session', async () => {
  let attempts = 0;
  let writes = 0;
  const handler = defaultHandler();
  const f = await fixture({ handle: record => {
    if (record.rpcMethod === 'tools/call') {
      attempts += 1;
      if (record.session === 'session-1') return new Response('expired', { status: 404 });
      writes += 1;
    }
    return handler(record);
  } });
  try {
    const result = await executeTool(f.registry, 'write-once');
    assert.equal(result.isError, false);
    assert.equal(attempts, 2);
    assert.equal(writes, 1);
    assert.equal(f.calls.filter(call => call.rpcMethod === 'initialize').length, 2);
    assert.equal(f.installs(), 1);
    const calls = f.calls.filter(call => call.rpcMethod === 'tools/call');
    assert.deepEqual(calls.map(call => call.params._meta['io.liketrek.agent']), [
      { trace: 'write-once' }, { trace: 'write-once' },
    ]);
  } finally { await f.close(); }
});

test('concurrent 404s share one reconnect, preserve metadata, and drain the old client before closing it', async () => {
  const handler = defaultHandler();
  const reconnectStarted = deferred<void>();
  const allowReconnect = deferred<void>();
  const holdStarted = deferred<RequestRecord>();
  const releaseHold = deferred<Response>();
  let initializeCount = 0;
  let expiredCount = 0;
  const bothExpired = deferred<void>();
  const f = await fixture({ handle: async record => {
    if (record.rpcMethod === 'initialize') {
      initializeCount += 1;
      if (initializeCount === 2) {
        reconnectStarted.resolve();
        await allowReconnect.promise;
      }
    }
    if (record.rpcMethod === 'tools/call' && record.params.arguments?.label === 'hold') {
      holdStarted.resolve(record);
      return releaseHold.promise;
    }
    if (record.rpcMethod === 'tools/call' && ['A', 'B'].includes(record.params.arguments?.label) && record.session === 'session-1') {
      expiredCount += 1;
      if (expiredCount === 2) bothExpired.resolve();
      return new Response('expired', { status: 404 });
    }
    return handler(record);
  } });
  try {
    const hold = executeTool(f.registry, 'hold');
    const holdRequest = await within(holdStarted.promise, 'old-session call');
    const a = executeTool(f.registry, 'A');
    const b = executeTool(f.registry, 'B');
    await within(bothExpired.promise, 'both expired calls');
    await within(reconnectStarted.promise, 'shared reconnect');
    assert.equal(initializeCount, 2);
    assert.equal(f.status().probe.connected, false);
    allowReconnect.resolve();
    const [resultA, resultB] = await Promise.all([a, b]);
    assert.equal(resultA.isError, false);
    assert.equal(resultB.isError, false);
    assert.equal(initializeCount, 2);
    assert.equal(f.installs(), 1);
    assert.equal(f.status().probe.connected, true);
    const retried = f.calls.filter(call => call.rpcMethod === 'tools/call' && call.session === 'session-2');
    assert.deepEqual(retried.map(call => call.params._meta['io.liketrek.agent']), [
      { trace: 'A' }, { trace: 'B' },
    ]);
    assert.equal(f.calls.some(call => call.method === 'DELETE' && call.session === 'session-1'), false);
    releaseHold.resolve(rpcResponse(holdRequest.request, { content: [{ type: 'text', text: 'drained' }] }));
    assert.equal((await hold).isError, false);
    await within(waitUntil(() => f.calls.some(call => call.method === 'DELETE' && call.session === 'session-1'), 'old session close'), 'old session close');
    assert.equal(f.calls.some(call => call.method === 'DELETE' && call.session === 'session-1'), true);
  } finally {
    releaseHold.resolve(rpcResponse({ id: 1 }, { content: [{ type: 'text', text: 'cleanup' }] }));
    allowReconnect.resolve();
    await f.close();
  }
});

test('a failed reconnect reports disconnected while retaining the installed registry lifecycle', async () => {
  const handler = defaultHandler();
  let initializeCount = 0;
  const f = await fixture({ handle: record => {
    if (record.rpcMethod === 'initialize' && ++initializeCount === 2) return new Response('unavailable', { status: 500 });
    if (record.rpcMethod === 'tools/call') return new Response('expired', { status: 404 });
    return handler(record);
  } });
  try {
    await assert.rejects(executeTool(f.registry, 'failed-reconnect'));
    await waitUntil(() => f.status().probe.error !== null, 'reconnect error status');
    assert.equal(f.status().probe.connected, false);
    assert.match(f.status().probe.error ?? '', /500/);
    await f.connect();
    assert.equal(f.installs(), 1);
    assert.equal(initializeCount, 2);
  } finally { await f.close(); }
});

test('HTTP 500 and a network timeout do not start a new session or replay the tool', async () => {
  for (const failure of ['http-500', 'timeout'] as const) {
    let attempts = 0;
    const handler = defaultHandler();
    const f = await fixture({ handle: record => {
      if (record.rpcMethod === 'tools/call') {
        attempts += 1;
        if (failure === 'http-500') return new Response('server failure', { status: 500 });
        throw new TypeError('network timeout');
      }
      return handler(record);
    } });
    try {
      await assert.rejects(executeTool(f.registry, failure));
      assert.equal(attempts, 1, failure);
      assert.equal(f.calls.filter(call => call.rpcMethod === 'initialize').length, 1, failure);
      assert.equal(f.installs(), 1, failure);
    } finally { await f.close(); }
  }
});

test('one caller can abort while a shared reconnect continues; global abort still stops the reconnect', async () => {
  {
    const handler = defaultHandler();
    const reconnectStarted = deferred<void>();
    const allowReconnect = deferred<void>();
    let initializeCount = 0;
    const f = await fixture({ handle: async record => {
      if (record.rpcMethod === 'initialize') {
        initializeCount += 1;
        if (initializeCount === 2) { reconnectStarted.resolve(); await allowReconnect.promise; }
      }
      if (record.rpcMethod === 'tools/call' && record.session === 'session-1') return new Response('expired', { status: 404 });
      return handler(record);
    } });
    try {
      const caller = new AbortController();
      const a = executeTool(f.registry, 'A', caller.signal).then(value => ({ value }), error => ({ error }));
      const b = executeTool(f.registry, 'B').then(value => ({ value }), error => ({ error }));
      await within(reconnectStarted.promise, 'per-caller reconnect');
      caller.abort(new DOMException('caller stopped', 'AbortError'));
      const aborted = await within(a, 'aborted caller');
      assert.equal('error' in aborted, true);
      assert.equal((aborted as { error: Error }).error.name, 'AbortError');
      allowReconnect.resolve();
      const surviving = await within(b, 'surviving caller');
      assert.equal('value' in surviving, true);
      assert.equal((surviving as { value: any }).value.isError, false);
      assert.equal(initializeCount, 2);
      assert.equal(f.calls.filter(call => call.rpcMethod === 'tools/call' && call.session === 'session-2').length, 1);
    } finally { allowReconnect.resolve(); await f.close(); }
  }

  {
    const runtime = new AbortController();
    const handler = defaultHandler();
    const reconnectStarted = deferred<void>();
    const allowReconnect = deferred<void>();
    let initializeCount = 0;
    const f = await fixture({ signal: runtime.signal, handle: async record => {
      if (record.rpcMethod === 'initialize') {
        initializeCount += 1;
        if (initializeCount === 2) { reconnectStarted.resolve(); await allowReconnect.promise; }
      }
      if (record.rpcMethod === 'tools/call') return new Response('expired', { status: 404 });
      return handler(record);
    } });
    try {
      const a = executeTool(f.registry, 'global-abort-A').then(value => ({ value }), error => ({ error }));
      const b = executeTool(f.registry, 'global-abort-B').then(value => ({ value }), error => ({ error }));
      await within(reconnectStarted.promise, 'global reconnect');
      runtime.abort(new DOMException('runtime stopped', 'AbortError'));
      const [stoppedA, stoppedB] = await within(Promise.all([a, b]), 'globally aborted calls');
      for (const stopped of [stoppedA, stoppedB]) {
        assert.equal('error' in stopped, true);
        assert.equal((stopped as { error: Error }).error.name, 'AbortError');
      }
      assert.equal(f.calls.filter(call => call.rpcMethod === 'tools/call').length, 2);
      assert.equal(initializeCount, 2);
    } finally { allowReconnect.resolve(); await f.close(); }
  }
});

test('resource list and read closures recover through each current client', async () => {
  const handler = defaultHandler();
  let listAttempts = 0;
  let readAttempts = 0;
  const f = await fixture({ handle: record => {
    if (record.rpcMethod === 'resources/list' && ++listAttempts === 1) return new Response('expired', { status: 404 });
    if (record.rpcMethod === 'resources/read' && ++readAttempts === 1) return new Response('expired', { status: 404 });
    return handler(record);
  } });
  try {
    const list = await findTool(f.registry, 'mcp__probe__list_resources').execute({}, {}, { abortSignal: new AbortController().signal });
    assert.equal(list.isError, false);
    const read = await findTool(f.registry, 'mcp__probe__read_resource').execute({ uri: 'fixture://resource/one' }, {}, { abortSignal: new AbortController().signal });
    assert.equal(read.isError, false);
    assert.equal(listAttempts, 2);
    assert.equal(readAttempts, 2);
    assert.equal(f.calls.filter(call => call.rpcMethod === 'initialize').length, 3);
    assert.equal(f.installs(), 1);
  } finally { await f.close(); }
});
