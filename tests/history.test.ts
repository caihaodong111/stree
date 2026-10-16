import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Trip } from '@stree/shared';
import { createApp } from '../backend/src/app.js';
import { FileAiStore } from '../backend/src/db/ai-store.js';
import { FileTripStore } from '../backend/src/db/store.js';
import { JobManager } from '../backend/src/planning/jobs.js';
import type { TravelPlanner } from '../backend/src/planning/planner.js';
import { request, tripFixture } from './fixtures/travel.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function stores() {
  const directory = await mkdtemp(path.join(tmpdir(), 'stree-history-'));
  directories.push(directory);
  return {
    audit: new FileAiStore(path.join(directory, 'ai')),
    trips: new FileTripStore(path.join(directory, 'trips')),
  };
}
describe('任务历史', () => {
  it('任务开始后立即可见，包含实时进度，完成后不会重复记录', async () => {
    const { audit } = await stores();
    let finish!: (trip: Trip) => void;
    const planner = {
      plan: vi.fn(async (_request, _signal, publish) => {
        publish({
          type: 'progress',
          stage: 'routing',
          message: '正在核验交通',
          timestamp: new Date().toISOString(),
        });
        return new Promise<Trip>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const manager = new JobManager(planner as unknown as TravelPlanner, audit);
    try {
      const job = manager.create(request);
      expect(await manager.history()).toMatchObject([{ id: job.id, status: 'running', request }]);
      await vi.waitFor(() => expect(planner.plan).toHaveBeenCalled());
      expect(await manager.history()).toMatchObject([
        { id: job.id, progress: { stage: 'routing', message: '正在核验交通' } },
      ]);
      const trip = tripFixture();
      finish(trip);
      await vi.waitFor(() => expect(job.status).toBe('completed'));
      const history = await manager.history();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ id: job.id, status: 'completed', tripId: trip.id });
    } finally {
      await manager.close();
    }
  });
  it('服务重启后中断的任务显示为失败，已保存路线继续可读', async () => {
    const { audit, trips } = await stores();
    const id = randomUUID();
    const now = new Date().toISOString();
    await audit.startRun({
      id,
      status: 'running',
      request: { ...request, provinceCode: '110000', cityCode: '110000' },
      previousTripId: null,
      tripId: null,
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const trip = tripFixture();
    await trips.save(trip);
    const app = await createApp({ store: trips, audit, logger: false });
    try {
      const response = await app.inject('/api/history');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        trips: [{ id: trip.id }],
        tasks: [
          {
            id,
            status: 'failed',
            cityName: '北京市',
            request: { days: 2 },
            error: expect.stringContaining('已中断'),
          },
        ],
      });
      expect(response.json().tasks[0]).not.toHaveProperty('calls');
      expect(response.json().tasks[0]).not.toHaveProperty('output');
    } finally {
      await app.close();
    }
  });
});
