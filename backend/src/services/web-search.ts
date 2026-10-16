import { load } from 'cheerio';
import { z } from 'zod';
import { WebSourceSchema, type WebSource } from '@stree/shared';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { traceAiCall } from '../planning/ai-recorder.js';

export const WebSearchArgsSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(4),
});
export interface TravelWebSearch {
  status(): { enabled: boolean; configured: boolean; provider: string };
  search(
    queries: string[],
    signal: AbortSignal,
  ): Promise<{
    sources: WebSource[];
    truncated: boolean;
    queryResults?: { query: string; matchedSources: number }[];
  }>;
}
export type SearchOptions = { enabled: boolean; endpoint: string; timeoutMs: number };

/** Decode Bing's public result links; never expose executable or credential-bearing URLs. */
function sourceURL(href: string): string | null {
  try {
    let url = new URL(href);
    if (/(^|\.)bing\.com$/.test(url.hostname)) {
      if (url.pathname !== '/ck/a') return null;
      const encoded = url.searchParams.get('u');
      if (!encoded) return null;
      url = new URL(
        encoded.startsWith('a1')
          ? Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
          : encoded,
      );
    }
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Extract actual search result cards. Page dates are not treated as article publication dates. */
export function parseSearchHTML(html: string, query: string): WebSource[] {
  const $ = load(html);
  if ($('#b_captcha, #captcha, form[action*="turing"]').length)
    throw new AppError('搜索服务要求验证，请稍后重试。', 503, 'WEB_SEARCH_CHALLENGE');
  if (!$('#b_results').length)
    throw new AppError(
      '搜索页面格式变化或暂时不可用，未取得可验证的搜索结果。',
      502,
      'WEB_SEARCH_INVALID_RESPONSE',
    );
  const sources = new Map<string, WebSource>();
  $('#b_results > li.b_algo').each((_index, element) => {
    const link = $(element).find('h2 a').first();
    const url = sourceURL(link.attr('href') ?? '');
    if (!url) return;
    const snippet = $(element).find('.b_caption p').first().text().replace(/\s+/g, ' ').trim();
    const source = WebSourceSchema.safeParse({
      url,
      title: link.text().replace(/\s+/g, ' ').trim().slice(0, 500) || new URL(url).hostname,
      ...(snippet ? { snippet: snippet.slice(0, 5000) } : {}),
      query,
      retrievedAt: new Date().toISOString(),
    });
    if (source.success && !sources.has(source.data.url)) sources.set(source.data.url, source.data);
  });
  if (!sources.size && $('#b_results > li.b_algo').length)
    throw new AppError(
      '搜索结果链接格式无法识别，未取得可验证的来源。',
      502,
      'WEB_SEARCH_INVALID_RESPONSE',
    );
  if (!sources.size && !$('.b_no, #b_results .b_ans').length)
    throw new AppError('搜索未返回可识别的结果或无结果提示。', 502, 'WEB_SEARCH_INVALID_RESPONSE');
  return [...sources.values()];
}

async function readHTML(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('搜索服务返回空响应。', 502);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new AppError('搜索页面过大，请缩小搜索范围。', 502);
      }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

/** Current planning models call this tool; retrieval itself uses public search, without another LLM. */
export class PublicWebSearch implements TravelWebSearch {
  constructor(
    private options: SearchOptions = {
      enabled: config.WEB_SEARCH_ENABLED,
      endpoint: config.WEB_SEARCH_ENDPOINT,
      timeoutMs: config.WEB_SEARCH_TIMEOUT_MS,
    },
  ) {
    const url = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AppError('搜索地址必须是无凭据、查询参数和片段的 HTTP(S) URL。', 400);
  }
  status() {
    return { enabled: this.options.enabled, configured: true, provider: 'bing' };
  }
  async search(queries: string[], signal: AbortSignal) {
    const input = WebSearchArgsSchema.parse({ queries });
    signal.throwIfAborted();
    const options = { ...this.options };
    if (!options.enabled) throw new AppError('联网搜索已关闭。', 503, 'WEB_SEARCH_DISABLED');
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, timeout, controller.signal]);
    let failure: unknown;
    const queriesToRun = [...new Set(input.queries)];
    const pending = queriesToRun.map(async (query) => {
      try {
        return await this.searchOne(query, options, combined);
      } catch (error) {
        failure ??= error;
        controller.abort(error);
        throw error;
      }
    });
    const settled = await Promise.allSettled(pending);
    signal.throwIfAborted();
    if (timeout.aborted)
      throw new AppError('联网搜索超时，可以稍后重试。', 504, 'WEB_SEARCH_TIMEOUT');
    if (failure) throw failure;
    const results = settled.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
    const sources = new Map<string, WebSource>();
    // Interleave queries so a broad query cannot consume all returned sources.
    for (let rank = 0; rank < Math.max(0, ...results.map((items) => items.length)); rank++)
      for (const items of results) {
        const source = items[rank];
        if (source && !sources.has(source.url)) sources.set(source.url, source);
      }
    return {
      sources: [...sources.values()].slice(0, 8),
      truncated: sources.size > 8,
      queryResults: queriesToRun.map((query, index) => ({
        query,
        matchedSources: results[index]!.length,
      })),
    };
  }
  private searchOne(
    query: string,
    options: SearchOptions,
    signal: AbortSignal,
  ): Promise<WebSource[]> {
    const url = new URL(options.endpoint);
    url.search = `q=${encodeURIComponent(query)}`;
    return traceAiCall(
      'tool',
      { query, endpoint: options.endpoint },
      async () => {
        let response: Response;
        try {
          let target = url;
          const allowedHosts = new Set([
            url.hostname,
            ...(/(^|\.)bing\.com$/.test(url.hostname) ? ['www.bing.com', 'cn.bing.com'] : []),
          ]);
          for (let hop = 0; ; hop++) {
            response = await fetch(target, {
              redirect: 'manual',
              signal,
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; STREE/2.0)', Accept: 'text/html' },
            });
            if (![301, 302, 303, 307, 308].includes(response.status)) break;
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (!location || hop >= 3)
              throw new AppError('搜索服务跳转次数过多或缺少目标地址。', 502);
            const next = new URL(location, target);
            if (
              !allowedHosts.has(next.hostname) ||
              next.protocol !== url.protocol ||
              next.port !== url.port ||
              next.username ||
              next.password
            )
              throw new AppError(
                '搜索服务跳转到未允许的地址，已停止请求。',
                502,
                'WEB_SEARCH_REDIRECT_BLOCKED',
              );
            target = next;
          }
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof AppError) throw error;
          throw new AppError('无法连接网页搜索服务，请检查网络。', 502, 'WEB_SEARCH_NETWORK_ERROR');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new AppError(
            `网页搜索 HTTP ${response.status}，请稍后重试。`,
            502,
            'WEB_SEARCH_PROVIDER_ERROR',
          );
        }
        const sources = parseSearchHTML(await readHTML(response), query);
        // Search engines can relax site: restrictions. Enforce the requested host ourselves.
        const domains = [...query.matchAll(/(?:^|\s)site:([a-z0-9.-]+)/gi)].map((match) =>
          match[1]!.toLowerCase(),
        );
        return domains.length
          ? sources.filter((source) => {
              const host = new URL(source.url).hostname.toLowerCase();
              return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
            })
          : sources;
      },
      { name: 'web_search.http', provider: 'bing' },
    );
  }
}
