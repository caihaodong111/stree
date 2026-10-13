import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { JobEvent, JobSnapshot, PlanRequest, Trip } from '@stree/shared';
import { AppError, publicError } from '../errors.js';
import type { TravelPlanner } from './planner.js';

export type Job = JobSnapshot & {
  controller: AbortController;
  emitter: EventEmitter;
  createdAt: number;
};
export class JobManager {
  private jobs = new Map<string, Job>();
  constructor(private planner: TravelPlanner) {}
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
    };
    this.jobs.set(job.id, job);
    const publish = (event: JobEvent) => {
      job.events.push(event);
      if (job.events.length > 80) job.events.splice(0, job.events.length - 80);
      job.emitter.emit('event', event);
    };
    void this.planner
      .plan(request, job.controller.signal, publish, previous)
      .then((trip) => {
        if (job.controller.signal.aborted) {
          job.status = 'cancelled';
          publish({ type: 'cancelled' });
          return;
        }
        job.status = 'completed';
        publish({ type: 'result', trip });
      })
      .catch((error) => {
        if (job.controller.signal.aborted) {
          job.status = 'cancelled';
          publish({ type: 'cancelled' });
        } else {
          job.status = 'failed';
          publish({ type: 'error', message: publicError(error) });
        }
      });
    return job;
  }
  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('规划任务不存在或已过期。', 404);
    return job;
  }
  cancel(id: string) {
    const job = this.get(id);
    if (job.status === 'running') job.controller.abort();
  }
  close() {
    for (const job of this.jobs.values()) job.controller.abort();
  }
}
