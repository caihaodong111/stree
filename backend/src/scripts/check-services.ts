import { CodexClient } from '../codex/client.js';
import { AmapService } from '../services/amap.js';
import { createStore } from '../db/store.js';
const codex = new CodexClient();
const amap = new AmapService();
const store = createStore();
try {
  const codexStatus = await codex.status();
  console.log(
    JSON.stringify(
      {
        codex: codexStatus,
        amap: { configured: amap.configured },
        storage: { driver: store.driver, available: await store.check() },
      },
      null,
      2,
    ),
  );
  if (amap.configured)
    console.log('高德行政区查询：', (await amap.district('330000'))[0]?.name ?? '未返回结果');
  if (!codexStatus.authenticated) process.exitCode = 1;
} catch {
  console.error('外部服务检查失败，请检查网络和配置。');
  process.exitCode = 1;
} finally {
  await codex.close();
  await store.close();
}
