import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { TripSchema, type Trip, type TripSummary } from '@stree/shared';
import { config, runtimeRoot } from '../config.js';
import { AppError } from '../errors.js';
import { tripsTable } from './schema.js';

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
  private pool = mysql.createPool({
    host: config.MYSQL_HOST,
    port: config.MYSQL_PORT,
    user: config.MYSQL_USER,
    password: config.MYSQL_PASSWORD,
    database: config.MYSQL_DATABASE,
    charset: 'utf8mb4',
    connectionLimit: 5,
    connectTimeout: 5000,
  });
  private db = drizzle(this.pool);
  async setup() {
    await this.pool.execute(
      'CREATE TABLE IF NOT EXISTS stree_trips (id VARCHAR(36) PRIMARY KEY, city_code VARCHAR(6) NOT NULL, title VARCHAR(128) NOT NULL, payload JSON NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL) CHARACTER SET utf8mb4',
    );
  }
  async save(trip: Trip) {
    const row = {
      id: trip.id,
      cityCode: trip.city.adcode,
      title: trip.routes[0]?.title ?? '旅行计划',
      payload: trip,
      createdAt: new Date(trip.createdAt),
      updatedAt: new Date(trip.updatedAt),
    };
    try {
      await this.db
        .insert(tripsTable)
        .values(row)
        .onDuplicateKeyUpdate({
          set: { payload: trip, title: row.title, updatedAt: row.updatedAt },
        });
    } catch {
      throw new AppError(
        '行程保存失败，请检查 MySQL 连接并执行 npm run db:setup。',
        503,
        'STORAGE_UNAVAILABLE',
      );
    }
  }
  async get(id: string) {
    const rows = await this.db.select().from(tripsTable).where(eq(tripsTable.id, id)).limit(1);
    return rows[0] ? TripSchema.parse(rows[0].payload) : null;
  }
  async list() {
    return (
      await this.db.select().from(tripsTable).orderBy(desc(tripsTable.updatedAt)).limit(30)
    ).map((row) => summary(TripSchema.parse(row.payload)));
  }
  async check() {
    try {
      await this.pool.execute('SELECT id FROM stree_trips LIMIT 1');
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
