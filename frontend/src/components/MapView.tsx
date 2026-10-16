import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  Bike,
  BusFront,
  CarFront,
  ChevronDown,
  Clock3,
  ExternalLink,
  Footprints,
  PersonStanding,
  Layers,
  Map as MapIcon,
  MapPin,
  RefreshCw,
  Route as RouteIcon,
  TrainFront,
} from 'lucide-react';
import type {
  DirectionStep,
  DirectionsResponse,
  Route,
  Segment,
  TravelMode,
  Trip,
} from '@stree/shared';
import { loadAmap } from '../lib/amap';
import { api } from '../api';
import { getSegmentEndpoints } from '@stree/shared';

const modes = [
  { id: 'driving', label: '驾车', icon: CarFront },
  { id: 'transit', label: '公交 / 地铁', icon: BusFront },
  { id: 'walking', label: '步行', icon: Footprints },
  { id: 'cycling', label: '骑行', icon: Bike },
] as const;
const stepIcons = {
  walking: PersonStanding,
  driving: CarFront,
  cycling: Bike,
  bus: BusFront,
  subway: TrainFront,
  railway: TrainFront,
  taxi: CarFront,
};
const stepColors = {
  walking: '#b3bac2',
  driving: '#16a05d',
  cycling: '#168bff',
  bus: '#3478ff',
  subway: '#eb80bc',
  railway: '#3478ff',
  taxi: '#f6a623',
};
export const formatDistance = (meters: number) =>
  meters < 1000 ? `${Math.round(meters)} 米` : `${(meters / 1000).toFixed(1)} 公里`;
