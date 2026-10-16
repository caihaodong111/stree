import {
  mysqlTable,
  varchar,
  json,
  datetime,
  tinyint,
  text,
  index,
  bigint,
  int,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import type { Trip, Region } from '@stree/shared';
import type { AiRun, AiCall } from './ai-store.js';
export const tripsTable = mysqlTable(
  'stree_trips',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    title: varchar('title', { length: 128 }).notNull(),
    city: json('city').$type<Region>().notNull(),
    days: tinyint('days', { unsigned: true }).notNull(),
    summary: text('summary').notNull(),
    payload: json('payload').$type<Trip>().notNull(),
    createdAt: datetime('created_at', { fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { fsp: 3 }).notNull(),
  },
  (table) => [index('stree_trips_recent_idx').on(table.updatedAt, table.id)],
);

export const aiRunsTable = mysqlTable(
  'stree_ai_runs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    previousTripId: varchar('previous_trip_id', { length: 36 }),
    tripId: varchar('trip_id', { length: 36 }),
    status: varchar('status', { length: 16 }).$type<AiRun['status']>().notNull(),
    request: json('request').$type<AiRun['request']>().notNull(),
    output: json('output'),
    error: text('error'),
    createdAt: datetime('created_at', { fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { fsp: 3 }).notNull(),
  },
  (table) => [
    index('stree_ai_runs_recent_idx').on(table.createdAt, table.id),
    index('stree_ai_runs_trip_idx').on(table.tripId),
  ],
);

export const aiCallsTable = mysqlTable(
  'stree_ai_calls',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 })
      .notNull()
      .references(() => aiRunsTable.id),
    parentCallId: varchar('parent_call_id', { length: 36 }),
    kind: varchar('kind', { length: 16 }).$type<AiCall['kind']>().notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    provider: varchar('provider', { length: 128 }),
    model: varchar('model', { length: 200 }),
    protocol: varchar('protocol', { length: 64 }),
    status: varchar('status', { length: 16 }).$type<AiCall['status']>().notNull(),
    input: json('input').notNull(),
    output: json('output'),
    usage: json('token_usage'),
    error: text('error'),
    durationMs: bigint('duration_ms', { mode: 'number', unsigned: true }),
    createdAt: datetime('created_at', { fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { fsp: 3 }),
  },
  (table) => [index('stree_ai_calls_run_idx').on(table.runId, table.createdAt, table.id)],
);

export const aiEventsTable = mysqlTable(
  'stree_ai_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 })
      .notNull()
      .references(() => aiRunsTable.id),
    sequence: int('sequence', { unsigned: true }).notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    payload: json('payload').notNull(),
    createdAt: datetime('created_at', { fsp: 3 }).notNull(),
  },
  (table) => [uniqueIndex('stree_ai_events_sequence_idx').on(table.runId, table.sequence)],
);
