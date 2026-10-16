import {
  CoordinateSchema,
  type Coordinate,
  type Poi,
  type PlaceSuggestion,
  type Segment,
  type DirectionStep,
  type TravelMode,
  type RoutePoint,
  RoutePointSchema,
} from '@stree/shared';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { belongsToCity } from './regions.js';

type Json = Record<string, any>;
export function parsePolyline(text: unknown): Coordinate[] {
  if (text && typeof text === 'object' && 'polyline' in text) text = text.polyline;
  if (typeof text !== 'string') return [];
  return text
    .split(';')
    .flatMap((point) => {
      const [longitude, latitude] = point.split(',').map(Number);
      const result = CoordinateSchema.safeParse({ longitude, latitude });
      return result.success ? [result.data] : [];
    })
    .filter(
      (point, index, points) =>
        index === 0 ||
        point.longitude !== points[index - 1]?.longitude ||
        point.latitude !== points[index - 1]?.latitude,
    );
}
const stringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const numericValue = (value: unknown): number | null =>
  value !== '' && value != null && !Array.isArray(value) && Number.isFinite(Number(value))
    ? Number(value)
    : null;
const list = (value: unknown): Json[] => (Array.isArray(value) ? value : []);
const durationMinutes = (value: unknown) => {
  const seconds = numericValue(value);
  return seconds === null ? null : Math.ceil(Math.max(0, seconds) / 60);
};
function normalizeDirectionPath(
  path: Json,
  from: RoutePoint,
  to: RoutePoint,
  mode: TravelMode,
): Segment | null {
  const steps: DirectionStep[] = [];
  const appendRoad = (step: Json, roadMode: 'walking' | 'driving' | 'cycling') => {
    const road = stringValue(step.road_name) || stringValue(step.road);
    steps.push({
      mode: roadMode,
      instruction:
        stringValue(step.instruction) ||
        `${roadMode === 'walking' ? '步行' : roadMode === 'cycling' ? '骑行' : '沿道路行驶'}${road ? ` · ${road}` : ''}`,
      name: road,
      distanceMeters: numericValue(step.step_distance ?? step.distance),
      durationMinutes: durationMinutes(step.cost?.duration ?? step.duration),
      polyline: parsePolyline(step.polyline),
    });
  };
  if (mode === 'transit') {
    for (const part of list(path.segments)) {
      // buslines are alternatives for this same ride, not successive transfers.
      const line = list(part.bus?.buslines)[0];
      const walking = part.walking;
      const walkingSteps = list(walking?.steps);
      if (walkingSteps.length) {
        const destination =
          stringValue(line?.departure_stop?.name) ||
          stringValue(part.railway?.departure_stop?.name) ||
          to.name;
        steps.push({
          mode: 'walking',
          name: '步行',
          instruction: `步行至${destination}`,
          instructions: walkingSteps.map((step) => stringValue(step.instruction)).filter(Boolean),
          distanceMeters:
            numericValue(walking.distance) ??
            (walkingSteps.every((step) => numericValue(step.distance) !== null)
              ? walkingSteps.reduce((sum, step) => sum + Number(step.distance), 0)
              : null),
          durationMinutes: durationMinutes(walking.cost?.duration ?? walking.duration),
          polyline: walkingSteps.flatMap((step) => parsePolyline(step.polyline)),
        });
      }
      if (line) {
        const subway =
          /地铁|轨道|subway/i.test(stringValue(line.type)) ||
          /^(地铁|轨道|subway)/i.test(stringValue(line.name));
        steps.push({
          mode: subway ? 'subway' : 'bus',
          name: stringValue(line.name),
          instruction: `乘坐${stringValue(line.name) || (subway ? '地铁' : '公交')}`,
          departureStop: stringValue(line.departure_stop?.name),
          arrivalStop: stringValue(line.arrival_stop?.name),
          stopCount: numericValue(line.via_num) === null ? undefined : Number(line.via_num) + 1,
          viaStops: list(line.via_stops)
            .map((stop) => stringValue(stop.name))
            .filter(Boolean),
          entrance: stringValue(part.entrance?.name),
          exit: stringValue(part.exit?.name),
          distanceMeters: numericValue(line.distance),
          durationMinutes: durationMinutes(line.cost?.duration ?? line.duration),
          polyline: parsePolyline(line.polyline),
        });
      }
      const rail = part.railway;
      if (rail && stringValue(rail.name)) {
        steps.push({
          mode: 'railway',
          name: stringValue(rail.name),
          instruction: `乘坐${rail.name}`,
          departureStop: stringValue(rail.departure_stop?.name),
          arrivalStop: stringValue(rail.arrival_stop?.name),
          viaStops: list(rail.via_stops || rail.via_stop)
            .map((stop) => stringValue(stop.name))
            .filter(Boolean),
          distanceMeters: numericValue(rail.distance),
          durationMinutes: durationMinutes(rail.time),
          polyline: parsePolyline(rail.polyline),
        });
      }
      const taxi = part.taxi;
      if (taxi && numericValue(taxi.distance) !== null) {
        steps.push({
          mode: 'taxi',
          name: '出租车',
          instruction: '乘出租车衔接',
          distanceMeters: numericValue(taxi.distance),
          durationMinutes: durationMinutes(taxi.drivetime ?? taxi.duration),
          polyline: parsePolyline(taxi.polyline),
        });
      }
    }
  } else list(path.steps).forEach((step) => appendRoad(step, mode));
  const points = steps.flatMap((step) => step.polyline);
  const duration = durationMinutes(path.cost?.duration ?? path.duration);
  const measuredDistance = numericValue(path.distance);
  const distance =
    measuredDistance ??
    (steps.length && steps.every((step) => step.distanceMeters !== null)
      ? steps.reduce((sum, step) => sum + (step.distanceMeters || 0), 0)
      : null);
  if (duration === null || distance === null || distance < 0 || points.length < 2) return null;
  const rides = steps.filter((step) => step.mode !== 'walking');
  const roads = [...new Set(steps.map((step) => step.name).filter(Boolean))];
  const mainRoads = new Set(
    roads
      .map((name) => ({
        name,
        distance: steps
          .filter((step) => step.name === name)
          .reduce((sum, step) => sum + (step.distanceMeters || 0), 0),
      }))
      .sort((a, b) => b.distance - a.distance)
      .slice(0, 4)
      .map((road) => road.name),
  );
  return {
    from: from.name,
    to: to.name,
    origin: RoutePointSchema.parse(from),
    destination: RoutePointSchema.parse(to),
    mode,
    durationMinutes: duration,
    distanceMeters: distance,
    price:
      mode === 'walking'
        ? 0
        : mode === 'cycling'
          ? null
          : numericValue(mode === 'transit' ? (path.cost?.transit_fee ?? path.cost) : path.tolls),
    summary:
      mode === 'transit'
        ? rides
            .map((step) => step.name)
            .filter(Boolean)
            .join(' → ') || '公共交通'
        : roads.length
          ? roads.filter((name) => mainRoads.has(name)).join(' → ')
          : mode === 'walking'
            ? '步行前往'
            : mode === 'cycling'
              ? '骑行前往'
              : '驾车前往（费用仅含已知路桥费）',
    polyline: points,
    steps,
    source: 'amap',
    walkingDistanceMeters:
      mode === 'walking'
        ? distance
        : mode === 'transit'
          ? numericValue(path.walking_distance)
          : null,
    ...(mode === 'transit' ? { transfers: Math.max(0, rides.length - 1) } : {}),
    trafficLights: mode === 'driving' ? numericValue(path.traffic_lights) : null,
  };
}
export function normalizePoi(item: Json): Poi | null {
  const location = parsePolyline(item.location)[0];
  if (!location || !item.id || !item.name) return null;
  return {
    id: String(item.id),
    name: String(item.name),
    address: stringValue(item.address),
    district: stringValue(item.adname),
    adcode: stringValue(item.adcode),
    location,
    category: stringValue(item.type),
    phone: stringValue(item.tel) || null,
    openingHours:
      stringValue(item.business?.opentime_today) ||
      stringValue(item.business?.opentime_week) ||
      null,
    referencePrice: numericValue(item.biz_ext?.cost ?? item.business?.cost),
    source: 'amap',
    fetchedAt: new Date().toISOString(),
  };
}

