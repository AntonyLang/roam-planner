import { createProvider } from '@earendil-works/pi-ai/models';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Config } from './config.ts';

export function configuredModels(config: Config) {
  const models = builtinModels();
  const deepseek = deepseekProvider();
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? deepseek.baseUrl ?? 'https://api.deepseek.com';
  const catalog = deepseek.getModels().map(model => ({ ...model, baseUrl }));
  for (const model of config.configuredModels.filter(m => m.provider === 'deepseek')) {
    if (!catalog.some(m => m.id === model.modelId)) {
      const template = catalog[0];
      catalog.push({ ...template, id: model.modelId, name: model.modelId,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    }
  }
  models.setProvider(createProvider({ id: 'deepseek', name: 'DeepSeek', baseUrl,
    auth: deepseek.auth, models: catalog, api: openAICompletionsApi() }));
  return models;
}