const formatTime = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60 ? `${minutes % 60} 分钟` : ''}`.trim()
    : `${minutes} 分钟`;
const compactTime = (minutes: number) => formatTime(minutes).replaceAll(' ', '');
const compactDistance = (meters: number) => formatDistance(meters).replaceAll(' ', '');
const shortLineName = (name: string) => name.replace(/[（(].*$/, '').replace(/^地铁/, '');
const subwayColors: Record<string, string> = {
  '1号线': '#bc3d32',
  '2号线': '#256cac',
  '4号线': '#008f96',
  '5号线': '#a92984',
  '6号线': '#cf990e',
  '7号线': '#d78b35',
  '8号线': '#13843b',
  昌平线: '#eb80bc',
  '9号线': '#77a239',
  '10号线': '#278fba',
  '13号线': '#d49b12',
  '14号线': '#b28686',
  '15号线': '#6f4391',
};

const getStepColor = (step: DirectionStep) =>
  step.mode === 'subway'
    ? subwayColors[shortLineName(step.name)] || stepColors.subway
    : stepColors[step.mode];

type Props = {
  trip: Trip;
  route: Route;
  dayIndex: number;
  selectedPoi: string | null;
  onSelect: (id: string) => void;
};
export default function MapView({ trip, route, dayIndex, selectedPoi, onSelect }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const detailBackRef = useRef<HTMLButtonElement>(null);
  const listScrollRef = useRef(0);
  const wasDetailRef = useRef(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const amapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const markersRef = useRef<Map<string, any>>(new globalThis.Map());
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const cache = useRef(new globalThis.Map<string, DirectionsResponse>());
  const forceRefresh = useRef(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const day = route.days[dayIndex];
  const [legIndex, setLegIndex] = useState(0);
  const leg = day?.segments[legIndex];
  const [mode, setMode] = useState<TravelMode>(leg?.mode || trip.request.transport);
  const [optionIndex, setOptionIndex] = useState(0);
  const [overview, setOverview] = useState(false);
  const [response, setResponse] = useState<{ key: string; data: DirectionsResponse } | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [retry, setRetry] = useState(0);
  const queryKey = `${trip.id}:${trip.updatedAt}:${route.id}:${dayIndex}:${legIndex}:${mode}`;
  const currentResponse = response?.key === queryKey ? response.data : null;
  const options = currentResponse?.routes || (leg?.mode === mode ? [leg] : []);
  const activeRoute = options[optionIndex] || options[0];
  const activeSteps = activeRoute?.steps || [];
  const showDetails = detailKey === queryKey && Boolean(activeRoute);
  const fastestIndex =
    options.length > 1
      ? options.findIndex(
          (option) =>
            option.durationMinutes === Math.min(...options.map((item) => item.durationMinutes)),
        )
      : -1;
  const knownWalks = options.flatMap((option) =>
    option.walkingDistanceMeters == null ? [] : [option.walkingDistanceMeters],
  );
  const leastWalkingIndex =
    new Set(knownWalks).size > 1
      ? options.findIndex((option) => option.walkingDistanceMeters === Math.min(...knownWalks))
      : -1;

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    const render = async () => {
      try {
        const AMap = await loadAmap(['AMap.Scale', 'AMap.ToolBar']);
        if (disposed || !element.current || !day) return;
        amapRef.current = AMap;
        const map = new AMap.Map(element.current, {
          viewMode: '2D',
          zoom: 12,
          center: [trip.city.center.longitude, trip.city.center.latitude],
          mapStyle: 'amap://styles/normal',
        });
        mapRef.current = map;
        map.addControl(new AMap.Scale());
        map.addControl(new AMap.ToolBar({ position: 'RB' }));
        setLoading(false);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : '地图加载失败');
          setLoading(false);
        }
      }
    };
    void render();
    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
      overlaysRef.current = [];
      markersRef.current.clear();
    };
  }, [trip.id, trip.updatedAt, route.id, dayIndex, attempt]);

  useEffect(() => {
    if (!leg) return;
    const controller = new AbortController();
    let disposed = false;
    setRouteError('');
    setDetailKey(null);
    resultsRef.current?.scrollTo({ top: 0 });
    setOptionIndex(0);
    const cached = cache.current.get(queryKey);
    const fresh = forceRefresh.current;
    forceRefresh.current = false;
    if (!fresh && cached && Date.now() - Date.parse(cached.fetchedAt) < 60_000) {
      setResponse({ key: queryKey, data: cached });
      setRouteBusy(false);
      return;
    }
    setRouteBusy(true);
    void api
      .directions(trip.id, route.id, dayIndex, legIndex, mode, controller.signal, fresh)
      .then((data) => {
        if (disposed) return;
        cache.current.set(queryKey, data);
        setResponse({ key: queryKey, data });
      })
      .catch((err) => {
        if (!disposed) setRouteError(err instanceof Error ? err.message : '路线查询失败，请重试。');
      })
      .finally(() => {
        if (!disposed) setRouteBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [queryKey, retry]);

  useEffect(() => {
    if (showDetails) detailBackRef.current?.focus({ preventScroll: true });
    else if (wasDetailRef.current && resultsRef.current) {
      resultsRef.current.scrollTop = listScrollRef.current;
      resultsRef.current
        .querySelector<HTMLButtonElement>(`[aria-label="查看方案${optionIndex + 1}详情"]`)
        ?.focus({ preventScroll: true });
    }
    wasDetailRef.current = showDetails;
  }, [showDetails]);

  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (loading || !map || !AMap || !day) return;
    if (overlaysRef.current.length) map.remove?.(overlaysRef.current);
    const overlays: any[] = [];
    const focused: any[] = [];
    markersRef.current.clear();
    const draw = (path: Segment['polyline'], color: string, muted = false, walking = false) => {
      if (path.length < 2) return;
      const polyline = new AMap.Polyline({
        path: path.map((p) => [p.longitude, p.latitude]),
        strokeColor: color,
        strokeWeight: muted ? 4 : 7,
        strokeOpacity: muted ? 0.32 : 0.95,
        strokeStyle: walking ? 'dashed' : 'solid',
        showDir: !muted && !walking,
        lineJoin: 'round',
        zIndex: muted ? 30 : 60,
        outlineColor: '#ffffff',
        isOutline: !muted,
        borderWeight: 2,
      });
      overlays.push(polyline);
      if (!muted) focused.push(polyline);
    };
    if (overview)
      day.segments.forEach((segment) => {
        if (segment.steps?.length)
          segment.steps.forEach((step) =>
            draw(step.polyline, getStepColor(step), !overview, step.mode === 'walking'),
          );
        else
          draw(
            segment.polyline,
            stepColors[segment.mode === 'transit' ? 'bus' : segment.mode],
            !overview,
            segment.mode === 'walking',
          );
      });
    if (!overview && activeRoute) {
      if (activeSteps.length)
        activeSteps.forEach((step) =>
          draw(step.polyline, getStepColor(step), false, step.mode === 'walking'),
        );
      else
        draw(
          activeRoute.polyline,
          stepColors[activeRoute.mode === 'transit' ? 'bus' : activeRoute.mode],
          false,
          activeRoute.mode === 'walking',
        );
      const endpoints = [activeRoute.polyline[0], activeRoute.polyline.at(-1)];
      endpoints.forEach((point, index) => {
        if (!point) return;
        const content = document.createElement('span');
        content.className = `map-endpoint ${index ? 'destination' : 'origin'}`;
        content.textContent = index ? '终' : '起';
        const marker = new AMap.Marker({
          position: [point.longitude, point.latitude],
          content,
          offset: new AMap.Pixel(-14, -14),
          zIndex: 130,
        });
        overlays.push(marker);
        focused.push(marker);
      });
      activeSteps
        .filter((step) => step.mode === 'bus' || step.mode === 'subway')
        .forEach((step) => {
          [step.polyline[0], step.polyline.at(-1)].forEach((point, index) => {
            if (!point) return;
            const content = document.createElement('span');
            content.className = 'map-transit-station';
            content.textContent = index ? '下' : '上';
            content.title = (index ? step.arrivalStop : step.departureStop) || step.name;
            content.style.borderColor = getStepColor(step);
            overlays.push(
              new AMap.Marker({
                position: [point.longitude, point.latitude],
                content,
                offset: new AMap.Pixel(-10, -10),
                zIndex: 120,
              }),
            );
          });
        });
    }
    day.stops.forEach((stop, index) => {
      const content = document.createElement('button');
      content.className = 'map-pin';
      content.textContent = String(index + 1);
      content.title = stop.poi.name;
      content.setAttribute('aria-label', stop.poi.name);
      const marker = new AMap.Marker({
        position: [stop.poi.location.longitude, stop.poi.location.latitude],
        content,
        offset: new AMap.Pixel(-17, -17),
        zIndex: 110,
      });
      marker.on('click', () => selectRef.current(stop.poiId));
      markersRef.current.set(stop.poiId, marker);
      overlays.push(marker);
    });
    if (day.hotel)
      overlays.push(
        new AMap.Marker({
          position: [day.hotel.location.longitude, day.hotel.location.latitude],
          label: { content: '住宿', direction: 'top' },
        }),
      );
    map.add(overlays);
    overlaysRef.current = overlays;
    const fit = !overview && focused.length ? focused : overlays;
    if (fit.length)
      map.setFitView(fit, false, [
        70,
        70,
        window.innerWidth <= 700 ? 50 : window.innerWidth <= 900 ? 344 : 410,
        50,
      ]);
  }, [loading, day, overview, legIndex, activeRoute, currentResponse, optionIndex]);

  useEffect(() => {
    if (!selectedPoi) return;
    const marker = markersRef.current.get(selectedPoi);
    if (marker && mapRef.current) mapRef.current.panTo(marker.getPosition());
  }, [selectedPoi, loading, activeRoute]);

  if (!day) return null;
  const endpoints = getSegmentEndpoints(trip, route, dayIndex, legIndex);
  const firstPoint = endpoints?.origin.location;
  const lastPoint = endpoints?.destination.location;
  const mapLink =
    leg && firstPoint && lastPoint
      ? mode === 'transit'
        ? `https://www.amap.com/ssr/dir?${new URLSearchParams({ fname: leg.from, flat: String(firstPoint.latitude), flon: String(firstPoint.longitude), ...(endpoints?.origin.id ? { fid: endpoints.origin.id } : {}), dname: leg.to, dlat: String(lastPoint.latitude), dlon: String(lastPoint.longitude), ...(endpoints?.destination.id ? { did: endpoints.destination.id } : {}), type: '1', policy: '0', dateTime: 'now' })}`
        : `https://uri.amap.com/navigation?${new URLSearchParams({ from: `${firstPoint.longitude},${firstPoint.latitude},${leg.from}`, to: `${lastPoint.longitude},${lastPoint.latitude},${leg.to}`, mode: mode === 'walking' ? 'walk' : mode === 'cycling' ? 'ride' : 'car', policy: '0', src: 'stree', callnative: mode === 'cycling' ? '1' : '0' })}`
      : null;
  return (
    <section className="map-panel directions-panel" aria-label="交通路线">
      <div className="map-topline">
        <span>
          <RouteIcon size={15} /> 交通路线{' '}
          <small>{activeRoute?.source === 'ai' ? 'AI 出行建议' : '高德地图提供'}</small>
        </span>
        <span>DAY {String(day.day).padStart(2, '0')}</span>
      </div>
      <div className="directions-layout">
        <aside className={`directions-sidebar${showDetails ? ' is-detail' : ''}`}>
          {showDetails && activeRoute && leg ? (
            <>
              <button
                type="button"
                className="directions-detail-back"
                ref={detailBackRef}
                aria-label="返回路线列表"
                onClick={() => setDetailKey(null)}
              >
                <ArrowLeft size={18} /> 路线详情
                <span>方案 {optionIndex + 1}</span>
              </button>
              <div className="directions-detail-body" key={`${queryKey}:${optionIndex}`}>
                <div className="directions-detail-overview">
                  <RouteSummary
                    option={activeRoute}
                    badge={mode === 'transit' && optionIndex === 0 ? '推荐' : ''}
                  />
                </div>
                <ol className="direction-steps" aria-label="路线分段指引">
                  <li className="direction-step direction-terminal">
                    <span className="direction-step-icon origin-dot">起</span>
                    <strong>{leg.from}</strong>
                  </li>
                  {activeSteps.map((step, index) => (
                    <StepDetail
                      key={index}
                      step={step}
                      transfer={
                        step.mode === 'walking' &&
                        activeSteps[index - 1]?.arrivalStop !== undefined &&
                        activeSteps[index - 1]?.arrivalStop ===
                          activeSteps[index + 1]?.departureStop
                      }
                    />
                  ))}
                  <li className="direction-step direction-terminal">
                    <span className="direction-step-icon destination-dot">终</span>
                    <strong>{leg.to}</strong>
                  </li>
                </ol>
                {!activeSteps.length && (
                  <p className="direction-legacy-note">
                    {activeRoute.summary}。
                    {routeBusy
                      ? '正在补充分段指引。'
                      : '此行程未保存逐步指引，可返回列表刷新路线。'}
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="transport-tabs" role="tablist" aria-label="路段交通方式">
                {modes.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={mode === id}
                    className={mode === id ? 'active' : ''}
                    disabled={!leg}
                    aria-label={label}
                    title={label}
                    onClick={() => {
                      setMode(id);
                      setOptionIndex(0);
                      setOverview(false);
                    }}
                  >
                    <Icon size={19} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              {leg ? (
                <>
                  <label
                    className="directions-leg-selector"
                    htmlFor={`traffic-leg-${route.id}-${day.day}`}
                  >
                    行程路段{' '}
                    <span>
                      {legIndex + 1} / {day.segments.length}
                    </span>
                    <div className="select-wrap">
                      <select
                        id={`traffic-leg-${route.id}-${day.day}`}
                        value={legIndex}
                        onChange={(event) => {
                          const index = Number(event.target.value);
                          setLegIndex(index);
                          setMode(day.segments[index]!.mode);
                          setOptionIndex(0);
                          setOverview(false);
                        }}
                      >
                        {day.segments.map((segment, index) => (
                          <option key={index} value={index}>
                            {index + 1}. {segment.from} → {segment.to}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </div>
                  </label>
                  <div className="directions-endpoints">
                    <div>
                      <i className="origin-dot" />
                      <span>{leg.from}</span>
                    </div>
                    <ArrowDown size={12} />
                    <div>
                      <i className="destination-dot" />
                      <span>{leg.to}</span>
                    </div>
                  </div>
                  <div className="directions-policy">
                    <span>{mode === 'transit' ? '高德推荐 · 现在出发' : '现在出发'}</span>
                    <button
                      type="button"
                      disabled={routeBusy}
                      onClick={() => {
                        cache.current.delete(queryKey);
                        forceRefresh.current = true;
                        setRetry((value) => value + 1);
                      }}
                      aria-label="刷新路线"
                    >
                      <RefreshCw size={12} />
                      刷新
                    </button>
                  </div>
                  <div className="directions-results" ref={resultsRef}>
                    <div className="directions-results-heading">
                      <span>
                        {routeBusy
                          ? '正在查询高德路线…'
                          : currentResponse
                            ? `${options.length} 条可选路线`
                            : activeRoute?.source === 'ai'
                              ? 'AI 出行建议 · 供参考'
                              : '行程中的交通路线'}
                      </span>
                      {routeBusy && <RefreshCw size={13} className="spin" />}
                    </div>
                    {routeError && (
                      <div className="directions-query-error" role="status">
                        <p>{routeError}</p>
                        {options.length > 0 && <p>下方显示行程保存的路线。</p>}
                        <button
                          type="button"
                          onClick={() => {
                            forceRefresh.current = true;
                            setRetry((value) => value + 1);
                          }}
                        >
                          重新查询
                        </button>
                      </div>
                    )}
                    {!options.length && routeBusy && (
                      <div className="directions-placeholder">
                        <RefreshCw size={19} className="spin" />
                        <p>正在查找{modes.find((item) => item.id === mode)?.label}方案</p>
                      </div>
                    )}
                    {options.map((option, index) => (
                      <div className="direction-option-card" key={index}>
                        <button
                          type="button"
                          className={`direction-option${optionIndex === index ? ' selected' : ''}`}
                          aria-pressed={optionIndex === index}
                          onClick={() => {
                            setOptionIndex(index);
                            setOverview(false);
                          }}
                        >
                          <RouteSummary
                            option={option}
                            badge={
                              currentResponse && index === 0 && mode === 'transit'
                                ? '推荐'
                                : index === fastestIndex
                                  ? '最快'
                                  : index === leastWalkingIndex
                                    ? '步行少'
                                    : currentResponse
                                      ? `方案 ${index + 1}`
                                      : '已规划'
                            }
                            badgeTitle={
                              index === fastestIndex
                                ? '当前可选方案中用时最短'
                                : index === leastWalkingIndex
                                  ? '当前可选方案中步行距离最少'
                                  : undefined
                            }
                          />
                        </button>
                        <button
                          type="button"
                          className="direction-option-link"
                          aria-label={`查看方案${index + 1}详情`}
                          onClick={() => {
                            setOptionIndex(index);
                            setOverview(false);
                            listScrollRef.current = resultsRef.current?.scrollTop || 0;
                            setDetailKey(queryKey);
                          }}
                        >
                          详情
                        </button>
                      </div>
                    ))}
                    {!routeBusy && currentResponse && !options.length && (
                      <p className="direction-legacy-note">
                        高德未返回此交通方式的路线，请选择其他方式。
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <div className="directions-placeholder">
                  <MapPin size={24} />
                  <p>当天没有需要查询的交通路段。</p>
                </div>
              )}
            </>
          )}
          <p className="directions-preview-note">切换交通方式仅用于查看，不改动行程时间与预算。</p>
        </aside>
        <div className="directions-map-area">
          <div
            className="map-canvas"
            ref={element}
            aria-label={`${trip.city.name}第${day.day}天路线地图`}
          />
          <div className="directions-map-toolbar">
            <button
              className={overview ? 'active' : ''}
              aria-pressed={overview}
              onClick={() => setOverview((value) => !value)}
            >
              <Layers size={14} />
              {overview ? '返回选中路段' : '查看全日路线'}
            </button>
          </div>
          <div className="directions-map-legend">
            {!overview && activeSteps.length ? (
              [
                ...new Map(
                  activeSteps.map((step) => [
                    step.mode === 'walking'
                      ? '步行'
                      : shortLineName(step.name) ||
                        modes.find((item) => item.id === step.mode)?.label ||
                        '乘车',
                    step,
                  ]),
                ).entries(),
              ].map(([name, step]) => (
                <span key={name}>
                  <i
                    style={{ background: getStepColor(step) }}
                    className={step.mode === 'walking' ? 'walking-line' : ''}
                  />
                  {name}
                </span>
              ))
            ) : (
              <span>
                <i style={{ background: '#3478ff' }} />
                {overview ? '全日路线' : modes.find((item) => item.id === mode)?.label}
              </span>
            )}
          </div>
          {loading && (
            <div className="map-overlay">
              <RefreshCw className="spin" size={22} />
              <p>正在展开城市地图</p>
            </div>
          )}
          {error && (
            <div className="map-overlay map-error">
              <MapIcon size={30} />
              <strong>地图暂时未能加载</strong>
              <p>{error}</p>
              <button className="button button-small" onClick={() => setAttempt((a) => a + 1)}>
                重新加载
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="map-bottomline">
        <span>
          <Clock3 size={14} />
          {overview
            ? `全日 ${day.stops.length} 个停靠点 · ${formatDistance(day.distanceMeters)} · 交通约 ${day.transitMinutes} 分钟`
            : activeRoute
              ? `选中路段 · ${formatTime(activeRoute.durationMinutes)} · ${formatDistance(activeRoute.distanceMeters)}`
              : '选择交通方式，查看可用路线'}
        </span>
        {mapLink && (
          <a href={mapLink} target="_blank" rel="noreferrer">
            {mode === 'cycling' ? '在高德打开骑行（手机）' : '在高德打开此路段'}{' '}
            <ExternalLink size={14} />
          </a>
        )}
      </div>
    </section>
  );
}
function RouteSummary({
  option,
  badge,
  badgeTitle,
}: {
  option: Segment;
  badge: string;
  badgeTitle?: string;
}) {
  return (
    <>
      <div className="direction-option-title">
        <strong>{compactTime(option.durationMinutes)}</strong>
        {option.walkingDistanceMeters != null && option.mode === 'transit' && (
          <small>步行 {compactDistance(option.walkingDistanceMeters)}</small>
        )}
        {badge && <span title={badgeTitle}>{badge}</span>}
      </div>
      <div className="direction-route-chips">
        {option.mode === 'transit' && option.steps?.length ? (
          option.steps
            .filter((step) => step.mode !== 'walking' || (step.distanceMeters ?? 0) > 0)
            .map((step, at) => {
              const Icon = stepIcons[step.mode];
              const line = shortLineName(step.name);
              return (
                <span
                  key={at}
                  className={`direction-route-chip chip-${step.mode}`}
                  title={step.name || step.instruction}
                  style={step.mode === 'subway' ? { background: getStepColor(step) } : undefined}
                >
                  {step.mode === 'walking' ? (
                    <>
                      <Footprints size={12} />
                      {step.durationMinutes ? step.durationMinutes : '步行'}
                    </>
                  ) : (
                    <>
                      {step.mode === 'driving' || step.mode === 'taxi' ? <Icon size={12} /> : null}
                      {line || (step.mode === 'driving' ? '驾车' : '乘车')}
                    </>
                  )}
                </span>
              );
            })
        ) : (
          <span className="direction-route-fallback">{option.summary}</span>
        )}
      </div>
      <div className="direction-option-metrics">
        {option.mode === 'transit' &&
          option.steps?.some((step) => step.stopCount !== undefined) && (
            <span>{option.steps.reduce((sum, step) => sum + (step.stopCount || 0), 0)}站</span>
          )}
        {option.price !== null && (
          <span>
            {option.mode === 'driving' ? '路桥费 ' : ''}
            {option.price}元
          </span>
        )}
        <span>{compactDistance(option.distanceMeters)}</span>
        {option.mode === 'transit' && option.transfers !== undefined && (
          <span>{option.transfers ? `换乘${option.transfers}次` : '无需换乘'}</span>
        )}
        {option.trafficLights != null && <span>红绿灯{option.trafficLights}个</span>}
      </div>
    </>
  );
}
function StepDetail({ step, transfer = false }: { step: DirectionStep; transfer?: boolean }) {
  const Icon = stepIcons[step.mode];
  const riding = step.mode === 'bus' || step.mode === 'subway' || step.mode === 'railway';
  const direction = step.name
    .match(/[（(](.*)[）)]/)?.[1]
    ?.split(/--|→|—/)
    .at(-1);
  const time = step.durationMinutes !== null ? `(${compactTime(step.durationMinutes)})` : '';
  const walking = step.mode === 'walking';
  const walkingLabel = transfer
    ? '站内换乘'
    : `步行${step.distanceMeters !== null ? compactDistance(step.distanceMeters) : ''}${time}`;
  return (
    <li
      className={`direction-step step-${step.mode}${riding ? ' step-ride' : ''}`}
      style={{ '--step-color': getStepColor(step) } as CSSProperties}
    >
      <span className="direction-step-icon">
        <Icon size={16} />
      </span>
      <div>
        {walking && step.instructions?.length ? (
          <details className="direction-via-stops direction-walk-instructions">
            <summary>
              {walkingLabel}
              <ChevronDown size={12} />
            </summary>
            <ol>
              {step.instructions.map((instruction, index) => (
                <li key={index}>{instruction}</li>
              ))}
            </ol>
          </details>
        ) : (
          <strong>
            {riding ? step.departureStop || '上车站' : walking ? walkingLabel : step.instruction}
            {riding && step.entrance ? `（${step.entrance}）` : ''}
          </strong>
        )}
        {riding && (
          <p className="direction-ride-line">
            <span className={`direction-route-chip chip-${step.mode}`}>
              {shortLineName(step.name)}
            </span>
            {direction ? `${direction}方向` : '乘车前往'}
          </p>
        )}
        {riding ? (
          <details className="direction-via-stops direction-ride-stops">
            <summary>
              <ChevronDown size={15} />
              <span>{step.stopCount !== undefined ? `${step.stopCount}站` : '途经站点'}</span>
              {time}
            </summary>
            {step.viaStops?.length ? (
              <ol>
                {step.viaStops.map((stop, index) => (
                  <li key={index}>{stop}</li>
                ))}
              </ol>
            ) : (
              <p>直达{step.arrivalStop || '下车站'}</p>
            )}
          </details>
        ) : (
          !walking && (
            <small>
              {[
                step.durationMinutes !== null ? formatTime(step.durationMinutes) : '',
                step.distanceMeters !== null ? formatDistance(step.distanceMeters) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </small>
          )
        )}
        {!riding && (step.entrance || step.exit) && (
          <small>
            {[step.entrance && `入口：${step.entrance}`, step.exit && `出口：${step.exit}`]
              .filter(Boolean)
              .join(' · ')}
          </small>
        )}
        {riding && (
          <strong className="direction-step-arrival">
            {step.arrivalStop || '下车站'}
            {step.exit ? `（${step.exit}）` : ''}
          </strong>
        )}
      </div>
    </li>
  );
}
