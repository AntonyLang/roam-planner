import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServiceConfigService } from '../../../src/nest/service-config/service-config.service';
import { decrypt_api_key } from '../../../src/nest/common/crypto/apiKeyCrypto';
vi.mock('../../../src/config', () => ({ ENCRYPTION_KEY: 'service-config-offline-fixture' }));
vi.mock('../../../src/nest/database/database.service', () => ({ DatabaseService: class {} }));

let directory: string;
let rows: Map<string, string>;
let service: ServiceConfigService;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'roam-config-'));
  vi.stubEnv('ROAM_SERVICE_TOKEN_FILE', path.join(directory, 'token'));
  vi.stubEnv('DEEPSEEK_API_KEY', 'environment-fixture');
  vi.stubEnv('AMAP_API_KEY', 'environment-map-fixture');
  rows = new Map();
  service = new ServiceConfigService({
    get: (_sql: string, key: string) => rows.has(key) ? { value: rows.get(key) } : undefined,
    run: (_sql: string, key: string, value: string) => rows.set(key, value),
    transaction: (action: () => void) => action(),
  } as any);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

test('browser reads are masked, persisted secrets encrypted, internal reads require the service token', () => {
  service.save({ model: { api_key: 'new-model-fixture' }, maps: { amap_key: 'new-map-fixture' } });
  const masked = JSON.stringify(service.read());
  expect(masked).not.toContain('new-model-fixture'); expect(masked).not.toContain('new-map-fixture');
  expect(service.read().model.api_key_configured).toBe(true);
  expect(rows.get('roam_service_config')).toMatch(/^enc:v1:/);
  expect(rows.get('roam_service_config')).not.toContain('new-model-fixture');
  expect(decrypt_api_key(rows.get('amap_api_key'))).toBe('new-map-fixture');
  expect(() => service.authenticate(undefined)).toThrow();
  expect(() => service.authenticate('wrong-token')).toThrow();
  expect(() => service.authenticate(readFileSync(service.tokenFile, 'utf8'))).not.toThrow();
});

test('blank/omitted keys retain secrets, explicit clear overrides environment defaults', () => {
  service.save({ model: { api_key: 'saved-fixture' } });
  service.save({ model: { api_key: '' }, maps: { provider: 'geoapify' } });
  expect((service.internal('agent') as any).api_key).toBe('saved-fixture');
  service.save({ model: { api_key: null }, maps: { amap_key: null } });
  expect((service.internal('agent') as any).api_key).toBe('');
  expect((service.internal('sources') as any).maps.amap_key).toBe('');
  expect(rows.get('amap_api_key')).toBe('');
  expect(service.read().needs_setup).toBe(true);
});
test('skipping first-run setup unlocks trip management without enabling an unconfigured planning service', () => {
  service.save({ model: { api_key: null } });
  expect(service.skip()).toMatchObject({ setup_complete: true, needs_setup: true, model: { api_key_configured: false } });
  expect(service.read().setup_complete).toBe(true);
});

function connected() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'roam_connection_check' } }] } }] }), { status: 200 })));
}
test('onboarding completion requires a tool-capable check matching the saved model', async () => {
  expect(() => service.complete()).toThrow();
  connected();
  expect((await service.check('model', { model: { api_key: 'unsaved-fixture', model_id: 'custom-model' } })).ok).toBe(true);
  expect(() => service.complete()).toThrow();
  service.save({ model: { api_key: 'unsaved-fixture', model_id: 'custom-model' } });
  expect(service.complete().needs_setup).toBe(false);
  service.save({ model: { base_url: 'https://different.example/v1' } });
  expect(() => service.complete()).toThrow();
});

test('an in-flight probe cannot overwrite a newer configuration', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const pending = service.check('model');
  service.save({ model: { api_key: 'newer-fixture' }, xhs: { enabled: true } });
  finish(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'roam_connection_check' } }] } }] }), { status: 200 }));
  await pending;
  expect((service.internal('agent') as any).api_key).toBe('newer-fixture');
  expect(service.read().xhs.enabled).toBe(true);
  expect(() => service.complete()).toThrow();
});

test('HTTP success without tool calling is not accepted as planning readiness', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 })));
  expect((await service.check('model')).ok).toBe(false);
  expect(() => service.complete()).toThrow();
});
test('connection probes use the planning streaming protocol and assemble fragmented tool names', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).stream).toBe(true);
    return new Response([
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'roam_connection_' } }] } }] }),
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'check', arguments: '{}' } }] } }] }),
      'data: [DONE]', '',
    ].join('\r\n'), { headers: { 'content-type': 'text/event-stream' } });
  }));
  expect((await service.check('model')).ok).toBe(true);
  expect(service.complete().setup_complete).toBe(true);
});
