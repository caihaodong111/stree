import { test, expect, type Page } from '@playwright/test';
import { provinces } from '../../backend/src/services/regions.js';
import { city } from '../fixtures/travel.js';

const shanghai = { ...city, name: '上海市', adcode: '310000' };
const chengdu = { ...city, name: '成都市', adcode: '510100' };
const ningbo = { ...city, name: '宁波市', adcode: '330200' };
const located = (localCity = shanghai) => ({
  province: provinces.find((item) => item.adcode === `${localCity.adcode.slice(0, 2)}0000`)!,
  city: localCity,
});
async function prepare(
  page: Page,
  resolveLocation: () => Promise<unknown> = async () => located(),
  resolveNetworkLocation: () => Promise<unknown> = async () => located(),
) {
  let locationRequests = 0;
  let networkRequests = 0;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (pathname === '/api/regions/provinces') return json({ regions: provinces });
    if (pathname === '/api/regions/cities') {
      const provinceCode = new URL(route.request().url()).searchParams.get('provinceCode');
      return json({
        regions:
          provinceCode === '310000'
            ? [shanghai]
            : provinceCode === '510000'
              ? [chengdu]
              : [ningbo, city],
      });
    }
    if (pathname === '/api/regions/locate') {
      locationRequests += 1;
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ longitude: 121.455, latitude: 31.249 });
      const response = await resolveLocation();
      return json(response, (response as { error?: string }).error ? 502 : 200);
    }
    if (pathname === '/api/regions/locate-city') {
      networkRequests += 1;
      expect(route.request().postDataJSON()).toEqual({ adcode: '310106' });
      const response = await resolveNetworkLocation();
      return json(response, (response as { error?: string }).error ? 502 : 200);
    }
    if (pathname === '/api/status')
      return json({
        codex: { available: false, authenticated: false, model: null },
        amap: { configured: true },
        storage: { driver: 'file', available: true },
        version: '2.0.0',
      });
    if (pathname === '/api/trips') return json({ trips: [] });
    return json({ error: 'Unexpected test endpoint' }, 404);
  });
  await page.goto('/#planner');
  await expect(page.getByLabel('目的地城市')).not.toBeDisabled();
  return { locationRequests: () => locationRequests, networkRequests: () => networkRequests };
}

