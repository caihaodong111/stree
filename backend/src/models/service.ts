import type { ModelSettings, ModelSettingsResponse, ProviderProbe } from '@stree/shared';
import { AppError } from '../errors.js';
import { ProviderStore, type StoredProvider } from './providers.js';
import {
  discoverModels,
  generateWithProvider,
  type GenerateOptions,
  type GenerateResult,
} from './http-client.js';

export type ModelSession = {
  providerName: string;
  generate: (options: GenerateOptions) => Promise<GenerateResult>;
};
export interface PlanningModels {
  session(): Promise<ModelSession>;
}

export class ModelService implements PlanningModels {
  constructor(readonly providers = new ProviderStore()) {}
  async settings(): Promise<ModelSettingsResponse> {
    const providers = await this.providers.list();
    const selected = await this.providers.selection();
    return {
      settings: selected ?? { model: null, effort: null },
      effectiveModel: selected?.model ?? null,
      defaultModel: null,
      models: [],
      providers,
    };
  }
  async saveSettings(settings: ModelSettings) {
    if (!settings.providerId || settings.providerId === 'codex')
      throw new AppError('请选择已配置的模型提供方。', 400);
    await this.providers.select(settings);
    return this.settings();
  }
  async session(): Promise<ModelSession> {
    const selection = await this.providers.selection();
    if (selection?.providerId) {
      const provider = await this.providers.get(selection.providerId);
      if (!provider || !selection.model) throw new AppError('请在设置中重新选择规划模型。', 503);
      const model = selection.model;
      const maxTokens = provider.models.find((item) => item.id === model)?.maxTokens;
      const resolvedProvider = {
        ...provider,
        maxOutputTokens: provider.maxOutputTokens ?? maxTokens ?? null,
      };
      return {
        providerName: provider.name,
        generate: (options) => generateWithProvider(resolvedProvider, model, options),
      };
    }
    throw new AppError('请先在设置中添加模型提供方并选择规划模型。', 503);
  }
  async probe(input: ProviderProbe) {
    const apiKey = input.clearApiKey
      ? ''
      : input.apiKey || (input.id ? (await this.providers.get(input.id))?.apiKey : '') || '';
    const provider: StoredProvider = {
      ...input,
      id: input.id || 'probe',
      name: input.name || '模型提供方',
      models: [],
      apiKey,
    };
    return discoverModels(provider);
  }
  async status() {
    const selection = await this.providers.selection();
    if (selection?.providerId) {
      const provider = await this.providers.get(selection.providerId);
      return {
        codex: { available: false, authenticated: false, model: null },
        model: {
          configured: Boolean(provider && selection.model),
          provider: provider?.name || selection.providerId,
          model: selection.model,
        },
      };
    }
    return {
      codex: { available: false, authenticated: false, model: null },
      model: {
        configured: false,
        provider: '',
        model: null,
        error: '请先在设置中添加模型提供方并选择规划模型。',
      },
    };
  }
}
