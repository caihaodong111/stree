import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  JobEvent,
  JobSnapshot,
  PlanRequest,
  PlanningTaskSummary,
  ProgressEvent,
  Trip,
} from '@stree/shared';
import { AppError, publicError } from '../errors.js';
import type { TravelPlanner } from './planner.js';
import type { AiStore } from '../db/ai-store.js';
import { jobEvents } from '../db/ai-store.js';
import { AiRecorder } from './ai-recorder.js';

export type Job = JobSnapshot & {
  controller: AbortController;
  emitter: EventEmitter;
  createdAt: number;
  request: PlanRequest;
};
export class JobManager {
  private jobs = new Map<string, Job>();
  private tasks = new Set<Promise<void>>();
  constructor(
    private planner: TravelPlanner,
    private audit?: AiStore,
  ) {}
  create(request: PlanRequest, previous?: Trip): Job {
    for (const [id, job] of this.jobs)
      if (Date.now() - job.createdAt > 60 * 60 * 1000 && job.status !== 'running')
        this.jobs.delete(id);
    if ([...this.jobs.values()].filter((job) => job.status === 'running').length >= 2)
      throw new AppError('当前已有规划任务运行，请等待完成后再试。', 429);
    const job: Job = {
      id: randomUUID(),
      status: 'running',
      events: [],
      controller: new AbortController(),
      emitter: new EventEmitter(),
      createdAt: Date.now(),
      request,
    };
    this.jobs.set(job.id, job);
    const recorder = this.audit ? new AiRecorder(job.id, this.audit, job.controller.signal) : null;
    const publish = (event: JobEvent, persist = true) => {
      if (persist) recorder?.event('job', event);
      job.events.push(event);
      if (job.events.length > 80) job.events.splice(0, job.events.length - 80);
      job.emitter.emit('event', event);
    };
    const execute = async () => {
      let started = false;
      const finish = async (
        status: 'completed' | 'failed' | 'cancelled',
        event: JobEvent,
        trip?: Trip,
        error?: string,
      ) => {
        if (recorder && started) {
          recorder.event('job', event);
          await recorder.flush();
          await this.audit!.finishRun(job.id, {
            status,
            tripId: trip?.id ?? null,
            output: trip ?? null,
            error: error ?? null,
            updatedAt: new Date().toISOString(),
          });
        }
        job.status = status;
        publish(event, false);
      };
      try {
        if (this.audit) {
          const now = new Date().toISOString();
          await this.audit.startRun({
            id: job.id,
            request,
            previousTripId: previous?.id ?? null,
            status: 'running',
            tripId: null,
            output: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          });
          started = true;
        }
        job.controller.signal.throwIfAborted();
        const operation = () =>
          this.planner.plan(request, job.controller.signal, publish, previous);
        const trip = await (recorder ? recorder.run(operation) : operation());
        if (job.controller.signal.aborted) await finish('cancelled', { type: 'cancelled' });
        else await finish('completed', { type: 'result', trip }, trip);
      } catch (error) {
        const cancelled = job.controller.signal.aborted;
        const message = publicError(error);
        try {
          await finish(
            cancelled ? 'cancelled' : 'failed',
            cancelled ? { type: 'cancelled' } : { type: 'error', message },
            undefined,
            message,
          );
        } catch (storageError) {
          // Surface failed persistence; do not report a successfully logged run.
          job.status = cancelled ? 'cancelled' : 'failed';
          publish({ type: 'error', message: publicError(storageError) }, false);
        }
      }
    };
    const task = execute();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
    return job;
  }
  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('规划任务不存在或已过期。', 404);
    return job;
  }
  async history(): Promise<Omit<PlanningTaskSummary, 'cityName'>[]> {
    const saved = (await this.audit?.list()) ?? [];
    const rows = new Map(
      saved.map((run) => [
        run.id,
        {
          id: run.id,
          status: run.status,
          request: run.request,
          tripId: run.tripId,
          error: run.error,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          progress: null as ProgressEvent | null,
        },
      ]),
    );
    for (const job of this.jobs.values()) {
      const terminal = [...job.events].reverse().find((event) => event.type !== 'progress');
      const progress =
        [...job.events]
          .reverse()
          .find((event): event is ProgressEvent => event.type === 'progress') ?? null;
      rows.set(job.id, {
        id: job.id,
        status: job.status,
        request: job.request,
        tripId: terminal?.type === 'result' ? terminal.trip.id : null,
        error: terminal?.type === 'error' ? terminal.message : null,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt:
          rows.get(job.id)?.updatedAt ??
          progress?.timestamp ??
          new Date(job.createdAt).toISOString(),
        progress,
      });
    }
    return [...rows.values()]
      .map((row) =>
        row.status === 'running' && !this.jobs.has(row.id)
          ? { ...row, status: 'failed' as const, error: '服务已重启，这次规划已中断，请重新生成。' }
          : row,
      )
      .sort(
        (a, b) =>
          Number(b.status === 'running') - Number(a.status === 'running') ||
          b.createdAt.localeCompare(a.createdAt),
      );
  }
  async snapshot(id: string): Promise<JobSnapshot> {
    const job = this.jobs.get(id);
    if (job) return { id: job.id, status: job.status, events: job.events };
    const run = await this.audit?.get(id);
    if (!run) throw new AppError('规划任务不存在或已过期。', 404);
    const events = jobEvents(run);
    if (run.status === 'running')
      return {
        id,
        status: 'failed',
        events: [
          ...events,
          { type: 'error', message: '该任务已不在当前服务中运行，记录已保留，请重新生成。' },
        ],
      };
    return { id, status: run.status, events };
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'running') job.controller.abort();
  }
  async close() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.tasks]);
  }
}
