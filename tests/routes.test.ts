import { describe, expect, it } from 'vitest';
import { getSegmentEndpoints } from '@stree/shared';
import { poi, tripFixture } from './fixtures/travel.js';

describe('交通查询与高德跳转使用同一地点', () => {
  it('历史首段恢复原始出发点和 POI ID，不使用偏移后的导航折线', () => {
    const trip = tripFixture();
    const route = trip.routes[0]!;
    trip.request.originPoiId = 'station-id';
    route.days[0]!.segments[0]!.from = trip.origin.name;
    const endpoints = getSegmentEndpoints(trip, route, 0, 0)!;
    expect(endpoints.origin).toEqual({ ...trip.origin, id: 'station-id' });
    expect(endpoints.destination).toEqual(route.days[0]!.stops[0]!.poi);
    expect(endpoints.destination.location).not.toEqual(route.days[0]!.segments[0]!.polyline.at(-1));
  });
  it('按站点顺序匹配同名地点，跳过同坐标站点并保留次日酒店出发段', () => {
    const trip = tripFixture();
    const route = trip.routes[0]!;
    const day = route.days[0]!;
    day.segments[0]!.from = trip.origin.name;
    day.stops[0]!.poi = poi('first-id', '同名地点');
    day.stops[1]!.poi = poi('second-id', '同名地点');
    day.segments[0]!.to = '同名地点';
    day.segments[1]!.from = '同名地点';
    day.segments[1]!.to = '同名地点';
    expect(getSegmentEndpoints(trip, route, 0, 1)!.origin.id).toBe('first-id');
    expect(getSegmentEndpoints(trip, route, 0, 1)!.destination.id).toBe('second-id');
    day.stops.splice(1, 0, structuredClone(day.stops[0]!));
    expect(getSegmentEndpoints(trip, route, 0, 1)!.destination.id).toBe('second-id');
    route.days[1]!.segments[0]!.from = day.hotel!.name;
    expect(getSegmentEndpoints(trip, route, 1, 0)!.origin.id).toBe(day.hotel!.id);
  });
  it('新行程保留准确端点，旧行程缺少对应站点时使用存储路径作为回退', () => {
    const trip = tripFixture();
    const route = trip.routes[0]!;
    const segment = route.days[0]!.segments[0]!;
    expect(getSegmentEndpoints(trip, route, 0, 0)!.origin.location).toEqual(segment.polyline[0]);
    segment.origin = { name: '新起点', id: 'origin-id', location: trip.origin.location };
    segment.destination = { name: '新终点', id: 'destination-id', location: trip.city.center };
    expect(getSegmentEndpoints(trip, route, 0, 0)).toEqual({
      origin: segment.origin,
      destination: segment.destination,
    });
  });
});
