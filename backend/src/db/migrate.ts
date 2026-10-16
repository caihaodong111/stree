import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { TripSchema, type Trip } from '@stree/shared';
import { config, runtimeRoot } from '../config.js';
import { createTripsSql, historySql, mysqlOptions, parseJson } from './mysql.js';
import { MysqlTripStore } from './store.js';
import { createAiTablesSql } from './ai-store.js';

// These four tables belong to the retired Python application; no other table is removed.
const legacyTables = ['route_plan_items', 'route_plans', 'hotel_pois', 'pois'];
const maintenanceTimeout = 30000;

async function query(db: Connection, sql: string, values: unknown[] = []) {
  return db.query<RowDataPacket[]>({ sql, values, timeout: maintenanceTimeout });
}

async function localTrips(): Promise<Trip[]> {
  const directory = path.join(runtimeRoot, 'trips');
  let files: string[];
  try {
    files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const trips: Trip[] = [];
  for (const file of files) {
    const trip = TripSchema.parse(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
    if (file !== `${trip.id}.json` || !/^[a-zA-Z0-9-]{1,36}$/.test(trip.id))
      throw new Error(`行程文件 ID 不匹配：${file}`);
    if (![trip.createdAt, trip.updatedAt].every((value) => Number.isFinite(+new Date(value))))
      throw new Error(`行程时间无效：${file}`);
    trips.push(trip);
  }
  return trips;
}

function sqlValue(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 23).replace('T', ' ');
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    Buffer.isBuffer(value)
  )
    return value;
  throw new Error('备份遇到无法序列化的字段，已中止迁移。');
}

