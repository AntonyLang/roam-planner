import { All, Controller, Req, Res } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Request, Response } from 'express';
import { readEnv } from '../../app-config';

@Controller('agent-api')
export class NativeAgentController {
  @All('*path')
  proxy(@Req() req: Request, @Res() res: Response): void {
    const config = readEnv().agent;
    // The native runtime has one local owner; it does not partition conversations by user.
    if (!config.localSingleUser) {
      res.status(403).json({ message: '原生规划服务需要启用本机单用户模式。' });
      return;
    }
    const incoming = new URL(req.originalUrl, 'http://trek.local');
    const target = new URL(config.nativeUrl);
    target.pathname = incoming.pathname.slice('/agent-api'.length);
    target.search = incoming.search;
    if (!target.pathname.startsWith('/v1/') && !['/ready', '/healthz'].includes(target.pathname)) {
      res.status(404).json({ message: 'Unknown Agent API' });
      return;
    }
    const content = req.body === undefined ? undefined : JSON.stringify(req.body);
    const headers: Record<string, string> = {};
    if (content !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(content));
    }
    if (typeof req.headers['last-event-id'] === 'string') headers['last-event-id'] = req.headers['last-event-id'];
    const forward = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = forward(target, { method: req.method, headers }, reply => {
      res.status(reply.statusCode!);
      for (const name of ['content-type', 'cache-control']) {
        const value = reply.headers[name];
        if (value !== undefined) res.setHeader(name, value);
      }
      if (reply.headers['content-type']?.startsWith('text/event-stream')) {
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.flushHeaders();
      }
      reply.on('error', error => res.destroy(error));
      reply.pipe(res);
    });
    upstream.on('error', error => {
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) res.destroy(error);
      else res.status(502).json({ message: '规划服务暂时不可用，请确认 Agent 已启动后重试。' });
    });
    // Disconnecting a viewer closes its stream; the runtime keeps the durable conversation.
    res.on('close', () => upstream.destroy());
    upstream.end(content);
  }
}
