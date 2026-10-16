import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  ModelSettingsSchema,
  ProviderSchema,
  ProviderInputSchema,
  type ModelSettings,
  type ProviderInput,
  type ProviderSummary,
} from '@stree/shared';
import { runtimeRoot } from '../config.js';
import { AppError } from '../errors.js';

const StoredProviderSchema = ProviderSchema.extend({ apiKey: z.string().default('') });
const StateSchema = z.object({
  providers: z.array(StoredProviderSchema),
  selection: ModelSettingsSchema.nullable(),
});
export type StoredProvider = z.infer<typeof StoredProviderSchema>;
type State = z.infer<typeof StateSchema>;

/** Local provider settings. Credentials never leave this store in public responses. */
export class ProviderStore {
  private state: State = { providers: [], selection: null };
  private ready: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private file = path.join(runtimeRoot, 'provider-settings.json')) {}
  private load() {
    return (this.ready ??= readFile(this.file, 'utf8')
      .then((text) => {
        this.state = StateSchema.parse(JSON.parse(text));
      })
      .catch((error) => {
        if (error.code !== 'ENOENT')
          throw new AppError('第三方模型配置读取失败，请检查本地配置文件。', 503);
      }));
  }
  private mutate(change: (state: State) => void) {
    const operation = this.writes.then(async () => {
      await this.load();
      const next = structuredClone(this.state);
      change(next);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
        await rename(temporary, this.file);
        this.state = next;
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  async list(): Promise<ProviderSummary[]> {
    await this.load();
    return this.state.providers.map(({ apiKey, ...provider }) => ({
      ...structuredClone(provider),
      keyConfigured: Boolean(apiKey),
    }));
  }
  async get(id: string): Promise<StoredProvider | undefined> {
    await this.load();
    return structuredClone(this.state.providers.find((item) => item.id === id));
  }
  async selection() {
    await this.load();
    // Replace legacy built-in selections with the first configured provider.
    const valid = (state: State) =>
      state.providers.some(
        (provider) =>
          provider.id === state.selection?.providerId &&
          provider.models.some((model) => model.id === state.selection?.model),
      );
    if (!valid(this.state) && (this.state.selection || this.state.providers.length))
      await this.mutate((state) => {
        if (valid(state)) return;
        const first = state.providers[0];
        state.selection = first
          ? { providerId: first.id, model: first.models[0]!.id, effort: null }
          : null;
      });
    return structuredClone(this.state.selection);
  }
  async select(selection: ModelSettings | null) {
    await this.mutate((state) => {
      if (selection) {
        const provider = state.providers.find((item) => item.id === selection.providerId);
        if (!provider || !provider.models.some((item) => item.id === selection.model))
          throw new AppError('请先配置提供方并选择它的模型。', 400);
        if (selection.effort) throw new AppError('模型推理已永久关闭，不支持启用思考强度。', 400);
      }
      state.selection = selection;
    });
  }
  async save(input: ProviderInput, creating: boolean) {
    const { apiKey, clearApiKey, ...provider } = ProviderInputSchema.parse(input);
    await this.mutate((state) => {
      const index = state.providers.findIndex((item) => item.id === provider.id);
      if (creating && index >= 0) throw new AppError('Provider ID 已存在，请换一个 ID。', 409);
      if (!creating && index < 0) throw new AppError('提供方不存在，请重新加载设置。', 404);
      const previous = state.providers[index];
      const saved = { ...provider, apiKey: clearApiKey ? '' : apiKey || previous?.apiKey || '' };
      if (index >= 0) state.providers[index] = saved;
      else state.providers.push(saved);
      if (
        state.selection?.providerId === provider.id &&
        !provider.models.some((item) => item.id === state.selection?.model)
      )
        state.selection = { providerId: provider.id, model: provider.models[0]!.id, effort: null };
    });
    return this.list();
  }
  async delete(id: string) {
    await this.mutate((state) => {
      if (!state.providers.some((item) => item.id === id))
        throw new AppError('提供方不存在。', 404);
      if (state.selection?.providerId === id)
        throw new AppError('该提供方正在用于规划，请先切换到其他提供方并保存。', 409);
      state.providers = state.providers.filter((item) => item.id !== id);
    });
    return this.list();
  }
}
