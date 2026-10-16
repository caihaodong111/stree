import { describe, expect, it, vi } from 'vitest';
import type { PlanningModels } from '../backend/src/models/service.js';
import type { AmapService } from '../backend/src/services/amap.js';
import type { TripStore } from '../backend/src/db/store.js';
import { RegionService } from '../backend/src/services/regions.js';
import { TravelPlanner } from '../backend/src/planning/planner.js';
import { AppError } from '../backend/src/errors.js';
import { agentPlan, city, places, poi, request } from './fixtures/travel.js';
import type { TravelWebSearch } from '../backend/src/services/web-search.js';
import { TripSchema } from '@stree/shared';
function setup(webSearch?: TravelWebSearch) {
  const amap = {
    district: vi.fn().mockResolvedValue([
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
    detail: vi
      .fn()
      .mockImplementation(async (id) => places.find((place) => place.id === id) ?? null),
    suggest: vi.fn().mockResolvedValue([]),
    leg: vi.fn().mockImplementation(async (from, to, mode) => ({
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
    settings: vi.fn().mockResolvedValue({ settings: { model: null, effort: null } }),
    generate: vi.fn().mockImplementation(async (options) => {
      await options.handleTool('search_hotels', { keyword: '西湖酒店' });
      return { text: JSON.stringify(agentPlan()), threadId: 'fake-thread', model: 'fake-model' };
    }),
  };
  const store = { save: vi.fn() };
  const planner = new TravelPlanner(
    amap as unknown as AmapService,
    new RegionService(amap as unknown as AmapService),
    {
      session: async () => {
        const { settings } = await codex.settings();
        return {
          providerName: 'Codex',
          generate: (options) => codex.generate({ ...options, settings }),
        };
      },
    } as PlanningModels,
    store as unknown as TripStore,
    webSearch,
  );
  return { amap, codex, store, planner };
}
describe('AI 行程直通、地图工具与保存', () => {
  it('直接保存 AI 的最终安排，不检查时间、预算、必去点或天数，也不重试或剔除路线', async () => {
    const { planner, codex, amap, store } = setup();
    const draft = agentPlan();
    draft.routes[0]!.days = draft.routes[0]!.days.slice(0, 1);
    const day = draft.routes[0]!.days[0]!;
    day.stops[1]!.arrival = '09:15';
    day.stops[1]!.departure = '09:30';
    day.hotelPoiId = null;
    day.legs.pop();
    draft.routes[0]!.estimatedFoodBudget = 9000;
    draft.routes[0]!.totalEstimatedBudget = 8765;
    draft.routes[0]!.distanceMeters = 12345;
    draft.routes.push({ ...structuredClone(draft.routes[0]!), id: 'another' });
    codex.generate.mockImplementation(async () => ({
      text: JSON.stringify(draft),
      threadId: 'ai-final',
      model: 'test-ai',
    }));
    const result = await planner.plan(
      { ...request, budget: 100, mustVisitPlaces: [{ id: 'park', name: '测试公园' }] },
      new AbortController().signal,
      () => {},
    );
    expect(codex.generate).toHaveBeenCalledTimes(1);
    expect(amap.leg).not.toHaveBeenCalled();
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]!.days).toHaveLength(1);
    expect(result.routes[0]!.totalEstimatedBudget).toBe(8765);
    expect(result.routes[0]!.distanceMeters).toBe(12345);
    expect(result.routes[0]!.days[0]!.stops.map(({ poi, ...stop }) => stop)).toEqual(day.stops);
    expect(result.routes[0]!.days[0]!.hotel).toBeNull();
    expect(store.save).toHaveBeenCalledWith(result);
  });
  it('公交查不到路线后仍直接交付 AI 的步行建议，不再最终算路或驳回', async () => {
    const { planner, codex, amap, store } = setup();
    amap.leg.mockRejectedValue(new AppError('天安门到天安门广场暂无公交路线', 422, 'NO_ROUTE'));
    codex.generate.mockImplementation(async (options) => {
      const facts = await options.handleTool('measure_route', {
        fromId: 'lake',
        toId: 'museum',
        mode: 'transit',
      });
      expect(facts).toMatchObject({ available: false, mode: 'transit' });
      const draft = agentPlan();
      draft.routes[0]!.days[0]!.legs[1]!.summary = 'AI 建议步行，耗时为估算，请现场确认入口';
      return { text: JSON.stringify(draft), model: 'test-ai', threadId: 'final' };
    });
    const trip = await planner.plan(request, new AbortController().signal, () => {});
    expect(codex.generate).toHaveBeenCalledTimes(1);
    expect(amap.leg).toHaveBeenCalledTimes(1);
    expect(trip.routes[0]!.days[0]!.segments[1]).toMatchObject({
      mode: 'walking',
      source: 'ai',
      polyline: [],
    });
    expect(store.save).toHaveBeenCalledWith(trip);
  });
  it('地图事实只绑定导航几何，不覆盖 AI 的时间、距离、预算或顺序', async () => {
    const { planner, amap, codex } = setup();
    codex.generate.mockImplementation(async (options) => {
      const queried = await options.handleTool('measure_route', {
        fromId: 'origin',
        toId: 'lake',
        mode: 'transit',
      });
      expect(queried.durationMinutes).toBe(30);
      const draft = agentPlan();
      draft.routes[0]!.days[0]!.legs[0]!.durationMinutes = 17;
      draft.routes[0]!.days[0]!.legs[0]!.distanceMeters = 777;
      return { text: JSON.stringify(draft), threadId: 'final', model: 'test-ai' };
    });
    const trip = await planner.plan(request, new AbortController().signal, () => {});
    const segment = trip.routes[0]!.days[0]!.segments[0]!;
    expect(segment).toMatchObject({ durationMinutes: 17, distanceMeters: 777, source: 'ai' });
    expect(segment.polyline).toHaveLength(2);
    expect(amap.leg).toHaveBeenCalledTimes(1);
  });
  it('起终点均接受出发地真实 ID 与 origin 别名，往返方向和模式分别缓存', async () => {
    const { planner, codex, amap } = setup();
    const selected = { ...poi('selected', '已选出发地'), location: city.center };
    amap.detail.mockImplementation(async (id) =>
      id === selected.id ? selected : (places.find((p) => p.id === id) ?? null),
    );
    codex.generate.mockImplementation(async (options) => {
      for (const fromId of ['selected', 'origin'])
        await expect(
          options.handleTool('measure_route', { fromId, toId: 'lake', mode: 'transit' }),
        ).resolves.toMatchObject({ available: true });
      for (const toId of ['selected', 'origin'])
        await expect(
          options.handleTool('measure_route', { fromId: 'lake', toId, mode: 'transit' }),
        ).resolves.toMatchObject({ available: true });
      await options.handleTool('measure_route', {
        fromId: 'origin',
        toId: 'lake',
        mode: 'walking',
      });
      const draft = agentPlan();
      draft.routes[0]!.days[0]!.legs[0]!.fromId = 'selected';
      return { text: JSON.stringify(draft), model: 'test-ai', threadId: 'final' };
    });
    const trip = await planner.plan(
      { ...request, originPoiId: 'selected' },
      new AbortController().signal,
      () => {},
    );
    expect(amap.leg).toHaveBeenCalledTimes(3);
    expect(
      amap.leg.mock.calls.some((call) => call[0].id === 'lake' && call[1].id === 'selected'),
    ).toBe(true);
    expect(trip.origin.id).toBe('selected');
  });
  it('保留地图服务、来源、缓存与已选同名地点，缓存结果不可被模型回调篡改', async () => {
    const { planner, codex, amap } = setup();
    codex.generate.mockImplementation(async (options) => {
      const first = await options.handleTool('search_hotels', { keyword: '西湖酒店' });
      first.hotels.length = 0;
      expect(
        (await options.handleTool('search_hotels', { keyword: ' 西湖酒店 ' })).hotels,
      ).toHaveLength(1);
      return { text: JSON.stringify(agentPlan()), model: 'test-ai', threadId: 'final' };
    });
    const trip = await planner.plan(request, new AbortController().signal, () => {});
    expect(amap.search.mock.calls.filter((call) => call[2] === 'hotel')).toHaveLength(1);
    expect(trip.routes[0]!.days[0]!.stops[0]!.poi).toEqual(places[0]);
  });
  it('AI 引用未预取的 POI 时只读取地图资料，不进行路线审查', async () => {
    const { planner, codex, amap } = setup();
    const external = { ...poi('extra', 'AI 选择的地点'), adcode: '510100' };
    amap.detail.mockImplementation(async (id) =>
      id === 'extra' ? external : (places.find((p) => p.id === id) ?? null),
    );
    codex.generate.mockImplementation(async () => {
      const draft = agentPlan();
      draft.routes[0]!.days[0]!.stops[0]!.poiId = 'extra';
      draft.routes[0]!.days[0]!.legs[0]!.toId = 'extra';
      draft.routes[0]!.days[0]!.legs[1]!.fromId = 'extra';
      return { text: JSON.stringify(draft), model: 'test-ai', threadId: 'final' };
    });
    const trip = await planner.plan(request, new AbortController().signal, () => {});
    expect(trip.routes[0]!.days[0]!.stops[0]!.poi).toEqual(external);
    expect(codex.generate).toHaveBeenCalledTimes(1);
  });
  it('跨城出发地贯穿首段交通、出发时间与总预算，起点不会替换成目的地中心', async () => {
    const { planner, amap, codex, store } = setup();
    const departure = {
      ...poi('shanghai-origin', '上海虹桥站'),
      adcode: '310106',
      location: { longitude: 121.32, latitude: 31.2 },
    };
    amap.detail.mockImplementation(async (id) =>
      id === departure.id ? departure : (places.find((place) => place.id === id) ?? null),
    );
    amap.leg.mockImplementation(async (from, to, mode) => ({
      from: from.name,
      to: to.name,
      mode,
      durationMinutes: 120,
      distanceMeters: 180000,
      price: 80,
      summary: '跨城交通参考',
      polyline: [from.location, to.location],
      source: 'amap',
    }));
    codex.generate.mockImplementation(async (options) => {
      const input = JSON.parse(options.prompt);
      expect(input.origin).toMatchObject({ id: departure.id, location: departure.location });
      expect(input.journeyScope).toMatchObject({
        startSource: 'user-origin',
        crossCityOrigin: true,
        includeInitialTransfer: true,
      });
      expect(options.instructions).toContain('第一条 leg 必须从 origin');
      expect(options.instructions).toContain('不能仅统计市内部分');
      const transfer = await options.handleTool('measure_route', {
        fromId: 'origin',
        toId: 'lake',
        mode: 'transit',
      });
      const draft = agentPlan();
      const route = draft.routes[0]!;
      const firstDay = route.days[0]!;
      const leg = firstDay.legs[0]!;
      const extraMinutes = transfer.durationMinutes - leg.durationMinutes;
      const extraDistance = transfer.distanceMeters - leg.distanceMeters;
      const extraPrice = transfer.price - leg.price!;
      Object.assign(leg, {
        durationMinutes: transfer.durationMinutes,
        distanceMeters: transfer.distanceMeters,
        price: transfer.price,
        summary: transfer.summary,
      });
      firstDay.startTime = '06:30';
      firstDay.transitMinutes += extraMinutes;
      firstDay.distanceMeters += extraDistance;
      route.transitMinutes += extraMinutes;
      route.distanceMeters += extraDistance;
      route.transportCost += extraPrice;
      route.totalEstimatedBudget += extraPrice;
      return { text: JSON.stringify(draft), model: 'test-ai', threadId: 'cross-city' };
    });
    const trip = await planner.plan(
      { ...request, origin: departure.name, originPoiId: departure.id },
      new AbortController().signal,
      () => {},
    );
    expect(trip.origin).toMatchObject({ id: departure.id, location: departure.location });
    const route = trip.routes[0]!;
    expect(route.days[0]).toMatchObject({ startTime: '06:30', transitMinutes: 180 });
    expect(route.days[0]!.segments[0]).toMatchObject({
      from: departure.name,
      durationMinutes: 120,
      distanceMeters: 180000,
      price: 80,
      origin: { id: departure.id, location: departure.location },
    });
    expect(route).toMatchObject({
      transitMinutes: 210,
      transportCost: 89,
      totalEstimatedBudget: 589,
    });
    expect(store.save).toHaveBeenCalledWith(trip);
  });
  it('未填出发地时向规划模型提供目的地市中心起点', async () => {
    const { planner, codex } = setup();
    codex.generate.mockImplementation(async (options) => {
      const input = JSON.parse(options.prompt);
      expect(input.origin.location).toEqual(city.center);
      expect(input.journeyScope).toMatchObject({
        startSource: 'city-center',
        crossCityOrigin: false,
        startPointId: 'origin',
      });
      return { text: JSON.stringify(agentPlan()), model: 'test-ai', threadId: 'center-origin' };
    });
    const trip = await planner.plan(
      { ...request, origin: '', originPoiId: null },
      new AbortController().signal,
      () => {},
    );
    expect(trip.origin.location).toEqual(city.center);
  });
  it('已选出发楼栋的详情为空时，保留同一 ID 的地图提示坐标', async () => {
    const { planner, amap } = setup();
    const building = { ...poi('building', '测试小区20栋'), adcode: '140213' };
    amap.detail.mockImplementation(async (id) =>
      id === 'building' ? null : (places.find((p) => p.id === id) ?? null),
    );
    amap.suggest.mockResolvedValue([building]);
    const trip = await planner.plan(
      { ...request, origin: building.name, originPoiId: building.id },
      new AbortController().signal,
      () => {},
    );
    expect(trip.origin).toMatchObject({ id: building.id, location: building.location });
  });
  it('地点预取没有找到必去点时交给 AI 处理，不提前终止生成', async () => {
    const { planner, amap, codex } = setup();
    const search = amap.search.getMockImplementation()!;
    amap.search.mockImplementation(async (...args) =>
      args[1] === '待查地点' ? [] : search(...args),
    );
    codex.generate.mockImplementation(async (options) => {
      expect(JSON.parse(options.prompt).placeNotes.join('；')).toContain('待查地点');
      return { text: JSON.stringify(agentPlan()), model: 'test-ai', threadId: 'final' };
    });
    await planner.plan(
      { ...request, mustVisit: ['待查地点'] },
      new AbortController().signal,
      () => {},
    );
    expect(codex.generate).toHaveBeenCalledTimes(1);
  });
  it.each(['{', '{"routes":[]}'])(
    '无法展示的 JSON 只报格式错误，不触发后端重新规划：%s',
    async (text) => {
      const { planner, codex, store } = setup();
      codex.generate.mockResolvedValue({ text, threadId: 'final', model: 'test-ai' });
      await expect(
        planner.plan(request, new AbortController().signal, () => {}),
      ).rejects.toMatchObject({ code: 'AI_OUTPUT_FORMAT' });
      expect(codex.generate).toHaveBeenCalledTimes(1);
      expect(store.save).not.toHaveBeenCalled();
    },
  );
  it('联网搜索仍由当前模型使用，来源去重并保存，不伪造资料', async () => {
    const source = {
      url: 'https://example.com/guide',
      title: '公开攻略',
      query: '杭州攻略',
      retrievedAt: new Date().toISOString(),
    };
    const webSearch = {
      status: () => ({ enabled: true, configured: true, provider: 'bing' }),
      search: vi.fn().mockResolvedValue({ sources: [source], truncated: false }),
    };
    const { planner, codex } = setup(webSearch);
    codex.generate.mockImplementation(async (options) => {
      await options.handleTool('web_search', { queries: ['杭州攻略'] });
      await options.handleTool('web_search', { queries: [' 杭州攻略 '] });
      return { text: JSON.stringify(agentPlan()), model: 'test-ai', threadId: 'final' };
    });
    const trip = await planner.plan(request, new AbortController().signal, () => {});
    expect(webSearch.search).toHaveBeenCalledTimes(1);
    expect(trip.research).toMatchObject({ status: 'completed', sources: [source] });
  });
});

it.each(['selected', 'origin'])(
  '跨城出发站作为首尾停靠点时绑定真实 POI 并可保存（%s）',
  async (originId) => {
    const { planner, codex, amap, store } = setup();
    const selected = {
      ...poi('selected', '太原南站'),
      adcode: '140105',
      location: { longitude: 112.61, latitude: 37.79 },
    };
    amap.detail.mockImplementation(async (id) =>
      id === 'selected' ? selected : (places.find((p) => p.id === id) ?? null),
    );
    codex.generate.mockImplementation(async (options) => {
      await options.handleTool('search_hotels', { keyword: '西湖酒店' });
      const draft = agentPlan();
      const first = draft.routes[0]!.days[0]!;
      const last = draft.routes[0]!.days.at(-1)!;
      first.stops.unshift({ ...first.stops[0]!, poiId: originId });
      last.stops.push({ ...last.stops[0]!, poiId: originId });
      return { text: JSON.stringify(draft), model: 'test-ai', threadId: 'station-stop' };
    });
    const trip = await planner.plan(
      { ...request, origin: '太原南站', originPoiId: 'selected' },
      new AbortController().signal,
      () => {},
    );
    expect(trip.routes[0]!.days[0]!.stops[0]!.poi).toMatchObject({
      id: originId,
      name: '太原南站',
      location: selected.location,
    });
    expect(trip.routes[0]!.days.at(-1)!.stops.at(-1)!.poi.name).toBe('太原南站');
    expect(TripSchema.safeParse(trip).success).toBe(true);
    expect(store.save).toHaveBeenCalledOnce();
  },
);