async function backupTables(db: Connection, tables: string[], directory: string) {
  const output = await open(path.join(directory, 'database.sql'), 'wx', 0o600);
  const counts: Record<string, number> = {};
  try {
    await query(db, 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
    await output.write(
      '-- STREE pre-migration backup; restore into an empty database.\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n',
    );
    for (const table of tables) {
      const quoted = mysql.escapeId(table);
      const [definition] = await query(db, `SHOW CREATE TABLE ${quoted}`);
      await output.write(`${definition[0]!['Create Table']};\n`);
      let lastId: string | number | null = null;
      let count = 0;
      // All recognized tables have an id primary key. Batches bound memory consumption.
      while (true) {
        const [rows] = await query(
          db,
          `SELECT * FROM ${quoted} ${lastId === null ? '' : 'WHERE id > ?'} ORDER BY id LIMIT 100`,
          lastId === null ? [] : [lastId],
        );
        if (!rows.length) break;
        if (table === 'stree_trips')
          for (const row of rows) TripSchema.parse(parseJson(row.payload));
        const columns = Object.keys(rows[0]!);
        const names = columns.map((column) => mysql.escapeId(column)).join(',');
        const values = rows
          .map(
            (row) => `(${columns.map((column) => mysql.escape(sqlValue(row[column]))).join(',')})`,
          )
          .join(',\n');
        await output.write(`INSERT INTO ${quoted} (${names}) VALUES\n${values};\n`);
        lastId = rows.at(-1)!.id;
        count += rows.length;
      }
      counts[table] = count;
    }
    await output.write('SET FOREIGN_KEY_CHECKS=1;\n');
    await output.sync();
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await output.close();
  }
  return counts;
}

async function upgradeTrips(db: Connection) {
  await query(db, createTripsSql);
  const [columns] = await query(db, 'SHOW COLUMNS FROM stree_trips');
  const fields = new Set(columns.map((row) => row.Field));
  for (const [name, type] of [
    ['city', 'JSON'],
    ['days', 'TINYINT UNSIGNED'],
    ['summary', 'TEXT'],
  ])
    if (!fields.has(name))
      await query(db, `ALTER TABLE stree_trips ADD COLUMN ${mysql.escapeId(name!)} ${type} NULL`);
  await query(
    db,
    `UPDATE stree_trips SET
    city=JSON_EXTRACT(payload, '$.city'),
    days=JSON_EXTRACT(payload, '$.request.days'),
    summary=JSON_UNQUOTE(JSON_EXTRACT(payload, '$.summary'))
    WHERE city IS NULL OR days IS NULL OR summary IS NULL`,
  );
  if (fields.has('city_code')) {
    // Only this obsolete field is removed; the city code is retained in city and payload.
    await query(
      db,
      `ALTER TABLE stree_trips DROP COLUMN city_code,
      MODIFY city JSON NOT NULL, MODIFY days TINYINT UNSIGNED NOT NULL,
      MODIFY summary TEXT NOT NULL, MODIFY created_at DATETIME(3) NOT NULL,
      MODIFY updated_at DATETIME(3) NOT NULL`,
    );
  } else if (
    ['city', 'days', 'summary'].some(
      (field) =>
        !fields.has(field) ||
        columns.some((column) => column.Field === field && column.Null === 'YES'),
    )
  ) {
    await query(
      db,
      `ALTER TABLE stree_trips MODIFY city JSON NOT NULL,
      MODIFY days TINYINT UNSIGNED NOT NULL, MODIFY summary TEXT NOT NULL`,
    );
  }
  const [indexes] = await query(db, 'SHOW INDEX FROM stree_trips');
  if (!indexes.some((row) => row.Key_name === 'stree_trips_recent_idx'))
    await query(db, 'CREATE INDEX stree_trips_recent_idx ON stree_trips (updated_at, id)');
}

export async function migrateDatabase() {
  // Validate all local files before opening a connection or changing a schema.
  const trips = await localTrips();
  const db = await mysql.createConnection(mysqlOptions);
  let locked = false;
  try {
    const lockName = `stree-migrate:${config.MYSQL_DATABASE}`;
    const [lock] = await query(db, 'SELECT GET_LOCK(?, 0) acquired', [lockName]);
    if (lock[0]?.acquired !== 1) throw new Error('已有数据库迁移正在运行。');
    locked = true;
    const [tables] = await query(db, 'SHOW TABLES');
    const existing = new Set(tables.map((row) => String(Object.values(row)[0])));
    const recognized = ['stree_trips', 'stree_ai_runs', 'stree_ai_calls', 'stree_ai_events', ...legacyTables].filter((table) => existing.has(table));
    const backup = path.join(
      runtimeRoot,
      'backups',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`,
    );
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const counts = await backupTables(db, recognized, backup);
    await writeFile(path.join(backup, 'local-trips.json'), JSON.stringify(trips), { mode: 0o600 });
    await writeFile(
      path.join(backup, 'manifest.json'),
      JSON.stringify(
        { database: config.MYSQL_DATABASE, counts, localTrips: trips.length },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await upgradeTrips(db);
    for (const sql of createAiTablesSql) await query(db, sql);
    const store = new MysqlTripStore(db);
    const matches = async (trip: Trip) => {
      // Compare using MySQL's JSON representation, including its numeric normalization.
      const [rows] = await query(
        db,
        'SELECT payload = CAST(? AS JSON) AS identical FROM stree_trips WHERE id = ?',
        [JSON.stringify(trip), trip.id],
      );
      return rows[0]?.identical === 1;
    };
    await db.beginTransaction();
    let imported = 0;
    try {
      for (const trip of trips) {
        const previous = await store.get(trip.id);
        // Repeat runs must not overwrite a newer database copy with an old local file.
        if (previous && +new Date(previous.updatedAt) > +new Date(trip.updatedAt)) continue;
        const identical = previous ? await matches(trip) : false;
        if (previous && +new Date(previous.updatedAt) === +new Date(trip.updatedAt) && !identical)
          throw new Error(`行程 ${trip.id} 时间相同但内容冲突，已中止导入。`);
        if (!identical) await store.save(trip);
        if (!(await matches(trip))) throw new Error(`行程 ${trip.id} 导入校验失败。`);
        imported++;
      }
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    }
    // Only after both backups and import verification succeed, remove retired tables.
    const removed: string[] = [];
    for (const table of legacyTables.filter((table) => existing.has(table))) {
      await query(db, `DROP TABLE ${mysql.escapeId(table)}`);
      removed.push(table);
    }
    const [plan] = await query(db, `EXPLAIN ${historySql}`);
    return { imported, skippedNewer: trips.length - imported, removed, backup, historyPlan: plan };
  } finally {
    if (locked)
      await query(db, 'SELECT RELEASE_LOCK(?)', [`stree-migrate:${config.MYSQL_DATABASE}`]).catch(
        () => undefined,
      );
    await db.end();
  }
}
