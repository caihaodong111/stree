import type { Route, RoutePoint, Trip } from './index.js';

/** Resolve the requested places, not navigation's snapped entrance coordinates. */
export function getSegmentEndpoints(
  trip: Trip,
  route: Route,
  dayIndex: number,
  segmentIndex: number,
): { origin: RoutePoint; destination: RoutePoint } | null {
  const day = route.days[dayIndex];
  const segment = day?.segments[segmentIndex];
  if (!day || !segment) return null;
  if (segment.origin && segment.destination)
    return { origin: segment.origin, destination: segment.destination };
  const pairs: Array<{ origin: RoutePoint; destination: RoutePoint }> = [];
  let from: RoutePoint | null =
    day.day === 1
      ? { ...trip.origin, ...(trip.request.originPoiId ? { id: trip.request.originPoiId } : {}) }
      : (route.days[dayIndex - 1]?.hotel ?? null);
  for (const stop of day.stops) {
    const to = stop.poi;
    if (
      from &&
      (from.location.longitude !== to.location.longitude ||
        from.location.latitude !== to.location.latitude)
    )
      pairs.push({ origin: from, destination: to });
    from = to;
  }
  if (from && day.hotel) pairs.push({ origin: from, destination: day.hotel });
  const pair = pairs[segmentIndex];
  // Position keeps different POIs with the same name distinct.
  if (pair && pair.origin.name === segment.from && pair.destination.name === segment.to)
    return pair;
  const start = segment.polyline[0];
  const end = segment.polyline.at(-1);
  return start && end
    ? {
        origin: { name: segment.from, location: start },
        destination: { name: segment.to, location: end },
      }
    : null;
}
