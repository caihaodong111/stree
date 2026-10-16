import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicWebSearch, parseSearchHTML } from '../backend/src/services/web-search.js';

const html = (url = 'https://example.com/guide', text = '真实旅游攻略') =>
  `<ol id="b_results"><li class="b_algo"><h2><a href="${url}">杭州攻略</a></h2><div class="b_caption"><p>${text}</p></div></li></ol>`;
const service = (timeoutMs = 1000) =>
  new PublicWebSearch({ enabled: true, endpoint: 'https://www.bing.com/search', timeoutMs });
afterEach(() => vi.unstubAllGlobals());

describe('当前模型使用的公开网页搜索', () => {
  it('从真实结果卡片解析来源、摘录并解码跳转，不把页面广告当作来源', () => {
    const target = 'https://www.douyin.com/video/123';
    const encoded = `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`;
    const sources = parseSearchHTML(
      html(encoded) + '<a href="https://ad.example">广告</a>',
      '杭州',
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      url: target,
      title: '杭州攻略',
      snippet: '真实旅游攻略',
      query: '杭州',
    });
    expect(sources[0]).not.toHaveProperty('publishedAt');
    expect(
      parseSearchHTML(html('javascript:alert(1)') + html('https://safe.example'), '杭州').map(
        (s) => s.url,
      ),
    ).toEqual(['https://safe.example/']);
  });
  it('阻止凭据链接；无法解析、验证页与真正无结果分别处理', () => {
    expect(() => parseSearchHTML(html('https://user:secret@example.com'), '杭州')).toThrow(
      '链接格式',
    );
    expect(() => parseSearchHTML('<h1>服务维护</h1>', '杭州')).toThrow('格式变化');
    expect(() => parseSearchHTML('<div id="b_captcha"></div>', '杭州')).toThrow('要求验证');
    expect(parseSearchHTML('<ol id="b_results"><li class="b_no">无结果</li></ol>', '杭州')).toEqual(
      [],
    );
  });
  it('合并多个查询、去重并对返回的来源总量设限，不调用其他模型或携带认证头', async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.redirect).toBe('manual');
      const query = new URL(url).searchParams.get('q');
      return new Response(
        `<ol id="b_results">${Array.from({ length: 10 }, (_, i) => `<li class="b_algo"><h2><a href="https://example.com/${query}/${i}">景点${i}</a></h2></li>`).join('')}</ol>`,
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await service().search(['杭州', '杭州', '西湖'], new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.sources).toHaveLength(8);
    expect(result.sources.slice(0, 2).map((source) => source.query)).toEqual(['杭州', '西湖']);
  });
  it('拒绝错误 HTTP 和格式，不把登录页当作搜索成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('key=secret', { status: 429 })));
    await expect(service().search(['杭州'], new AbortController().signal)).rejects.toThrow(
      'HTTP 429',
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>Login</h1>')));
    await expect(service().search(['杭州'], new AbortController().signal)).rejects.toThrow(
      '格式变化',
    );
  });
  it('允许必应地域跳转，拒绝跳往其他服务器', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cn.bing.com/search?q=test' },
        }),
      )
      .mockResolvedValueOnce(new Response(html()));
    vi.stubGlobal('fetch', fetchMock);
    expect((await service().search(['杭州'], new AbortController().signal)).sources).toHaveLength(
      1,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock
      .mockReset()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
      );
    await expect(service().search(['杭州'], new AbortController().signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('搜索引擎放宽 site 限制时不把其他站点伪装成小红书或抖音结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(html('https://example.com/guide'))),
    );
    expect(
      (await service().search(['site:xiaohongshu.com 杭州'], new AbortController().signal)).sources,
    ).toEqual([]);
  });
  it('取消和超时会中断正在运行的网络请求', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    );
    const controller = new AbortController();
    const task = service().search(['杭州'], controller.signal);
    controller.abort();
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await expect(service(10).search(['杭州'], new AbortController().signal)).rejects.toMatchObject({
      code: 'WEB_SEARCH_TIMEOUT',
    });
  });
  it('失败的并发查询中止同批其他请求，不返回部分结果冒充完整成功', async () => {
    let aborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL, { signal }) => {
        if (new URL(url).searchParams.get('q') === '失败')
          return Promise.resolve(new Response('error', { status: 503 }));
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      }),
    );
    await expect(service().search(['等待', '失败'], new AbortController().signal)).rejects.toThrow(
      'HTTP 503',
    );
    expect(aborted).toBe(true);
  });
});
