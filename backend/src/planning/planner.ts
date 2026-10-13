import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AgentPlanSchema,
  type AgentPlan,
  type PlanRequest,
  type Poi,
  type ProgressEvent,
  type Region,
  type Route,
  type Trip,
} from '@stree/shared';
import { AmapService } from '../services/amap.js';
import { RegionService, belongsToCity } from '../services/regions.js';
import { CodexClient, type DynamicTool } from '../codex/client.js';
import type { TripStore } from '../db/store.js';
import { AppError } from '../errors.js';
import { clock, minutes, validatePlan } from './validation.js';

const SearchSchema = z.object({
  keyword: z.string().trim().max(100),
  kind: z.enum(['attraction', 'any']).default('attraction'),
});
const HotelSchema = z.object({ keyword: z.string().trim().max(100) });
const MeasureSchema = z.object({ fromId: z.string(), toId: z.string() });
const tools: DynamicTool[] = [
  {
    type: 'function',
    name: 'search_places',
    description:
      '查询当前目的地城市的真实景点、餐饮或街区。必须使用返回的 POI id，地点事实来自高德。',
    inputSchema: z.toJSONSchema(SearchSchema),
  },
  {
    type: 'function',
    name: 'search_hotels',
    description: '查询当前城市真实酒店。参考价可能缺失，不代表当日可订价格。',
    inputSchema: z.toJSONSchema(HotelSchema),
  },
  {
    type: 'function',
    name: 'measure_route',
    description: '查询两处已返回 POI 之间的真实交通时间、距离与已知票价。fromId 可用 origin。',
    inputSchema: z.toJSONSchema(MeasureSchema),
  },
];
const instructions = `你是 STREE 中国国内旅行规划引擎。以简体中文为用户设计可执行的城市行程与逐站攻略。
只允许使用提示或 STREE 工具返回的 POI id，不得虚构地点、坐标、交通线路、营业时间、门票、酒店价格、预约政策或实时人流。
用户的必去点必须在每条候选路线中完整保留。行程天数必须等于输入，日编号连续且不重叠。
先按同一片区组织每天的行程，使用 measure_route 核对至少一个关键交通区间；如时间不合理，调整点位顺序和停留时长。
主要交通为公共交通时，邻近景点允许步行衔接；高德返回的 mode 与耗时为真实采用的交通方式。
餐饮可提供区域与菜品建议，若安排具体店铺为站点，必须先用 search_places 的 any 类型查询。
住宿开启且行程超过1天时，使用 search_hotels 查询真实酒店并安排在非最后一天；没有价格数据时标注需要确认，估算住宿预算明确为估算。
攻略必须逐站对应，包含看点、游玩建议、预约核实提示与拍照建议；行程攻略包含出发前准备、当地建议与携带物品。
工具没有提供的政策、价格和开放时间写“需以官方当日信息确认”，不要把一般建议描述为已经核实的事实。
估算餐饮、门票、酒店预算是整条路线合计的每人参考金额，住宿假设每人分摊一间房的费用；不要把高德人均消费当成门票。
生成1至3条有实际区别的候选路线，优先满足预算和节奏。最终只返回符合 outputSchema 的 JSON，不输出 Markdown。不要使用 shell、文件系统、其他应用或任何与旅行无关的工具。`;

