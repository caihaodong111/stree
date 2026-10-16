import { config as dotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

export const backendRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
export const projectRoot = path.resolve(backendRoot, '..');
dotenv({ path: path.join(backendRoot, '.env'), quiet: true });
const EnvSchema = z.object({
  APP_HOST: z.string().default('127.0.0.1'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  MODEL_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(50).default(8),
  MODEL_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(200).default(32),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(3600000).default(600000),
  MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(600000).default(240000),
  SETTINGS_ENABLED: z
    .enum(['true', 'false'])
    .default(process.env.NODE_ENV === 'production' ? 'false' : 'true')
    .transform((value) => value === 'true'),
  AMAP_WEB_SERVICE_KEY: z.string().default(''),
  AMAP_REQUEST_INTERVAL_MS: z.coerce.number().min(0).default(400),
  WEB_SEARCH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  WEB_SEARCH_ENDPOINT: z.string().url().default('https://www.bing.com/search'),
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(100).max(300000).default(30000),
  CODEX_BIN: z.string().default('codex'),
  CODEX_MODEL: z.string().default(''),
  STORAGE_DRIVER: z.enum(['mysql', 'file']).default('file'),
  MYSQL_HOST: z.string().default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().default('stree'),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  MYSQL_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(10000),
  MYSQL_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  MYSQL_COMPRESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
});
export const config = EnvSchema.parse(process.env);
export const runtimeRoot = path.join(backendRoot, '.runtime');
