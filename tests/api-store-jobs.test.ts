import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../backend/src/app.js';
import { FileTripStore } from '../backend/src/db/store.js';
import type { AmapService } from '../backend/src/services/amap.js';
import type { CodexClient } from '../backend/src/codex/client.js';
import type { TravelPlanner } from '../backend/src/planning/planner.js';
import { JobManager } from '../backend/src/planning/jobs.js';
import { request, tripFixture } from './fixtures/travel.js';
describe('行程存储与 API', () => {
  it('持久化到新目录，重新创建存储后可读取，并阻止路径穿越', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'stree-test-'));
    try {
      const store = new FileTripStore(directory);
      const trip = tripFixture();
      await store.save(trip);
      const restarted = new FileTripStore(directory);
      expect((await restarted.get(trip.id))?.city.adcode).toBe('330100');
      expect((await restarted.list())[0]?.id).toBe(trip.id);
      expect(await restarted.get('../outside')).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('提供全国目录、清晰的非法输入错误和可读取的历史记录', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'stree-api-'));
    const store = new FileTripStore(directory);
    const trip = tripFixture();
    await store.save(trip);
    const codex = {
      status: vi.fn().mockResolvedValue({ available: true, authenticated: true, model: 'test' }),
      close: vi.fn(),
    };
    const amap = { configured: true, district: vi.fn().mockResolvedValue([]) };
    const app = await createApp({
      store,
      codex: codex as unknown as CodexClient,
      amap: amap as unknown as AmapService,
      logger: false,
    });
    try {
      expect((await app.inject('/api/regions/provinces')).json().regions).toHaveLength(34);
      expect(
        (await app.inject('/api/regions/cities?provinceCode=310000')).json().regions[0].name,
      ).toBe('上海市');
      expect((await app.inject('/api/regions/cities?provinceCode=999999')).statusCode).toBe(400);
      expect(
        (await app.inject({ method: 'POST', url: '/api/plans', payload: { ...request, days: 8 } }))
          .statusCode,
      ).toBe(400);
      expect((await app.inject(`/api/trips/${trip.id}`)).json().engine).toBe('codex-app-server');
      expect((await app.inject('/api/trips')).json().trips).toHaveLength(1);
      const created = await app.inject({ method: 'POST', url: '/api/plans', payload: request });
      await new Promise((resolve) => setImmediate(resolve));
      const events = await app.inject({
        url: `/api/jobs/${created.json().jobId}/events`,
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(events.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(events.headers['content-type']).toContain('text/event-stream');
      expect(events.body).toContain('"type":"error"');
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
describe('规划任务', () => {
  it('取消发生在结果返回前时，仍发布取消终态而不是遗留运行中的任务', async () => {
    let finish: (trip: ReturnType<typeof tripFixture>) => void = () => {};
    const planner = {
      plan: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const manager = new JobManager(planner as unknown as TravelPlanner);
    const job = manager.create(request);
    manager.cancel(job.id);
    finish(tripFixture());
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.get(job.id).status).toBe('cancelled');
    expect(job.events.at(-1)?.type).toBe('cancelled');
  });
  it('限制并发，失败任务发布可展示的错误', async () => {
    const planner = { plan: vi.fn().mockImplementation(() => new Promise(() => {})) };
    const manager = new JobManager(planner as unknown as TravelPlanner);
    manager.create(request);
    manager.create(request);
    expect(() => manager.create(request)).toThrow('当前已有规划任务');
    manager.close();
  });
});
