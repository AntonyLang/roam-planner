import { AsyncLocalStorage } from 'node:async_hooks';
import { Type } from '@earendil-works/pi-ai';
import { McpClient, McpSessionExpiredError, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { defineExtension, defineTool, type Registry } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import type { McpServerDefinition } from '../config.ts';
import type { Tool,CallToolResult } from '@earendil-works/pi-mcp';
import type { ToolExecutionApi,ToolExecutionResult,ToolRegistration } from '@earendil-works/pi-durable';

const metadata = new AsyncLocalStorage<Record<string, unknown>>();
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();
const transportSendSignal = new AsyncLocalStorage<AbortSignal | undefined>();
const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

class RequestSignalStreamableHttpTransport extends StreamableHttpTransport {
  override send(...args: Parameters<StreamableHttpTransport['send']>) {
    return transportSendSignal.run(args[1]?.signal, () => super.send(...args));
  }
}

type McpClientLease = { client: McpClient; active: number; retired: boolean; closePromise?: Promise<void> };
type McpConnection = {
  current: McpClientLease;
  clients: Set<McpClientLease>;
  connected: boolean;
  error: string | null;
  reconnecting?: Promise<McpClientLease>;
};

const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function createMcpConnections(config: Record<string, McpServerDefinition>, registry: Registry,options:{
  invoke?:(server:string,tool:Tool,args:Record<string,unknown>,api:ToolExecutionApi,context:Context,call:(meta?:Record<string,unknown>)=>Promise<CallToolResult>)=>Promise<ToolExecutionResult>;
  defer?:(server:string,tool:Tool)=>boolean;
  include?:(server:string,tool:Tool)=>boolean;
  signal?: AbortSignal;
}={}) {
  const connections = new Map<string, McpConnection>();
  let closing = false;

  const createLease = (definition: McpServerDefinition): McpClientLease => ({
    client: new McpClient({ name: 'travel-agent-c', version: '0.1.0', requestTimeoutMs: definition.requestTimeoutMs }),
    active: 0,
    retired: false,
  });
  const createTransport = (definition: McpServerDefinition) => new RequestSignalStreamableHttpTransport({
    url: definition.url, headers: definition.headers, openGetStream: false,
    fetch: async (url, init) => {
      const extra = metadata.getStore();
      let request: { id?: unknown; method?: string; params: Record<string, unknown> } | undefined;
      if (typeof init?.body === 'string') request = JSON.parse(init.body);
      if (extra && typeof init?.body === 'string' && request?.method === 'tools/call') {
        request.params._meta = { ...(request.params._meta as Record<string, unknown> | undefined), 'io.liketrek.agent': extra };
        init = { ...init, body: JSON.stringify(request) };
      }
      const signals: AbortSignal[] = [];
      if (options.signal) signals.push(options.signal);
      if (init?.signal) signals.push(init.signal);
      const isRequest = request && typeof request.method === 'string' && Object.hasOwn(request, 'id');
      const executionSignal = isRequest ? callSignal.getStore() : undefined;
      const isResponseResume = init?.method === 'GET' && new Headers(init.headers).has('last-event-id');
      const sendSignal = isRequest || isResponseResume ? transportSendSignal.getStore() : undefined;
      if (executionSignal) signals.push(executionSignal);
      if (sendSignal) signals.push(sendSignal);
      if (signals.length === 1) {
        const [signal] = signals;
        if (signal !== init?.signal) init = { ...init, signal };
      } else if (signals.length > 1) init = { ...init, signal: AbortSignal.any(signals) };
      return fetch(url, init);
    },
  });

  const closeLease = (record: McpConnection, lease: McpClientLease): Promise<void> => {
    if (!lease.closePromise) {
      lease.closePromise = lease.client.close().finally(() => { record.clients.delete(lease); });
    }
    return lease.closePromise;
  };
  const releaseLease = async (record: McpConnection, lease: McpClientLease) => {
    lease.active -= 1;
    if (lease.retired && lease.active === 0) await closeLease(record, lease);
  };

  const reconnect = (definition: McpServerDefinition, record: McpConnection, expired: McpClientLease): Promise<McpClientLease> => {
    if (record.current !== expired) return Promise.resolve(record.current);
    if (record.reconnecting) return record.reconnecting;
    if (closing) return Promise.reject(new Error('MCP connections are closing'));

    const next = createLease(definition);
    record.clients.add(next);
    const reconnecting = (async () => {
      try {
        // A caller-local abort must stop only that caller's wait, not shared initialization.
        await callSignal.run(undefined, () => next.client.connect(createTransport(definition)));
      } catch (error) {
        await closeLease(record, next);
        throw error;
      }
      if (closing) {
        await closeLease(record, next);
        throw new Error('MCP connections are closing');
      }
      const previous = record.current;
      record.current = next;
      record.error = null;
      previous.retired = true;
      if (previous.active === 0) await closeLease(record, previous);
      return next;
    })();
    record.reconnecting = reconnecting;
    void reconnecting.then(
      () => { if (record.reconnecting === reconnecting) record.reconnecting = undefined; },
      error => {
        record.error = error instanceof Error ? error.message : String(error);
        if (record.reconnecting === reconnecting) record.reconnecting = undefined;
      },
    );
    return reconnecting;
  };

  const withSessionRecovery = async <T>(server: string, definition: McpServerDefinition, record: McpConnection,
    signal: AbortSignal | undefined, operation: (client: McpClient) => Promise<T>): Promise<T> => {
    const first = record.current;
    first.active += 1;
    let retry: McpClientLease | undefined;
    try {
      try {
        return await operation(first.client);
      } catch (error) {
        if (!(error instanceof McpSessionExpiredError)) throw error;
        if (signal?.aborted) throw abortReason(signal);
        retry = await withAbort(reconnect(definition, record, first), signal);
        retry.active += 1;
        if (signal?.aborted) throw abortReason(signal);
        // Deliberately outside the catch: a second 404 is returned, never replayed again.
        return await operation(retry.client);
      }
    } finally {
      if (retry) await releaseLease(record, retry);
      await releaseLease(record, first);
    }
  };

  const invokeResource = async (server: string, remote: Tool, args: Record<string, unknown>, api: ToolExecutionApi, context: Context,
    load: () => Promise<unknown>) => {
    const call = async (): Promise<CallToolResult> => {
      try {
        const value = await callSignal.run(context.abortSignal, load);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    };
    if (options.invoke) return options.invoke(server, remote, args, api, context, call);
    const result = await call();
    return { output: toLlmContent(result), isError: result.isError, details: jsonValue(result) };
  };
  async function connect() {
    await Promise.all(Object.entries(config).map(async ([server, definition]) => {
      if (closing || connections.get(server)?.connected) return;
      const lease = createLease(definition);
      const record: McpConnection = { current: lease, clients: new Set([lease]), connected: false, error: null };
      connections.set(server, record);
      try {
        await callSignal.run(undefined, () => lease.client.connect(createTransport(definition)));
        const remoteTools = await withSessionRecovery(server, definition, record, options.signal,
          client => client.listTools());
        const tools:ToolRegistration[] = remoteTools.filter(tool=>options.include?.(server,tool)??true).map(remote => defineTool({
          name: `mcp__${server}__${remote.name}`, description: remote.description ?? remote.name,
          parameters: Type.Unsafe<Record<string, unknown>>(remote.inputSchema),
          ...(options.defer?.(server,remote)?{deferred:true as const}:{}),
          replay: remote.annotations?.readOnlyHint === true ? 'safe' : 'unsafe',
          execute: async (args, api, context) => {
            const call=(extra:Record<string,unknown>={})=>metadata.run(extra,()=>callSignal.run(context.abortSignal,
              () => withSessionRecovery(server, definition, record, context.abortSignal,
                client => client.callTool(remote.name,args,{signal:context.abortSignal}))));
            if(options.invoke)return options.invoke(server,remote,args,api,context,call);
            const result=await call();
            return {output:toLlmContent(result),isError:result.isError,details:jsonValue(result)};
          },
        }));
        if (record.current.client.serverCapabilities?.resources) {
          const listResourcesSchema: Record<string, unknown> = { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false };
          const readResourceSchema: Record<string, unknown> = { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'], additionalProperties: false };
          const listResourcesTool: Tool = { name: 'list_resources', description: '按 MCP resources/list 列举资源。', inputSchema: listResourcesSchema,
            annotations: { readOnlyHint: true } };
          const readResourceTool: Tool = { name: 'read_resource', description: '按 MCP resources/read 读取指定资源。', inputSchema: readResourceSchema,
            annotations: { readOnlyHint: true } };
          if (options.include?.(server, listResourcesTool) ?? true) {
            tools.push(defineTool({ name: 'mcp__' + server + '__list_resources', description: '按 MCP resources/list 列举一页资源；cursor 用于续页。',
              parameters: Type.Unsafe<{ cursor?: string }>(listResourcesSchema), replay: 'safe', execute: async ({ cursor }, api, context) =>
                invokeResource(server, listResourcesTool, { cursor }, api, context,
                  () => withSessionRecovery(server, definition, record, context.abortSignal,
                    client => client.listResourcesPage(cursor, { signal: context.abortSignal }))) }));
          }
          if (options.include?.(server, readResourceTool) ?? true) {
            tools.push(defineTool({ name: 'mcp__' + server + '__read_resource', description: '按 MCP resources/read 读取版本化文章或目录 resource，输入 uri。',
              parameters: Type.Unsafe<{ uri: string }>(readResourceSchema), replay: 'safe', execute: async ({ uri }, api, context) =>
                invokeResource(server, readResourceTool, { uri }, api, context,
                  () => withSessionRecovery(server, definition, record, context.abortSignal,
                    client => client.readResource(uri, { signal: context.abortSignal }))) }));
          }
        }
        registry.install(defineExtension({ name: `mcp-${server}`, tools }));
        record.connected = true;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        await Promise.all([...record.clients].map(lease => closeLease(record, lease)));
      }
    }));
  }
  return { connect, status: () => Object.fromEntries([...connections].map(([name, c]) => [name, {
    connected: c.connected && !c.reconnecting && c.error === null,
    error: c.error,
  }])),
    close: async () => {
      closing = true;
      await Promise.all([...connections.values()].flatMap(record => [...record.clients].map(lease => closeLease(record, lease))));
    } };
}
