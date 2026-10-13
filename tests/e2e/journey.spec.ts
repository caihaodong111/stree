import { test, expect, type Page } from '@playwright/test';
import { tripFixture, city, province } from '../fixtures/travel.js';
import { provinces } from '../../backend/src/services/regions.js';
async function prepare(page: Page, mode: 'result' | 'pending' | 'error' = 'result') {
  const trip = tripFixture();
  trip.routes.push({
    ...structuredClone(trip.routes[0]!),
    id: 'culture',
    title: '城市文化慢游',
    label: '文化体验',
  });
  const input: any[] = [];
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
          if (item.content) this.el.appendChild(item.content);
        });
      }
      destroy() {
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
    if (pathname === '/status')
      return json({
        codex: { available: true, authenticated: true, model: 'test' },
        amap: { configured: true },
        storage: { available: true, driver: 'file' },
        version: '2.0.0',
      });
    if (pathname === '/regions/provinces') return json({ regions: provinces });
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
    if (pathname === '/trips')
      return json({
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
test('生成路线、查看逐站攻略、切换方案与天数、导出并修改行程', async ({ page }, info) => {
  const { trip, input } = await prepare(page);
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect(page.getByRole('heading', { name: '这座城，有了你的走法。' })).toBeVisible();
  await expect(page.locator('.map-canvas')).toHaveAttribute('data-paths', '2');
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
test('运行中可取消并重新开始', async ({ page }) => {
  const { input } = await prepare(page, 'pending');
  await page.getByRole('button', { name: '生成我的路线' }).click();
  await expect(page.getByRole('button', { name: '取消规划' })).toBeVisible();
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
