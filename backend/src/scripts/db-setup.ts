import { MysqlTripStore } from '../db/store.js';
const store = new MysqlTripStore();
try {
  await store.setup();
  console.log('stree_trips 表已就绪。');
} catch {
  console.error('数据库初始化失败，请检查 backend/.env 的 MySQL 配置及数据库是否存在。');
  process.exitCode = 1;
} finally {
  await store.close();
}
