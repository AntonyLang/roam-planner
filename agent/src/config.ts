import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelRef } from '@earendil-works/pi-durable';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

export type McpServerDefinition = { url: string; headers?: Record<string, string>; requestTimeoutMs?: number };

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (existsSync(path.join(projectRoot, '.env'))) loadEnvFile(path.join(projectRoot, '.env'));

export function loadConfig() {
  const model = { provider: process.env.AGENT_PROVIDER ?? 'deepseek', modelId: process.env.AGENT_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash' };
  const configuredModels: ModelRef[] = process.env.AGENT_MODELS ? JSON.parse(process.env.AGENT_MODELS) : [model];
  return {
    port: Number(process.env.AGENT_PORT ?? 8102), host: process.env.AGENT_HOST ?? '127.0.0.1',
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    serviceSettingsUrl: process.env.ROAM_SETTINGS_URL,
    serviceTokenFile: process.env.ROAM_SERVICE_TOKEN_FILE,
    database: process.env.AGENT_DATABASE ?? path.join(projectRoot, '.run/agent-c/session.sqlite'),
    cwd: process.env.AGENT_WORKSPACE ?? projectRoot,
    skillsDir: path.join(projectRoot, 'agent/skills'), model, configuredModels,
    thinkingLevel: (process.env.AGENT_THINKING_LEVEL ?? 'high') as ModelThinkingLevel,
    mcpServers: process.env.AGENT_MCP_SERVERS ? JSON.parse(process.env.AGENT_MCP_SERVERS) as Record<string, McpServerDefinition> : {
      trek: { url: process.env.TREK_MCP_URL ?? 'http://127.0.0.1:3000/mcp' },
      sources: { url: process.env.SOURCES_MCP_URL ?? 'http://127.0.0.1:8004/mcp' },
    },
  };
}
export type Config = Omit<ReturnType<typeof loadConfig>, 'apiKey' | 'baseUrl' | 'serviceSettingsUrl' | 'serviceTokenFile'> & {
  apiKey?: string; baseUrl?: string; serviceSettingsUrl?: string; serviceTokenFile?: string;
};
