import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  PlanRequestSchema,
  ModelSettingsSchema,
  ProviderInputSchema,
  ProviderProbeSchema,
  TravelModeSchema,
  CoordinateSchema,
  getSegmentEndpoints,
} from '@stree/shared';
import { config, projectRoot } from './config.js';
import { AppError, publicError } from './errors.js';
import { createStore, type TripStore } from './db/store.js';
import { AmapService } from './services/amap.js';
import { RegionService, provinces } from './services/regions.js';
import { TravelPlanner } from './planning/planner.js';
import { JobManager } from './planning/jobs.js';
import { ModelService } from './models/service.js';
import { ProviderStore } from './models/providers.js';
import { FileAiStore, MysqlAiStore, type AiStore } from './db/ai-store.js';
import { PublicWebSearch, type TravelWebSearch } from './services/web-search.js';

export async function createApp(
  overrides: {
    amap?: AmapService;
    store?: TripStore;
    providers?: ProviderStore;
    logger?: boolean;
    audit?: AiStore;
    webSearch?: TravelWebSearch;
    settingsEnabled?: boolean;
  } = {},
) {
  const app = Fastify({ logger: overrides.logger ?? true, bodyLimit: 65536 });
  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS.split(',').map((item) => item.trim()),
  });
  const amap = overrides.amap ?? new AmapService();
  const store = overrides.store ?? createStore();
  const regions = new RegionService(amap);
  const models = new ModelService(overrides.providers);
  const audit =
    overrides.audit ?? (store.driver === 'mysql' ? new MysqlAiStore() : new FileAiStore());
  const webSearch = overrides.webSearch ?? new PublicWebSearch();
  const jobs = new JobManager(new TravelPlanner(amap, regions, models, store, webSearch), audit);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        error: '请检查表单填写内容。',
        details: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    if (error instanceof AppError)
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    const details = error as { code?: string; name?: string };
    if (details.code === 'FST_ERR_CTP_INVALID_JSON_BODY')
      return reply.status(400).send({ error: '请求 JSON 格式不正确。' });
    request.log.error({ code: details.code, name: details.name }, 'request failed');
    reply.status(500).send({ error: publicError(error) });
  });
  app.get('/api/health', () => ({ status: 'ok', version: '2.0.0' }));
  app.get('/api/status', async () => ({
    ...(await models.status()),
    amap: { configured: amap.configured },
    storage: { driver: store.driver, available: await store.check() },
    webSearch: webSearch.status(),
    version: '2.0.0',
  }));
  app.get('/api/regions/provinces', () => ({ regions: provinces }));
  app.post('/api/regions/locate', async (request) =>
    regions.locate(CoordinateSchema.parse(request.body)),
  );
  app.post('/api/regions/locate-city', async (request) => {
    const { adcode } = z.object({ adcode: z.string().regex(/^\d{6}$/) }).parse(request.body);
    return regions.locateByAdcode(adcode);
  });
  if (overrides.settingsEnabled ?? config.SETTINGS_ENABLED) {
    app.get('/api/settings/model', () => models.settings());
    app.put('/api/settings/model', (request) =>
      models.saveSettings(ModelSettingsSchema.parse(request.body)),
    );
    app.post('/api/settings/providers', async (request) => ({
      providers: await models.providers.save(ProviderInputSchema.parse(request.body), true),
    }));
    app.put('/api/settings/providers/:id', async (request) => {
      const input = ProviderInputSchema.parse(request.body);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      if (id !== input.id) throw new AppError('编辑提供方时不能更改 Provider ID。', 400);
      return { providers: await models.providers.save(input, false) };
    });
    app.delete('/api/settings/providers/:id', async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      return { providers: await models.providers.delete(id) };
    });
    app.post('/api/settings/providers/discover', async (request) => ({
      models: await models.probe(ProviderProbeSchema.parse(request.body)),
    }));
  }
  app.get('/api/regions/cities', async (request) => {
    const { provinceCode } = z
      .object({ provinceCode: z.string().regex(/^\d{6}$/) })
      .parse(request.query);
    return { regions: await regions.cities(provinceCode) };
  });
  app.get('/api/places', async (request) => {
    const input = z
      .object({ cityCode: z.string().regex(/^\d{6}$/), keyword: z.string().trim().min(1).max(100) })
      .parse(request.query);
    return { places: await amap.search(input.cityCode, input.keyword, 'any') };
  });
  app.get('/api/places/popular', async (request) => {
    const { cityCode } = z.object({ cityCode: z.string().regex(/^\d{6}$/) }).parse(request.query);
    return { places: await amap.popularAttractions(cityCode) };
  });
  app.get('/api/places/suggest', async (request) => {
    const input = z
      .object({
        cityCode: z
          .string()
          .regex(/^\d{6}$/)
          .optional(),
        keyword: z.string().trim().min(1).max(100),
      })
      .parse(request.query);
    return { places: await amap.suggest(input.cityCode, input.keyword) };
  });
  app.post('/api/plans', async (request, reply) => {
    const body = PlanRequestSchema.extend({ previousTripId: z.string().uuid().optional() }).parse(
      request.body,
    );
    if (!(await store.check()))
      throw new AppError('行程存储未就绪，请检查数据库连接并执行 npm run db:migrate。', 503);
    const previous = body.previousTripId ? await store.get(body.previousTripId) : undefined;
    if (body.previousTripId && !previous) throw new AppError('原行程不存在。', 404);
    const job = jobs.create(body, previous ?? undefined);
    reply.status(202);
    return { jobId: job.id };
  });
  app.get('/api/jobs/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return jobs.snapshot(id);
  });
  app.get('/api/history', async () => {
    const [trips, tasks] = await Promise.all([store.list(), jobs.history()]);
    const provinceCodes = [...new Set(tasks.map((task) => task.request.provinceCode))];
    const destinations = (
      await Promise.all(
        provinceCodes.map(async (code) =>
          regions
            .cities(code)
            .catch(() => provinces.filter((province) => province.adcode === code)),
        ),
      )
    ).flat();
    return {
      trips,
      tasks: tasks.map((task) => ({
        ...task,
        cityName:
          destinations.find((city) => city.adcode === task.request.cityCode)?.name ??
          provinces.find((province) => province.adcode === task.request.provinceCode)?.name ??
          '城市旅行',
      })),
    };
  });
  app.get('/api/ai/runs', async () => ({
    runs: (await audit.list()).map(({ request: _request, ...run }) => run),
  }));
  app.get('/api/ai/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const run = await audit.get(id);
    if (!run) throw new AppError('AI 任务记录不存在。', 404);
    return run;
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    jobs.cancel(id);
    return { ok: true };
  });
  app.get('/api/jobs/:id/events', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const snapshot = await jobs.snapshot(id);
    const job = snapshot.status === 'running' ? jobs.get(id) : null;
    // A raw SSE response must retain headers prepared by Fastify's CORS hook.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();
    reply.raw.flushHeaders();
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    snapshot.events.forEach(send);
    if (!job || job.status !== 'running') {
      reply.raw.end();
      return;
    }
    const listener = (event: any) => {
      send(event);
      if (event.type !== 'progress') reply.raw.end();
    };
    job.emitter.on('event', listener);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15000);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      job.emitter.off('event', listener);
    });
  });
  app.get('/api/trips', async () => ({ trips: await store.list() }));
  app.get('/api/trips/:id/directions', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z
      .object({
        routeId: z.string().min(1).max(40),
        dayIndex: z.coerce.number().int().min(0).max(6),
        segmentIndex: z.coerce.number().int().min(0).max(8),
        mode: TravelModeSchema,
        refresh: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    const trip = await store.get(id);
    if (!trip) throw new AppError('行程不存在。', 404);
    const route = trip.routes.find((item) => item.id === input.routeId);
    const segment = route?.days[input.dayIndex]?.segments[input.segmentIndex];
    if (!segment) throw new AppError('行程中没有这个交通路段。', 404);
    const endpoints = getSegmentEndpoints(trip, route!, input.dayIndex, input.segmentIndex);
    if (!endpoints) throw new AppError('此路段缺少坐标，请重新规划行程。', 422);
    const routes = await amap.directions(
      endpoints.origin,
      endpoints.destination,
      input.mode,
      trip.city.adcode,
      undefined,
      { fresh: input.refresh === 'true' },
    );
    return { routes, fetchedAt: new Date().toISOString() };
  });
  app.get('/api/trips/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const trip = await store.get(id);
    if (!trip) throw new AppError('行程不存在。', 404);
    return trip;
  });
  const frontendDist = path.join(projectRoot, 'frontend', 'dist');
  if (existsSync(frontendDist)) {
    await app.register(staticFiles, { root: frontendDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.status(404).send({ error: '接口不存在。' })
        : reply.sendFile('index.html'),
    );
  }
  // Cancel work before Fastify waits for active SSE connections to drain.
  // Waiting until onClose deadlocks shutdown against those same connections.
  app.addHook('preClose', async () => {
    await jobs.close();
  });
  app.addHook('onClose', async () => {
    await store.close();
    await audit.close();
  });
  return app;
}
