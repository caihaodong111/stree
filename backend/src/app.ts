import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { PlanRequestSchema } from '@stree/shared';
import { config, projectRoot } from './config.js';
import { AppError, publicError } from './errors.js';
import { createStore, type TripStore } from './db/store.js';
import { AmapService } from './services/amap.js';
import { RegionService, provinces } from './services/regions.js';
import { CodexClient } from './codex/client.js';
import { TravelPlanner } from './planning/planner.js';
import { JobManager } from './planning/jobs.js';

export async function createApp(
  overrides: { amap?: AmapService; codex?: CodexClient; store?: TripStore; logger?: boolean } = {},
) {
  const app = Fastify({ logger: overrides.logger ?? true, bodyLimit: 65536 });
  await app.register(cors, {
    origin: config.ALLOWED_ORIGINS.split(',').map((item) => item.trim()),
  });
  const amap = overrides.amap ?? new AmapService();
  const codex = overrides.codex ?? new CodexClient();
  const store = overrides.store ?? createStore();
  const regions = new RegionService(amap);
  const jobs = new JobManager(new TravelPlanner(amap, regions, codex, store));
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
    codex: await codex.status(),
    amap: { configured: amap.configured },
    storage: { driver: store.driver, available: await store.check() },
    version: '2.0.0',
  }));
  app.get('/api/regions/provinces', () => ({ regions: provinces }));
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
  app.post('/api/plans', async (request, reply) => {
    const body = PlanRequestSchema.extend({ previousTripId: z.string().uuid().optional() }).parse(
      request.body,
    );
    if (!(await store.check()))
      throw new AppError(
        '行程存储未就绪，请执行 npm run db:setup；本地体验可设置 STORAGE_DRIVER=file。',
        503,
      );
    const previous = body.previousTripId ? await store.get(body.previousTripId) : undefined;
    if (body.previousTripId && !previous) throw new AppError('原行程不存在。', 404);
    const job = jobs.create(body, previous ?? undefined);
    reply.status(202);
    return { jobId: job.id };
  });
  app.get('/api/jobs/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = jobs.get(id);
    return { id: job.id, status: job.status, events: job.events };
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    jobs.cancel(id);
    return { ok: true };
  });
  app.get('/api/jobs/:id/events', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = jobs.get(id);
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
    job.events.forEach(send);
    if (job.status !== 'running') {
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
  app.addHook('onClose', async () => {
    jobs.close();
    await codex.close();
    await store.close();
  });
  return app;
}
