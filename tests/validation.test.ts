import { describe, expect, it } from 'vitest';
import { PlanRequestSchema } from '@stree/shared';
import { validatePlan } from '../backend/src/planning/validation.js';
import { agentPlan, places, request } from './fixtures/travel.js';
const registry = new Map(places.map((p) => [p.id, p]));
describe('行程约束', () => {
  it('接受已确认地点、连续天数和已查询的过夜酒店', () =>
    expect(validatePlan(agentPlan(), request, registry, []).plan).not.toBeNull());
  it.each(['unknown', 'missing', 'overlap', 'days', 'budget', 'hotel', 'hotelType'])(
    '拒绝无效约束 %s',
    (kind) => {
      const plan = agentPlan();
      const route = plan.routes[0]!;
      let required: string[] = [];
      if (kind === 'unknown') route.days[0]!.stops[0]!.poiId = 'fabricated';
      if (kind === 'missing') required = ['park', 'not-in-plan'];
      if (kind === 'overlap') route.days[0]!.stops[1]!.arrival = '10:00';
      if (kind === 'days') route.days.pop();
      if (kind === 'budget') route.estimatedFoodBudget = 2000;
      if (kind === 'hotel') route.days[0]!.hotelPoiId = null;
      if (kind === 'hotelType') route.days[0]!.hotelPoiId = 'lake';
      expect(validatePlan(plan, request, registry, required).plan).toBeNull();
    },
  );
  it('验证真实日期与输入上限', () => {
    expect(PlanRequestSchema.safeParse({ ...request, startDate: '2026-02-30' }).success).toBe(
      false,
    );
    expect(PlanRequestSchema.safeParse({ ...request, days: 8 }).success).toBe(false);
  });
});
