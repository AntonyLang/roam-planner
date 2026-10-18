import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { watchEvents, type ConversationId } from '@earendil-works/pi-durable';
import { Subagents, TravelContext } from './documents.ts';
import { loadConfig } from './config.ts';
import { openRuntime, type TravelRuntime } from './runtime.ts';

async function body(request: IncomingMessage) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const send = (response: ServerResponse, status: number, data: unknown) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
};

export function createAgentServer(runtime: TravelRuntime) {
  const context = BACKGROUND_CONTEXT;
  return createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    try {
      if (url.pathname === '/healthz' || url.pathname === '/ready') return send(response, 200, {
        status: 'ready', runtime: 'pi-durable', configured: !!runtime.config.apiKey, mcp: runtime.mcp.status(),
      });
      const trip = /^\/v1\/trips\/(\d+)\/conversation$/.exec(url.pathname);
      if (trip && request.method === 'GET') {
        const conversation = await runtime.create(Number(trip[1]));
        return send(response, 200, { conversation_id: conversation.id });
      }
      const match = /^\/v1\/conversations\/([^/]+)(?:\/(entries|events|messages|stop|continue))?$/.exec(url.pathname);
      if (!match) return send(response, 404, { message: 'Unknown Agent API' });
      const id = Number(match[1]) as ConversationId;
      const conversation = await runtime.harness.conversation(id, context);
      if (!conversation) return send(response, 404, { message: 'Conversation not found' });
      const action = match[2];
      if (request.method === 'GET' && !action) return send(response, 200, await runtime.state(id));
      if (request.method === 'GET' && action === 'entries') return send(response, 200,
        await conversation.entries({ order: 'ascending' }, 100, url.searchParams.has('cursor') ? JSON.parse(url.searchParams.get('cursor')!) : undefined, context));
      if (request.method === 'POST' && (action === 'messages' || action === 'continue')) {
        const input = await body(request);
        const content = input.message ?? (action === 'continue' ? '请读取已有主／子会话和停止摘要，按当前旅行目标继续。' : '');
        if (typeof content !== 'string' || !content.trim() || typeof input.request_id !== 'string') return send(response, 422, { message: 'message and request_id are required' });
        if ((await runtime.harness.snapshot(Subagents, id, context))?.stopState === 'stopping') return send(response, 409, { message: '正在收尾，结束后可以继续。' });
        return send(response, 202, await runtime.submit(id, content, input.request_id));
      }
      if (request.method === 'POST' && action === 'stop') return send(response, 202, { task_id: await runtime.stop(id), status: 'stopping' });
      if (request.method === 'GET' && action === 'events') {
        const stream = await watchEvents(runtime.harness, id, context);
        const children = await runtime.harness.watchDoc(Subagents, id, context);
        const travel = await runtime.harness.watchDoc(TravelContext, id, context);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = async (event: string, value: unknown) => {
          if (response.destroyed) return;
          if (!response.write(`event: ${event}\ndata: ${JSON.stringify({ conversation_id: id, ...value as object })}\n\n`)) await new Promise<void>(resolve => {
            const finish=()=>{response.off('drain',finish);response.off('close',finish);resolve();};
            response.once('drain',finish);response.once('close',finish);
          });
        };
        const stopWatching = () => { void stream.stop(); void children?.stop(); void travel?.stop(); };
        response.on('close', stopWatching);
        await emit('session', { events: [stream.snapshot] });
        if (children) await emit('subagents', { state: children.value });
        if (travel) await emit('travel', { state: travel.value });
        if (response.destroyed) { stopWatching(); return; }
        stream.start(async events => { await emit('session', { events }); });
        children?.start(async value => { await emit('subagents', { state: value }); });
        travel?.start(async value => { await emit('travel', { state: value }); });
        const heartbeat = setInterval(() => response.write(': connected\n\n'), 15000);
        response.on('close', () => {
          clearInterval(heartbeat);
          stopWatching();
        });
        return;
      }
      return send(response, 405, { message: 'Method not allowed' });
    } catch (error) {
      if (response.headersSent) response.end();
      else send(response, (error as {statusCode?:number})?.statusCode ?? 500,
        { message: error instanceof Error ? error.message : String(error), code: (error as {code?:string})?.code });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const runtime = await openRuntime(config);
  const server = createAgentServer(runtime);
  server.listen(config.port, config.host, () => process.stdout.write(`Travel Agent C: http://${config.host}:${config.port}\n`));
  const close = async () => { server.close(); await runtime.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
