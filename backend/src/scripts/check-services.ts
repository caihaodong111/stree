import { AmapService } from '../services/amap.js';
import { createStore } from '../db/store.js';
import { ModelService } from '../models/service.js';
import { PublicWebSearch } from '../services/web-search.js';
const amap = new AmapService();
const store = createStore();
try {
  const modelStatus = await new ModelService().status();
  const storageAvailable = await store.check();
  console.log(
    JSON.stringify(
      {
        ...modelStatus,
        amap: { configured: amap.configured },
        storage: { driver: store.driver, available: storageAvailable },
        webSearch: new PublicWebSearch().status(),
      },
      null,
      2,
    ),
  );
  if (amap.configured)
    console.log('高德行政区查询：', (await amap.district('330000'))[0]?.name ?? '未返回结果');
  if (!modelStatus.model.configured || !storageAvailable) process.exitCode = 1;
} catch {
  console.error('外部服务检查失败，请检查网络和配置。');
  process.exitCode = 1;
} finally {
  await store.close();
}
