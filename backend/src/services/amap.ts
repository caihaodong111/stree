import {
  CoordinateSchema,
  type Coordinate,
  type Poi,
  type Segment,
  type TravelMode,
} from '@stree/shared';
import { config } from '../config.js';
import { AppError } from '../errors.js';

type Json = Record<string, any>;
export function parsePolyline(text: unknown): Coordinate[] {
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
  ): Promise<Json> {
    if (!this.key)
      throw new AppError('请先在 backend/.env 配置高德 Web 服务 Key。', 503, 'AMAP_NOT_CONFIGURED');
    const cacheKey = `${endpoint}?${new URLSearchParams(params)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.until > Date.now()) return structuredClone(cached.data);
    const operation = async () => {
      signal?.throwIfAborted();
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
      this.cache.set(cacheKey, { data, until: Date.now() + 10 * 60 * 1000 });
      if (this.cache.size > 1500) this.cache.delete(this.cache.keys().next().value!);
      return structuredClone(data);
    };
    const task = this.queue.then(operation, operation);
    this.queue = task.catch(() => undefined);
    return task;
  }
  async search(
    cityCode: string,
    keywords: string,
    kind: 'attraction' | 'hotel' | 'any' = 'attraction',
    signal?: AbortSignal,
  ): Promise<Poi[]> {
    const data = await this.request(
      '/v3/place/text',
      {
        keywords,
        city: cityCode,
        citylimit: 'true',
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
  async district(code: string): Promise<Json[]> {
    const data = await this.request('/v3/config/district', {
      keywords: code,
      subdistrict: '1',
      extensions: 'base',
    });
    return Array.isArray(data.districts) ? data.districts : [];
  }
  async leg(
    from: { name: string; location: Coordinate },
    to: { name: string; location: Coordinate },
    mode: TravelMode,
    cityCode: string,
    signal?: AbortSignal,
  ): Promise<Segment> {
    const endpoint =
      mode === 'walking'
        ? '/v3/direction/walking'
        : mode === 'driving'
          ? '/v3/direction/driving'
          : '/v3/direction/transit/integrated';
    const data = await this.request(
      endpoint,
      {
        origin: `${from.location.longitude.toFixed(6)},${from.location.latitude.toFixed(6)}`,
        destination: `${to.location.longitude.toFixed(6)},${to.location.latitude.toFixed(6)}`,
        ...(mode === 'transit'
          ? { city: cityCode, cityd: cityCode, extensions: 'all', strategy: '0' }
          : {}),
      },
      signal,
    );
    const path = mode === 'transit' ? data.route?.transits?.[0] : data.route?.paths?.[0];
    if (!path && mode === 'transit') {
      // Nearby stops often have no transit itinerary. Verify the walking path with AMap.
      const walking = await this.leg(from, to, 'walking', cityCode, signal);
      if (walking.distanceMeters <= 3000 && walking.durationMinutes <= 45) return walking;
    }
    if (!path)
      throw new AppError(
        `${from.name} 到 ${to.name} 暂无可用${mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : '驾车'}路线，请调整出行方式或地点。`,
        422,
        'NO_ROUTE',
      );
    const points: Coordinate[] = [];
    const lineNames: string[] = [];
    if (mode === 'transit') {
      for (const part of path.segments ?? []) {
        for (const step of part.walking?.steps ?? []) points.push(...parsePolyline(step.polyline));
        for (const line of part.bus?.buslines ?? []) {
          points.push(...parsePolyline(line.polyline));
          if (line.name) lineNames.push(String(line.name));
        }
        for (const line of part.railway?.via_stops ?? [])
          points.push(...parsePolyline(line.location));
      }
    } else for (const step of path.steps ?? []) points.push(...parsePolyline(step.polyline));
    const duration = numericValue(path.duration);
    const distance = numericValue(path.distance);
    if (duration === null || distance === null || points.length < 2)
      throw new AppError(
        `${from.name} 到 ${to.name} 的高德路径数据不完整，请更换交通方式。`,
        502,
        'INCOMPLETE_ROUTE',
      );
    const price =
      mode === 'walking' ? 0 : numericValue(mode === 'transit' ? path.cost : path.tolls);
    return {
      from: from.name,
      to: to.name,
      mode,
      durationMinutes: Math.ceil(duration / 60),
      distanceMeters: distance,
      price,
      summary: lineNames.length
        ? [...new Set(lineNames)].slice(0, 4).join(' → ')
        : mode === 'walking'
          ? '步行前往'
          : mode === 'driving'
            ? '驾车前往（费用仅含已知路桥费）'
            : '公共交通',
      polyline: points,
      source: 'amap',
    };
  }
}