export class TravelPlanner {
  constructor(
    private amap: AmapService,
    private regions: RegionService,
    private codex: CodexClient,
    private store: TripStore,
  ) {}
  async plan(
    request: PlanRequest,
    signal: AbortSignal,
    emit: (event: ProgressEvent) => void,
    previous?: Trip,
  ): Promise<Trip> {
    const progress = (stage: ProgressEvent['stage'], message: string) =>
      emit({ type: 'progress', stage, message, timestamp: new Date().toISOString() });
    progress('places', '正在确认省份、城市和出发地点');
    const { province, city } = await this.regions.resolve(request.provinceCode, request.cityCode);
    const poiMap = new Map<string, Poi>();
    const register = (items: Poi[]) => {
      const filtered = items.filter((item) => belongsToCity(item.adcode, city.adcode));
      filtered.forEach((item) => poiMap.set(item.id, item));
      return filtered;
    };
    let origin = { name: `${city.name}中心（可在表单指定出发地）`, location: city.center };
    if (request.origin.trim()) {
      const places = register(await this.amap.search(city.adcode, request.origin, 'any', signal));
      const resolved = places[0];
      if (!resolved)
        throw new AppError(
          `未能在${city.name}找到出发地“${request.origin}”，请填写更完整的名称。`,
          422,
        );
      origin = { name: resolved.name, location: resolved.location };
    }
    const requiredIds: string[] = [];
    for (const name of request.mustVisit) {
      progress('places', `正在查找必去地点：${name}`);
      const items = register(await this.amap.search(city.adcode, name, 'any', signal));
      const normalized = name.replace(/[\s（）()·]/g, '');
      const matched = items
        .filter((item) => item.name.replace(/[\s（）()·]/g, '').includes(normalized))
        .sort((a, b) => a.name.length - b.name.length)[0];
      if (!matched)
        throw new AppError(
          `未能在${city.name}确认必去地点“${name}”，请核对名称和目的地。`,
          422,
          'MUST_VISIT_NOT_FOUND',
        );
      if (!requiredIds.includes(matched.id)) requiredIds.push(matched.id);
    }
    progress('places', `正在获取${city.name}的候选景点`);
    register(await this.amap.search(city.adcode, city.name, 'attraction', signal));
    if (!poiMap.size) throw new AppError('当前城市未搜索到可用地点，请调整目的地或必去地点。', 422);
    let calls = 0;
    const handleTool = async (name: string, args: unknown) => {
      signal.throwIfAborted();
      if (++calls > 40) throw new AppError('本次工具查询已达上限，请基于已经返回的地点完成规划。');
      if (name === 'search_places') {
        const input = SearchSchema.parse(args);
        const result = register(
          await this.amap.search(city.adcode, input.keyword, input.kind, signal),
        );
        return { places: result, city: city.name };
      }
      if (name === 'search_hotels') {
        const input = HotelSchema.parse(args);
        return {
          hotels: register(await this.amap.search(city.adcode, input.keyword, 'hotel', signal)),
          note: '高德参考消费不等于当日房价；未提供价格时需确认。',
        };
      }
      if (name === 'measure_route') {
        const input = MeasureSchema.parse(args);
        const from = input.fromId === 'origin' ? origin : poiMap.get(input.fromId);
        const to = poiMap.get(input.toId);
        if (!from || !to) throw new AppError('请使用已查询的地点 ID。');
        const segment = await this.amap.leg(from, to, request.transport, city.adcode, signal);
        const { polyline: _, ...facts } = segment;
        return facts;
      }
      throw new AppError('未知旅行工具。');
    };
    const prompt = JSON.stringify({
      request,
      province: province.name,
      city: city.name,
      origin,
      requiredPoiIds: requiredIds,
      candidatePlaces: [...poiMap.values()],
      previousPlan: previous
        ? {
            previousRequest: previous.request,
            summary: previous.summary,
            routes: previous.routes.map((r) => ({
              title: r.title,
              days: r.days.map((d) => ({ day: d.day, stops: d.stops.map((s) => s.poi.name) })),
            })),
          }
        : null,
    });
    progress('planning', 'Codex 正在组合路线并编写对应攻略');
    const schema = z.toJSONSchema(AgentPlanSchema);
    delete schema.$schema;
    let generated: Awaited<ReturnType<CodexClient['generate']>>;
    let plan: AgentPlan | null = null;
    let errors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      generated = await this.codex.generate({
        tools,
        instructions,
        prompt:
          attempt === 0
            ? prompt
            : `${prompt}\n上次结果校验未通过，请重新生成并修复：${errors.join('；')}\n所有已确认地点：${JSON.stringify([...poiMap.values()])}`,
        outputSchema: schema,
        handleTool,
        signal,
        onProgress: (message) => progress('planning', message),
      });
      let raw: unknown;
      try {
        raw = JSON.parse(generated.text);
      } catch {
        errors = ['最终输出必须是完整 JSON'];
        continue;
      }
      const result = validatePlan(raw, request, poiMap, requiredIds);
      plan = result.plan;
      errors = result.errors;
      if (plan) break;
      progress('planning', '正在修正行程中的时间、地点或预算约束');
    }
    if (!plan)
      throw new AppError(
        'AI 返回的行程未通过地点与约束校验，请简化需求后重试。',
        422,
        'INVALID_AI_PLAN',
      );
    progress('routing', '正在用高德计算每天的实际交通路径');
    const routes: Route[] = [];
    const rejected: string[] = [];
    for (const route of plan.routes) {
      try {
        const days: Route['days'] = [];
        let distanceMeters = 0;
        let transitMinutes = 0;
        let transportCost = 0;
        const warnings: string[] = [];
        let previousHotel: Poi | null = null;
        for (const day of route.days) {
          const segments: Route['days'][number]['segments'] = [];
          const stops: Route['days'][number]['stops'] = [];
          let from: { name: string; location: Poi['location'] } | null =
            day.day === 1 ? origin : previousHotel;
          let previousEnd = 8 * 60;
          for (const stop of day.stops) {
            const poi = poiMap.get(stop.poiId)!;
            let duration = 0;
            if (
              from &&
              (from.location.latitude !== poi.location.latitude ||
                from.location.longitude !== poi.location.longitude)
            ) {
              const segment = await this.amap.leg(
                from,
                poi,
                request.transport,
                city.adcode,
                signal,
              );
              segments.push(segment);
              duration = segment.durationMinutes;
            }
            const arrival = Math.max(minutes(stop.arrival), previousEnd + duration);
            const departure = arrival + minutes(stop.departure) - minutes(stop.arrival);
            if (departure > 23 * 60)
              throw new AppError(`${route.title}第${day.day}天交通耗时过长，无法在当天完成。`, 422);
            if (
              arrival !== minutes(stop.arrival) &&
              !warnings.includes('已按高德实际交通时间顺延部分站点，出发前请核对开放时间。')
            )
              warnings.push('已按高德实际交通时间顺延部分站点，出发前请核对开放时间。');
            stops.push({ ...stop, arrival: clock(arrival), departure: clock(departure), poi });
            previousEnd = departure;
            from = poi;
          }
          const hotel = day.hotelPoiId ? poiMap.get(day.hotelPoiId)! : null;
          if (hotel && from)
            segments.push(await this.amap.leg(from, hotel, request.transport, city.adcode, signal));
          if (day.day > 1 && !previousHotel)
            warnings.push(`第${day.day}天地图从首个景点开始，住宿出发段需自行确认。`);
          previousHotel = hotel;
          const dayDistance = segments.reduce((n, s) => n + s.distanceMeters, 0);
          const dayTransit = segments.reduce((n, s) => n + s.durationMinutes, 0);
          transportCost += segments.reduce((n, s) => n + (s.price ?? 0), 0);
          distanceMeters += dayDistance;
          transitMinutes += dayTransit;
          days.push({
            day: day.day,
            title: day.title,
            overview: day.overview,
            date: dateAt(request.startDate, day.day - 1),
            stops,
            hotel,
            hotelReason: day.hotelReason,
            foodTips: day.foodTips,
            segments,
            distanceMeters: dayDistance,
            transitMinutes: dayTransit,
          });
        }
        const totalEstimatedBudget = Math.round(
          route.estimatedFoodBudget +
            route.estimatedTicketBudget +
            (request.includeHotel ? route.estimatedHotelBudget : 0) +
            transportCost,
        );
        if (request.budget !== null && totalEstimatedBudget > request.budget)
          throw new AppError(`${route.title}包含实际交通后的费用超过预算。`, 422);
        routes.push({
          ...route,
          days,
          totalEstimatedBudget,
          transportCost,
          distanceMeters,
          transitMinutes,
          warnings,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof AppError) rejected.push(error.message);
        else throw error;
      }
    }
    if (!routes.length)
      throw new AppError(
        rejected[0] ?? '没有路线通过高德交通与预算校验，请调整需求。',
        422,
        'NO_FEASIBLE_ROUTE',
      );
    const now = new Date().toISOString();
    const trip: Trip = {
      id: previous?.id ?? randomUUID(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      province,
      city,
      origin,
      request,
      summary: plan.summary,
      routes,
      engine: 'codex-app-server',
      model: generated!.model,
      threadId: generated!.threadId,
    };
    if (rejected.length)
      trip.routes.forEach((route) =>
        route.warnings.push('部分候选方案因交通或预算校验未通过，已移除。'),
      );
    signal.throwIfAborted();
    progress('saving', '路线与攻略已完成，正在保存行程');
    await this.store.save(trip);
    return trip;
  }
}
function dateAt(start: string | null, offset: number): string | null {
  if (!start) return null;
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
