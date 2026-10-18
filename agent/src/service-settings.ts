import { readFile } from 'node:fs/promises';
import type { Config } from './config.ts';
type RemoteSettings = { revision: number; base_url: string; model_id: string; thinking_level: Config['thinkingLevel']; api_key: string };
// The browser receives only configured flags; this container reads secrets over
// the private service-token channel. A temporary backend restart keeps the last
// working in-memory settings rather than interrupting a running conversation.
export function serviceSettings(config: Config) {
  let revision = -1;
  let pending: Promise<boolean> | undefined;
  return async function refresh(): Promise<boolean> {
    if (!config.serviceSettingsUrl || !config.serviceTokenFile) return false;
    if (pending) return pending;
    pending = (async () => {
      try {
        const token = (await readFile(config.serviceTokenFile!, 'utf8')).trim();
        const response = await fetch(config.serviceSettingsUrl!, { headers: { 'x-roam-service-token': token }, signal: AbortSignal.timeout(5000) });
        if (!response.ok) return false;
        const next = await response.json() as RemoteSettings;
        if (next.revision === revision) return false;
        config.apiKey = next.api_key; config.baseUrl = next.base_url;
        config.model.modelId = next.model_id; config.thinkingLevel = next.thinking_level;
        config.configuredModels.splice(0, config.configuredModels.length, { ...config.model });
        revision = next.revision;
        return true;
      } catch { return false; }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
