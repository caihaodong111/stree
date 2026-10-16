import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  ProviderInputSchema,
  ProviderProbeSchema,
  ProviderSchema,
  TripSchema,
  AgentPlanSchema,
  type Provider,
} from '@stree/shared';
import { ProviderStore, type StoredProvider } from '../backend/src/models/providers.js';
import { ModelService } from '../backend/src/models/service.js';
import { discoverModels, generateWithProvider } from '../backend/src/models/http-client.js';
import { createApp } from '../backend/src/app.js';
import { FileTripStore } from '../backend/src/db/store.js';
import { FileAiStore } from '../backend/src/db/ai-store.js';
import type { AmapService } from '../backend/src/services/amap.js';
import { agentPlan, city, places, request, tripFixture } from './fixtures/travel.js';
import { createOutputDecoder, queryKey } from '../backend/src/models/output.js';

const servers: Server[] = [];
const directories: string[] = [];
const options = () => ({
  instructions: '只使用真实地点',
  prompt: '返回 JSON 行程',
  outputSchema: { type: 'object' },
  tools: [
    {
      type: 'function' as const,
      name: 'search_hotels',
      description: '查询酒店',
      inputSchema: { type: 'object' },
    },
  ],
  handleTool: vi.fn().mockResolvedValue({ hotels: ['verified-hotel'] }),
  signal: new AbortController().signal,
  onProgress: vi.fn(),
});
const base = (
  baseURL: string,
  protocol: Provider['protocol'] = 'openai-completions',
): StoredProvider => ({
  id: 'test-vendor',
  name: '测试厂商',
  baseURL,
  protocol,
  apiKey: 'test-secret-key',
  models: [{ id: 'vendor-model', name: '测试模型' }],
  maxOutputTokens: 16384,
  jsonMode: false,
});
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), 'stree-providers-'));
  directories.push(dir);
  return dir;
}
async function server(
  handler: (
    url: string,
    body: any,
    headers: any,
    reply: (data: object, status?: number) => void,
  ) => void,
) {
  const instance = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    handler(req.url!, text ? JSON.parse(text) : {}, req.headers, (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  servers.push(instance);
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map((item) => {
      item.closeAllConnections();
      return new Promise<void>((resolve) => item.close(() => resolve()));
    }),
  );
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('第三方提供方配置', () => {
  it('密钥仅保存后端、留空保留、可替换清除，并在重启后保留配置', async () => {
    const file = path.join(await directory(), 'providers.json');
    const store = new ProviderStore(file);
    const input = base('http://localhost:9000/v1');
    await store.save(input, true);
    expect(JSON.stringify(await store.list())).not.toContain('test-secret-key');
    expect((await store.list())[0]?.keyConfigured).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.select({ providerId: input.id, model: 'vendor-model', effort: null });
    const restarted = new ProviderStore(file);
    expect((await restarted.get(input.id))?.apiKey).toBe(input.apiKey);
    expect((await restarted.selection())?.model).toBe('vendor-model');
    await restarted.save({ ...input, apiKey: '' }, false);
    expect((await restarted.get(input.id))?.apiKey).toBe(input.apiKey);
    await restarted.save({ ...input, apiKey: 'replacement' }, false);
    expect((await restarted.get(input.id))?.apiKey).toBe('replacement');
    await restarted.save({ ...input, apiKey: '', clearApiKey: true }, false);
    expect((await restarted.list())[0]?.keyConfigured).toBe(false);
    await expect(restarted.delete(input.id)).rejects.toMatchObject({ statusCode: 409 });
    await restarted.select(null);
    await restarted.delete(input.id);
    expect(await restarted.list()).toEqual([]);
    expect(await readFile(file, 'utf8')).not.toContain('replacement');
  });
  it('拒绝非法协议、地址、ID、重复或空模型，防止覆盖其他提供方', async () => {
    const input = base('https://vendor.example/v1');
    for (const patch of [
      { id: '9bad' },
      { id: 'codex' },
      { baseURL: 'file:///secret' },
      { baseURL: 'https://user:pass@vendor.test' },
      { models: [] },
      { models: [{ id: 'same' }, { id: 'same' }] },
      { apiKey: 'bad\nkey' },
    ])
      expect(ProviderInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    const store = new ProviderStore(path.join(await directory(), 'providers.json'));
    await store.save(input, true);
    await expect(store.save(input, true)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      store.select({ providerId: input.id, model: 'missing', effort: null }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('移除本机账户后的模型选择', () => {
  it.each([
    null,
    { model: 'old-codex-model', effort: 'high' },
    { providerId: 'codex', model: null, effort: null },
  ])('旧配置 %j 自动选用第一个提供方并在重启后保留', async (selection) => {
    const file = path.join(await directory(), 'providers.json');
    const provider = base('https://vendor.example/v1');
    await writeFile(file, JSON.stringify({ providers: [provider], selection }));
    const models = new ModelService(new ProviderStore(file));
    const settings = await models.settings();
    expect(settings.settings).toEqual({
      providerId: provider.id,
      model: 'vendor-model',
      effort: null,
    });
    expect(settings.models).toEqual([]);
    expect(await new ProviderStore(file).selection()).toEqual(settings.settings);
    expect((await models.status()).model).toMatchObject({
      configured: true,
      provider: provider.name,
    });
    expect(JSON.stringify(settings)).not.toContain(provider.apiKey);
  });
  it('没有提供方时要求先添加模型，并拒绝保存本机账户选择', async () => {
    const models = new ModelService(
      new ProviderStore(path.join(await directory(), 'providers.json')),
    );
    expect((await models.settings()).effectiveModel).toBeNull();
    expect((await models.status()).model.configured).toBe(false);
    await expect(models.session()).rejects.toMatchObject({ statusCode: 503 });
    for (const providerId of [undefined, 'codex'])
      await expect(
        models.saveSettings({ providerId, model: null, effort: null }),
      ).rejects.toMatchObject({ statusCode: 400 });
  });
  it('保留已选的其他提供方及其模型', async () => {
    const file = path.join(await directory(), 'providers.json');
    const first = base('https://first.example/v1');
    const second = { ...first, id: 'second', name: '第二个提供方' };
    const selection = { providerId: second.id, model: 'vendor-model', effort: null };
    await writeFile(file, JSON.stringify({ providers: [first, second], selection }));
    expect((await new ModelService(new ProviderStore(file)).settings()).settings).toEqual(
      selection,
    );
  });
});

describe('获取可用模型', () => {
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    '%s 保留网关路径并使用对应认证头',
    async (protocol) => {
      const calls: { route: string; headers: Record<string, string> }[] = [];
      const url = await server((route, _body, headers, reply) => {
        calls.push({ route, headers });
        reply({ data: [{ id: 'model', displayName: '目录模型' }] });
      });
      expect(await discoverModels(base(`${url}/gateway/v1/`, protocol))).toEqual([
        { id: 'model', name: '目录模型' },
      ]);
      expect(calls[0].route).toBe(
        protocol === 'anthropic-messages' ? '/gateway/v1/models?limit=1000' : '/gateway/v1/models',
      );
      expect(calls[0].headers.accept).toBe('application/json');
      if (protocol === 'anthropic-messages') {
        expect(calls[0].headers['x-api-key']).toBe('test-secret-key');
        expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
        expect(calls[0].headers.authorization).toBeUndefined();
      } else expect(calls[0].headers.authorization).toBe('Bearer test-secret-key');
    },
  );
  it('通过 API 获取时复用已存密钥，新值优先，明确清除和新增探测不借用密钥', async () => {
    const seen: (string | undefined)[] = [];
    const url = await server((_route, _body, headers, reply) => {
      seen.push(headers.authorization);
      reply({ data: [{ id: 'listed-model' }] });
    });
    const dir = await directory();
    const providers = new ProviderStore(path.join(dir, 'providers.json'));
    const provider = base(url);
    await providers.save(provider, true);
    const app = await createApp({
      providers,
      store: new FileTripStore(dir),
      audit: new FileAiStore(path.join(dir, 'audit')),
      logger: false,
    });
    try {
      for (const patch of [
        { id: provider.id, apiKey: '' },
        { id: provider.id, apiKey: 'replacement' },
        { id: provider.id, clearApiKey: true },
        {},
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/settings/providers/discover',
          payload: { baseURL: url, protocol: 'openai-completions', ...patch },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ models: [{ id: 'listed-model', name: 'listed-model' }] });
        expect(response.body).not.toContain(provider.apiKey);
      }
      expect(seen).toEqual(['Bearer test-secret-key', 'Bearer replacement', undefined, undefined]);
      expect((await providers.get(provider.id))?.apiKey).toBe('test-secret-key');
      expect((await providers.list())[0]?.models).toEqual(provider.models);
    } finally {
      await app.close();
    }
  });
  it('读取完整大目录，并兼容网关别名、重复模型和不同名称字段', async () => {
    const url = await server((route, _body, _headers, reply) => {
      if (route.startsWith('/map/'))
        return reply({
          models: {
            alias: { id: 'canonical', displayName: '别名模型' },
            '': { id: 'fallback', name: '备用模型' },
            metadata: 123,
          },
        });
      reply({
        data: [
          null,
          {},
          { id: 'first', display_name: '', name: '首个模型' },
          { id: 'first', name: '重复模型' },
          ...Array.from({ length: 250 }, (_, index) => ({ id: `model-${index}` })),
        ],
      });
    });
    const models = await discoverModels(base(url));
    expect(models).toHaveLength(251);
    expect(models[0]).toEqual({ id: 'first', name: '首个模型' });
    expect(models.at(-1)?.id).toBe('model-249');
    expect(await discoverModels(base(`${url}/map`))).toEqual([
      { id: 'alias', name: '别名模型' },
      { id: 'fallback', name: '备用模型' },
    ]);
  });
  it('认证拒绝保留上游原因，提示更换密钥且不泄露或修改旧配置', async () => {
    const url = await server((_route, _body, _headers, reply) =>
      reply({ error: { message: 'test-secret-key 无效或已删除' } }, 401),
    );
    await expect(discoverModels(base(url))).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_REJECTED',
      message: expect.stringContaining('填写该 API 地址对应的有效密钥'),
    });
    await expect(discoverModels(base(url))).rejects.toThrow('[已隐藏密钥] 无效或已删除');
  });
  it.each(['空 格', '中文密钥', 'bad\nkey', '   '])(
    '非法密钥 %j 在请求前报告格式错误',
    async (apiKey) => {
      expect(
        ProviderProbeSchema.safeParse({
          baseURL: 'http://localhost/v1',
          protocol: 'openai-completions',
          apiKey,
        }).success,
      ).toBe(false);
      await expect(
        discoverModels({ ...base('http://localhost/v1'), apiKey }),
      ).rejects.toMatchObject({ statusCode: 400 });
    },
  );
  it('空目录和过大目录给出可操作错误', async () => {
    const url = await server((route, _body, _headers, reply) => {
      if (route.startsWith('/large/')) return reply({ models: 'x'.repeat(4 * 1024 * 1024) });
      reply({ data: [] });
    });
    await expect(discoverModels(base(url))).rejects.toThrow('手动添加模型 ID');
    await expect(discoverModels(base(`${url}/large`))).rejects.toThrow('模型目录响应过大');
  });
});

describe('Harness 模型容量字段的存储与调用适配', () => {
  it('发现的容量字段可保存并在重启后保留，模型输出上限用于生成请求', async () => {
    const seen: any[] = [];
    const url = await server((route, body, _headers, reply) => {
      if (route.endsWith('/models'))
        return reply({
          data: [
            {
              id: 'vendor-model',
              display_name: '目录模型',
              context_length: 256000,
              top_provider: { max_completion_tokens: 32000 },
            },
          ],
        });
      seen.push(body);
      reply({ choices: [{ message: { content: '{"result":true}' }, finish_reason: 'stop' }] });
    });
    const listed = await discoverModels(base(url));
    expect(listed).toEqual([
      { id: 'vendor-model', name: '目录模型', contextWindow: 256000, maxTokens: 32000 },
    ]);
    const file = path.join(await directory(), 'providers.json');
    const store = new ProviderStore(file);
    const provider = { ...base(url), models: listed, maxOutputTokens: null };
    await store.save(provider, true);
    const restarted = new ProviderStore(file);
    expect((await restarted.get(provider.id))?.models).toEqual(listed);
    const service = new ModelService(restarted);
    await (await service.session()).generate(options());
    expect(seen[0].max_tokens).toBe(32000);
    await restarted.save({ ...provider, maxOutputTokens: 8192 }, false);
    await (await service.session()).generate(options());
    expect(seen[1].max_tokens).toBe(8192);
    for (const patch of [{ contextWindow: 0 }, { maxTokens: -1 }, { maxTokens: 1.5 }])
      expect(
        ProviderSchema.safeParse({ ...provider, models: [{ id: 'vendor-model', ...patch }] })
          .success,
      ).toBe(false);
  });
});

describe('厂商 API 协议与工具循环', () => {
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    '%s 连续重复成功查询时转入最终成稿，保留查询结果并避免无效循环',
    async (protocol) => {
      let rounds = 0;
      const url = await server((_route, body, _headers, reply) => {
        rounds++;
        const done = rounds === 6;
        if (done) {
          expect(body.tools).toEqual([]);
          expect(JSON.stringify(body)).toContain('复用已有');
          expect(JSON.stringify(body)).toContain('verified-hotel');
        }
        const text = JSON.stringify(agentPlan());
        if (protocol === 'openai-completions')
          reply({
            choices: [
              {
                message: done
                  ? { content: text }
                  : {
                      tool_calls: [
                        {
                          id: `call-${rounds}`,
                          type: 'function',
                          function: { name: 'search_hotels', arguments: '{"keyword":"西湖"}' },
                        },
                      ],
                    },
                finish_reason: done ? 'stop' : 'tool_calls',
              },
            ],
          });
        else if (protocol === 'openai-responses')
          reply({
            status: 'completed',
            output: done
              ? [{ type: 'message', content: [{ type: 'output_text', text }] }]
              : [
                  {
                    type: 'function_call',
                    call_id: `call-${rounds}`,
                    name: 'search_hotels',
                    arguments: '{"keyword":"西湖"}',
                  },
                ],
          });
        else
          reply({
            stop_reason: done ? 'end_turn' : 'tool_use',
            content: done
              ? [{ type: 'text', text }]
              : [
                  {
                    type: 'tool_use',
                    id: `call-${rounds}`,
                    name: 'search_hotels',
                    input: { keyword: '西湖' },
                  },
                ],
          });
      });
      const result = await generateWithProvider(base(url, protocol), 'fixture', options());
      expect(JSON.parse(result.text)).toEqual(agentPlan());
      expect(rounds).toBe(6);
    },
  );
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    '%s 完成工具调用、回传结果与 JSON 输出',
    async (protocol) => {
      const requests: any[] = [];
      const url = await server((route, body, headers, reply) => {
        requests.push({ route, body, headers });
        if (requests.length === 1) {
          if (protocol === 'openai-completions')
            reply({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    reasoning_content: '',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'search_hotels', arguments: '{"keyword":"西湖"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            });
          else if (protocol === 'openai-responses')
            reply({
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  call_id: 'call-1',
                  name: 'search_hotels',
                  arguments: '{"keyword":"西湖"}',
                },
              ],
            });
          else
            reply({
              stop_reason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'call-1',
                  name: 'search_hotels',
                  input: { keyword: '西湖' },
                },
              ],
            });
        } else {
          const text = JSON.stringify(agentPlan());
          if (protocol === 'openai-completions')
            reply({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
          else if (protocol === 'openai-responses')
            reply({
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
            });
          else reply({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
        }
      });
      const input = options();
      const result = await generateWithProvider(base(`${url}/v1`, protocol), 'vendor-model', input);
      expect(input.handleTool).toHaveBeenCalledWith('search_hotels', { keyword: '西湖' });
      expect(JSON.parse(result.text)).toEqual(agentPlan());
      expect(result).toMatchObject({ model: 'vendor-model', engine: 'custom-provider' });
      expect(requests).toHaveLength(2);
      for (const { body } of requests) {
        if (protocol === 'openai-completions') expect(body.enable_thinking).toBe(false);
        else if (protocol === 'openai-responses')
          expect(body.reasoning).toEqual({ effort: 'none' });
        else expect(body.thinking).toEqual({ type: 'disabled' });
      }
      expect(requests[0].route).toBe(
        protocol === 'openai-completions'
          ? '/v1/chat/completions'
          : protocol === 'openai-responses'
            ? '/v1/responses'
            : '/v1/messages',
      );
      expect(JSON.stringify(requests[1].body)).toContain('verified-hotel');
      expect(
        requests[0].body[protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'],
      ).toBe(16384);
      if (protocol === 'anthropic-messages')
        expect(requests[0].headers['x-api-key']).toBe('test-secret-key');
      else expect(requests[0].headers.authorization).toBe('Bearer test-secret-key');
      if (protocol === 'openai-completions')
        expect(requests[1].body.messages[2]).not.toHaveProperty('reasoning_content');
    },
  );
  it.each(['openai-completions', 'openai-responses'] as const)(
    '%s 默认不发送项目输出 Token 上限',
    async (protocol) => {
      const url = await server((_route, body, _headers, reply) => {
        expect(body).not.toHaveProperty('max_tokens');
        expect(body).not.toHaveProperty('max_completion_tokens');
        expect(body).not.toHaveProperty('max_output_tokens');
        const text = JSON.stringify(agentPlan());
        reply(
          protocol === 'openai-completions'
            ? { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
            : {
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
              },
        );
      });
      const { maxOutputTokens: _, apiKey: _key, ...provider } = base(url, protocol);
      const parsed = ProviderSchema.parse(provider);
      expect(parsed.maxOutputTokens).toBeNull();
      expect(
        JSON.parse(
          (await generateWithProvider({ ...parsed, apiKey: '' }, 'vendor-model', options())).text,
        ),
      ).toEqual(agentPlan());
    },
  );
  it('模型截断且没有任何输出时保留上游原因', async () => {
    const url = await server((_route, _body, _headers, reply) =>
      reply({
        choices: [{ message: { content: null }, finish_reason: 'length' }],
      }),
    );
    await expect(
      generateWithProvider({ ...base(url), maxOutputTokens: null }, 'vendor-model', options()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_OUTPUT_INCOMPLETE',
      message: '模型服务结束输出（finish_reason=length），未提供可续写内容。',
    });
  });
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    '%s 自动续写多段截断 JSON，保留字符串中的空格和协议历史',
    async (protocol) => {
      const expected = { summary: '第一段 保留 空格', routes: agentPlan().routes };
      const text = JSON.stringify(expected);
      const cuts = [text.indexOf(' 保留') + 1, text.indexOf(' 空格') + 1, text.length - 19];
      const pieces = [
        text.slice(0, cuts[0]),
        text.slice(cuts[0], cuts[1]),
        text.slice(cuts[1], cuts[2]),
        text.slice(cuts[2]),
      ];
      const requests: any[] = [];
      const url = await server((_route, body, _headers, reply) => {
        const round = requests.push(body) - 1;
        expect(round).toBeLessThan(pieces.length);
        const done = round === pieces.length - 1;
        const text = pieces[round];
        if (round > 0) {
          const history = protocol === 'openai-responses' ? body.input : body.messages;
          expect(history.at(-1).role).toBe('user');
          expect(history.at(-1).content).toContain('不重复已输出内容');
          expect(JSON.stringify(history)).toContain(pieces[round - 1].replaceAll('"', '\\"'));
        }
        if (protocol === 'openai-completions')
          reply({
            choices: [
              {
                message: { content: text, reasoning_content: '' },
                finish_reason: done ? 'stop' : 'length',
              },
            ],
          });
        else if (protocol === 'openai-responses')
          reply({
            status: done ? 'completed' : 'incomplete',
            incomplete_details: done ? null : { reason: 'max_output_tokens' },
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
            ],
          });
        else
          reply({
            stop_reason: done ? 'end_turn' : 'max_tokens',
            content: [{ type: 'text', text }],
          });
      });
      const input = options();
      const result = await generateWithProvider(base(url, protocol), 'vendor-model', input);
      expect(JSON.parse(result.text)).toEqual(expected);
      expect(requests).toHaveLength(4);
      expect(input.onProgress).toHaveBeenCalledTimes(3);
      if (protocol === 'openai-completions')
        expect(requests[1].messages[2]).not.toHaveProperty('reasoning_content');
    },
  );
  it('length 标记下的完整 JSON 直接使用，无需丢弃或重新生成', async () => {
    let requests = 0;
    const url = await server((_route, _body, _headers, reply) => {
      requests++;
      reply({
        choices: [{ message: { content: JSON.stringify(agentPlan()) }, finish_reason: 'length' }],
      });
    });
    expect(
      JSON.parse((await generateWithProvider(base(url), 'vendor-model', options())).text),
    ).toEqual(agentPlan());
    expect(requests).toBe(1);
  });
  it('提供方忽略关闭参数仍返回推理时明确拒绝，不继续工具调用或续写', async () => {
    let requests = 0;
    const url = await server((_route, body, _headers, reply) => {
      requests++;
      expect(body.enable_thinking).toBe(false);
      reply({
        choices: [
          { message: { content: null, reasoning_content: 'PRIVATE' }, finish_reason: 'length' },
        ],
      });
    });
    await expect(generateWithProvider(base(url), 'vendor-model', options())).rejects.toMatchObject({
      code: 'THINKING_MODE_UNSUPPORTED',
    });
    expect(requests).toBe(1);
  });
  it('Qwen 服务重建后仍关闭聊天模板思考，拒绝重新启用思考强度', async () => {
    const requests: any[] = [];
    const url = await server((_route, body, _headers, reply) => {
      requests.push(body);
      reply({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
    });
    const file = path.join(await directory(), 'providers.json');
    const store = new ProviderStore(file);
    const provider = { ...base(url), models: [{ id: 'qwen-fixture', name: 'Qwen' }] };
    await store.save(provider, true);
    await expect(
      store.select({ providerId: provider.id, model: 'qwen-fixture', effort: 'high' }),
    ).rejects.toThrow('模型推理已永久关闭');
    await store.select({ providerId: provider.id, model: 'qwen-fixture', effort: null });
    const restarted = new ModelService(new ProviderStore(file));
    await (await restarted.session()).generate(options());
    expect(requests[0]).toMatchObject({
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
  it.each([
    {
      usage: { completion_tokens_details: { reasoning_tokens: 1 } },
      choices: [{ message: { content: '{}' } }],
    },
    { output: [{ type: 'reasoning', summary: [] }] },
    { content: [{ type: 'thinking', thinking: 'PRIVATE' }] },
  ])('服务端报告推理内容或Token时拒绝接受结果 %#', async (response) => {
    const url = await server((_route, _body, _headers, reply) => reply(response));
    const protocol =
      'output' in response
        ? 'openai-responses'
        : 'content' in response
          ? 'anthropic-messages'
          : 'openai-completions';
    await expect(
      generateWithProvider(base(url, protocol), 'fixture', options()),
    ).rejects.toMatchObject({ code: 'THINKING_MODE_UNSUPPORTED' });
  });
  it('续写期间的上游 HTTP 错误仍按接口原始原因显示', async () => {
    let requests = 0;
    const url = await server((_route, _body, _headers, reply) => {
      if (++requests === 1)
        return reply({
          choices: [{ message: { content: '{"summary":"' }, finish_reason: 'length' }],
        });
      reply({ error: { message: 'context capacity exhausted' } }, 400);
    });
    await expect(generateWithProvider(base(url), 'vendor-model', options())).rejects.toMatchObject({
      code: 'PROVIDER_HTTP_ERROR',
      message: '模型接口返回 HTTP 400：context capacity exhausted',
    });
  });
  it('用户可以取消自动续写', async () => {
    const controller = new AbortController();
    let requests = 0;
    const url = await server((_route, _body, _headers, reply) => {
      requests++;
      reply({ choices: [{ message: { content: '{"summary":"' }, finish_reason: 'length' }] });
    });
    await expect(
      generateWithProvider(base(url), 'vendor-model', {
        ...options(),
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });
  it('工具参数被截断时回传错误要求模型修正，不执行残缺参数', async () => {
    let requests = 0;
    const url = await server((_route, body, _headers, reply) => {
      if (++requests === 1)
        return reply({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'truncated-call',
                    type: 'function',
                    function: { name: 'search_hotels', arguments: '{"keyword":"西' },
                  },
                  {
                    id: 'complete-call',
                    type: 'function',
                    function: { name: 'search_hotels', arguments: '{"keyword":"西湖"}' },
                  },
                ],
              },
              finish_reason: 'length',
            },
          ],
        });
      expect(JSON.parse(body.messages.at(-2).content).error).toContain('工具参数 JSON 不完整');
      expect(JSON.parse(body.messages.at(-1).content).hotels).toEqual(['verified-hotel']);
      reply({
        choices: [{ message: { content: JSON.stringify(agentPlan()) }, finish_reason: 'stop' }],
      });
    });
    const input = options();
    expect(JSON.parse((await generateWithProvider(base(url), 'vendor-model', input)).text)).toEqual(
      agentPlan(),
    );
    expect(input.handleTool).toHaveBeenCalledTimes(1);
  });
  it('模型续写时重新输出完整 JSON，使用完整版本', async () => {
    let requests = 0;
    const url = await server((_route, _body, _headers, reply) => {
      const done = ++requests > 1;
      reply({
        choices: [
          {
            message: { content: done ? JSON.stringify(agentPlan()) : '{"summary":"' },
            finish_reason: done ? 'stop' : 'length',
          },
        ],
      });
    });
    expect(
      JSON.parse((await generateWithProvider(base(url), 'vendor-model', options())).text),
    ).toEqual(agentPlan());
    expect(requests).toBe(2);
  });
  it('启用 JSON 模式时，续写片段不受完整 JSON 对象格式约束', async () => {
    let requests = 0;
    const expected = JSON.stringify(agentPlan());
    const cut = 37;
    const url = await server((_route, body, _headers, reply) => {
      const done = ++requests > 1;
      if (done) expect(body).not.toHaveProperty('response_format');
      else expect(body.response_format).toEqual({ type: 'json_object' });
      reply({
        choices: [
          {
            message: { content: done ? expected.slice(cut) : expected.slice(0, cut) },
            finish_reason: done ? 'stop' : 'length',
          },
        ],
      });
    });
    expect(
      JSON.parse(
        (await generateWithProvider({ ...base(url), jsonMode: true }, 'vendor-model', options()))
          .text,
      ),
    ).toEqual(agentPlan());
  });
  it('发现模型使用对应认证并支持无密钥本地服务', async () => {
    const seen: any[] = [];
    const url = await server((route, _body, headers, reply) => {
      seen.push({ route, headers });
      reply({
        data: [{ id: 'a', display_name: '模型 A' }, { id: 'a' }, { id: 'b', name: '模型 B' }],
      });
    });
    expect(await discoverModels(base(url, 'anthropic-messages'))).toHaveLength(2);
    expect(seen[0].route).toBe('/v1/models?limit=1000');
    expect(seen[0].headers['x-api-key']).toBe('test-secret-key');
    await discoverModels({ ...base(`${url}/v1`), apiKey: '' });
    expect(seen[1].headers.authorization).toBeUndefined();
  });
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    '%s 配置更高查询上限后仍能完成长行程，保留每次工具结果',
    async (protocol) => {
      let rounds = 0;
      const url = await server((_route, body, _headers, reply) => {
        rounds++;
        if (rounds > 1) {
          const history = JSON.stringify(body);
          for (let index = (rounds - 2) * 3; index < (rounds - 1) * 3; index++)
            expect(history).toContain(`verified-${index}`);
        }
        const calls = Array.from({ length: 3 }, (_, index) => ({
          id: `call-${(rounds - 1) * 3 + index}`,
          keyword: `地点-${(rounds - 1) * 3 + index}`,
        }));
        const done = rounds === 21;
        const text = JSON.stringify(agentPlan());
        if (protocol === 'openai-completions')
          reply({
            choices: [
              {
                finish_reason: done ? 'stop' : 'tool_calls',
                message: done
                  ? { content: text }
                  : {
                      content: null,
                      tool_calls: calls.map(({ id, keyword }) => ({
                        id,
                        type: 'function',
                        function: { name: 'search_hotels', arguments: JSON.stringify({ keyword }) },
                      })),
                    },
              },
            ],
          });
        else if (protocol === 'openai-responses')
          reply({
            status: 'completed',
            output: done
              ? [{ type: 'message', content: [{ type: 'output_text', text }] }]
              : calls.map(({ id, keyword }) => ({
                  type: 'function_call',
                  call_id: id,
                  name: 'search_hotels',
                  arguments: JSON.stringify({ keyword }),
                })),
          });
        else
          reply({
            stop_reason: done ? 'end_turn' : 'tool_use',
            content: done
              ? [{ type: 'text', text }]
              : calls.map(({ id, keyword }) => ({
                  type: 'tool_use',
                  id,
                  name: 'search_hotels',
                  input: { keyword },
                })),
          });
      });
      const input = options();
      input.handleTool.mockImplementation(async (_name, args) => ({
        hotels: [`verified-${args.keyword.split('-')[1]}`],
      }));
      const result = await generateWithProvider(base(url, protocol), 'vendor-model', {
        ...input,
        limits: { maxToolRounds: 24, maxToolCalls: 80 },
      });
      expect(JSON.parse(result.text)).toEqual(agentPlan());
      expect(rounds).toBe(21);
      expect(input.handleTool).toHaveBeenCalledTimes(60);
      expect(input.onProgress).toHaveBeenLastCalledWith(
        '正在调用旅行工具：search_hotels（第 60 次）',
      );
    },
  );
  it('上游在工具查询后拒绝请求时显示实际接口原因', async () => {
    let rounds = 0;
    const url = await server((_route, _body, _headers, reply) => {
      if (++rounds === 3)
        return reply(
          { error: { message: 'context window exhausted', code: 'context_length_exceeded' } },
          400,
        );
      reply({
        choices: [
          {
            message: {
              tool_calls: Array.from({ length: 3 }, (_, index) => ({
                id: `call-${rounds}-${index}`,
                type: 'function',
                function: {
                  name: 'search_hotels',
                  arguments: JSON.stringify({ keyword: `地点-${rounds}-${index}` }),
                },
              })),
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    });
    const input = options();
    await expect(generateWithProvider(base(url), 'vendor-model', input)).rejects.toMatchObject({
      code: 'PROVIDER_HTTP_ERROR',
      message: '模型接口返回 HTTP 400：context window exhausted',
    });
    expect(input.handleTool).toHaveBeenCalledTimes(6);
  });
  it('识别模型在 HTTP 200 响应内返回的生成失败', async () => {
    const url = await server((_route, _body, _headers, reply) =>
      reply({ status: 'failed', error: { message: 'model unavailable' } }),
    );
    await expect(
      generateWithProvider(base(url, 'openai-responses'), 'vendor-model', options()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_GENERATION_FAILED',
      message: '模型接口返回错误：model unavailable',
    });
  });
  it('展示脱敏后的上游错误，并允许取消等待', async () => {
    const url = await server((_route, _body, _headers, reply) =>
      reply({ error: { message: 'test-secret-key internal diagnostics' } }, 401),
    );
    await expect(generateWithProvider(base(url), 'vendor-model', options())).rejects.toThrow(
      'HTTP 401',
    );
    try {
      await discoverModels(base(url));
    } catch (error) {
      expect(String(error)).not.toContain('test-secret-key');
      expect(String(error)).toContain('[已隐藏密钥] internal diagnostics');
    }
    const waiting = await server(() => {});
    const controller = new AbortController();
    const promise = generateWithProvider(base(waiting), 'vendor-model', {
      ...options(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('不跟随带密钥的重定向请求', async () => {
    let targetCalls = 0;
    const target = await server((_route, _body, _headers, reply) => {
      targetCalls++;
      reply({ data: [{ id: 'test' }] });
    });
    const redirect = createServer((_req, res) => {
      res.writeHead(302, { Location: `${target}/models` });
      res.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    servers.push(redirect);
    const url = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`;
    await expect(discoverModels(base(url))).rejects.toMatchObject({ code: 'PROVIDER_UNREACHABLE' });
    expect(targetCalls).toBe(0);
  });
});

it('通过设置 API 接入第三方并完成行程存储，不依赖 Codex 登录；已有会话固定凭据', async () => {
  const seen: any[] = [];
  const url = await server((_route, body, headers, reply) => {
    seen.push({ body, headers });
    reply({
      choices: [{ message: { content: JSON.stringify(agentPlan()) }, finish_reason: 'stop' }],
    });
  });
  const dir = await directory();
  const providers = new ProviderStore(path.join(dir, 'providers.json'));
  const amap = {
    configured: true,
    district: vi
      .fn()
      .mockResolvedValue([{ adcode: '330000', districts: [{ ...city, center: '120.15,30.27' }] }]),
    search: vi.fn().mockResolvedValue(places),
    leg: vi.fn().mockImplementation(async (from, to, mode) => ({
      from: from.name,
      to: to.name,
      mode,
      durationMinutes: 10,
      distanceMeters: 1000,
      price: 3,
      summary: '实际交通',
      polyline: [from.location, to.location],
      source: 'amap',
    })),
  } as unknown as AmapService;
  const app = await createApp({
    providers,
    amap,
    store: new FileTripStore(dir),
    audit: new FileAiStore(path.join(dir, 'audit')),
    logger: false,
  });
  try {
    const provider = base(`${url}/v1`);
    const created = await app.inject({
      method: 'POST',
      url: '/api/settings/providers',
      payload: provider,
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(provider.apiKey);
    const selected = await app.inject({
      method: 'PUT',
      url: '/api/settings/model',
      payload: { providerId: provider.id, model: 'vendor-model', effort: null },
    });
    expect(selected.json().settings.providerId).toBe(provider.id);
    expect((await app.inject('/api/status')).json().model.configured).toBe(true);
    const service = new ModelService(providers);
    const session = await service.session();
    await providers.save({ ...provider, apiKey: 'new-key' }, false);
    await session.generate(options());
    expect(seen[0].headers.authorization).toBe('Bearer test-secret-key');
    const plan = await app.inject({
      method: 'POST',
      url: '/api/plans',
      payload: { ...request, origin: '' },
    });
    expect(plan.statusCode).toBe(202);
    const id = plan.json().jobId;
    await vi.waitFor(async () =>
      expect((await app.inject(`/api/jobs/${id}`)).json().status).toBe('completed'),
    );
    const result = (await app.inject(`/api/jobs/${id}`)).json().events.at(-1).trip;
    expect(TripSchema.parse(result).engine).toBe('custom-provider');
    expect((await app.inject(`/api/trips/${result.id}`)).json().model).toBe('vendor-model');
    expect((await app.inject('/api/settings/codex-models')).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

describe('生产行程格式与查询收尾回归', () => {
  const schema = z.toJSONSchema(AgentPlanSchema);
  const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
  const respond = (protocol: (typeof protocols)[number], text: string) =>
    protocol === 'openai-completions'
      ? { choices: [{ message: { content: text }, finish_reason: 'stop' }] }
      : protocol === 'openai-responses'
        ? {
            status: 'completed',
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
            ],
          }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text }] };

  it.each(protocols)(
    '%s 正常结束但括号损坏时恢复完整输出，保留查询上下文且禁止重新查询',
    async (protocol) => {
      let rounds = 0;
      const broken =
        '{"summary":"北京三日游","routes":[{"days":[{"stops":[{"guide":{"photography":"胡同砖墙"}]}]}]}</assistant>';
      const url = await server((_route, body, _headers, reply) => {
        rounds++;
        if (rounds === 1) return reply(respond(protocol, broken));
        expect(body.tools).toEqual([]);
        const history = protocol === 'openai-responses' ? body.input : body.messages;
        expect(JSON.stringify(history)).toContain('北京三日游');
        expect(JSON.stringify(history)).toContain('JSON 语法错误');
        expect(JSON.stringify(history)).toContain('禁止再次调用工具');
        reply(respond(protocol, JSON.stringify(agentPlan())));
      });
      const input = { ...options(), outputSchema: schema };
      const result = await generateWithProvider(base(url, protocol), 'vendor-model', input);
      expect(JSON.parse(result.text)).toEqual(agentPlan());
      expect(rounds).toBe(2);
      expect(input.handleTool).not.toHaveBeenCalled();
      expect(input.onProgress).toHaveBeenCalledWith(expect.stringContaining('自动恢复'));
    },
  );

  it('合法 JSON 缺少展示字段时也会恢复，不直接返回无法渲染的对象', async () => {
    let rounds = 0;
    const url = await server((_route, body, _headers, reply) => {
      rounds++;
      if (rounds === 1)
        return reply(respond('openai-completions', '{"summary":"三日游","routes":[]}'));
      expect(JSON.stringify(body.messages)).toContain('展示字段不符合 schema');
      reply(respond('openai-completions', JSON.stringify(agentPlan())));
    });
    const result = await generateWithProvider(base(url), 'vendor-model', {
      ...options(),
      outputSchema: schema,
    });
    expect(AgentPlanSchema.safeParse(JSON.parse(result.text)).success).toBe(true);
    expect(rounds).toBe(2);
  });

  it('只清除外层代码围栏及结束标签，保留字符串内同名文字和括号', async () => {
    const plan = agentPlan();
    plan.summary = '保留字符串 </assistant> 和 } ]，不要猜测括号';
    const decode = createOutputDecoder(schema);
    const decoded = decode('```json\n' + JSON.stringify(plan) + '\n```</assistant>');
    expect(decoded.error).toBeNull();
    expect(JSON.parse(decoded.text)).toEqual(plan);
    expect(decode('{"summary":"缺字段"}').error).toContain('schema');
    expect(decode('说明文字 ' + JSON.stringify(plan)).error).toContain('JSON 语法错误');
  });

  it('连续异常只恢复两次，明确失败并保留取消能力', async () => {
    let rounds = 0;
    const url = await server((_route, _body, _headers, reply) => {
      rounds++;
      reply(respond('openai-completions', '{"summary":'));
    });
    await expect(generateWithProvider(base(url), 'vendor-model', options())).rejects.toMatchObject({
      code: 'AI_OUTPUT_FORMAT',
    });
    expect(rounds).toBe(3);
    const controller = new AbortController();
    let pendingRounds = 0;
    const pending = await server((_route, _body, _headers, reply) => {
      if (++pendingRounds === 1) reply(respond('openai-completions', 'invalid'));
      else controller.abort();
    });
    await expect(
      generateWithProvider(base(pending), 'vendor-model', {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(pendingRounds).toBe(2);
  });

  it('截断后最后一段仍有语法错误时重新输出完整文档，不继续拼接损坏内容', async () => {
    let rounds = 0;
    const url = await server((_route, body, _headers, reply) => {
      rounds++;
      if (rounds === 1)
        return reply({
          choices: [{ message: { content: '{"summary":"' }, finish_reason: 'length' }],
        });
      if (rounds === 2) return reply(respond('openai-completions', 'broken",]'));
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages.at(-1).content).toContain('重新输出一份完整 JSON');
      reply(respond('openai-completions', JSON.stringify(agentPlan())));
    });
    const result = await generateWithProvider(
      { ...base(url), jsonMode: true },
      'vendor-model',
      options(),
    );
    expect(JSON.parse(result.text)).toEqual(agentPlan());
    expect(rounds).toBe(3);
  });

  it('重复参数按内容缓存，交错的新查询不会无限重置重复计数', async () => {
    let rounds = 0;
    const url = await server((_route, body, _headers, reply) => {
      rounds++;
      if (rounds === 8) {
        expect(body.tools).toEqual([]);
        return reply(respond('openai-completions', JSON.stringify(agentPlan())));
      }
      const keyword =
        rounds === 1 || rounds === 4
          ? 'A'
          : rounds === 2 || rounds === 6
            ? 'B'
            : rounds === 3
              ? 'C'
              : 'A';
      reply({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: `c-${rounds}`,
                  type: 'function',
                  function: {
                    name: 'search_hotels',
                    arguments: JSON.stringify(
                      rounds % 2 ? { keyword, kind: 'hotel' } : { kind: 'hotel', keyword },
                    ),
                  },
                },
              ],
            },
          },
        ],
      });
    });
    const input = options();
    const result = await generateWithProvider(base(url), 'vendor-model', input);
    expect(JSON.parse(result.text)).toEqual(agentPlan());
    expect(rounds).toBe(8);
    expect(input.handleTool).toHaveBeenCalledTimes(3);
    expect(
      queryKey(
        'measure_route',
        { fromId: 'real-origin', toId: 'A', mode: 'walking' },
        'real-origin',
      ),
    ).toBe(
      queryKey('measure_route', { mode: 'walking', toId: 'A', fromId: 'origin' }, 'real-origin'),
    );
  });

  it('批量工具达到上限后不再执行，但为全部 tool_call_id 提供匹配结果', async () => {
    let rounds = 0;
    const url = await server((_route, body, _headers, reply) => {
      rounds++;
      if (rounds === 1)
        return reply({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: Array.from({ length: 5 }, (_, i) => ({
                  id: `c-${i}`,
                  type: 'function',
                  function: {
                    name: 'search_hotels',
                    arguments: JSON.stringify({ keyword: String(i) }),
                  },
                })),
              },
            },
          ],
        });
      const outputs = body.messages.filter((m: any) => m.role === 'tool');
      expect(outputs).toHaveLength(5);
      expect(outputs[2].content).toContain('查询阶段已结束');
      expect(body.tools).toEqual([]);
      expect(body.tool_choice).toBe('none');
      reply(respond('openai-completions', JSON.stringify(agentPlan())));
    });
    const input = options();
    await generateWithProvider(base(url), 'vendor-model', {
      ...input,
      limits: { maxToolCalls: 2 },
    });
    expect(input.handleTool).toHaveBeenCalledTimes(2);
    expect(rounds).toBe(2);
  });

  it.each(protocols)('%s 新查询也受到轮数限制，切入无工具的最终输出', async (protocol) => {
    let rounds = 0;
    const url = await server((_route, body, _headers, reply) => {
      rounds++;
      if (rounds === 3) {
        expect(body.tools).toEqual([]);
        return reply(respond(protocol, JSON.stringify(agentPlan())));
      }
      const id = `c-${rounds}`;
      const input = { keyword: id };
      reply(
        protocol === 'openai-completions'
          ? {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id,
                        type: 'function',
                        function: { name: 'search_hotels', arguments: JSON.stringify(input) },
                      },
                    ],
                  },
                },
              ],
            }
          : protocol === 'openai-responses'
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'function_call',
                    call_id: id,
                    name: 'search_hotels',
                    arguments: JSON.stringify(input),
                  },
                ],
              }
            : {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id, name: 'search_hotels', input }],
              },
      );
    });
    const input = options();
    await generateWithProvider(base(url, protocol), 'vendor-model', {
      ...input,
      limits: { maxToolRounds: 2 },
    });
    expect(rounds).toBe(3);
    expect(input.handleTool).toHaveBeenCalledTimes(2);
  });

  it('模型忽略停止工具调用指令时也能有限结束，不执行额外工具', async () => {
    let rounds = 0;
    const url = await server((_route, _body, _headers, reply) => {
      rounds++;
      reply({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: `c-${rounds}`,
                  type: 'function',
                  function: { name: 'search_hotels', arguments: '{"keyword":"重复"}' },
                },
              ],
            },
          },
        ],
      });
    });
    const input = options();
    await expect(
      generateWithProvider(base(url), 'vendor-model', { ...input, limits: { maxToolRounds: 1 } }),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_RECOVERY_EXHAUSTED' });
    expect(input.handleTool).toHaveBeenCalledTimes(1);
    expect(rounds).toBe(13);
  });

  it('单次接口等待和整体生成均有超时提示，不误报用户取消', async () => {
    const url = await server(() => {});
    await expect(
      generateWithProvider(base(url), 'vendor-model', {
        ...options(),
        limits: { requestTimeoutMs: 30 },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    await expect(
      generateWithProvider(base(url), 'vendor-model', {
        ...options(),
        limits: { timeoutMs: 30, requestTimeoutMs: 1000 },
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('部署提供方先查询真实资料，再以 schema 约束生成最终行程', async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (bodies.length === 1) {
          expect(body).not.toHaveProperty('response_format');
          return new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'hotel',
                        type: 'function',
                        function: { name: 'search_hotels', arguments: '{"keyword":"前门"}' },
                      },
                    ],
                  },
                },
              ],
            }),
          );
        }
        expect(body.tools).toEqual([]);
        expect(body.response_format.type).toBe('json_schema');
        expect(JSON.stringify(body.messages)).toContain('verified-hotel');
        return new Response(
          JSON.stringify(respond('openai-completions', JSON.stringify(agentPlan()))),
        );
      }),
    );
    const input = options();
    await generateWithProvider(
      { ...base('https://api.siliconflow.cn/v1'), jsonMode: true },
      'vendor-model',
      { ...input, outputSchema: schema, limits: { maxToolRounds: 1 } },
    );
    expect(input.handleTool).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
  });

  it('部署提供方启用服务端 schema 约束，显式不支持时才降级为 JSON 对象', async () => {
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        if (bodies.length === 1)
          return new Response(
            JSON.stringify({ error: { message: 'response_format json_schema is unsupported' } }),
            { status: 400 },
          );
        return new Response(
          JSON.stringify(respond('openai-completions', JSON.stringify(agentPlan()))),
        );
      }),
    );
    const result = await generateWithProvider(
      { ...base('https://api.siliconflow.cn/v1'), jsonMode: true },
      'vendor-model',
      { ...options(), tools: [], outputSchema: schema },
    );
    expect(JSON.parse(result.text)).toEqual(agentPlan());
    expect(bodies[0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'travel_plan', strict: true, schema },
    });
    expect(bodies[1].response_format).toEqual({ type: 'json_object' });
  });
});
