import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config, runtimeRoot } from '../config.js';

export const aiDiagnosticsDirectory = path.join(runtimeRoot, 'diagnostics', 'ai-storage');

/** Log failure metadata only: never driver SQL, parameter contents, or connection options. */
export async function recordStorageFailure(
  error: unknown,
  sql: string,
  values: unknown[],
  phase: string,
  elapsedMs: number,
  directory = aiDiagnosticsDirectory,
) {
  const detail = (error ?? {}) as Record<string, unknown>;
  const safeCode = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(value) ? value : undefined;
  let message =
    typeof detail.sqlMessage === 'string'
      ? detail.sqlMessage
      : typeof detail.message === 'string'
        ? detail.message
        : '';
  for (const value of [config.MYSQL_PASSWORD, config.AMAP_WEB_SERVICE_KEY, ...values]) {
    if (typeof value === 'string' && value.length >= 4)
      message = message.split(value).join('[redacted]');
  }
  message = message
    .replace(/'[^']*'|"[^"]*"/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 1000);
  const diagnostic = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    operation: sql.match(/^\s*(\w+)/)?.[1],
    table: sql.match(/(?:FROM|INTO|UPDATE|TABLE IF NOT EXISTS)\s+(stree_\w+)/i)?.[1],
    recordId: (/^\s*UPDATE/i.test(sql) ? [...values].reverse() : values).find(
      (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value),
    ),
    phase,
    elapsedMs,
    code: safeCode(detail.code) ?? 'UNKNOWN_DATABASE_ERROR',
    errno: typeof detail.errno === 'number' ? detail.errno : undefined,
    sqlState: safeCode(detail.sqlState),
    fatal: typeof detail.fatal === 'boolean' ? detail.fatal : undefined,
    message,
    parameterBytes: values.map((value) =>
      value == null
        ? 0
        : Buffer.byteLength(value instanceof Date ? value.toISOString() : String(value)),
    ),
  };
  // Logging must not replace the original database failure if the local disk is unavailable.
  await mkdir(directory, { recursive: true, mode: 0o700 })
    .then(() =>
      appendFile(path.join(directory, 'errors.jsonl'), `${JSON.stringify(diagnostic)}\n`, {
        mode: 0o600,
      }),
    )
    .catch(() => undefined);
  return diagnostic;
}
