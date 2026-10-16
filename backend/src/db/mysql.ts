import mysql from 'mysql2/promise';
import { config } from '../config.js';

export const mysqlOptions = {
  host: config.MYSQL_HOST,
  port: config.MYSQL_PORT,
  user: config.MYSQL_USER,
  password: config.MYSQL_PASSWORD,
  database: config.MYSQL_DATABASE,
  charset: 'utf8mb4',
  timezone: 'Z',
  compress: config.MYSQL_COMPRESS,
  connectTimeout: config.MYSQL_CONNECT_TIMEOUT_MS,
};

export function createMysqlPool() {
  return mysql.createPool({
    ...mysqlOptions,
    connectionLimit: config.MYSQL_CONNECTION_LIMIT,
    maxIdle: Math.min(5, config.MYSQL_CONNECTION_LIMIT),
    idleTimeout: 60000,
    enableKeepAlive: true,
    // Reject excess work instead of building an unbounded, slow request queue.
    waitForConnections: false,
  });
}

export const historySql = `SELECT id, city, title, days, summary, created_at
  FROM stree_trips ORDER BY updated_at DESC, id DESC LIMIT 30`;

export const createTripsSql = `CREATE TABLE IF NOT EXISTS stree_trips (
  id VARCHAR(36) PRIMARY KEY,
  title VARCHAR(128) NOT NULL,
  city JSON NOT NULL,
  days TINYINT UNSIGNED NOT NULL,
  summary TEXT NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX stree_trips_recent_idx (updated_at, id)
) ENGINE=InnoDB CHARACTER SET utf8mb4`;

export function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