test('已授权时自动选中所在省市并排在首位，仍可切换其他目的地', async ({ page, context }, info) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  const requests = await prepare(page);
  await expect(page.getByLabel('省份或直辖市')).toHaveValue('310000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('310000');
  await expect(page.getByLabel('省份或直辖市').locator('option').first()).toHaveText('上海市');
  await expect(page.getByLabel('目的地城市').locator('option').first()).toHaveText('上海市');
  await expect(page.locator('.location-strip')).toHaveCount(0);
  expect(requests.locationRequests()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/location-${info.project.name}.png`, fullPage: true });
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  await expect(page.getByLabel('省份或直辖市').locator('option')).toHaveCount(34);
});

test('首次进入时自动请求定位，同省城市也优先展示', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'permissions', {
      value: { query: async () => ({ state: 'prompt' }) },
    });
  });
  const requests = await prepare(page, async () => located(city));
  await expect.poll(requests.locationRequests).toBe(1);
  await expect(page.getByRole('button', { name: /使用当前位置|重新定位/ })).toHaveCount(0);

  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('省份或直辖市')).toHaveValue('330000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('330100');
  await expect(page.getByLabel('目的地城市').locator('option').first()).toHaveText('杭州市');
  await page.getByLabel('目的地城市').selectOption('330200');
  await expect(page.getByLabel('目的地城市')).toHaveValue('330200');
});

for (const scenario of [
  { code: 1, text: '定位权限未开启' },
  { code: 3, text: '定位超时' },
  { code: 2, text: '暂时无法获取位置' },
]) {
  test(`${scenario.text}时可继续手动选择城市`, async ({ page }) => {
    await page.addInitScript((code) => {
      (window as any).AMap = {
        plugin: (_plugins: string[], callback: () => void) => callback(),
        Geolocation: class {
          getCityInfo(callback: (status: string, result: unknown) => void) {
            callback('error', {});
          }
        },
      };
      Object.defineProperty(navigator, 'permissions', {
        value: { query: async () => ({ state: 'prompt' }) },
      });
      Object.defineProperty(navigator, 'geolocation', {
        value: {
          getCurrentPosition: (_success: unknown, error: (err: { code: number }) => void) =>
            error({ code }),
        },
      });
    }, scenario.code);
    const requests = await prepare(page);

    await expect(page.locator('.location-strip')).toHaveCount(0);
    expect(requests.locationRequests()).toBe(0);
    expect(requests.networkRequests()).toBe(0);
    await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
    await page.getByLabel('省份或直辖市').selectOption('510000');
    await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  });
}

test('定位结果晚到不会覆盖用户手动选择', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = await prepare(page, async () => {
    await pending;
    return located();
  });
  await expect.poll(requests.locationRequests).toBe(1);
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  release();
  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('省份或直辖市')).toHaveValue('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  await expect(page.getByLabel('省份或直辖市').locator('option').first()).toHaveText('上海市');
});

async function simulateDeviceFailure(page: Page, code = 3, adcode = '310106') {
  await page.addInitScript(
    ({ code, adcode }) => {
      Object.defineProperty(navigator, 'permissions', {
        value: { query: async () => ({ state: 'prompt' }) },
      });
      Object.defineProperty(navigator, 'geolocation', {
        value: {
          getCurrentPosition: (_success: unknown, error: (err: { code: number }) => void) =>
            error({ code }),
        },
      });
      (window as any).networkLookups = 0;
      (window as any).AMap = {
        plugin: (_plugins: string[], callback: () => void) => callback(),
        Geolocation: class {
          getCityInfo(callback: (status: string, result: unknown) => void) {
            (window as any).networkLookups += 1;
            callback('complete', { adcode });
          }
        },
      };
    },
    { code, adcode },
  );
}

test('设备定位超时后使用访客网络城市，优先选择且不显示来源描述', async ({ page }, info) => {
  await simulateDeviceFailure(page);
  const requests = await prepare(page);

  await expect(page.getByLabel('目的地城市')).toHaveValue('310000');
  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('省份或直辖市').locator('option').first()).toHaveText('上海市');
  await expect(page.getByLabel('目的地城市').locator('option').first()).toHaveText('上海市');
  expect(requests.locationRequests()).toBe(0);
  expect(requests.networkRequests()).toBe(1);
  await page.screenshot({
    path: `test-results/location-fallback-${info.project.name}.png`,
    fullPage: true,
  });
});

test('用户拒绝定位时不会启动网络定位', async ({ page }) => {
  await simulateDeviceFailure(page, 1);
  const requests = await prepare(page);

  await expect(page.locator('.location-strip')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).networkLookups)).toBe(0);
  expect(requests.networkRequests()).toBe(0);
});

test('备用网络定位晚到也不会覆盖手动目的地', async ({ page }) => {
  await simulateDeviceFailure(page, 2);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = await prepare(
    page,
    async () => located(),
    async () => {
      await pending;
      return located();
    },
  );

  await expect.poll(requests.networkRequests).toBe(1);
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  release();
  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
});

test('网络返回无效城市时不会将其当成真实所在地', async ({ page }) => {
  await simulateDeviceFailure(page, 3, '');
  const requests = await prepare(page);

  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('目的地城市')).toHaveValue('330100');
  expect(requests.networkRequests()).toBe(0);
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
});

test('省市识别服务失败时保留原选择并允许重试', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  let calls = 0;
  await prepare(page, async () =>
    ++calls === 1 ? { error: '高德服务连接超时，请稍后重试。' } : located(),
  );
  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('目的地城市')).toHaveValue('330100');
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
  await reenterTab(page);
  await expect(page.getByLabel('目的地城市')).toHaveValue('310000');
});

async function reenterTab(page: Page) {
  await page.evaluate(() => {
    let visible = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (visible ? 'visible' : 'hidden'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test('返回标签页自动更新定位但保留手动目的地', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  const requests = await prepare(page);
  await expect(page.getByLabel('目的地城市')).toHaveValue('310000');
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  await reenterTab(page);
  await expect.poll(requests.locationRequests).toBe(2);
  await expect(page.locator('.location-strip')).toHaveCount(0);
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
});

test('定位尚未结束时返回标签页不会重复启动请求', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests = await prepare(page, async () => {
    await pending;
    return located();
  });
  await expect.poll(requests.locationRequests).toBe(1);
  await reenterTab(page);
  await reenterTab(page);
  release();
  await expect(page.getByLabel('目的地城市')).toHaveValue('310000');
  expect(requests.locationRequests()).toBe(1);
});

test('没有 Permissions API 时仍会在进入网页后自动定位', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ longitude: 121.455, latitude: 31.249 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'permissions', { value: undefined }),
  );
  await prepare(page);
  await expect(page.getByLabel('目的地城市')).toHaveValue('310000');
  await expect(page.getByRole('button', { name: /使用当前位置|重新定位/ })).toHaveCount(0);
});