export class AmapService {
  private queue: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;
  private cache = new Map<string, { until: number; data: Json }>();
  constructor(
    private key = config.AMAP_WEB_SERVICE_KEY,
    private intervalMs = config.AMAP_REQUEST_INTERVAL_MS,
    private fetcher: typeof fetch = fetch,
  ) {}
  get configured() {
    return Boolean(this.key);
  }
  async request(
    endpoint: string,
    params: Record<string, string>,
    signal?: AbortSignal,
    cacheOptions: { fresh?: boolean; ttlMs?: number } = {},
  ): Promise<Json> {
    if (!this.key)
      throw new AppError('请先在 backend/.env 配置高德 Web 服务 Key。', 503, 'AMAP_NOT_CONFIGURED');
    const cacheKey = `${endpoint}?${new URLSearchParams(params)}`;
    const cached = this.cache.get(cacheKey);
    if (!cacheOptions.fresh && cached && cached.until > Date.now())
      return structuredClone(cached.data);
    const operation = async () => {
      signal?.throwIfAborted();
      // A matching request may have filled the cache while this one was queued.
      const queuedCache = this.cache.get(cacheKey);
      if (!cacheOptions.fresh && queuedCache && queuedCache.until > Date.now())
        return structuredClone(queuedCache.data);
      const delay = Math.max(0, this.nextRequestAt - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      signal?.throwIfAborted();
      this.nextRequestAt = Date.now() + this.intervalMs;
      const url = new URL(endpoint, 'https://restapi.amap.com');
      url.search = new URLSearchParams({ ...params, key: this.key, output: 'json' }).toString();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new AppError('高德服务连接超时，请稍后重试。', 502, 'AMAP_NETWORK_ERROR');
      }
      if (!response.ok) throw new AppError(`高德服务暂时不可用（HTTP ${response.status}）。`, 502);
      const data = (await response.json()) as Json;
      if (data.status !== '1')
        throw new AppError(
          `高德查询失败：${stringValue(data.info) || 'UNKNOWN_ERROR'}（${stringValue(data.infocode)}）。`,
          502,
          'AMAP_API_ERROR',
        );
      this.cache.set(cacheKey, {
        data,
        until: Date.now() + (cacheOptions.ttlMs ?? 10 * 60 * 1000),
      });
      if (this.cache.size > 1500) this.cache.delete(this.cache.keys().next().value!);
      return structuredClone(data);
    };
    const task = this.queue.then(operation, operation);
    this.queue = task.catch(() => undefined);
    return task;
  }
  async locateDistrict(position: Coordinate, signal?: AbortSignal): Promise<string> {
    // Browser coordinates are WGS84; reverse geocoding requires AMap's coordinates.
    const converted = await this.request(
      '/v3/assistant/coordinate/convert',
      { locations: `${position.longitude},${position.latitude}`, coordsys: 'gps' },
      signal,
    );
    const location = parsePolyline(converted.locations)[0];
    if (!location)
      throw new AppError('暂时无法识别当前位置，请手动选择省市。', 422, 'LOCATION_UNAVAILABLE');
    const data = await this.request(
      '/v3/geocode/regeo',
      { location: `${location.longitude},${location.latitude}`, extensions: 'base' },
      signal,
    );
    const adcode = stringValue(data.regeocode?.addressComponent?.adcode);
    if (!/^\d{6}$/.test(adcode))
      throw new AppError('当前位置暂无可用的省市信息，请手动选择。', 422, 'LOCATION_UNAVAILABLE');
    return adcode;
  }
  async search(
    cityCode: string | undefined,
    keywords: string,
    kind: 'attraction' | 'hotel' | 'any' = 'attraction',
    signal?: AbortSignal,
  ): Promise<Poi[]> {
    const data = await this.request(
      '/v3/place/text',
      {
        keywords,
        ...(cityCode ? { city: cityCode, citylimit: 'true' } : { citylimit: 'false' }),
        offset: '12',
        page: '1',
        extensions: 'all',
        ...(kind === 'hotel'
          ? { types: '100000' }
          : kind === 'attraction'
            ? { types: '110000|140000' }
            : {}),
      },
      signal,
    );
    return (Array.isArray(data.pois) ? data.pois : [])
      .map(normalizePoi)
      .filter((poi: Poi | null): poi is Poi => poi !== null);
  }
  async popularAttractions(cityCode: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
    const data = await this.request(
      '/v5/place/text',
      {
        region: cityCode,
        city_limit: 'true',
        keywords: '景点',
        types: '110000',
        page_size: '12',
        page_num: '1',
      },
      signal,
    );
    const seen = new Set<string>();
    return list(data.pois).flatMap((item) => {
      const location = parsePolyline(item.location)[0];
      const id = stringValue(item.id);
      const name = stringValue(item.name);
      const adcode = stringValue(item.adcode);
      if (!id || !name || !location || !belongsToCity(adcode, cityCode) || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          name,
          location,
          adcode,
          district: [item.cityname, item.adname].map(stringValue).filter(Boolean).join(''),
          address: stringValue(item.address),
        },
      ];
    });
  }
  async suggest(
    cityCode: string | undefined,
    keywords: string,
    signal?: AbortSignal,
  ): Promise<PlaceSuggestion[]> {
    const data = await this.request(
      '/v3/assistant/inputtips',
      {
        keywords,
        ...(cityCode ? { city: cityCode, citylimit: 'true' } : { citylimit: 'false' }),
        datatype: 'poi',
      },
      signal,
    );
    const seen = new Set<string>();
    return (Array.isArray(data.tips) ? data.tips : []).flatMap((item: Json) => {
      const location = parsePolyline(item.location)[0];
      const id = stringValue(item.id);
      const name = stringValue(item.name);
      const adcode = stringValue(item.adcode);
      if (
        !id ||
        !name ||
        !location ||
        (cityCode && !belongsToCity(adcode, cityCode)) ||
        seen.has(id)
      )
        return [];
      seen.add(id);
      return [
        {
          id,
          name,
          location,
          adcode,
          district: stringValue(item.district),
          address: stringValue(item.address),
        },
      ];
    });
  }
  async detail(id: string, signal?: AbortSignal): Promise<Poi | null> {
    const data = await this.request('/v3/place/detail', { id, extensions: 'all' }, signal);
    for (const item of Array.isArray(data.pois) ? data.pois : []) {
      const poi = normalizePoi(item);
      if (poi?.id === id) return poi;
    }
    return null;
  }
  async district(code: string): Promise<Json[]> {
    const data = await this.request('/v3/config/district', {
      keywords: code,
      subdistrict: '1',
      extensions: 'base',
    });
    return Array.isArray(data.districts) ? data.districts : [];
  }
  async leg(
    from: RoutePoint,
    to: RoutePoint,
    mode: TravelMode,
    cityCode: string,
    signal?: AbortSignal,
  ): Promise<Segment> {
    // The planning model chooses each leg's mode. A missing route must be returned to it.
    return (await this.directions(from, to, mode, cityCode, signal))[0]!;
  }
  async directions(
    from: RoutePoint,
    to: RoutePoint,
    mode: TravelMode,
    cityCode: string,
    signal?: AbortSignal,
    options: { fresh?: boolean } = {},
  ): Promise<Segment[]> {
    const endpoint =
      mode === 'walking'
        ? '/v3/direction/walking'
        : mode === 'driving'
          ? '/v3/direction/driving'
          : mode === 'cycling'
            ? '/v5/direction/bicycling'
            : '/v5/direction/transit/integrated';
    const data = await this.request(
      endpoint,
      {
        origin: `${from.location.longitude.toFixed(6)},${from.location.latitude.toFixed(6)}`,
        destination: `${to.location.longitude.toFixed(6)},${to.location.latitude.toFixed(6)}`,
        ...(mode === 'transit'
          ? {
              city1: cityCode,
              city2: cityCode,
              ad1: from.adcode ?? cityCode,
              ad2: to.adcode ?? cityCode,
              strategy: '0',
              AlternativeRoute: '5',
              show_fields: 'cost,polyline',
              ...(from.id && to.id ? { originpoi: from.id, destinationpoi: to.id } : {}),
            }
          : mode === 'driving'
            ? { extensions: 'all', strategy: '10' }
            : mode === 'cycling'
              ? { show_fields: 'cost,polyline', alternative_route: '3' }
              : {}),
      },
      signal,
      { fresh: options.fresh, ttlMs: 60_000 },
    );
    const paths = list(mode === 'transit' ? data.route?.transits : data.route?.paths);
    if (!paths.length)
      throw new AppError(
        `${from.name} 到 ${to.name} 暂无可用${mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : mode === 'cycling' ? '骑行' : '驾车'}路线，请调整出行方式或地点。`,
        422,
        'NO_ROUTE',
      );
    const routes = paths
      .map((path) => normalizeDirectionPath(path, from, to, mode))
      .filter((segment): segment is Segment => segment !== null)
      .slice(0, mode === 'transit' ? 5 : 3);
    if (!routes.length)
      throw new AppError(
        `${from.name} 到 ${to.name} 的高德路径数据不完整，请更换交通方式。`,
        502,
        'INCOMPLETE_ROUTE',
      );
    return routes;
  }
}
