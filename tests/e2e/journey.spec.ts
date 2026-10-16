import { test, expect, type Page } from '@playwright/test';
import { tripFixture, city, province, poi } from '../fixtures/travel.js';
import { provinces } from '../../backend/src/services/regions.js';
import { readFile } from 'node:fs/promises';
async function prepare(page: Page, mode: 'result' | 'pending' | 'error' = 'result') {
  const trip = tripFixture();
  trip.routes.push({
    ...structuredClone(trip.routes[0]!),
    id: 'culture',
    title: '城市文化慢游',
    label: '文化体验',
  });
  const input: any[] = [];
  const suggestions = [
    { ...poi('station', '杭州站'), address: '江城路1号' },
    { ...poi('station-north', '杭州站'), address: '北进站口' },
    poi('lake', '西湖'),
    poi('museum', '博物馆'),
  ];
  let settings: { model: string | null; effort: string | null; providerId?: string } = {
    providerId: 'test-vendor',
    model: 'test',
    effort: null,
  };
  let providers: any[] = [
    {
      id: 'test-vendor',
      name: '测试提供方',
      baseURL: 'https://vendor.example/v1',
      protocol: 'openai-completions',
      keyConfigured: true,
      jsonMode: false,
      models: [
        { id: 'test', name: '默认测试模型' },
        { id: 'deep', name: '深度规划模型' },
      ],
    },
  ];
  await page.addInitScript(() => {
    class FakeMap {
      el: HTMLElement;
      constructor(el: HTMLElement) {
        this.el = el;
      }
      addControl() {}
      panTo() {}
      setFitView() {}
      add(items: any[]) {
        this.el.dataset.paths = String(items.filter((item) => item.path).length);
        items.forEach((item) => {
          if (item.content) {
            // Place mock markers inside the visible map area, beside the floating route panel.
            const index = this.el.querySelectorAll('[data-fake-marker]').length;
            item.content.dataset.fakeMarker = 'true';
            item.content.style.position = 'absolute';
            item.content.style.left = `${window.innerWidth > 700 ? 400 : 30}px`;
            item.content.style.top = `${55 + index * 38}px`;
            this.el.appendChild(item.content);
          }
        });
      }
      destroy() {
        this.el.replaceChildren();
      }
      remove() {
        this.el.replaceChildren();
      }
    }
    class Marker {
      content?: HTMLElement;
      position: any;
      constructor(options: any) {
        this.content = options.content;
        this.position = options.position;
      }
      on(_event: string, fn: () => void) {
        this.content?.addEventListener('click', fn);
      }
      getPosition() {
        return this.position;
      }
    }
    (window as any).AMap = {
      Map: FakeMap,
      Marker,
      Pixel: class {},
      Scale: class {},
      ToolBar: class {},
      Polyline: class {
        path: any;
        constructor(options: any) {
          this.path = options.path;
        }
      },
      plugin: (_plugins: any, callback: () => void) => callback(),
    };
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname.replace('/api', '');
    const json = (body: any, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/settings/providers/discover')
      return json({
        models: [
          { id: 'vendor-fast', name: '快速模型' },
          { id: 'vendor-deep', name: '深入模型' },
        ],
      });
    if (pathname === '/settings/providers' || pathname.startsWith('/settings/providers/')) {
      if (route.request().method() === 'DELETE')
        providers = providers.filter((item) => item.id !== pathname.split('/').at(-1));
      else {
        const { apiKey, clearApiKey, ...input } = route.request().postDataJSON();
        const previous = providers.find((item) => item.id === input.id);
        providers = [
          ...providers.filter((item) => item.id !== input.id),
          {
            ...input,
            keyConfigured: clearApiKey ? false : Boolean(apiKey || previous?.keyConfigured),
          },
        ];
      }
      return json({ providers });
    }
    if (pathname === '/settings/model') {
      if (route.request().method() === 'PUT') settings = route.request().postDataJSON();
      return json({
        settings,
        providers,
        defaultModel: 'test',
        effectiveModel: settings.model || 'test',
        models: [
          {
            model: 'test',
            displayName: '默认测试模型',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
          },
          {
            model: 'deep',
            displayName: '深度规划模型',
            isDefault: false,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [
              { reasoningEffort: 'high', description: '' },
              { reasoningEffort: 'xhigh', description: '' },
            ],
          },
        ],
      });
    }
    if (pathname === '/status')
      return json({
        codex: { available: false, authenticated: false, model: null },
        model: { configured: true, provider: '测试提供方', model: settings.model },
        amap: { configured: true },
        storage: { available: true, driver: 'file' },
        version: '2.0.0',
      });
    if (pathname === '/regions/provinces') return json({ regions: provinces });
    if (pathname === '/places/popular') return json({ places: suggestions.slice(2) });
    if (pathname === '/places/suggest') {
      const keyword = url.searchParams.get('keyword') ?? '';
      return json({ places: suggestions.filter((place) => place.name.includes(keyword)) });
    }
    if (pathname === '/regions/cities') {
      const code = url.searchParams.get('provinceCode');
      if (code === '710000')
        return json({ error: '高德暂未提供该省份的城市目录，请选择其他目的地。' }, 422);
      return json({
        regions:
          code === '510000'
            ? [{ ...city, name: '成都市', adcode: '510100' }]
            : code === '310000'
              ? [{ ...city, name: '上海市', adcode: '310000' }]
              : [city],
      });
    }
    if (pathname === '/plans') {
      input.push(route.request().postDataJSON());
      return json({ jobId: trip.id }, 202);
    }
    const progress = {
      type: 'progress',
      stage: 'planning',
      message: '正在设计真实路线',
      timestamp: '2026-10-13T00:00:00Z',
    };
    if (pathname.endsWith('/events'))
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify(progress)}\n\n${mode === 'pending' ? '' : `data: ${JSON.stringify(mode === 'error' ? { type: 'error', message: '当前目的地没有可用交通路线' } : { type: 'result', trip })}\n\n`}`,
      });
    if (pathname.endsWith('/cancel')) return json({ ok: true });
    if (pathname.startsWith('/jobs/')) return json({ status: 'running', events: [progress] });
    if (pathname === '/trips' || pathname === '/history')
      return json({
        tasks: [],
        trips: [
          {
            id: trip.id,
            city,
            createdAt: trip.createdAt,
            summary: trip.summary,
            title: trip.routes[0]!.title,
            days: 2,
          },
        ],
      });
    if (pathname === `/trips/${trip.id}`) return json(trip);
    return json({ error: 'unknown test endpoint' }, 404);
  });
  await page.goto('/');
  await expect(page.getByLabel('目的地城市')).toHaveValue('330100');
  await expect(page.locator('.opening-screen')).toHaveCount(0);
  return { trip, input };
}
test('按省市选目的地并清晰处理高德目录缺失', async ({ page }) => {
  await prepare(page);
  await expect(page.getByLabel('省份或直辖市').locator('option')).toHaveCount(34);
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  await page.getByLabel('省份或直辖市').selectOption('710000');
  await expect(page.getByRole('alert')).toContainText('暂未提供');
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeDisabled();
});
test('空白点击立即显示预加载热门景点，支持连续多选、重新展开和缓存', async ({ page }, info) => {
  const popularRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/places/popular?')) popularRequests.push(request.url());
  });
  await prepare(page);
  await expect.poll(() => popularRequests.length).toBe(1);
  const mustVisit = page.getByRole('combobox', { name: '必去地点', exact: true });
  await mustVisit.click();
  await expect(mustVisit).toHaveAttribute('aria-expanded', 'true', { timeout: 250 });
  await expect(page.getByRole('option', { name: /^西湖 / })).toBeVisible({ timeout: 250 });
  await page.screenshot({
    path: `test-results/popular-places-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('option', { name: /^西湖 / }).click();
  await expect(page.locator('.place-chip')).toHaveCount(1);
  await expect(page.getByRole('option', { name: /^西湖 / })).toHaveCount(0);
  await mustVisit.press('ArrowDown');
  await mustVisit.press('Enter');
  await expect(page.locator('.place-chip')).toHaveCount(2);
  await mustVisit.press('Escape');
  await expect(mustVisit).toHaveAttribute('aria-expanded', 'false');
  await mustVisit.click();
  await expect(mustVisit).toHaveAttribute('aria-expanded', 'true');
  expect(popularRequests).toHaveLength(1);
  await page.getByRole('button', { name: /移除西湖/ }).click();
  await mustVisit.click();
  await expect(page.getByRole('option', { name: /^西湖 / })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('热门景点切换城市不串结果，加载失败可重试，空结果可继续搜索', async ({ page }) => {
  await prepare(page);
  let attempts = 0;
  await page.route('**/api/places/popular?**', async (route) => {
    const cityCode = new URL(route.request().url()).searchParams.get('cityCode');
    if (cityCode === '510100') {
      attempts++;
      if (attempts === 1)
        return route.fulfill({ status: 502, json: { error: '景点服务暂时不可用' } });
      return route.fulfill({ json: { places: [] } });
    }
    return route.fulfill({ json: { places: [poi('bund', '外滩')] } });
  });
  await page.getByLabel('省份或直辖市').selectOption('510000');
  const mustVisit = page.getByRole('combobox', { name: '必去地点', exact: true });
  await mustVisit.click();
  await expect(page.getByRole('option', { name: /^西湖 / })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('景点服务暂时不可用');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('暂无推荐景点');
  await mustVisit.fill('博');
  await expect(page.getByRole('option', { name: /博物馆/ })).toBeVisible();
  await mustVisit.fill('');
  await page.getByLabel('省份或直辖市').selectOption('310000');
  await mustVisit.click();
  await expect(page.getByRole('option', { name: /外滩/ })).toBeVisible();
});
test('地点联想支持键盘选同名地址、多选去重、移除，并把准确 ID 提交给规划', async ({
  page,
}, info) => {
  const { input } = await prepare(page);
  const origin = page.getByRole('combobox', { name: '出发地点', exact: true });
  const mustVisit = page.getByRole('combobox', { name: '必去地点', exact: true });
  await origin.fill('杭州');
  await expect(page.getByRole('option', { name: /杭州站.*北进站口/ })).toBeVisible();
  await origin.press('ArrowDown');
  await origin.press('Enter');
  await expect(origin).toHaveValue('杭州站');
  await expect(page.locator('.place-confirmation')).toContainText('北进站口');
  await mustVisit.fill('西');
  await page.getByRole('option', { name: /西湖/ }).click();
  await expect(mustVisit).toHaveValue('');
  await mustVisit.fill('西');
  await expect(page.getByRole('status')).toContainText('已添加');
  await mustVisit.fill('博');
  await page.getByRole('option', { name: /博物馆/ }).click();
  await expect(page.locator('.place-chip')).toHaveCount(2);
  await page.getByRole('button', { name: /移除博物馆/ }).click();
  await expect(page.locator('.place-chip')).toHaveCount(1);
  await mustVisit.fill('公园，博');
  await page.getByRole('option', { name: /博物馆/ }).click();
  await expect(mustVisit).toHaveValue('公园，');
  await mustVisit.fill('公园，杭');
  await expect(page.getByRole('option', { name: /杭州站/ })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `test-results/place-autocomplete-${info.project.name}.png`,
    fullPage: true,
  });
  await mustVisit.press('Escape');
  await mustVisit.fill('公园');
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect.poll(() => input.length).toBe(1);
  expect(input[0]).toMatchObject({
    origin: '杭州站',
    originPoiId: 'station-north',
    mustVisit: ['西湖', '博物馆', '公园'],
    mustVisitPlaces: [
      { id: 'lake', name: '西湖' },
      { id: 'museum', name: '博物馆' },
    ],
  });
});

test('改写出发地点后清除旧 ID，切换城市后保留出发地并清空必去地点', async ({ page }) => {
  const { input } = await prepare(page);
  await page.getByLabel('出发地点', { exact: true }).fill('杭州');
  await page.getByRole('option', { name: /杭州站.*江城路1号/ }).click();
  await page.getByLabel('必去地点', { exact: true }).fill('西');
  await page.getByRole('option', { name: /西湖/ }).click();
  await page.getByLabel('出发地点', { exact: true }).fill('新酒店');
  await expect(page.locator('.place-confirmation')).toHaveCount(0);
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect.poll(() => input.length).toBe(1);
  expect(input[0].originPoiId).toBeNull();
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  await expect(page.getByLabel('出发地点', { exact: true })).toHaveValue('新酒店');
  await expect(page.getByLabel('必去地点', { exact: true })).toHaveValue('');
  await expect(page.locator('.place-chip')).toHaveCount(0);
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('出发地全国搜索，切换省市和目录缺失时仍保留并可编辑', async ({ page }) => {
  const { input } = await prepare(page);
  const queries: URL[] = [];
  await page.route('**/api/places/suggest?**', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    return route.fulfill({
      json: {
        places: [
          {
            ...poi('shanghai-station', '上海站'),
            adcode: '310106',
            district: '上海市静安区',
            address: '秣陵路303号',
            location: { longitude: 121.455, latitude: 31.249 },
          },
        ],
      },
    });
  });
  const origin = page.getByLabel('出发地点', { exact: true });
  await origin.fill('上海站');
  await page.getByRole('option', { name: /上海站.*静安区/ }).click();
  expect(queries[0]!.searchParams.has('cityCode')).toBe(false);
  await page.getByLabel('省份或直辖市').selectOption('510000');
  await expect(page.getByLabel('目的地城市')).toHaveValue('510100');
  await expect(origin).toHaveValue('上海站');
  await expect(page.locator('.place-confirmation')).toContainText('上海市静安区');
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect.poll(() => input.length).toBe(1);
  expect(input[0]).toMatchObject({
    cityCode: '510100',
    origin: '上海站',
    originPoiId: 'shanghai-station',
  });
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
  await page.getByLabel('省份或直辖市').selectOption('710000');
  await expect(page.getByRole('alert')).toContainText('暂未提供');
  await expect(origin).toBeEnabled();
  await expect(origin).toHaveValue('上海站');
  await origin.fill('北京站');
  await expect(page.getByRole('option', { name: /上海站/ })).toBeVisible();
  expect(queries.at(-1)!.searchParams.has('cityCode')).toBe(false);
});

test('地点查询失败可重试，无结果可继续编辑，旧响应不覆盖新关键词', async ({ page }) => {
  await prepare(page);
  let failed = false;
  let oldRequested = false;
  await page.route('**/api/places/suggest?**', async (route) => {
    const keyword = new URL(route.request().url()).searchParams.get('keyword');
    if (keyword === '失败' && !failed) {
      failed = true;
      return route.fulfill({ status: 502, json: { error: '高德暂时不可用' } });
    }
    if (keyword === '旧') {
      oldRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return route.fulfill({
      json: { places: keyword === '空' ? [] : [poi(keyword ?? '', `${keyword}地点`)] },
    });
  });
  const origin = page.getByLabel('出发地点', { exact: true });
  await origin.fill('失败');
  await expect(page.getByRole('status')).toContainText('高德暂时不可用');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('option', { name: /失败地点/ })).toBeVisible();
  await origin.fill('空');
  await expect(page.getByRole('status')).toContainText('未找到');
  await origin.fill('旧');
  await expect.poll(() => oldRequested).toBe(true);
  await origin.fill('新');
  await expect(page.getByRole('option', { name: /新地点/ })).toBeVisible();
  await origin.press('Enter');
  await expect(origin).toHaveValue('新地点');
  await expect(page.getByRole('listbox')).toHaveCount(0);
});
test('生成路线、查看逐站攻略、切换方案与天数、导出并修改行程', async ({ page }, info) => {
  const { trip, input } = await prepare(page);
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect(page.getByRole('heading', { name: '这座城，有了你的走法。' })).toBeVisible();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-paths', /^[1-9]\d*$/);
  await page.getByRole('button', { name: '测试西湖', exact: true }).click();
  await expect(page.locator('#stop-lake details')).toHaveAttribute('open', '');
  await expect(page.locator('#stop-lake .stop-guide')).toContainText('沿着湖边慢慢走');
  await page.locator('#stop-lake summary').click();
  await expect(page.locator('#stop-lake details')).not.toHaveAttribute('open', '');
  await page.getByRole('tab', { name: /DAY 02/ }).click();
  await expect(page.getByRole('heading', { name: '公园的一天', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /方案 02/ }).click();
  await expect(page.getByRole('tab', { name: /方案 02/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '路线攻略', exact: true }).click();
  await expect(page.getByRole('heading', { name: '出发前，先准备好' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出攻略' }).click();
  expect((await download).suggestedFilename()).toContain('STREE');
  await page.getByLabel('修改行程的要求').fill('第二天减少步行，多留一些休息时间');
  await page.getByRole('button', { name: '调整这份行程' }).click();
  await expect.poll(() => input.length).toBe(2);
  expect(input[1].previousTripId).toBe(trip.id);
  expect(input[1].message).toContain('减少步行');
  await expect(page.getByRole('heading', { name: '这座城，有了你的走法。' })).toBeVisible();
  await page.getByRole('button', { name: '我的行程', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '我的行程' })).toBeVisible();
  await page.locator('.history-item').first().click();
  await expect(page.getByRole('dialog', { name: '我的行程' })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `test-results/journey-${info.project.name}.png`, fullPage: true });
});
test('联网攻略来源可查看，链接安全打开，导出和历史读取保留来源', async ({ page }, info) => {
  const { trip } = await prepare(page);
  trip.research = {
    status: 'partial',
    sources: [
      {
        url: 'https://www.douyin.com/video/123',
        title: '西湖慢游攻略',
        snippet: '沿湖步行，按片区安排游览。',
        query: '杭州西湖攻略',
        retrievedAt: '2026-10-16T01:00:00Z',
      },
    ],
    warnings: ['部分攻略查询没有返回可用来源。'],
  };
  await page.getByRole('button', { name: '生成我的路线' }).click();
  const card = page.getByRole('region', { name: '联网攻略来源' });
  await expect(card).toBeVisible();
  await card.getByText('查看 1 条来源').click();
  const link = card.getByRole('link', { name: '西湖慢游攻略' });
  await expect(link).toHaveAttribute('href', trip.research.sources[0]!.url);
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(card).toContainText('不代表已阅读全文');
  await expect(card).toContainText('部分攻略查询');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出攻略' }).click();
  const file = await (await downloaded).path();
  expect(await readFile(file!, 'utf8')).toContain(
    '[西湖慢游攻略](<https://www.douyin.com/video/123>)',
  );
  await page.getByRole('button', { name: '我的行程', exact: true }).click();
  await page.locator('.history-item').first().click();
  await expect(card).toContainText('查看 1 条来源');
  if (!(await link.isVisible())) await card.getByText('查看 1 条来源').click();
  await card.screenshot({ path: `test-results/research-${info.project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('运行中可取消并重新开始', async ({ page }) => {
  const { input } = await prepare(page, 'pending');
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect(page.getByRole('button', { name: '取消规划' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('正在设计真实路线');
  await expect(page.locator('.progress-stages [aria-current="step"]')).toContainText('AI 规划');
  await expect(page.locator('.journey-elapsed')).toContainText('已等待');
  await expect(page.getByLabel('目的地城市')).toBeDisabled();
  await page.getByRole('button', { name: '取消规划' }).click();
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '取消规划' })).not.toBeVisible();
  expect(input).toHaveLength(1);
});
test('规划失败展示明确错误并允许重试', async ({ page }) => {
  await prepare(page, 'error');
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect(page.getByRole('alert')).toContainText('没有可用交通路线');
  await expect(page.getByRole('button', { name: '生成我的路线' })).toBeEnabled();
});

test('AI 行程可直接展示，导航查询失败不驳回路线，交通建议标明 AI 来源', async ({ page }) => {
  const { trip } = await prepare(page);
  const day = trip.routes[0]!.days[0]!;
  day.segments[0] = {
    ...day.segments[0]!,
    source: 'ai',
    polyline: [],
    origin: trip.origin,
    destination: day.stops[0]!.poi,
    summary: 'AI 建议乘车，耗时为估算',
  };
  await page.route('**/directions?**', (route) =>
    route.fulfill({ status: 422, json: { error: '地图暂未返回公共交通导航' } }),
  );
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect(page.getByRole('heading', { name: '这座城，有了你的走法。' })).toBeVisible();
  await expect(page.locator('.directions-query-error')).toContainText('地图暂未返回公共交通导航');
  await expect(page.getByText('AI 出行建议', { exact: true })).toBeVisible();
  await expect(page.getByText('AI 参考交通费', { exact: true })).toBeVisible();
  await expect(page.locator('#planner .error-banner')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出攻略' }).click();
  const exported = await readFile((await (await download).path())!, 'utf8');
  expect(exported).toContain('AI 选择理由');
  expect(exported).toContain('08:00');
});

test('我的行程显示生成中任务，刷新后能继续查看进度而不重复创建任务', async ({ page }, info) => {
  const { trip, input } = await prepare(page, 'pending');
  const createdAt = new Date(Date.now() - 90000).toISOString();
  const task = {
    id: trip.id,
    status: 'running',
    request: {
      ...trip.request,
      mustVisit: ['西湖'],
      mustVisitPlaces: [{ id: 'lake', name: '西湖' }],
      originPoiId: 'station',
    },
    tripId: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    cityName: '杭州市',
    progress: {
      type: 'progress',
      stage: 'planning',
      message: '正在设计真实路线',
      timestamp: createdAt,
    },
  };
  await page.route('**/api/history', (route) =>
    route.fulfill({
      json: {
        trips: [],
        tasks: [
          task,
          {
            ...task,
            id: 'failed-task',
            status: 'failed',
            error: '模型接口返回 HTTP 429：TPM limit reached.',
          },
        ],
      },
    }),
  );
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect.poll(() => input.length).toBe(1);
  await page.getByRole('button', { name: '我的行程', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '我的行程' });
  await expect(drawer.locator('.history-task').first()).toContainText('生成中');
  await expect(drawer).toContainText('正在设计真实路线');
  await drawer.getByRole('button', { name: /未完成/ }).click();
  await drawer.getByText('查看失败原因').click();
  await expect(drawer).toContainText('TPM limit reached');
  await drawer.getByRole('button', { name: /^全部/ }).click();
  await page.screenshot({ path: `test-results/task-history-${info.project.name}.png` });
  await page.reload();
  await page.getByRole('button', { name: '我的行程', exact: true }).click();
  await drawer.getByRole('button', { name: '查看进度' }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('button', { name: '取消规划' })).toBeVisible();
  await expect(page.locator('.journey-current')).toContainText('正在设计真实路线');
  await expect(page.locator('.journey-elapsed')).toContainText('1 分');
  await expect(page.locator('.place-chip')).toContainText('西湖');
  expect(input).toHaveLength(1);
  await page.getByRole('button', { name: '取消规划' }).click();
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect.poll(() => input.length).toBe(2);
  expect(input[1].mustVisitPlaces).toEqual([{ id: 'lake', name: '西湖' }]);
  expect(input[1].originPoiId).toBe('station');
});

test('我的行程自动更新任务状态，完成后只显示已保存路线', async ({ page }) => {
  const { trip } = await prepare(page);
  let complete = false;
  const createdAt = new Date().toISOString();
  await page.route('**/api/history', (route) =>
    route.fulfill({
      json: {
        tasks: [
          {
            id: trip.id,
            status: complete ? 'completed' : 'running',
            request: trip.request,
            tripId: complete ? trip.id : null,
            error: null,
            cityName: '杭州市',
            createdAt,
            updatedAt: createdAt,
            progress: null,
          },
        ],
        trips: complete
          ? [
              {
                id: trip.id,
                city: trip.city,
                days: 2,
                title: trip.routes[0]!.title,
                summary: trip.summary,
                createdAt,
              },
            ]
          : [],
      },
    }),
  );
  await page.getByRole('button', { name: '我的行程', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '我的行程' });
  await expect(drawer.locator('.history-task')).toHaveCount(1);
  complete = true;
  await expect(drawer.locator('.history-item')).toHaveCount(1, { timeout: 6000 });
  await expect(drawer.locator('.history-task')).toHaveCount(0);
  await drawer.getByRole('button', { name: /生成中/ }).click();
  await expect(drawer).toContainText('暂时没有正在生成的行程');
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole('button', { name: '我的行程', exact: true })).toBeFocused();
});

test('我的行程加载失败可重试，恢复后显示记录', async ({ page }) => {
  await prepare(page);
  let failed = true;
  await page.route('**/api/history', (route) =>
    route.fulfill({
      status: failed ? 503 : 200,
      json: failed ? { error: '记录暂时无法读取' } : { trips: [], tasks: [] },
    }),
  );
  await page.getByRole('button', { name: '我的行程', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '我的行程' });
  await expect(drawer.getByRole('alert')).toContainText('记录暂时无法读取');
  failed = false;
  await drawer.getByRole('button', { name: '重试', exact: true }).click();
  await expect(drawer).toContainText('下一段旅程，等你开启。');
  await expect(drawer.getByRole('alert')).toHaveCount(0);
});

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
}
async function generalSettings(page: Page) {
  await page.getByRole('heading', { name: '规划设置', exact: true }).scrollIntoViewIfNeeded();
}
async function modelSettings(page: Page) {
  await page.getByRole('heading', { name: '模型', exact: true }).scrollIntoViewIfNeeded();
}
async function editTestProvider(page: Page) {
  await page.getByRole('button', { name: '编辑 测试提供方', exact: true }).click();
  await page.getByText('自定义设置', { exact: true }).click();
}
const modelPicker = (page: Page) =>
  page.getByRole('dialog', { name: '选择要添加的模型', exact: true });

test('Harness 设置外壳、模型保存、撤销、重开和键盘关闭', async ({ page }, info) => {
  await prepare(page);
  await openSettings(page);
  await expect(page.getByRole('navigation', { name: '设置分类' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '规划设置', exact: true })).toBeVisible();
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '添加自定义提供方' })).toBeVisible();
  await page.screenshot({ path: `output/harness-settings-${info.project.name}.png` });
  await generalSettings(page);
  await expect(page.getByLabel('模型提供方').locator('option')).toHaveText(['测试提供方']);
  await expect(page.getByLabel('思考强度')).toHaveCount(0);
  await page.getByLabel('规划模型').selectOption('deep');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存，下次规划将使用新配置。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await openSettings(page);
  await generalSettings(page);
  await expect(page.getByLabel('规划模型')).toHaveValue('deep');
  await page.getByLabel('规划模型').selectOption('test');
  await page.getByRole('button', { name: '撤销更改' }).click();
  await expect(page.getByLabel('规划模型')).toHaveValue('deep');
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Harness 空配置提示和规划模型保存门槛', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/settings/model', (route) =>
    route.fulfill({
      json: {
        settings: { model: null, effort: null },
        effectiveModel: null,
        defaultModel: null,
        models: [],
        providers: [],
      },
    }),
  );
  await openSettings(page);
  await expect(page.getByRole('button', { name: '添加自定义提供方' })).toBeEnabled();
  await generalSettings(page);
  await expect(page.getByLabel('模型提供方')).toBeDisabled();
  await expect(page.getByLabel('规划模型')).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
  await expect(page.getByTestId('current-planning-model')).toContainText('尚未配置规划模型');
});

test('Harness 加载与保存失败可重试，并保留模型草稿', async ({ page }) => {
  await prepare(page);
  await page.route('**/api/settings/model', (route) =>
    route.fulfill({ status: 503, json: { error: '模型服务暂时不可用' } }),
  );
  await openSettings(page);
  await expect(page.getByRole('alert')).toContainText('模型服务暂时不可用');
  await page.unroute('**/api/settings/model');
  await page.getByRole('button', { name: '重新加载' }).click();
  await generalSettings(page);
  await page.getByLabel('规划模型').selectOption('deep');
  await page.route('**/api/settings/model', (route) =>
    route.fulfill({ status: 400, json: { error: '保存失败，请重试' } }),
  );
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('alert')).toContainText('保存失败');
  await expect(page.getByLabel('规划模型')).toHaveValue('deep');
  await page.unroute('**/api/settings/model');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存，下次规划将使用新配置。', { exact: true })).toBeVisible();
});

test('Harness 创建、选用、编辑、删除提供方，密钥不回显', async ({ page }, info) => {
  await prepare(page);
  await openSettings(page);
  await page.getByRole('button', { name: '添加自定义提供方' }).click();
  await page.getByLabel('Provider ID').fill('deepseek');
  await page.getByLabel('显示名称', { exact: true }).fill('我的 DeepSeek');
  await page.getByLabel('API 地址').fill('https://api.deepseek.com');
  await page.getByLabel('API 密钥', { exact: true }).fill('test-provider-secret');
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await expect(modelPicker(page)).toBeVisible();
  await expect(page.getByLabel('模型 ID 1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加所选' }).click();
  await expect(page.getByLabel('模型 ID 1')).toHaveValue('vendor-fast');
  expect(
    await page
      .getByRole('form', { name: '自定义提供方' })
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: `output/harness-editor-${info.project.name}.png` });
  await page.getByRole('button', { name: '创建提供方' }).click();
  await expect(page.getByTestId('provider-card')).toHaveCount(2);
  await generalSettings(page);
  await page.getByLabel('模型提供方').selectOption('deepseek');
  await page.getByLabel('规划模型').selectOption('vendor-deep');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存，下次规划将使用新配置。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭设置' }).click();
  await openSettings(page);
  await expect(
    page.getByTestId('provider-card').filter({ hasText: '我的 DeepSeek' }),
  ).toContainText('使用中');
  await page.getByRole('button', { name: '编辑 我的 DeepSeek' }).click();
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute(
    'placeholder',
    /已保存凭据/,
  );
  await page.getByText('自定义设置', { exact: true }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('更新的 DeepSeek');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑 更新的 DeepSeek' })).toBeVisible();
  await generalSettings(page);
  await page.getByLabel('模型提供方').selectOption('test-vendor');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存，下次规划将使用新配置。', { exact: true })).toBeVisible();
  await modelSettings(page);
  await page.getByRole('button', { name: '删除 更新的 DeepSeek' }).click();
  const confirm = page.getByRole('dialog', { name: '删除 更新的 DeepSeek？', exact: true });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除 更新的 DeepSeek' }).click();
  await page.getByRole('button', { name: '确定删除' }).click();
  await expect(page.getByTestId('provider-card')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Harness 模型目录搜索、勾选和合并保留已保存名称，嵌套弹窗独立关闭', async ({ page }) => {
  await prepare(page);
  await openSettings(page);
  await editTestProvider(page);
  const requests: any[] = [];
  await page.route('**/api/settings/providers/discover', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        models: [
          { id: 'test', name: '上游新名称' },
          { id: 'vendor-fast', name: '快速模型' },
          { id: 'vendor-deep', name: '深入模型' },
        ],
      },
    });
  });
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await expect(page.getByLabel('选择模型 test', { exact: true })).toBeDisabled();
  await modelPicker(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByLabel('模型 ID 3', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await page.getByRole('button', { name: '取消全选' }).click();
  await page.getByLabel('搜索可用模型').fill('快速');
  await page.getByRole('button', { name: '全选当前结果' }).click();
  await page.getByLabel('搜索可用模型').fill('vendor-deep');
  await expect(page.getByLabel('选择模型 vendor-deep')).not.toBeChecked();
  await page.getByRole('button', { name: '添加所选' }).click();
  await expect(page.getByLabel('模型 ID 3', { exact: true })).toHaveValue('vendor-fast');
  await expect(page.getByLabel('显示名称 1', { exact: true })).toHaveValue('默认测试模型');
  expect(requests[0]).toMatchObject({ id: 'test-vendor' });
  expect(requests[0].apiKey).toBeUndefined();
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await page.getByLabel('搜索可用模型').fill('不存在');
  await expect(modelPicker(page)).toContainText('没有匹配的模型');
  await page.keyboard.press('Escape');
  await expect(modelPicker(page)).not.toBeVisible();
  await expect(page.getByRole('form', { name: '编辑提供方' })).toBeVisible();
  await expect(page.getByRole('button', { name: '获取可用模型' })).toBeFocused();
});

test('Harness 认证失败保留目录，替换探测密钥后可重试', async ({ page }) => {
  await prepare(page);
  await openSettings(page);
  await editTestProvider(page);
  await page.route('**/api/settings/providers/discover', (route) =>
    route.request().postDataJSON().apiKey === 'replacement'
      ? route.fulfill({ json: { models: [{ id: 'recovered', name: '恢复后的模型' }] } })
      : route.fulfill({
          status: 502,
          json: { error: 'HTTP 401：API Key 无效或已删除，请填写有效密钥' },
        }),
  );
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await expect(page.getByRole('alert')).toContainText('API Key 无效或已删除');
  await expect(page.getByLabel('模型 ID 1', { exact: true })).toHaveValue('test');
  await page.getByLabel('API 密钥', { exact: true }).fill('replacement');
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await page.getByRole('button', { name: '添加所选' }).click();
  await expect(page.getByLabel('模型 ID 3', { exact: true })).toHaveValue('recovered');
});

test('Harness 大目录完整显示并限制采用数量', async ({ page }) => {
  await prepare(page);
  await openSettings(page);
  await editTestProvider(page);
  await page.route('**/api/settings/providers/discover', (route) =>
    route.fulfill({
      json: {
        models: Array.from({ length: 205 }, (_, index) => ({
          id: `large-${index}`,
          name: `模型 ${index}`,
        })),
      },
    }),
  );
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await expect(modelPicker(page)).toContainText('共获取 205 个模型');
  await expect(page.getByRole('button', { name: '添加所选' })).toBeDisabled();
  await page.getByRole('button', { name: '取消全选' }).click();
  await page.getByLabel('搜索可用模型').fill('large-204');
  await page.getByRole('button', { name: '全选当前结果' }).click();
  await page.getByRole('button', { name: '添加所选' }).click();
  await expect(page.getByLabel('模型 ID 3', { exact: true })).toHaveValue('large-204');
});

test('Harness 新增探测不借用同名配置密钥，拒绝非法密钥', async ({ page }) => {
  await prepare(page);
  await openSettings(page);
  await page.getByRole('button', { name: '添加自定义提供方' }).click();
  await page.getByLabel('API 地址').fill('https://gateway.example/v1');
  const request = page.waitForRequest('**/api/settings/providers/discover');
  await page.getByRole('button', { name: '获取可用模型' }).click();
  expect((await request).postDataJSON()).not.toHaveProperty('id');
  await modelPicker(page).getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('Provider ID').fill('test-vendor');
  await page.getByLabel('API 密钥', { exact: true }).fill('中文密钥');
  await expect(page.getByRole('button', { name: '获取可用模型' })).toBeDisabled();
  await expect(page.getByLabel('API 密钥', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page.getByLabel('API 密钥', { exact: true }).fill('new-probe-key');
  const next = page.waitForRequest('**/api/settings/providers/discover');
  await page.getByRole('button', { name: '获取可用模型' }).click();
  expect((await next).postDataJSON()).toMatchObject({ apiKey: 'new-probe-key' });
  expect((await next).postDataJSON()).not.toHaveProperty('id');
});

test('Harness 目录失败后手动添加模型和容量，保存后保持配置', async ({ page }) => {
  await prepare(page);
  await openSettings(page);
  await page.getByRole('button', { name: '添加自定义提供方' }).click();
  await page.getByLabel('Provider ID').fill('9invalid');
  await expect(page.getByRole('alert')).toContainText('小写字母');
  await expect(page.getByRole('button', { name: '创建提供方' })).toBeDisabled();
  await page.getByLabel('Provider ID').fill('my-gateway');
  await page.getByLabel('显示名称', { exact: true }).fill('我的网关');
  await page.getByLabel('API 地址').fill('https://gateway.example/v1');
  await page.route('**/api/settings/providers/discover', (route) =>
    route.fulfill({ status: 404, json: { error: '服务未提供模型目录，可以手动添加' } }),
  );
  await page.getByRole('button', { name: '获取可用模型' }).click();
  await expect(page.getByRole('alert')).toContainText('手动添加');
  await page.getByRole('button', { name: '添加模型', exact: true }).click();
  await page.getByLabel('模型 ID 1').fill('/models/Qwen');
  await page.getByLabel('显示名称 1').fill('Qwen 本地模型');
  await page.getByRole('button', { name: '容量 1' }).click();
  await page.getByLabel('上下文窗口 1').fill('256K');
  await page.getByLabel('最大输出 token 1').fill('32K');
  await page.getByRole('button', { name: '创建提供方' }).click();
  await expect(page.getByRole('button', { name: '编辑 我的网关' })).toBeVisible();
  await page.getByRole('button', { name: '编辑 我的网关' }).click();
  await page.getByText('自定义设置', { exact: true }).click();
  await page.getByRole('button', { name: '容量 1' }).click();
  await expect(page.getByLabel('上下文窗口 1')).toHaveValue('256K');
  await expect(page.getByLabel('最大输出 token 1')).toHaveValue('32K');
  await generalSettings(page);
  await page.getByLabel('模型提供方').selectOption('my-gateway');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('已保存，下次规划将使用新配置。', { exact: true })).toBeVisible();
});

test('交通方式查询真实备选路线，切换路段与地图联动，失败时不显示旧方式的路线', async ({
  page,
}, info) => {
  const { trip, input } = await prepare(page);
  const queries: string[] = [];
  let walkingRequests = 0;
  await page.route('**/api/trips/*/directions?**', async (request) => {
    const query = new URL(request.request().url()).searchParams;
    const mode = query.get('mode');
    queries.push(`${query.get('segmentIndex')}:${mode}`);
    if (mode === 'walking' && walkingRequests++ === 0) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return request.fulfill({ status: 422, json: { error: '此路段暂无可用步行路线' } });
    }
    const leg = trip.routes[0]!.days[0]!.segments[Number(query.get('segmentIndex'))]!;
    const segment = {
      ...leg,
      mode,
      durationMinutes: mode === 'driving' ? 12 : 25,
      price: mode === 'driving' ? 0 : 3,
      transfers: 0,
      walkingDistanceMeters: 300,
      summary:
        mode === 'driving'
          ? '湖滨路 → 北山街'
          : mode === 'walking'
            ? '沿湖滨路步行'
            : mode === 'cycling'
              ? '沿湖滨路骑行'
              : '地铁1号线',
      steps: [
        {
          mode: mode === 'transit' ? 'subway' : mode,
          name: mode === 'transit' ? '地铁1号线' : '湖滨路',
          instruction: '沿湖滨路直行',
          distanceMeters: 2400,
          durationMinutes: 12,
          departureStop: '城站',
          arrivalStop: '龙翔桥',
          stopCount: 3,
          viaStops: ['定安路'],
          polyline: leg.polyline,
        },
      ],
    };
    return request.fulfill({
      json: {
        routes: [
          segment,
          {
            ...segment,
            durationMinutes: segment.durationMinutes + 5,
            polyline: [
              { longitude: 120.17, latitude: 30.29 },
              { longitude: 120.18, latitude: 30.3 },
            ],
          },
        ],
        fetchedAt: '2026-10-13T00:00:00Z',
      },
    });
  });
  await page.getByRole('button', { name: '生成我的路线' }).click();
  const panel = page.getByRole('region', { name: '交通路线', exact: true });
  await expect(panel.getByText('2 条可选路线')).toBeVisible();
  await expect(panel.getByText('高德推荐 · 现在出发')).toBeVisible();
  await expect(panel.locator('.direction-option').first()).toContainText('推荐');
  const beforeRefresh = queries.length;
  await panel.getByRole('button', { name: '刷新路线' }).click();
  await expect.poll(() => queries.length).toBeGreaterThan(beforeRefresh);
  await expect(panel.getByRole('button', { name: '刷新路线' })).toBeEnabled();
  await expect(panel.locator('.direction-steps')).toHaveCount(0);
  await panel.scrollIntoViewIfNeeded();
  const pageScroll = await page.evaluate(() => window.scrollY);
  await panel.getByRole('button', { name: '查看方案2详情', exact: true }).click();
  await expect(panel.getByRole('button', { name: '返回路线列表' })).toBeVisible();
  await expect(panel.locator('.directions-detail-overview')).toContainText('30分钟');
  await expect(panel.locator('.step-subway')).toContainText('城站');
  await expect(panel.locator('.step-subway')).toContainText('龙翔桥');
  await expect(panel.locator('.direction-option')).toHaveCount(0);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - pageScroll)).toBeLessThan(2);
  await expect(panel.locator('.map-bottomline')).toContainText('30 分钟');
  await panel.getByRole('button', { name: '返回路线列表' }).click();
  await expect(panel.locator('.direction-option').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: '查看方案2详情', exact: true })).toBeFocused();
  await panel.getByRole('tab', { name: '驾车', exact: true }).click();
  await expect(panel.locator('.direction-option').first()).toContainText('12分钟');
  await expect(panel.locator('.map-bottomline a')).toHaveAttribute('href', /mode=car/);
  await panel.getByRole('tab', { name: '步行', exact: true }).click();
  await expect(panel.locator('.direction-option')).toHaveCount(0);
  await expect(panel.getByRole('status')).toContainText('暂无可用步行路线');
  await expect(panel.locator('.direction-option')).toHaveCount(0);
  await panel.getByRole('button', { name: '重新查询' }).click();
  await expect(panel.locator('.direction-option').first()).toContainText('沿湖滨路步行');
  await panel.getByRole('tab', { name: '骑行', exact: true }).click();
  await expect.poll(() => queries.includes('0:cycling')).toBe(true);
  await expect(panel.locator('.direction-option').first()).toContainText('沿湖滨路骑行');
  await expect(panel.locator('.map-bottomline a')).toHaveAttribute('href', /mode=ride/);
  await panel.getByRole('button', { name: '查看方案1详情', exact: true }).click();
  await expect(panel.locator('.step-cycling')).toContainText('沿湖滨路直行');
  await panel.getByRole('button', { name: '返回路线列表' }).click();
  await panel.getByLabel(/行程路段/).selectOption('1');
  await expect(panel.getByRole('tab', { name: '公交 / 地铁' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect.poll(() => queries.includes('1:transit')).toBe(true);
  await panel.getByRole('button', { name: '查看全日路线' }).click();
  await expect(panel.locator('.map-bottomline')).toContainText('全日 2 个停靠点');
  await page.getByRole('tab', { name: /DAY 02/ }).click();
  await expect(panel.getByLabel(/行程路段/)).toHaveValue('0');
  expect(input).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await panel.screenshot({ path: `test-results/directions-${info.project.name}.png` });
});
