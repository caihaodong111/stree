import { migrateDatabase } from '../db/migrate.js';
try {
  console.log(JSON.stringify(await migrateDatabase(), null, 2));
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(
    '数据库迁移未完成：',
    code || (error instanceof Error ? error.message : '未知错误'),
  );
  process.exitCode = 1;
}
