import type { LocationPoint, MapRouteResponse, RouteSegment } from "../types";

type Mode = "walking" | "driving" | "transfer";
type Coordinate = [number, number];

export interface AMapRoutePlanResult {
  response: MapRouteResponse;
  services: any[];
}

export async function planStopsRouteWithAmap(payload: {
  AMap: any;
  map: any;
  origin: LocationPoint;
  stops: LocationPoint[];
  mode: Mode;
}): Promise<AMapRoutePlanResult> {
  const services: any[] = [];
  const segments: RouteSegment[] = [];
  let totalDuration = 0;
  let totalDistance = 0;
  let totalPrice = 0;
  let hasPrice = false;

  let previous = payload.origin;
  for (const stop of payload.stops) {
    const service = createRouteService(payload.AMap, payload.map, payload.mode);
    services.push(service);

    const segment = await searchLeg({
      AMap: payload.AMap,
      service,
      mode: payload.mode,
      start: previous,
      end: stop
    });
    segments.push(segment);

    if (segment.duration_minutes != null) {
      totalDuration += segment.duration_minutes;
    }
    if (segment.distance_meters != null) {
      totalDistance += segment.distance_meters;
    }
    if (segment.price != null) {
      totalPrice += segment.price;
      hasPrice = true;
    }

    previous = stop;
  }

  const summaryParts = [`高德${modeLabel(payload.mode)}共 ${segments.length} 段`];
  if (totalDuration) {
    summaryParts.push(`总耗时约 ${totalDuration} 分钟`);
  }
  if (totalDistance) {
    summaryParts.push(`总距离约 ${(totalDistance / 1000).toFixed(1)} km`);
  }
  if (payload.mode === "walking") {
    summaryParts.push("总费用约 0 元");
  } else if (hasPrice) {
    summaryParts.push(`总费用约 ${Math.round(totalPrice)} 元`);
  }

  return {
    response: {
      mode: payload.mode,
      requested_mode: payload.mode,
      summary: summaryParts.join(" · "),
      total_duration_minutes: totalDuration || null,
      total_distance_meters: totalDistance || null,
      total_price: payload.mode === "walking" ? 0 : hasPrice ? roundPrice(totalPrice) : null,
      render_source: "amap-js",
      segments
    },
    services
  };
}

function createRouteService(AMap: any, map: any, mode: Mode) {
  if (mode === "walking") {
    return new AMap.Walking({
      map,
      hideMarkers: true,
      autoFitView: false
    });
  }
  if (mode === "driving") {
    return new AMap.Driving({
      map,
      hideMarkers: true,
      autoFitView: false
    });
  }
  return new AMap.Transfer({
    map,
    hideMarkers: true,
    autoFitView: false,
    city: "北京市"
  });
}

async function searchLeg(payload: {
  AMap: any;
  service: any;
  mode: Mode;
  start: LocationPoint;
  end: LocationPoint;
}): Promise<RouteSegment> {
  const result = await new Promise<any>((resolve, reject) => {
    payload.service.search(
      [payload.start.longitude, payload.start.latitude],
      [payload.end.longitude, payload.end.latitude],
      (status: string, response: any) => {
        if (status === "complete") {
          resolve(response);
          return;
        }
        reject(new Error(response?.info || `高德${modeLabel(payload.mode)}规划失败`));
      }
    );
  });

  if (payload.mode === "walking") {
    return parseWalkingResult(result, payload.start.name, payload.end.name);
  }
  if (payload.mode === "driving") {
    return parseDrivingResult(result, payload.start.name, payload.end.name);
  }
  return parseTransferResult(result, payload.start.name, payload.end.name);
}

function parseWalkingResult(result: any, fromName: string, toName: string): RouteSegment {
  const route = result?.routes?.[0] ?? result?.route ?? {};
  const duration = toMinutes(route.time ?? route.duration);
  const distance = toInt(route.distance);
  const polyline = collectStepPath(route.steps);
  return {
    from_name: fromName,
    to_name: toName,
    mode: "walking",
    summary: buildSummary("步行", duration, distance, 0),
    duration_minutes: duration,
    distance_meters: distance,
    price: 0,
    polyline
  };
}

