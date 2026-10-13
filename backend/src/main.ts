import { createApp } from './app.js';
import { config } from './config.js';
const app = await createApp();
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
try {
  await app.listen({ host: config.APP_HOST, port: config.APP_PORT });
} catch {
  app.log.error('无法启动服务，请检查端口是否已被使用。');
  await app.close();
  process.exit(1);
}
