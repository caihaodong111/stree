import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  rename,
  appendFile,
  copyFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type { Pool, Connection, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { JobEvent, PlanRequest } from '@stree/shared';
import { config, runtimeRoot } from '../config.js';
import { AppError } from '../errors.js';
import { createMysqlPool, parseJson } from './mysql.js';
import { aiDiagnosticsDirectory, recordStorageFailure } from './ai-diagnostics.js';

export type AiStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type AiRun = {
  id: string;
  request: PlanRequest;
  previousTripId: string | null;
  status: AiStatus;
  tripId: string | null;
  output: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AiCall = {
  id: string;
  runId: string;
  parentCallId: string | null;
  kind: 'model' | 'tool';
  name: string;
  provider: string | null;
  model: string | null;
  protocol: string | null;
  status: AiStatus;
  input: unknown;
  output: unknown;
  usage: unknown;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
};
export type AiEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};
export type AiRunDetail = AiRun & { calls: AiCall[]; events: AiEvent[] };
export interface AiStore {
  startRun(run: AiRun): Promise<void>;
  finishRun(
    id: string,
    patch: Pick<AiRun, 'status' | 'tripId' | 'output' | 'error' | 'updatedAt'>,
  ): Promise<void>;
  startCall(call: AiCall): Promise<void>;
  finishCall(
    id: string,
    patch: Pick<AiCall, 'status' | 'output' | 'usage' | 'error' | 'durationMs' | 'finishedAt'>,
  ): Promise<void>;
  appendEvent(event: AiEvent): Promise<void>;
  get(id: string): Promise<AiRunDetail | null>;
  list(): Promise<Omit<AiRun, 'output'>[]>;
  close(): Promise<void>;
}

const secretKey =
  /^(?:authorization|proxy.authorization|cookie|set.cookie|api.?key|.*password|.*secret|access.?token|refresh.?token)$/i;
const reasoningKey =
  /^(?:reasoning_content|reasoning_details|thinking|encrypted_content|chain_of_thought)$/i;
/** Strip credentials and private reasoning while preserving public model output and tool data. */
export function redactAiData(value: unknown, secrets: string[] = []): unknown {
  const hidden = '[已隐藏密钥]';
  const known = [
    config.MYSQL_PASSWORD,
    config.AMAP_WEB_SERVICE_KEY,
    process.env.LLM_API_KEY ?? '',
    ...secrets,
  ].filter(Boolean);
  const clean = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let text = item;
      for (const secret of known) text = text.split(secret).join(hidden);
      return text
        .replace(/Bearer\s+[^\s"']+/gi, `Bearer ${hidden}`)
        .replace(/([?&](?:key|api_key|token|password)=)[^&\s]+/gi, `$1${hidden}`);
    }
    if (Array.isArray(item))
      return item
        .filter(
          (entry) =>
            !entry ||
            typeof entry !== 'object' ||
            !('type' in entry) ||
            !['reasoning', 'thinking', 'redacted_thinking'].includes(String(entry.type)),
        )
        .map(clean);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(
            ([key, entry]) =>
              !reasoningKey.test(key) && !(key === 'reasoning' && typeof entry === 'string'),
          )
          .map(([key, entry]) => [key, secretKey.test(key) ? hidden : clean(entry)]),
      );
    return item ?? null;
  };
  return clean(value);
}
const json = (value: unknown) => JSON.stringify(redactAiData(value));
const validId = (id: string) => /^[a-zA-Z0-9-]{1,64}$/.test(id);

export const createAiTablesSql = [
  `CREATE TABLE IF NOT EXISTS stree_ai_runs (
    id VARCHAR(36) PRIMARY KEY, previous_trip_id VARCHAR(36) NULL, trip_id VARCHAR(36) NULL,
    status VARCHAR(16) NOT NULL, request JSON NOT NULL, output JSON NULL, error TEXT NULL,
    created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
    INDEX stree_ai_runs_recent_idx (created_at, id), INDEX stree_ai_runs_trip_idx (trip_id)
  ) ENGINE=InnoDB CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS stree_ai_calls (
    id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, parent_call_id VARCHAR(36) NULL,
    kind VARCHAR(16) NOT NULL, name VARCHAR(128) NOT NULL, provider VARCHAR(128) NULL,
    model VARCHAR(200) NULL, protocol VARCHAR(64) NULL, status VARCHAR(16) NOT NULL,
    input JSON NOT NULL, output JSON NULL, token_usage JSON NULL, error TEXT NULL,
    duration_ms BIGINT UNSIGNED NULL, created_at DATETIME(3) NOT NULL, finished_at DATETIME(3) NULL,
    INDEX stree_ai_calls_run_idx (run_id, created_at, id),
    CONSTRAINT stree_ai_calls_run_fk FOREIGN KEY (run_id) REFERENCES stree_ai_runs(id)
  ) ENGINE=InnoDB CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS stree_ai_events (
    id VARCHAR(36) PRIMARY KEY, run_id VARCHAR(36) NOT NULL, sequence INT UNSIGNED NOT NULL,
    type VARCHAR(64) NOT NULL, payload JSON NOT NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY stree_ai_events_sequence_idx (run_id, sequence),
    CONSTRAINT stree_ai_events_run_fk FOREIGN KEY (run_id) REFERENCES stree_ai_runs(id)
  ) ENGINE=InnoDB CHARACTER SET utf8mb4`,
];

