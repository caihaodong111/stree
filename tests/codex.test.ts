import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../backend/src/codex/client.js';
import { AppError } from '../backend/src/errors.js';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const clients: CodexClient[] = [];
const settingsPaths: string[] = [];
const create = (settingsPath = path.join(tmpdir(), `stree-settings-${randomUUID()}.json`)) => {
  settingsPaths.push(settingsPath);
  const client = new CodexClient(
    fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url)),
    settingsPath,
  );
  clients.push(client);
  return client;
};
const options = (prompt = 'generate') => ({
  prompt,
  tools: [],
  instructions: 'test',
  outputSchema: { type: 'object' },
  handleTool: vi.fn().mockResolvedValue({ places: ['verified-poi'] }),
  signal: new AbortController().signal,
  onProgress: vi.fn(),
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(settingsPaths.splice(0).map((file) => rm(file, { force: true })));
});
describe('Codex App Server 协议桥接', () => {
  it('保存模型和强度后用于真实协议调用，并在重启后保留、可恢复默认', async () => {
    const settingsPath = path.join(tmpdir(), `stree-settings-${randomUUID()}.json`);
    const client = create(settingsPath);
    const initial = await client.settings();
    expect(initial.models).toHaveLength(2);
    await client.saveSettings({ model: 'test-deep', effort: 'xhigh' });
    const result = await client.generate(options());
    expect(JSON.parse(result.text)).toMatchObject({ model: 'test-deep', effort: 'xhigh' });
    expect(result.model).toBe('test-deep');
    const restarted = create(settingsPath);
    expect((await restarted.settings()).settings).toEqual({ model: 'test-deep', effort: 'xhigh' });
    await expect(restarted.saveSettings({ model: 'missing', effort: null })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      restarted.saveSettings({ model: 'test-deep', effort: 'low' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await restarted.settings()).settings).toEqual({ model: 'test-deep', effort: 'xhigh' });
    await restarted.saveSettings({ model: null, effort: null });
    expect((await restarted.settings()).effectiveModel).toBe(initial.defaultModel);
  });
  it('完成握手、动态工具请求和最终结构化输出', async () => {
    const input = options();
    const result = await create().generate(input);
    expect(input.handleTool).toHaveBeenCalledWith('search_places', { keyword: '西湖' });
    expect(JSON.parse(result.text).toolResult).toMatchObject({ success: true });
    expect(result.threadId).toBe('test-thread');
    expect(input.onProgress).toHaveBeenCalledWith('正在编写路线与逐站攻略');
  });
  it('以工具失败返回可处理的错误而不是挂起', async () => {
    const input = options();
    input.handleTool.mockRejectedValue(new AppError('未查询到地点'));
    const result = await create().generate(input);
    expect(JSON.parse(result.text).toolResult).toMatchObject({ success: false });
  });
  it('用户取消会结束等待', async () => {
    const client = create();
    const controller = new AbortController();
    const input = {
      ...options('wait'),
      signal: controller.signal,
      onProgress: () => controller.abort(),
    };
    await expect(client.generate(input)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('进程断开不会继续等待', async () => {
    await expect(create().generate(options('disconnect'))).rejects.toMatchObject({
      code: 'CODEX_DISCONNECTED',
    });
  });
  it('等待由用户取消后仍允许新的规划', async () => {
    const client = create();
    const controller = new AbortController();
    await expect(
      client.generate({
        ...options('wait'),
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.generate(options())).resolves.toMatchObject({ threadId: 'test-thread' });
  });
});
