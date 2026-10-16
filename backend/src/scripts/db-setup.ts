import { MysqlTripStore } from '../db/store.js';
import { MysqlAiStore } from '../db/ai-store.js';
const store = new MysqlTripStore();
const audit = new MysqlAiStore();
try {
  await store.setup();
  await audit.setup();
  console.log('行程表与三张 AI 记录表已就绪。');
} catch {
  console.error('数据库初始化失败，请检查 MySQL 连接；已有旧表结构请执行 npm run db:migrate。');
  process.exitCode = 1;
} finally {
  await store.close();
  await audit.close();
}