function parseDrivingResult(result: any, fromName: string, toName: string): RouteSegment {
  const route = result?.routes?.[0] ?? result?.route ?? {};
  const duration = toMinutes(route.time ?? route.duration);
  const distance = toInt(route.distance);
  const tolls = toFloat(route.tolls);
  const polyline = collectStepPath(route.steps);
  return {
    from_name: fromName,
    to_name: toName,
    mode: "driving",
    summary: buildSummary("驾车", duration, distance, tolls),
    duration_minutes: duration,
    distance_meters: distance,
    price: tolls ?? 0,
    polyline
  };
}

function parseTransferResult(result: any, fromName: string, toName: string): RouteSegment {
  const plan = result?.plans?.[0] ?? {};
  const segments = Array.isArray(plan.segments) ? plan.segments : [];
  const duration = toMinutes(plan.time ?? plan.duration);
  const distance = toInt(plan.distance);
  const price = toFloat(plan.cost);
  const lineNames: string[] = [];
  const polyline: Array<{ longitude: number; latitude: number }> = [];

  for (const segment of segments) {
    polyline.push(...collectStepPath(segment?.walking?.steps ?? []));

    const buses = segment?.transit?.lines ?? segment?.bus?.buslines ?? [];
    for (const bus of buses) {
      const name = String(bus?.name || "").trim();
      if (name) {
        lineNames.push(name);
      }
      polyline.push(...decodePath(bus?.path ?? bus?.polyline));
    }
  }

  const summaryParts = [buildSummary("公交 / 地铁", duration, distance, price)];
  if (lineNames.length) {
    summaryParts.push(lineNames.slice(0, 4).join(" → "));
  }

  return {
    from_name: fromName,
    to_name: toName,
    mode: "transfer",
    summary: summaryParts.join(" · "),
    duration_minutes: duration,
    distance_meters: distance,
    price,
    polyline: dedupePath(polyline)
  };
}

function collectStepPath(steps: any): Array<{ longitude: number; latitude: number }> {
  if (!Array.isArray(steps)) {
    return [];
  }
  const path: Array<{ longitude: number; latitude: number }> = [];
  for (const step of steps) {
    path.push(...decodePath(step?.path ?? step?.polyline));
  }
  return dedupePath(path);
}

function decodePath(value: any): Array<{ longitude: number; latitude: number }> {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((point) => {
        if (Array.isArray(point) && point.length >= 2) {
          return {
            longitude: Number(point[0]),
            latitude: Number(point[1])
          };
        }
        if (typeof point?.getLng === "function" && typeof point?.getLat === "function") {
          return {
            longitude: Number(point.getLng()),
            latitude: Number(point.getLat())
          };
        }
        if ("lng" in (point || {}) && "lat" in (point || {})) {
          return {
            longitude: Number(point.lng),
            latitude: Number(point.lat)
          };
        }
        return null;
      })
      .filter((point): point is { longitude: number; latitude: number } => Boolean(point));
  }

  if (typeof value === "string") {
    return value
      .split(";")
      .map((item) => {
        const [longitude, latitude] = item.split(",");
        if (!longitude || !latitude) {
          return null;
        }
        return {
          longitude: Number(longitude),
          latitude: Number(latitude)
        };
      })
      .filter((point): point is { longitude: number; latitude: number } => Boolean(point));
  }

  return [];
}

function dedupePath(points: Array<{ longitude: number; latitude: number }>) {
  return points.filter((point, index) => {
    if (index === 0) {
      return true;
    }
    const previous = points[index - 1];
    return previous.longitude !== point.longitude || previous.latitude !== point.latitude;
  });
}

function buildSummary(mode: string, duration: number | null, distance: number | null, price: number | null) {
  const parts = [`${mode}路线`];
  if (duration != null) {
    parts.push(`约 ${duration} 分钟`);
  }
  if (distance != null) {
    parts.push(distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${distance} m`);
  }
  if (price != null && price > 0) {
    parts.push(`费用约 ${Math.round(price)} 元`);
  }
  return parts.join(" · ");
}

function toMinutes(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return Math.round(seconds / 60);
}

function toInt(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function toFloat(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? roundPrice(number) : null;
}

function roundPrice(value: number) {
  return Math.round(value * 100) / 100;
}

function modeLabel(mode: Mode) {
  if (mode === "walking") {
    return "步行路线";
  }
  if (mode === "driving") {
    return "驾车路线";
  }
  return "公交路线";
}
