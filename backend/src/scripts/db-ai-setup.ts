import { MysqlAiStore } from '../db/ai-store.js';
const store = new MysqlAiStore();
try {
  await store.setup();
  console.log('stree_ai_runs、stree_ai_calls、stree_ai_events 已就绪。现有行程和记录保留。');
} catch {
  console.error('AI 记录表初始化失败，请检查数据库连接和建表权限。');
  process.exitCode = 1;
} finally {
  await store.close();
}