function decode<T>(row: RowDataPacket): T {
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
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      names[key] ?? key,
      ['request', 'input', 'output', 'token_usage', 'payload'].includes(key)
        ? parseJson(value)
        : value instanceof Date
          ? value.toISOString()
          : value,
    ]),
  ) as T;
}
export class MysqlAiStore implements AiStore {
  constructor(
    private pool: Pool | Connection = createMysqlPool(),
    private diagnosticsDirectory = aiDiagnosticsDirectory,
  ) {}
  private async execute(sql: string, values: unknown[] = []) {
    let db: Connection | PoolConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    let phase = 'acquire';
    try {
      if ('getConnection' in this.pool) {
        try {
          db = await this.pool.getConnection();
        } catch (error) {
          // SQL has not started: obtaining another connection cannot duplicate a write.
          if (
            !['ETIMEDOUT', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST'].includes(
              String((error as { code?: string })?.code),
            )
          )
            throw error;
          await recordStorageFailure(
            error,
            sql,
            values,
            'acquire_retry',
            Date.now() - started,
            this.diagnosticsDirectory,
          );
          db = await this.pool.getConnection();
        }
      } else db = this.pool;
      const connection = db;
      phase = 'execute';
      return await Promise.race([
        connection.execute<RowDataPacket[]>({
          sql,
          values,
          timeout: config.MYSQL_QUERY_TIMEOUT_MS,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            connection.destroy();
            reject(Object.assign(new Error('query timeout'), { code: 'MYSQL_QUERY_TIMEOUT' }));
          }, config.MYSQL_QUERY_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      clearTimeout(timer);
      const diagnostic = await recordStorageFailure(
        error,
        sql,
        values,
        phase,
        Date.now() - started,
        this.diagnosticsDirectory,
      );
      throw new AppError(
        `AI 记录写入或读取失败（${diagnostic.code}，诊断 ${diagnostic.id}）。`,
        503,
        'AI_STORAGE_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      if (db && 'release' in db && typeof db.release === 'function') db.release();
    }
  }
  async setup() {
    for (const sql of createAiTablesSql) await this.execute(sql);
  }
  async startRun(run: AiRun) {
    await this.execute(
      'INSERT INTO stree_ai_runs (id,previous_trip_id,trip_id,status,request,output,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [
        run.id,
        run.previousTripId,
        run.tripId,
        run.status,
        json(run.request),
        json(run.output),
        run.error,
        new Date(run.createdAt),
        new Date(run.updatedAt),
      ],
    );
  }
  async finishRun(
    id: string,
    patch: Pick<AiRun, 'status' | 'tripId' | 'output' | 'error' | 'updatedAt'>,
  ) {
    await this.execute(
      'UPDATE stree_ai_runs SET status=?,trip_id=?,output=?,error=?,updated_at=? WHERE id=?',
      [
        patch.status,
        patch.tripId,
        json(patch.output),
        redactAiData(patch.error),
        new Date(patch.updatedAt),
        id,
      ],
    );
  }
  async startCall(call: AiCall) {
    await this.execute(
      'INSERT INTO stree_ai_calls (id,run_id,parent_call_id,kind,name,provider,model,protocol,status,input,output,token_usage,error,duration_ms,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        call.id,
        call.runId,
        call.parentCallId,
        call.kind,
        call.name,
        call.provider,
        call.model,
        call.protocol,
        call.status,
        json(call.input),
        json(call.output),
        json(call.usage),
        call.error,
        call.durationMs,
        new Date(call.createdAt),
        null,
      ],
    );
  }
  async finishCall(
    id: string,
    patch: Pick<AiCall, 'status' | 'output' | 'usage' | 'error' | 'durationMs' | 'finishedAt'>,
  ) {
    await this.execute(
      'UPDATE stree_ai_calls SET status=?,output=?,token_usage=?,error=?,duration_ms=?,finished_at=? WHERE id=?',
      [
        patch.status,
        json(patch.output),
        json(patch.usage),
        redactAiData(patch.error),
        patch.durationMs,
        patch.finishedAt ? new Date(patch.finishedAt) : null,
        id,
      ],
    );
  }
  async appendEvent(event: AiEvent) {
    await this.execute(
      'INSERT INTO stree_ai_events (id,run_id,sequence,type,payload,created_at) VALUES (?,?,?,?,?,?)',
      [
        event.id,
        event.runId,
        event.sequence,
        event.type,
        json(event.payload),
        new Date(event.createdAt),
      ],
    );
  }
  async get(id: string): Promise<AiRunDetail | null> {
    if (!validId(id)) return null;
    const [runs] = await this.execute('SELECT * FROM stree_ai_runs WHERE id=?', [id]);
    if (!runs[0]) return null;
    const [calls] = await this.execute(
      'SELECT * FROM stree_ai_calls WHERE run_id=? ORDER BY created_at,id',
      [id],
    );
    const [events] = await this.execute(
      'SELECT * FROM stree_ai_events WHERE run_id=? ORDER BY sequence',
      [id],
    );
    return {
      ...decode<AiRun>(runs[0]),
      calls: calls.map((row) => decode<AiCall>(row)),
      events: events.map((row) => decode<AiEvent>(row)),
    };
  }
  async list() {
    const [rows] = await this.execute(
      'SELECT id,previous_trip_id,trip_id,status,request,error,created_at,updated_at FROM stree_ai_runs ORDER BY created_at DESC,id DESC LIMIT 50',
    );
    return rows.map((row) => decode<Omit<AiRun, 'output'>>(row));
  }
  async close() {
    await this.pool.end();
  }
}

/** Local records: small run summaries, one file per call and append-only event logs. */
export class FileAiStore implements AiStore {
  private queue = Promise.resolve();
  constructor(private directory = path.join(runtimeRoot, 'ai-runs')) {}
  private file(id: string) {
    if (!validId(id)) throw new AppError('AI 记录 ID 无效。');
    return path.join(this.directory, `${id}.json`);
  }
  private async read<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async write(file: string, value: unknown) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, json(value), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private enqueue(operation: () => Promise<void>) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async writeRun(run: AiRun) {
    await this.write(this.file(run.id), { ...run, storageVersion: 2 });
    const { output: _output, ...summary } = run;
    await this.write(path.join(this.directory, 'summaries', `${run.id}.json`), summary);
  }
  private async lines(file: string) {
    try {
      return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  private async run(id: string): Promise<AiRun | null> {
    const saved = await this.read<AiRunDetail & { storageVersion?: number }>(this.file(id));
    if (!saved) return null;
    if (saved.storageVersion !== 2) {
      // Upgrade legacy single-file records only when writing; preserve their original bytes.
      const backup = path.join(this.directory, 'legacy', `${id}.json`);
      await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
      await copyFile(this.file(id), backup, 1).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      for (const call of saved.calls ?? [])
        await this.write(path.join(this.directory, 'calls', `${call.id}.json`), call);
      await mkdir(path.join(this.directory, 'indexes'), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(this.directory, 'indexes', `${id}.jsonl`),
        (saved.calls ?? []).map((call) => JSON.stringify(call.id)).join('\n') +
          ((saved.calls?.length ?? 0) ? '\n' : ''),
        { mode: 0o600 },
      );
      await mkdir(path.join(this.directory, 'events'), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(this.directory, 'events', `${id}.jsonl`),
        (saved.events ?? []).map((event) => json(event)).join('\n') +
          ((saved.events?.length ?? 0) ? '\n' : ''),
        { mode: 0o600 },
      );
      const { calls: _calls, events: _events, storageVersion: _version, ...run } = saved;
      await this.writeRun(run);
      return run;
    }
    const { calls: _calls, events: _events, storageVersion: _version, ...run } = saved;
    return run;
  }
  async startRun(run: AiRun) {
    await this.enqueue(() => this.writeRun(run));
  }
  async finishRun(
    id: string,
    patch: Pick<AiRun, 'status' | 'tripId' | 'output' | 'error' | 'updatedAt'>,
  ) {
    await this.enqueue(async () => {
      const run = await this.run(id);
      if (!run) throw new AppError('AI 任务不存在。', 404);
      await this.writeRun({ ...run, ...patch });
    });
  }
  async startCall(call: AiCall) {
    await this.enqueue(async () => {
      if (!(await this.run(call.runId))) throw new AppError('AI 任务不存在。', 404);
      this.file(call.id);
      await this.write(path.join(this.directory, 'calls', `${call.id}.json`), call);
      await mkdir(path.join(this.directory, 'indexes'), { recursive: true, mode: 0o700 });
      await appendFile(
        path.join(this.directory, 'indexes', `${call.runId}.jsonl`),
        `${JSON.stringify(call.id)}\n`,
        { mode: 0o600 },
      );
    });
  }
  async finishCall(
    id: string,
    patch: Pick<AiCall, 'status' | 'output' | 'usage' | 'error' | 'durationMs' | 'finishedAt'>,
  ) {
    await this.enqueue(async () => {
      this.file(id);
      const file = path.join(this.directory, 'calls', `${id}.json`);
      let call = await this.read<AiCall>(file);
      if (!call) {
        // An old record can be updated after reopening a legacy store.
        const names = await readdir(this.directory).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        for (const name of names.filter(
          (name) => name.endsWith('.json') && validId(name.slice(0, -5)),
        )) {
          const legacy = await this.read<AiRunDetail & { storageVersion?: number }>(
            path.join(this.directory, name),
          );
          if (legacy?.calls?.some((item) => item.id === id)) {
            await this.run(legacy.id);
            call = await this.read<AiCall>(file);
            break;
          }
        }
      }
      if (!call) throw new AppError('AI 调用不存在。', 404);
      await this.write(file, { ...call, ...patch });
    });
  }
  async appendEvent(event: AiEvent) {
    await this.enqueue(async () => {
      if (!(await this.run(event.runId))) throw new AppError('AI 任务不存在。', 404);
      await mkdir(path.join(this.directory, 'events'), { recursive: true, mode: 0o700 });
      await appendFile(
        path.join(this.directory, 'events', `${event.runId}.jsonl`),
        `${json(event)}\n`,
        { mode: 0o600 },
      );
    });
  }
  async get(id: string): Promise<AiRunDetail | null> {
    if (!validId(id)) return null;
    const run = await this.read<AiRunDetail & { storageVersion?: number }>(this.file(id));
    if (!run) return null;
    if (run.storageVersion !== 2) return run;
    const { storageVersion: _version, ...metadata } = run;
    const callIds = [
      ...new Set(
        (await this.lines(path.join(this.directory, 'indexes', `${id}.jsonl`))).map(
          (line) => JSON.parse(line) as string,
        ),
      ),
    ];
    const calls: AiCall[] = [];
    // Bound open files when a long tool loop has hundreds of records.
    for (let offset = 0; offset < callIds.length; offset += 8) {
      const batch = await Promise.all(
        callIds.slice(offset, offset + 8).map((callId) => {
          this.file(callId);
          return this.read<AiCall>(path.join(this.directory, 'calls', `${callId}.json`));
        }),
      );
      calls.push(...batch.filter((call): call is AiCall => call !== null));
    }
    const events = (await this.lines(path.join(this.directory, 'events', `${id}.jsonl`))).map(
      (line) => JSON.parse(line) as AiEvent,
    );
    return { ...metadata, calls, events: events.sort((a, b) => a.sequence - b.sequence) };
  }
  async list(): Promise<Omit<AiRun, 'output'>[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter(
      (name) => name.endsWith('.json') && validId(name.slice(0, -5)),
    );
    const runs = await Promise.all(
      names.map(async (name) => {
        const summary = await this.read<Omit<AiRun, 'output'>>(
          path.join(this.directory, 'summaries', name),
        );
        if (summary) return summary;
        const saved = await this.read<AiRunDetail & { storageVersion?: number }>(
          path.join(this.directory, name),
        );
        if (!saved) return null;
        const {
          output: _output,
          calls: _calls,
          events: _events,
          storageVersion: _version,
          ...run
        } = saved;
        return run;
      }),
    );
    return runs
      .filter((run): run is Omit<AiRun, 'output'> => run !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
  }
  async close() {
    await this.queue;
  }
}

export function jobEvents(run: AiRunDetail): JobEvent[] {
  return run.events
    .filter((event) => event.type === 'job')
    .map((event) => event.payload as JobEvent);
}
