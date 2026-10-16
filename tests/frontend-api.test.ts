import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, isUnavailableEndpoint } from '../frontend/src/api.js';

afterEach(() => vi.unstubAllGlobals());

describe('可选页面入口的接口状态', () => {
  it.each([404, 405, 410, 501])('HTTP %i 的失效接口不再提供入口', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '接口不存在' }), { status })),
    );
    const error = await api.modelSettings().catch((error: unknown) => error);
    expect(isUnavailableEndpoint(error)).toBe(true);
    expect(error).toMatchObject({ message: '接口不存在' });
  });

  it.each([401, 403, 429, 500, 502, 503])('HTTP %i 保留入口以展示错误和重试', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: '服务暂时不可用' }), { status })),
    );
    const error = await api.travelHistory().catch((error: unknown) => error);
    expect(isUnavailableEndpoint(error)).toBe(false);
    expect(error).toMatchObject({ message: '服务暂时不可用' });
  });

  it('网络中断保留入口，正常历史记录仍可读取', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ trips: [], tasks: [] }));
    vi.stubGlobal('fetch', fetch);
    expect(isUnavailableEndpoint(await api.travelHistory().catch((error: unknown) => error))).toBe(
      false,
    );
    expect(await api.travelHistory()).toEqual({ trips: [], tasks: [] });
  });
});
