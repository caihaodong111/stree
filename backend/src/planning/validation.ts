import { AgentPlanSchema, type AgentPlan, type PlanRequest, type Poi } from '@stree/shared';

export const minutes = (time: string): number => {
  const [hour, minute] = time.split(':').map(Number);
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) return NaN;
  return hour * 60 + minute;
};
export const clock = (value: number): string =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export function validatePlan(
  raw: unknown,
  request: PlanRequest,
  pois: Map<string, Poi>,
  mustVisitIds: string[],
): { plan: AgentPlan | null; errors: string[] } {
  const parsed = AgentPlanSchema.safeParse(raw);
  if (!parsed.success)
    return {
      plan: null,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    };
  const plan = parsed.data;
  const errors: string[] = [];
  const routeIds = new Set<string>();
  for (const route of plan.routes) {
    if (routeIds.has(route.id)) errors.push(`路线 ID ${route.id} 重复`);
    routeIds.add(route.id);
    if (route.days.length !== request.days) errors.push(`${route.id} 必须包含 ${request.days} 天`);
    const visited = new Set<string>();
    route.days.forEach((day, index) => {
      if (day.day !== index + 1) errors.push(`${route.id} 天数顺序不正确`);
      let previousEnd = 0;
      for (const stop of day.stops) {
        if (!pois.has(stop.poiId)) errors.push(`地点 ${stop.poiId} 未经过高德查询`);
        if (visited.has(stop.poiId)) errors.push(`${route.id} 重复安排地点 ${stop.poiId}`);
        visited.add(stop.poiId);
        const start = minutes(stop.arrival),
          end = minutes(stop.departure);
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end - start < 15 ||
          start < previousEnd
        )
          errors.push(`${route.id} ${stop.poiId} 时间不合法或重叠`);
        previousEnd = end;
      }
      if (day.hotelPoiId && !pois.has(day.hotelPoiId))
        errors.push(`酒店 ${day.hotelPoiId} 未经过查询`);
      if (request.includeHotel && day.day < request.days && !day.hotelPoiId)
        errors.push(`第 ${day.day} 天必须安排经过高德查询的酒店`);
      if (
        day.hotelPoiId &&
        pois.has(day.hotelPoiId) &&
        !pois.get(day.hotelPoiId)!.category.includes('住宿')
      )
        errors.push(`地点 ${day.hotelPoiId} 不是住宿设施`);
      if (!request.includeHotel && day.hotelPoiId) errors.push('用户未要求住宿，请移除酒店');
      if (day.day === request.days && day.hotelPoiId) errors.push('最后一天不安排过夜酒店');
    });
    for (const id of mustVisitIds)
      if (!visited.has(id)) errors.push(`${route.id} 遗漏必去点 ${pois.get(id)?.name}`);
    const preliminary =
      route.estimatedFoodBudget +
      route.estimatedTicketBudget +
      (request.includeHotel ? route.estimatedHotelBudget : 0);
    if (request.budget !== null && preliminary > request.budget)
      errors.push(`${route.id} 已知估算费用超过预算`);
  }
  return { plan: errors.length ? null : plan, errors };
}
