import { ProviderProbeSchema, type ProviderModel } from '@stree/shared';
import { api } from '../../api';
import { messageOf } from './utils';

export type DiscoveredModelView = ProviderModel;
export interface IApiClient {
  llm: {
    discoverModels(input: {
      settingsNs: string;
      provider?: string;
      baseURL?: string;
      api?: string;
      apiKey?: string;
      clearApiKey?: boolean;
    }): Promise<{
      result:
        | { ok: true; value: { models: ProviderModel[] } }
        | { ok: false; error: { message: string } };
    }>;
  };
}

/** Adapt the vendored model editor's discovery call to STREE's API. */
export function createCatalogApi(clearApiKey = false): IApiClient {
  return {
    llm: {
      async discoverModels(input) {
        const parsed = ProviderProbeSchema.safeParse({
          id: input.provider,
          baseURL: input.baseURL,
          protocol: input.api || 'openai-completions',
          apiKey: input.apiKey,
          clearApiKey,
        });
        if (!parsed.success)
          return { result: { ok: false, error: { message: parsed.error.issues[0]!.message } } };
        try {
          return { result: { ok: true, value: await api.discoverModels(parsed.data) } };
        } catch (error) {
          return { result: { ok: false, error: { message: messageOf(error) } } };
        }
      },
    },
  };
}
