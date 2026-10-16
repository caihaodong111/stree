import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../backend/src/app.js';
import { ProviderStore } from '../backend/src/models/providers.js';
import { FileTripStore } from '../backend/src/db/store.js';
import { FileAiStore } from '../backend/src/db/ai-store.js';

it('线上关闭所有设置接口后，仍能读取已配置的规划模型并使用存储', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stree-production-'));
  const providers = new ProviderStore(path.join(directory, 'providers.json'));
  await providers.save(
    {
      id: 'online',
      name: '线上模型',
      baseURL: 'https://vendor.example/v1',
      protocol: 'openai-completions',
      models: [{ id: 'travel', name: 'Travel' }],
      apiKey: 'private-test-key',
      jsonMode: false,
      maxOutputTokens: null,
    },
    true,
  );
  await providers.select({ providerId: 'online', model: 'travel', effort: null });
  const app = await createApp({
    providers,
    settingsEnabled: false,
    logger: false,
    store: new FileTripStore(path.join(directory, 'trips')),
    audit: new FileAiStore(path.join(directory, 'audit')),
  });
  try {
    for (const [method, url] of [
      ['GET', '/api/settings/model'],
      ['PUT', '/api/settings/model'],
      ['POST', '/api/settings/providers'],
      ['PUT', '/api/settings/providers/online'],
      ['DELETE', '/api/settings/providers/online'],
      ['POST', '/api/settings/providers/discover'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain('private-test-key');
    }
    const status = (await app.inject('/api/status')).json();
    expect(status.model).toMatchObject({ configured: true, provider: '线上模型', model: 'travel' });
    expect(status.storage).toEqual({ driver: 'file', available: true });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect(await providers.selection()).toMatchObject({ providerId: 'online', model: 'travel' });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
