import { Injectable, HttpException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.service';
import { decrypt_api_key, encrypt_api_key } from '../common/crypto/apiKeyCrypto';
import { writeInstanceApiKey } from '../settings/instance-api-keys';
import type { ConfigPatch } from './service-config.dto';
type Settings = {
  revision: number; setup_complete: boolean;
  model: { base_url: string; model_id: string; thinking_level: string; api_key: string };
  maps: { provider: 'amap'|'geoapify'; amap_key: string; geoapify_key: string };
  search: { exa_mcp_url: string }; xhs: { enabled: boolean }; model_check_hash?: string;
};
const settingKey = 'roam_service_config';
const hashModel = (model: Settings['model']) => createHash('sha256').update(JSON.stringify(model)).digest('hex');
async function hasConnectionTool(response: Response) {
  const body = await response.text();
  const events = response.headers.get('content-type')?.includes('text/event-stream')
    ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(line => line && line !== '[DONE]')
    : [body];
  const names = new Map<number, string>();
  for (const event of events) {
    const value = JSON.parse(event);
    const choice = value.choices?.[0];
    if (choice?.message?.tool_calls?.some((call: {function?:{name?:string}}) => call.function?.name === 'roam_connection_check')) return true;
    for (const call of choice?.delta?.tool_calls ?? []) {
      if (call.function?.name) names.set(call.index ?? 0, (names.get(call.index ?? 0) ?? '') + call.function.name);
    }
  }
  return [...names.values()].includes('roam_connection_check');
}
@Injectable()
export class ServiceConfigService {
  readonly tokenFile = process.env.ROAM_SERVICE_TOKEN_FILE || path.resolve(__dirname, '../../../data/.service-access/token');
  private readonly token: string;
  constructor(private readonly db: DatabaseService) {
    mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    if (!existsSync(this.tokenFile)) writeFileSync(this.tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    this.token = readFileSync(this.tokenFile, 'utf8').trim();
  }
  private defaults(): Settings {
    return { revision: 0, setup_complete: false,
      model: { base_url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', model_id: process.env.AGENT_MODEL || 'deepseek-flash',
        thinking_level: process.env.AGENT_THINKING_LEVEL || 'high', api_key: process.env.DEEPSEEK_API_KEY || '' },
      maps: { provider: process.env.SOURCES_ROUTES_PROVIDER === 'geoapify' ? 'geoapify' : 'amap',
        amap_key: process.env.AMAP_API_KEY || '', geoapify_key: process.env.GEOAPIFY_API_KEY || '' },
      search: { exa_mcp_url: process.env.EXA_MCP_URL || 'https://mcp.exa.ai/mcp' }, xhs: { enabled: false } };
  }
  private load(): Settings {
    const row = this.db.get<{value:string}>('SELECT value FROM app_settings WHERE key=?', settingKey);
    if (!row) return this.defaults();
    const plain = decrypt_api_key(row.value);
    if (!plain) throw new HttpException('无法读取已保存的服务配置，请检查数据卷与加密密钥。', 503);
    return JSON.parse(plain);
  }
  private persist(config: Settings) {
    this.db.transaction(() => {
      this.db.run('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        settingKey, encrypt_api_key(JSON.stringify(config)));
      writeInstanceApiKey(this.db, 'amap_api_key', config.maps.amap_key);
    });
  }
  private merge(current: Settings, patch: ConfigPatch = {}): Settings {
    const next = { ...current, model: { ...current.model, ...patch.model }, maps: { ...current.maps, ...patch.maps },
      search: { ...current.search, ...patch.search }, xhs: { ...current.xhs, ...patch.xhs } } as Settings;
    for (const [group, field] of [['model','api_key'],['maps','amap_key'],['maps','geoapify_key']] as const) {
      const value = (patch[group] as Record<string, unknown>|undefined)?.[field];
      (next[group] as unknown as Record<string,unknown>)[field] = value === null ? '' : typeof value === 'string' && value.trim()
        ? value.trim() : (current[group] as unknown as Record<string,unknown>)[field];
    }
    if (next.model_check_hash !== hashModel(next.model)) delete next.model_check_hash;
    return next;
  }
  private view(config: Settings) {
    return { setup_complete: config.setup_complete, needs_setup: !config.setup_complete || !config.model.api_key,
      model: { base_url: config.model.base_url, model_id: config.model.model_id, thinking_level: config.model.thinking_level,
        api_key_configured: !!config.model.api_key },
      maps: { provider: config.maps.provider, amap_key_configured: !!config.maps.amap_key, geoapify_key_configured: !!config.maps.geoapify_key },
      search: config.search, xhs: config.xhs };
  }
  read() { return this.view(this.load()); }
  save(patch: ConfigPatch) {
    const config = this.merge(this.load(), patch); config.revision++;
    this.persist(config);
    return this.view(config);
  }
  complete() {
    const config = this.load();
    if (!config.model.api_key || config.model_check_hash !== hashModel(config.model))
      throw new HttpException('请先保存模型配置，并检查连接成功后完成引导。', 409);
    config.setup_complete = true; this.persist(config); return this.view(config);
  }
  skip() {
    const config = this.load();
    config.setup_complete = true; this.persist(config); return this.view(config);
  }
  authenticate(value: unknown) {
    const actual = typeof value === 'string' ? Buffer.from(value) : Buffer.alloc(0), expected = Buffer.from(this.token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpException('Service access denied', 401);
  }
  internal(kind: string) {
    const config = this.load();
    if (kind === 'agent') return { revision: config.revision, ...config.model };
    if (kind === 'sources') return { revision: config.revision, maps: config.maps, search: config.search, xhs: config.xhs };
    throw new HttpException('Unknown service', 404);
  }
  private async sourceRequest(route: string, method = 'GET', body?: unknown) {
    const base = process.env.EXTERNAL_SOURCES_URL || 'http://127.0.0.1:8004';
    const response = await fetch(new URL(route, base), { method, headers: { 'content-type': 'application/json',
      'x-roam-service-token': this.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new HttpException('来源服务暂时无法完成操作，请稍后重试。', 502);
    return response.json();
  }
  xhs(action: 'status'|'login'|'logout') { return this.sourceRequest(`/internal/xhs/${action}`, action === 'status' ? 'GET' : 'POST'); }
  async check(service: 'model'|'maps'|'search'|'xhs', patch?: ConfigPatch) {
    const current = this.load(), config = this.merge(current, patch), started = Date.now();
    if (service !== 'model') {
      try { return await this.sourceRequest('/internal/services/check', 'POST', { service,
        config: { revision: config.revision, maps: config.maps, search: config.search, xhs: config.xhs } }); }
      catch { return { ok: false, message: '来源服务暂时无法连接，请稍后重试。', checked_at: new Date().toISOString(), latency_ms: Date.now()-started }; }
    }
    let ok = false, message = '';
    if (!config.model.api_key) message = '请填写模型 API Key。';
    else {
      try {
        const response = await fetch(config.model.base_url.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.model.api_key}` },
          body: JSON.stringify({ model: config.model.model_id, messages: [{ role: 'user', content: 'Call roam_connection_check.' }],
            tools: [{ type: 'function', function: { name: 'roam_connection_check', description: 'Check connection', parameters: { type: 'object', properties: {} } } }],
            tool_choice: { type: 'function', function: { name: 'roam_connection_check' } },
            max_tokens: 128, stream: true, thinking: { type: 'disabled' } }), signal: AbortSignal.timeout(25000) });
        ok = response.ok && await hasConnectionTool(response);
        message = ok ? '模型连接成功，可用于规划。' : response.ok ? '模型已连接，但未完成规划所需的工具调用，请检查模型是否支持工具。'
          : `模型连接失败（HTTP ${response.status}），请检查 Key、模型名称和地址。`;
      } catch { message = '模型连接超时或服务不可达，请检查地址与网络。'; }
    }
    const saved = this.load();
    if (ok) {
      saved.model_check_hash = hashModel(config.model); this.persist(saved);
    }
    return { ok, message, checked_at: new Date().toISOString(), latency_ms: Date.now()-started };
  }
}
