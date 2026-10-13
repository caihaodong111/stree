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
  AMAP_WEB_SERVICE_KEY: z.string().default(''),
  AMAP_REQUEST_INTERVAL_MS: z.coerce.number().min(0).default(400),
  CODEX_BIN: z.string().default('codex'),
  CODEX_MODEL: z.string().default(''),
  CODEX_TIMEOUT_MS: z.coerce.number().min(1000).default(480000),
  STORAGE_DRIVER: z.enum(['mysql', 'file']).default('mysql'),
  MYSQL_HOST: z.string().default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().default(3306),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().default('stree'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
});
export const config = EnvSchema.parse(process.env);
export const runtimeRoot = path.join(backendRoot, '.runtime');
