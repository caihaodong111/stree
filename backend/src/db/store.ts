import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
import { TripSchema, RegionSchema, type Trip, type TripSummary } from '@stree/shared';
import { config, runtimeRoot } from '../config.js';
import { AppError } from '../errors.js';
import { createMysqlPool, createTripsSql, historySql, parseJson } from './mysql.js';

export interface TripStore {
  driver: string;
  save(trip: Trip): Promise<void>;
  get(id: string): Promise<Trip | null>;
  list(): Promise<TripSummary[]>;
  check(): Promise<boolean>;
  close(): Promise<void>;
}
const summary = (trip: Trip): TripSummary => ({
  id: trip.id,
  city: trip.city,
  createdAt: trip.createdAt,
  summary: trip.summary,
  title: trip.routes[0]?.title ?? '旅行计划',
  days: trip.request.days,
});
const validId = (id: string) => /^[a-zA-Z0-9-]{1,64}$/.test(id);
export class FileTripStore implements TripStore {
  driver = 'file';
  constructor(private directory = path.join(runtimeRoot, 'trips')) {}
  async save(trip: Trip) {
    if (!validId(trip.id)) throw new AppError('行程 ID 无效。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, `${trip.id}.json`);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(TripSchema.parse(trip)), { mode: 0o600 });
    await rename(temp, target);
  }
  async get(id: string): Promise<Trip | null> {
    if (!validId(id)) return null;
    try {
      return TripSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, `${id}.json`), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async list() {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter((name) => name.endsWith('.json'));
    const rows = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return rows
      .filter((trip): trip is Trip => trip !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 30)
      .map(summary);
  }
  async check() {
    try {
      await mkdir(this.directory, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  async close() {}
}
export class MysqlTripStore implements TripStore {
  driver = 'mysql';
  constructor(private pool: Pool | Connection = createMysqlPool()) {}
  private async query(sql: string, values: unknown[] = []) {
    const connection = 'getConnection' in this.pool ? await this.pool.getConnection() : this.pool;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound preparation and result transfer as well as statement execution. A timed-out
      // socket is destroyed, so it cannot leave later requests queued behind a stuck query.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          connection.destroy();
          reject(new AppError('数据库操作超时。', 503, 'STORAGE_UNAVAILABLE'));
        }, config.MYSQL_QUERY_TIMEOUT_MS);
      });
      return await Promise.race([
        connection.execute<RowDataPacket[]>({
          sql,
          values,
          timeout: config.MYSQL_QUERY_TIMEOUT_MS,
        }),
        deadline,
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'PROTOCOL_SEQUENCE_TIMEOUT')
        connection.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      if (
        'getConnection' in this.pool &&
        'release' in connection &&
        typeof connection.release === 'function'
      )
        connection.release();
    }
  }
  async setup() {
    await this.query(createTripsSql);
    // Schema upgrades are explicit maintenance operations, never request-time DDL.
    await this.query(`${historySql.replace('LIMIT 30', 'LIMIT 0')}`);
  }
  async save(input: Trip) {
    const trip = TripSchema.parse(input);
    if (!validId(trip.id) || trip.id.length > 36) throw new AppError('行程 ID 无效。');
    const createdAt = new Date(trip.createdAt);
    const updatedAt = new Date(trip.updatedAt);
    if (!Number.isFinite(+createdAt) || !Number.isFinite(+updatedAt))
      throw new AppError('行程时间无效。');
    try {
      // A single atomic upsert keeps the light history fields and full payload consistent.
      await this.query(
        `INSERT INTO stree_trips
        (id, title, city, days, summary, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE title=VALUES(title), city=VALUES(city), days=VALUES(days),
          summary=VALUES(summary), payload=VALUES(payload), created_at=VALUES(created_at),
          updated_at=VALUES(updated_at)`,
        [
          trip.id,
          trip.routes[0]?.title ?? '旅行计划',
          JSON.stringify(trip.city),
          trip.request.days,
          trip.summary,
          JSON.stringify(trip),
          createdAt,
          updatedAt,
        ],
      );
    } catch {
      throw new AppError(
        '行程保存失败，数据库暂时不可用，请稍后重试。',
        503,
        'STORAGE_UNAVAILABLE',
      );
    }
  }
  async get(id: string): Promise<Trip | null> {
    if (!validId(id) || id.length > 36) return null;
    let rows: RowDataPacket[];
    try {
      [rows] = await this.query('SELECT payload FROM stree_trips WHERE id = ? LIMIT 1', [id]);
    } catch {
      throw new AppError('行程读取失败，数据库暂时不可用。', 503, 'STORAGE_UNAVAILABLE');
    }
    return rows[0] ? TripSchema.parse(parseJson(rows[0].payload)) : null;
  }
  async list(): Promise<TripSummary[]> {
    let rows: RowDataPacket[];
    try {
      [rows] = await this.query(historySql);
    } catch {
      throw new AppError('历史行程读取失败，数据库暂时不可用。', 503, 'STORAGE_UNAVAILABLE');
    }
    return rows.map((row) => ({
      id: row.id,
      city: RegionSchema.parse(parseJson(row.city)),
      title: row.title,
      days: row.days,
      summary: row.summary,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
  async check() {
    try {
      await this.query('SELECT id, city, days, summary FROM stree_trips LIMIT 0');
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    await this.pool.end();
  }
}
export function createStore(): TripStore {
  return config.STORAGE_DRIVER === 'file' ? new FileTripStore() : new MysqlTripStore();
}
