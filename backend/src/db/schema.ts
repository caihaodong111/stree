import { mysqlTable, varchar, json, datetime } from 'drizzle-orm/mysql-core';
import type { Trip } from '@stree/shared';
export const tripsTable = mysqlTable('stree_trips', {
  id: varchar('id', { length: 36 }).primaryKey(),
  cityCode: varchar('city_code', { length: 6 }).notNull(),
  title: varchar('title', { length: 128 }).notNull(),
  payload: json('payload').$type<Trip>().notNull(),
  createdAt: datetime('created_at').notNull(),
  updatedAt: datetime('updated_at').notNull(),
});
