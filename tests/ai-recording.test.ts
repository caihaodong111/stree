import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import {
  FileAiStore,
  MysqlAiStore,
  redactAiData,
  type AiRun,
  type AiStore,
} from '../backend/src/db/ai-store.js';
import { AiRecorder, traceAiCall, bindAiContext } from '../backend/src/planning/ai-recorder.js';
import { JobManager } from '../backend/src/planning/jobs.js';
import type { TravelPlanner } from '../backend/src/planning/planner.js';
import { generateWithProvider } from '../backend/src/models/http-client.js';
import type { StoredProvider } from '../backend/src/models/providers.js';
import { config } from '../backend/src/config.js';
import { request, tripFixture } from './fixtures/travel.js';
import { AppError } from '../backend/src/errors.js';
import { CodexClient } from '../backend/src/codex/client.js';
import { fileURLToPath } from 'node:url';
import { createApp } from '../backend/src/app.js';
import { FileTripStore } from '../backend/src/db/store.js';
import { PublicWebSearch } from '../backend/src/services/web-search.js';
import { AgentPlanSchema } from '@stree/shared';
import { z } from 'zod';
import { agentPlan } from './fixtures/travel.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'stree-ai-'));
  directories.push(directory);
  const store = new FileAiStore(directory);
  const now = new Date().toISOString();
  const run: AiRun = {
    id: randomUUID(),
    request,
    previousTripId: null,
    status: 'running',
    tripId: null,
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.startRun(run);
  return {
    directory,
    store,
    run,
    recorder: new AiRecorder(run.id, store, new AbortController().signal),
  };
}
describe('AI 调用与日志持久化', () => {
  it('格式自动恢复保留原始异常响应、每次修正调用和恢复事件，并隐藏密钥', async () => {
    const { recorder, store, run } = await setup();
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content:
                      ++requests === 1
                        ? '{"summary":"broken"</assistant>'
                        : JSON.stringify(agentPlan()),
                  },
                },
              ],
            }),
          ),
      ),
    );
    await recorder.run(() =>
      generateWithProvider(
        {
          id: 'test',
          name: 'test',
          baseURL: 'https://vendor.example/v1',
          protocol: 'openai-completions',
          apiKey: 'private-recovery-key',
          models: [{ id: 'test', name: 'test' }],
          maxOutputTokens: null,
          jsonMode: true,
        },
        'test',
        {
          instructions: '输出行程 JSON',
          prompt: '原始需求',
          outputSchema: z.toJSONSchema(AgentPlanSchema),
          tools: [],
          handleTool: vi.fn(),
          signal: new AbortController().signal,
          onProgress: vi.fn(),
        },
      ),
    );
    await recorder.flush();
    const record = await store.get(run.id);
    expect(record!.calls.filter((c) => c.kind === 'model')).toHaveLength(2);
    expect(JSON.stringify(record!.calls[0]!.output)).toContain('broken');
    expect(record!.events.filter((e) => e.type === 'output_recovery')).toHaveLength(1);
    expect(JSON.stringify(record)).not.toContain('private-recovery-key');
  });
  it('联网检索记录实际查询和公开来源，关联触发工具，不向搜索服务发送模型密钥', async () => {
    const { recorder, store, run } = await setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<ol id="b_results"><li class="b_algo"><h2><a href="https://travel.example/guide">旅游攻略</a></h2></li></ol>',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const search = new PublicWebSearch({
      enabled: true,
      endpoint: 'https://www.bing.com/search',
      timeoutMs: 1000,
    });
    await recorder.run(() =>
      traceAiCall(
        'tool',
        { queries: ['杭州攻略'] },
        () => search.search(['杭州攻略'], new AbortController().signal),
        { name: 'web_search' },
      ),
    );
    const detail = await store.get(run.id);
    const parent = detail!.calls.find((call) => call.name === 'web_search')!;
    const network = detail!.calls.find((call) => call.name === 'web_search.http')!;
    expect(network.parentCallId).toBe(parent.id);
    expect(network.input).toEqual({ query: '杭州攻略', endpoint: 'https://www.bing.com/search' });
    expect(network.output).toMatchObject([{ url: 'https://travel.example/guide' }]);
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
  });
  it('重启后的 API 可查询完整记录、任务终态与 SSE，不依赖旧进程内存', async () => {
    const { store, directory, run } = await setup();
    const trip = tripFixture();
    const now = new Date().toISOString();
    await store.appendEvent({
      id: randomUUID(),
      runId: run.id,
      sequence: 1,
      type: 'job',
      payload: { type: 'result', trip },
      createdAt: now,
    });
    await store.finishRun(run.id, {
      status: 'completed',
      tripId: trip.id,
      output: trip,
      error: null,
      updatedAt: now,
    });
    const app = await createApp({
      store: new FileTripStore(path.join(directory, 'trips')),
      audit: new FileAiStore(directory),
      logger: false,
    });
    try {
      const list = (await app.inject('/api/ai/runs')).json();
      expect(list.runs).toHaveLength(1);
      expect(list.runs[0]).not.toHaveProperty('output');
      expect((await app.inject(`/api/ai/runs/${run.id}`)).json()).toMatchObject({
        id: run.id,
        status: 'completed',
        output: trip,
      });
      expect((await app.inject(`/api/jobs/${run.id}`)).json()).toMatchObject({
        status: 'completed',
        events: [{ type: 'result', trip }],
      });
      const events = await app.inject(`/api/jobs/${run.id}/events`);
      expect(events.headers['content-type']).toContain('text/event-stream');
      expect(events.body).toContain('"type":"result"');
      expect((await app.inject('/api/ai/runs/not-a-uuid')).statusCode).toBe(400);
      expect((await app.inject(`/api/ai/runs/${randomUUID()}`)).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
  it('Codex 进程在任务外启动后，异步工具回调仍正确入库并关联模型调用', async () => {
    const { recorder, store, directory, run } = await setup();
    const client = new CodexClient(
      fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url)),
      path.join(directory, 'model-settings.json'),
    );
    try {
      await client.settings();
      await recorder.run(() =>
        traceAiCall('model', { prompt: 'generate' }, () =>
          client.generate({
            prompt: 'generate',
            instructions: 'test',
            outputSchema: { type: 'object' },
            tools: [],
            handleTool: async () => ({ places: ['verified-poi'] }),
            signal: new AbortController().signal,
            onProgress: () => {},
          }),
        ),
      );
      const saved = await store.get(run.id);
      const model = saved!.calls.find((call) => call.kind === 'model')!;
      const tool = saved!.calls.find((call) => call.kind === 'tool')!;
      expect(saved!.calls).toHaveLength(2);
      expect(tool).toMatchObject({
        parentCallId: model.id,
        name: 'search_places',
        input: { keyword: '西湖' },
        output: { places: ['verified-poi'] },
      });
      expect(model.output).toMatchObject({ threadId: 'test-thread', model: 'test-model' });
    } finally {
      await client.close();
    }
  });
  it('嵌套调用关联模型，重启可读取，进度不受内存上限影响', async () => {
    const { store, directory } = await setup();
    const trip = tripFixture();
    const planner = {
      plan: async (_request: unknown, _signal: unknown, emit: (event: any) => void) => {
        for (let i = 0; i < 90; i++)
          emit({
            type: 'progress',
            stage: 'planning',
            message: `进度 ${i}`,
            timestamp: new Date().toISOString(),
          });
        await traceAiCall(
          'model',
          { prompt: '规划路线' },
          async () => {
            const callback = bindAiContext(() =>
              traceAiCall('tool', { keyword: '西湖' }, async () => ({ places: ['西湖'] }), {
                name: 'search_places',
              }),
            );
            // Invoke from a callback after the model has crossed an async boundary.
            await new Promise<void>((resolve, reject) =>
              setImmediate(() => callback().then(() => resolve(), reject)),
            );
            return { text: '{}', usage: { input_tokens: 10, output_tokens: 20 } };
          },
          { model: 'fixture-model', provider: 'test' },
        );
        return trip;
      },
    };
    const manager = new JobManager(planner as unknown as TravelPlanner, store);
    const job = manager.create(request, trip);
    await vi.waitFor(() => expect(job.status).toBe('completed'));
    expect(job.events).toHaveLength(80);
    const restarted = new JobManager(
      planner as unknown as TravelPlanner,
      new FileAiStore(directory),
    );
    const snapshot = await restarted.snapshot(job.id);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.events).toHaveLength(91);
    const saved = await store.get(job.id);
    expect(saved).toMatchObject({ previousTripId: trip.id, tripId: trip.id, output: trip });
    const model = saved!.calls.find((call) => call.kind === 'model')!;
    const tool = saved!.calls.find((call) => call.kind === 'tool')!;
    expect(tool.parentCallId).toBe(model.id);
    expect(model.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    await manager.close();
  });
  it.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)(
    '%s 每轮请求、工具参数、结果和 Token 入库，密钥与思考内容不落盘',
    async (protocol) => {
      const { store, directory, run, recorder } = await setup();
      const provider: StoredProvider = {
        id: 'fixture',
        name: 'Fixture',
        protocol,
        baseURL: 'https://fixture.example/v1',
        apiKey: 'fixture-secret',
        models: [],
        maxOutputTokens: 100,
        jsonMode: false,
      };
      let round = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          const tool = ++round === 1;
          let body: object;
          if (protocol === 'openai-completions')
            body = {
              usage: { prompt_tokens: 10, completion_tokens: 20 },
              choices: [
                {
                  finish_reason: 'stop',
                  message: tool
                    ? {
                        content: null,
                        reasoning_content: '',
                        tool_calls: [
                          {
                            id: 'tool-1',
                            type: 'function',
                            function: { name: 'search_places', arguments: '{"keyword":"西湖"}' },
                          },
                        ],
                      }
                    : { content: '{"ok":true}', reasoning_content: '' },
                },
              ],
            };
          else if (protocol === 'openai-responses')
            body = {
              usage: { input_tokens: 10, output_tokens: 20 },
              output: tool
                ? [
                    {
                      type: 'function_call',
                      name: 'search_places',
                      call_id: 'tool-1',
                      arguments: '{"keyword":"西湖"}',
                    },
                  ]
                : [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
            };
          else
            body = {
              usage: { input_tokens: 10, output_tokens: 20 },
              stop_reason: tool ? 'tool_use' : 'end_turn',
              content: tool
                ? [
                    {
                      type: 'tool_use',
                      id: 'tool-1',
                      name: 'search_places',
                      input: { keyword: '西湖' },
                    },
                  ]
                : [{ type: 'text', text: '{"ok":true}' }],
            };
          return new Response(JSON.stringify(body));
        }),
      );
      const result = await recorder.run(() =>
        generateWithProvider(provider, 'fixture-model', {
          instructions: '旅行规划',
          prompt: 'fixture-secret',
          outputSchema: { type: 'object' },
          tools: [
            {
              type: 'function',
              name: 'search_places',
              description: '',
              inputSchema: { type: 'object' },
            },
          ],
          signal: new AbortController().signal,
          onProgress: () => {},
          handleTool: async (_name, args) => ({ args, places: ['西湖'] }),
        }),
      );
      expect(result.text).toBe('{"ok":true}');
      const saved = await store.get(run.id);
      expect(saved!.calls).toHaveLength(3);
      const models = saved!.calls.filter((call) => call.kind === 'model');
      const tool = saved!.calls.find((call) => call.kind === 'tool')!;
      expect(models).toHaveLength(2);
      expect(models.every((call) => call.usage !== null)).toBe(true);
      expect(tool.parentCallId).toBe(models[0]!.id);
      const persisted = (
        await Promise.all([
          readFile(path.join(directory, `${run.id}.json`), 'utf8'),
          ...saved!.calls.map((call) =>
            readFile(path.join(directory, 'calls', `${call.id}.json`), 'utf8'),
          ),
        ])
      ).join('\n');
      expect(persisted).not.toContain('fixture-secret');
      expect(persisted).not.toContain('PRIVATE_REASONING');
      expect(models[1]!.input).toMatchObject({ model: 'fixture-model' });
    },
  );
  it('工具错误作为失败调用保存，失败任务和取消任务都有终态', async () => {
    const { store, recorder, run } = await setup();
    await recorder.run(() =>
      traceAiCall('tool', {}, async () => ({ error: '高德暂时不可用' }), { name: 'search_places' }),
    );
    expect((await store.get(run.id))!.calls[0]).toMatchObject({
      status: 'failed',
      error: '高德暂时不可用',
    });
    const failed = new JobManager(
      {
        plan: async () => {
          throw new AppError('地点查询失败', 502);
        },
      } as unknown as TravelPlanner,
      store,
    );
    const job = failed.create(request);
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(await store.get(job.id)).toMatchObject({ status: 'failed', error: '地点查询失败' });
    const cancelled = new JobManager(
      {
        plan: async (_request: unknown, signal: AbortSignal) =>
          traceAiCall(
            'model',
            {},
            () =>
              new Promise((_resolve, reject) =>
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('Aborted', 'AbortError')),
                  { once: true },
                ),
              ),
          ),
      } as unknown as TravelPlanner,
      store,
    );
    const cancelJob = cancelled.create(request);
    await vi.waitFor(async () => expect((await store.get(cancelJob.id))?.calls).toHaveLength(1));
    cancelled.cancel(cancelJob.id);
    await vi.waitFor(() => expect(cancelJob.status).toBe('cancelled'));
    const saved = await store.get(cancelJob.id);
    expect(saved).toMatchObject({ status: 'cancelled' });
    expect(saved!.calls[0]!.status).toBe('cancelled');
    await failed.close();
    await cancelled.close();
  });
  it('数据库首次记录失败时不调用模型；并行任务不会串记录', async () => {
    const { store } = await setup();
    const unavailable = Object.assign(Object.create(store), {
      startRun: vi.fn().mockRejectedValue(new AppError('AI 记录保存失败', 503)),
    }) as AiStore;
    const plan = vi.fn().mockResolvedValue(tripFixture());
    const failing = new JobManager({ plan } as unknown as TravelPlanner, unavailable);
    const job = failing.create(request);
    await vi.waitFor(() => expect(job.status).toBe('failed'));
    expect(plan).not.toHaveBeenCalled();
    const manager = new JobManager(
      {
        plan: async (input: typeof request) => {
          await traceAiCall('model', { prompt: input.message }, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return { text: input.message };
          });
          return tripFixture();
        },
      } as unknown as TravelPlanner,
      store,
    );
    const a = manager.create({ ...request, message: '任务甲' });
    const b = manager.create({ ...request, message: '任务乙' });
    await vi.waitFor(() => expect([a.status, b.status]).toEqual(['completed', 'completed']));
    expect((await store.get(a.id))!.calls[0]!.input).toEqual({ prompt: '任务甲' });
    expect((await store.get(b.id))!.calls[0]!.output).toEqual({ text: '任务乙' });
    await manager.close();
    await failing.close();
  });
  it('递归脱敏认证字段、URL 密钥和内部思考，但保留模型配置', () => {
    const cleaned = redactAiData({
      password: 'secret',
      Authorization: 'Bearer hidden',
      url: 'https://vendor.example?api_key=hidden',
      reasoning: { effort: 'high' },
      reasoning_content: 'private',
      values: [{ type: 'thinking', thinking: 'private' }, { text: '正常输出' }],
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/secret|private|Bearer hidden|api_key=hidden/);
    expect(cleaned).toMatchObject({
      reasoning: { effort: 'high' },
      values: [{ text: '正常输出' }],
    });
  });
  it('MySQL 读写使用参数化 SQL；查询超时销毁连接并返回脱敏错误', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]), destroy: vi.fn(), end: vi.fn() };
    const fixture = await setup();
    const store = new MysqlAiStore(pool as unknown as Pool, fixture.directory);
    await store.startRun(fixture.run);
    expect(pool.execute.mock.calls[0]![0].values[0]).toBe(fixture.run.id);
    expect(pool.execute.mock.calls[0]![0].sql).not.toContain(fixture.run.id);
    vi.useFakeTimers();
    pool.execute.mockImplementation(() => new Promise(() => {}));
    const pending = expect(store.list()).rejects.toMatchObject({ code: 'AI_STORAGE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(config.MYSQL_QUERY_TIMEOUT_MS);
    await pending;
    expect(pool.destroy).toHaveBeenCalledOnce();
    const diagnostic = JSON.parse(
      (await readFile(path.join(fixture.directory, 'errors.jsonl'), 'utf8')).trim(),
    );
    expect(diagnostic).toMatchObject({
      code: 'MYSQL_QUERY_TIMEOUT',
      operation: 'SELECT',
      table: 'stree_ai_runs',
      phase: 'execute',
    });
  });
  it('保留数据库原始错误码、阶段和参数大小，不记录 SQL 参数或密钥', async () => {
    const fixture = await setup();
    const pool = {
      execute: vi.fn().mockRejectedValue({
        code: 'ER_INVALID_JSON_TEXT',
        errno: 3140,
        sqlState: '22032',
        sqlMessage: "Invalid JSON text near 'PRIVATE_DATA' in column 'output'",
        sql: 'DO_NOT_LOG_RAW_SQL',
      }),
      end: vi.fn(),
    };
    const store = new MysqlAiStore(pool as unknown as Pool, fixture.directory);
    await expect(
      store.finishCall('test-id', {
        status: 'completed',
        output: { text: 'PRIVATE_DATA' },
        usage: null,
        error: null,
        durationMs: 100,
        finishedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({
      code: 'AI_STORAGE_UNAVAILABLE',
      message: expect.stringContaining('ER_INVALID_JSON_TEXT'),
    });
    const log = await readFile(path.join(fixture.directory, 'errors.jsonl'), 'utf8');
    expect(log).not.toMatch(/PRIVATE_DATA|DO_NOT_LOG_RAW_SQL/);
    expect(JSON.parse(log)).toMatchObject({
      code: 'ER_INVALID_JSON_TEXT',
      errno: 3140,
      sqlState: '22032',
      operation: 'UPDATE',
      table: 'stree_ai_calls',
    });
  });
  it('只在SQL执行前重试一次临时连接失败，不重复执行写入', async () => {
    const fixture = await setup();
    const connection = { execute: vi.fn().mockResolvedValue([[], []]), release: vi.fn() };
    const pool = {
      getConnection: vi
        .fn()
        .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
        .mockResolvedValue(connection),
    };
    const store = new MysqlAiStore(pool as unknown as Pool, fixture.directory);
    await store.startRun(fixture.run);
    expect(pool.getConnection).toHaveBeenCalledTimes(2);
    expect(connection.execute).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(path.join(fixture.directory, 'errors.jsonl'), 'utf8')),
    ).toMatchObject({ code: 'ETIMEDOUT', phase: 'acquire_retry' });
  });
  it('SQL已开始后的连接异常仍明确失败，不自动重放写入', async () => {
    const fixture = await setup();
    const connection = {
      execute: vi.fn().mockRejectedValue({ code: 'ECONNRESET' }),
      release: vi.fn(),
    };
    const pool = { getConnection: vi.fn().mockResolvedValue(connection) };
    const store = new MysqlAiStore(pool as unknown as Pool, fixture.directory);
    await expect(store.startRun(fixture.run)).rejects.toMatchObject({
      code: 'AI_STORAGE_UNAVAILABLE',
    });
    expect(pool.getConnection).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenCalledTimes(1);
  });
  it('入库失败时保存已脱敏的公开响应以便复现，任务仍明确失败', async () => {
    const fixture = await setup();
    vi.spyOn(fixture.store, 'finishCall').mockRejectedValue(new AppError('数据库失败', 503));
    const recorder = new AiRecorder(
      fixture.run.id,
      fixture.store,
      new AbortController().signal,
      fixture.directory,
    );
    await expect(
      recorder.run(() =>
        traceAiCall('model', {}, async () => ({
          text: 'PUBLIC_RESULT',
          reasoning_content: 'PRIVATE_REASONING',
          api_key: 'PRIVATE_KEY',
        })),
      ),
    ).rejects.toThrow('数据库失败');
    const saved = await fixture.store.get(fixture.run.id);
    const recovery = await readFile(
      path.join(fixture.directory, `${saved!.calls[0]!.id}.response.json`),
      'utf8',
    );
    expect(recovery).toContain('PUBLIC_RESULT');
    expect(recovery).not.toMatch(/PRIVATE_REASONING|PRIVATE_KEY/);
  });
});
