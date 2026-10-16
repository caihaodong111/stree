import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../backend/src/app.js';
import { FileTripStore } from '../backend/src/db/store.js';
import { FileAiStore } from '../backend/src/db/ai-store.js';
import type { AmapService } from '../backend/src/services/amap.js';
import type { TravelPlanner } from '../backend/src/planning/planner.js';
import { JobManager } from '../backend/src/planning/jobs.js';
import { request, tripFixture } from './fixtures/travel.js';
import { ProviderStore } from '../backend/src/models/providers.js';
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
    const amap = {
      configured: true,
      locateDistrict: vi.fn().mockResolvedValue('310106'),
      district: vi.fn().mockResolvedValue([]),
      suggest: vi.fn().mockResolvedValue([]),
      popularAttractions: vi.fn().mockResolvedValue([]),
      directions: vi.fn().mockResolvedValue([trip.routes[0]!.days[0]!.segments[0]!]),
    };
    const app = await createApp({
      store,
      audit: new FileAiStore(path.join(directory, 'audit')),
      amap: amap as unknown as AmapService,
      logger: false,
      providers: new ProviderStore(path.join(directory, 'config', 'providers.json')),
    });
    try {
      expect((await app.inject('/api/places/popular?cityCode=330100')).json()).toEqual({
        places: [],
      });
      expect(amap.popularAttractions).toHaveBeenCalledWith('330100');
      expect((await app.inject('/api/places/popular')).statusCode).toBe(400);
      expect((await app.inject('/api/places/popular?cityCode=invalid')).statusCode).toBe(400);
      expect(
        (
          await app.inject('/api/places/suggest?cityCode=330100&keyword=%20%E8%A5%BF%E6%B9%96%20')
        ).json(),
      ).toEqual({ places: [] });
      expect(amap.suggest).toHaveBeenCalledWith('330100', '西湖');
      expect(
        (await app.inject('/api/places/suggest?keyword=%E4%B8%8A%E6%B5%B7%E7%AB%99')).json(),
      ).toEqual({ places: [] });
      expect(amap.suggest).toHaveBeenCalledWith(undefined, '上海站');
      expect(
        (await app.inject('/api/places/suggest?cityCode=invalid&keyword=test')).statusCode,
      ).toBe(400);
      expect((await app.inject('/api/places/suggest?cityCode=330100&keyword=')).statusCode).toBe(
        400,
      );
      expect((await app.inject('/api/regions/provinces')).json().regions).toHaveLength(34);
      const located = await app.inject({
        method: 'POST',
        url: '/api/regions/locate',
        payload: { longitude: 121.455, latitude: 31.249 },
      });
      expect(located.statusCode).toBe(200);
      expect(located.json()).toMatchObject({
        province: { adcode: '310000' },
        city: { adcode: '310000' },
      });
      expect(amap.locateDistrict).toHaveBeenCalledWith({ longitude: 121.455, latitude: 31.249 });
      const networkCity = await app.inject({
        method: 'POST',
        url: '/api/regions/locate-city',
        payload: { adcode: '310106' },
      });
      expect(networkCity.statusCode).toBe(200);
      expect(networkCity.json()).toMatchObject({ city: { adcode: '310000' } });
      expect(amap.locateDistrict).toHaveBeenCalledTimes(1);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/regions/locate-city',
            payload: { adcode: 'invalid' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/regions/locate-city',
            payload: { adcode: '999999' },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/regions/locate',
            payload: { longitude: '121.455', latitude: 31.249 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/regions/locate',
            payload: { longitude: 200, latitude: 90 },
          })
        ).statusCode,
      ).toBe(400);
      expect((await app.inject('/api/settings/model')).json().effectiveModel).toBeNull();
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/settings/model',
            payload: { model: null, effort: null },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/settings/model',
            payload: { model: '', effort: null },
          })
        ).statusCode,
      ).toBe(400);
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
      const directionUrl = `/api/trips/${trip.id}/directions?routeId=${trip.routes[0]!.id}&dayIndex=0&segmentIndex=0&mode=driving`;
      const directions = await app.inject(directionUrl);
      expect(directions.statusCode).toBe(200);
      expect(directions.json().routes).toHaveLength(1);
      expect(amap.directions).toHaveBeenCalledWith(
        { name: '测试出发地', location: trip.routes[0]!.days[0]!.segments[0]!.polyline[0] },
        { name: '测试西湖', location: trip.routes[0]!.days[0]!.segments[0]!.polyline.at(-1) },
        'driving',
        '330100',
        undefined,
        { fresh: false },
      );
      expect((await app.inject(directionUrl.replace('dayIndex=0', 'dayIndex=6'))).statusCode).toBe(
        404,
      );
      expect(
        (await app.inject(directionUrl.replace('mode=driving', 'mode=invalid'))).statusCode,
      ).toBe(400);
      expect(amap.directions).toHaveBeenCalledTimes(1);
      expect((await store.get(trip.id))?.routes[0]?.transitMinutes).toBe(
        trip.routes[0]!.transitMinutes,
      );
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
