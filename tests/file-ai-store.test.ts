import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileAiStore, type AiCall, type AiRun, type AiEvent } from '../backend/src/db/ai-store.js';
import { request } from './fixtures/travel.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'stree-file-log-'));
  directories.push(directory);
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
  const call: AiCall = {
    id: randomUUID(),
    runId: run.id,
    parentCallId: null,
    kind: 'model',
    name: 'chat/completions',
    provider: 'test',
    model: 'test',
    protocol: 'openai-completions',
    status: 'running',
    input: { text: 'large-context'.repeat(40000) },
    output: null,
    usage: null,
    error: null,
    durationMs: null,
    createdAt: now,
    finishedAt: null,
  };
  const event: AiEvent = {
    id: randomUUID(),
    runId: run.id,
    sequence: 1,
    type: 'job',
    payload: { type: 'progress', stage: 'planning', message: 'AI 规划中', timestamp: now },
    createdAt: now,
  };
  return { directory, run, call, event, store: new FileAiStore(directory) };
}
describe('本地分条 AI 日志', () => {
  it('新事件和其他调用不会重写已保存的大调用，重启后可恢复完整记录', async () => {
    const { store, directory, run, call, event } = await fixture();
    await store.startRun(run);
    await store.startCall(call);
    await store.finishCall(call.id, {
      status: 'completed',
      output: { ok: true },
      usage: null,
      error: null,
      durationMs: 10,
      finishedAt: run.createdAt,
    });
    const callFile = path.join(directory, 'calls', `${call.id}.json`);
    const before = await readFile(callFile, 'utf8');
    for (let sequence = 1; sequence <= 20; sequence++)
      await store.appendEvent({ ...event, id: randomUUID(), sequence });
    await store.startCall({ ...call, id: randomUUID(), input: { other: true } });
    await store.finishRun(run.id, {
      status: 'failed',
      tripId: null,
      output: null,
      error: '测试终态',
      updatedAt: run.createdAt,
    });
    expect(await readFile(callFile, 'utf8')).toBe(before);
    expect((await readFile(path.join(directory, `${run.id}.json`), 'utf8')).length).toBeLessThan(
      3000,
    );
    const reopened = new FileAiStore(directory);
    const saved = await reopened.get(run.id);
    expect(saved).toMatchObject({ status: 'failed', error: '测试终态' });
    expect(saved!.calls).toHaveLength(2);
    expect(saved!.events).toHaveLength(20);
    expect(saved!.calls[0]!.input).toEqual(call.input);
    // Listing reads only the small summary even if a detail file cannot be decoded.
    await writeFile(callFile, 'damaged call detail');
    expect(await reopened.list()).toMatchObject([{ id: run.id, status: 'failed' }]);
  });
  it('兼容旧版单文件记录，首次修改时保留原文件并迁移调用和事件', async () => {
    const { directory, run, call, event } = await fixture();
    const original = JSON.stringify({ ...run, calls: [call], events: [event] });
    await writeFile(path.join(directory, `${run.id}.json`), original, { mode: 0o600 });
    const store = new FileAiStore(directory);
    expect((await store.get(run.id))!.calls).toHaveLength(1);
    await store.finishCall(call.id, {
      status: 'completed',
      output: { ok: true },
      usage: null,
      error: null,
      durationMs: 10,
      finishedAt: run.createdAt,
    });
    await store.appendEvent({ ...event, id: randomUUID(), sequence: 2 });
    expect(await readFile(path.join(directory, 'legacy', `${run.id}.json`), 'utf8')).toBe(original);
    const saved = await new FileAiStore(directory).get(run.id);
    expect(saved!.calls[0]!.status).toBe('completed');
    expect(saved!.events).toHaveLength(2);
  });
});
