import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RowDataPacket } from 'mysql2/promise';
import { runtimeRoot } from '../config.js';
import { createMysqlPool, parseJson } from '../db/mysql.js';
import { FileTripStore } from '../db/store.js';
import { FileAiStore, type AiCall, type AiEvent, type AiRun } from '../db/ai-store.js';
import { TripSchema } from '@stree/shared';

const directory = path.join(
  runtimeRoot,
  'backups',
  `mysql-to-files-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
);
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const name of ['trips', 'ai-runs']) {
  await cp(path.join(runtimeRoot, name), path.join(directory, 'previous-files', name), {
    recursive: true,
    errorOnExist: true,
  }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
const staging = path.join(directory, 'imported');
const trips = new FileTripStore(path.join(staging, 'trips'));
const audit = new FileAiStore(path.join(staging, 'ai-runs'));
const db = createMysqlPool();
const counts = { trips: 0, runs: 0, calls: 0, events: 0 };
const names: Record<string, string> = {
  run_id: 'runId',
  parent_call_id: 'parentCallId',
  previous_trip_id: 'previousTripId',
  trip_id: 'tripId',
  duration_ms: 'durationMs',
  token_usage: 'usage',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  finished_at: 'finishedAt',
};
const decode = <T>(row: RowDataPacket): T =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      names[key] ?? key,
      ['request', 'input', 'output', 'token_usage', 'payload'].includes(key)
        ? parseJson(value)
        : value instanceof Date
          ? value.toISOString()
          : value,
    ]),
  ) as T;
const query = async (sql: string, values: unknown[] = []) =>
  (await db.execute<RowDataPacket[]>({ sql, values, timeout: 60000 }))[0];
const readOptional = async (file: string) =>
  readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
try {
  const expected: Record<string, number> = {};
  for (const [name, table] of Object.entries({
    trips: 'stree_trips',
    runs: 'stree_ai_runs',
    calls: 'stree_ai_calls',
    events: 'stree_ai_events',
  }))
    expected[name] = Number((await query(`SELECT COUNT(*) AS count FROM ${table}`))[0]!.count);
  for (const row of await query('SELECT payload FROM stree_trips ORDER BY id')) {
    await trips.save(TripSchema.parse(parseJson(row.payload)));
    counts.trips++;
  }
  console.log(JSON.stringify({ stage: 'trips-exported', count: counts.trips }));
  for (const row of await query('SELECT * FROM stree_ai_runs ORDER BY created_at,id')) {
    const run = decode<AiRun>(row);
    await audit.startRun(run);
    for (let offset = 0; ; offset += 8) {
      const calls = await query(
        `SELECT * FROM stree_ai_calls WHERE run_id=? ORDER BY created_at,id LIMIT 8 OFFSET ${offset}`,
        [run.id],
      );
      if (!calls.length) break;
      for (const call of calls) {
        await audit.startCall(decode<AiCall>(call));
        counts.calls++;
      }
    }
    for (const event of await query(
      'SELECT * FROM stree_ai_events WHERE run_id=? ORDER BY sequence',
      [run.id],
    )) {
      await audit.appendEvent(decode<AiEvent>(event));
      counts.events++;
    }
    counts.runs++;
    console.log(JSON.stringify({ stage: 'run-exported', runId: run.id, ...counts }));
  }
  if (
    Object.entries(expected).some(([name, count]) => counts[name as keyof typeof counts] !== count)
  )
    throw new Error('导出条数与数据库不一致，未切换文件。');
  const currentTrips = new FileTripStore();
  for (const file of await readdir(path.join(staging, 'trips'))) {
    const trip = await trips.get(file.slice(0, -5));
    const previous = await currentTrips.get(trip!.id);
    if (!previous || previous.updatedAt <= trip!.updatedAt) await currentTrips.save(trip!);
  }
  const currentAi = path.join(runtimeRoot, 'ai-runs');
  const stagedAi = path.join(staging, 'ai-runs');
  await mkdir(currentAi, { recursive: true, mode: 0o700 });
  for (const file of (await readdir(stagedAi)).filter((name) => name.endsWith('.json'))) {
    const run = await readOptional(path.join(stagedAi, file));
    const previous = await readOptional(path.join(currentAi, file));
    if (previous && previous.updatedAt > run.updatedAt) continue;
    const index = await readFile(path.join(stagedAi, 'indexes', `${run.id}.jsonl`), 'utf8').catch(
      (error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
    for (const line of index.split('\n').filter(Boolean)) {
      const callId = JSON.parse(line);
      await mkdir(path.join(currentAi, 'calls'), { recursive: true, mode: 0o700 });
      await copyFile(
        path.join(stagedAi, 'calls', `${callId}.json`),
        path.join(currentAi, 'calls', `${callId}.json`),
      );
    }
    for (const name of ['summaries', 'indexes', 'events']) {
      await mkdir(path.join(currentAi, name), { recursive: true, mode: 0o700 });
      const filename = `${run.id}.${name === 'summaries' ? 'json' : 'jsonl'}`;
      await copyFile(
        path.join(stagedAi, name, filename),
        path.join(currentAi, name, filename),
      ).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await copyFile(path.join(stagedAi, file), path.join(currentAi, file));
  }
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        source: 'mysql',
        expected,
        exported: counts,
        mysqlUnchanged: true,
        storageFormat: 2,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ stage: 'complete', directory, ...counts, mysqlUnchanged: true }));
} catch (error) {
  console.error(error instanceof Error ? error.message : '导出失败；MySQL 原数据未修改。');
  process.exitCode = 1;
} finally {
  await audit.close();
  await trips.close();
  await db.end();
}
