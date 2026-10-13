import { describe, expect, it, vi } from 'vitest';
import type { CodexClient } from '../backend/src/codex/client.js';
import type { AmapService } from '../backend/src/services/amap.js';
import type { TripStore } from '../backend/src/db/store.js';
import { RegionService } from '../backend/src/services/regions.js';
import { TravelPlanner } from '../backend/src/planning/planner.js';
import { AppError } from '../backend/src/errors.js';
import { agentPlan, city, places, poi, request } from './fixtures/travel.js';
function setup() {
  const amap = {
    district: vi
      .fn()
      .mockResolvedValue([
        {
          adcode: '330000',
          districts: [
            { adcode: city.adcode, name: city.name, level: 'city', center: '120.15,30.27' },
          ],
        },
      ]),
    search: vi
      .fn()
      .mockImplementation(async (_city, _query, kind) =>
        _query === '杭州站'
          ? [{ ...poi('origin', '杭州站'), location: city.center }]
          : kind === 'hotel'
            ? places.filter((p) => p.category.includes('住宿'))
            : places.filter((p) => !p.category.includes('住宿')),
      ),
    leg: vi
      .fn()
      .mockImplementation(async (from, to, mode) => ({
        from: from.name,
        to: to.name,
        mode,
        durationMinutes: 30,
        distanceMeters: 2500,
        price: 3,
        summary: '测试交通',
        polyline: [from.location, to.location],
        source: 'amap',
      })),
  };
  const codex = {
    generate: vi.fn().mockImplementation(async (options) => {
      await options.handleTool('search_hotels', { keyword: '西湖酒店' });
      return { text: JSON.stringify(agentPlan()), threadId: 'fake-thread', model: 'fake-model' };
    }),
  };
  const store = { save: vi.fn() };
  const planner = new TravelPlanner(
    amap as unknown as AmapService,
    new RegionService(amap as unknown as AmapService),
    codex as unknown as CodexClient,
    store as unknown as TripStore,
  );
  return { amap, codex, store, planner };
}
describe('完整行程编排与保存', () => {
  it('用真实交通耗时调整重叠，保留每站攻略和住宿，保存后返回结果', async () => {
    const { planner, store, amap } = setup();
    const result = await planner.plan(request, new AbortController().signal, () => {});
    expect(result.engine).toBe('codex-app-server');
    expect(result.routes[0]!.days[0]!.stops[1]!.arrival).toBe('11:30');
    expect(result.routes[0]!.days[0]!.hotel!.name).toBe('测试酒店');
    expect(amap.leg).toHaveBeenCalledTimes(4);
    expect(store.save).toHaveBeenCalledWith(result);
  });
  it('跨省城市不能送进规划引擎', async () => {
    const { planner, codex } = setup();
    await expect(
      planner.plan({ ...request, cityCode: '510100' }, new AbortController().signal, () => {}),
    ).rejects.toThrow('城市与省份不匹配');
    expect(codex.generate).not.toHaveBeenCalled();
  });
  it('无法完成交通核验时不会保存或用直线代替', async () => {
    const { planner, amap, store } = setup();
    amap.leg.mockRejectedValue(new AppError('无可用路线', 422, 'NO_ROUTE'));
    await expect(planner.plan(request, new AbortController().signal, () => {})).rejects.toThrow(
      '无可用路线',
    );
    expect(store.save).not.toHaveBeenCalled();
  });
  it('只使用所选城市内的高德 POI', async () => {
    const { planner, amap, codex } = setup();
    amap.search.mockResolvedValue([{ ...places[0]!, adcode: '510106' }]);
    await expect(
      planner.plan({ ...request, origin: '' }, new AbortController().signal, () => {}),
    ).rejects.toThrow('未搜索到可用地点');
    expect(codex.generate).not.toHaveBeenCalled();
  });
});
