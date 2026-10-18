import { createProvider, type MutableModels } from '@earendil-works/pi-ai/models';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Config } from './config.ts';

export function configuredModels(config: Config, models: MutableModels = builtinModels()) {
  const deepseek = deepseekProvider();
  const baseUrl = config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? deepseek.baseUrl ?? 'https://api.deepseek.com';
  const catalog = deepseek.getModels().map(model => ({ ...model, baseUrl }));
  for (const model of config.configuredModels.filter(m => m.provider === 'deepseek')) {
    if (!catalog.some(m => m.id === model.modelId)) {
      const template = catalog[0];
      catalog.push({ ...template, id: model.modelId, name: model.modelId,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    }
  }
  models.setProvider(createProvider({ id: 'deepseek', name: 'DeepSeek', baseUrl,
    auth: { apiKey: { name: 'Planning model API key', resolve: async () => {
      const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY;
      return apiKey ? { auth: { apiKey }, source: 'Service configuration' } : undefined;
    } } }, models: catalog, api: openAICompletionsApi() }));
  return models;
}
