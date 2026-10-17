import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NativeAgentController } from '../../src/nest/agent/native-agent.controller';

let app: INestApplication;
let upstream: Server;
let base: string;
let upstreamUrl: string;
const calls: { method?: string; url?: string; body: string; cookie?: string; authorization?: string }[] = [];
let streamClosed: (() => void) | undefined;

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, body, cookie: req.headers.cookie, authorization: req.headers.authorization });
    if (req.url === '/v1/conversations/9/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: session\ndata: {"conversation_id":9}\n\n');
      res.on('close', () => streamClosed?.());
      return;
    }
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ path: req.url, body: body ? JSON.parse(body) : null }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const module = await Test.createTestingModule({ controllers: [NativeAgentController] }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterEach(() => { vi.unstubAllEnvs(); calls.length = 0; streamClosed = undefined; });
afterAll(async () => {
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
});
function configured() {
  vi.stubEnv('TREK_LOCAL_SINGLE_USER', 'true');
  vi.stubEnv('AGENT_API_URL', upstreamUrl);
}

describe('same-origin native Agent transport', () => {
  it('forwards JSON once with status and query while keeping TREK credentials local', async () => {
    configured();
    const body = { message: '规划两天行程', request_id: 'proxy-once' };
    const response = await fetch(base + '/agent-api/v1/conversations/9/messages?view=current', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'trek_session=private', Authorization: 'Bearer private' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ path: '/v1/conversations/9/messages?view=current', body });
    expect(calls).toEqual([{ method: 'POST', url: '/v1/conversations/9/messages?view=current', body: JSON.stringify(body), cookie: undefined, authorization: undefined }]);
  });

  it('streams the first SSE frame immediately and closes the upstream viewer on disconnect', async () => {
    configured();
    const closed = new Promise<void>(resolve => { streamClosed = resolve; });
    const viewer = new AbortController();
    try {
      const response = await fetch(base + '/agent-api/v1/conversations/9/events', { signal: viewer.signal });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-transform');
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"conversation_id":9');
      viewer.abort();
      await reader.cancel().catch(() => {});
      await closed;
    } finally { viewer.abort(); }
  });

  it('keeps internal process controls private and refuses shared-user mode', async () => {
    configured();
    expect((await fetch(base + '/agent-api/internal/native-shutdown', { method: 'POST' })).status).toBe(404);
    vi.stubEnv('TREK_LOCAL_SINGLE_USER', 'false');
    expect((await fetch(base + '/agent-api/ready')).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('returns an actionable 502 when the native service is unavailable, without retrying', async () => {
    configured();
    const unused = createServer();
    await new Promise<void>(resolve => unused.listen(0, '127.0.0.1', resolve));
    const port = (unused.address() as AddressInfo).port;
    await new Promise<void>(resolve => unused.close(() => resolve()));
    vi.stubEnv('AGENT_API_URL', `http://127.0.0.1:${port}`);
    const response = await fetch(base + '/agent-api/ready');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: '规划服务暂时不可用，请确认 Agent 已启动后重试。' });
    expect(calls).toEqual([]);
  });
});
