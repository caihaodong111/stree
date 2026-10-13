import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../backend/src/codex/client.js';
import { AppError } from '../backend/src/errors.js';
import { config } from '../backend/src/config.js';
const clients: CodexClient[] = [];
const create = () => {
  const client = new CodexClient(
    fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url)),
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
});
describe('Codex App Server 协议桥接', () => {
  it('完成握手、动态工具请求和最终结构化输出', async () => {
    const input = options();
    const result = await create().generate(input);
    expect(input.handleTool).toHaveBeenCalledWith('search_places', { keyword: '西湖' });
    expect(JSON.parse(result.text).toolResult).toMatchObject({ success: true });
    expect(result.threadId).toBe('test-thread');
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
  it('超时结束并允许新的规划', async () => {
    const previous = config.CODEX_TIMEOUT_MS;
    config.CODEX_TIMEOUT_MS = 100;
    try {
      const client = create();
      await expect(client.generate(options('wait'))).rejects.toMatchObject({
        code: 'PLANNING_TIMEOUT',
      });
      await expect(client.generate(options())).resolves.toMatchObject({ threadId: 'test-thread' });
    } finally {
      config.CODEX_TIMEOUT_MS = previous;
    }
  });
});
