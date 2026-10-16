import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Compass,
  History,
  MapPin,
  Route,
  Sparkles,
  Settings,
  X,
} from 'lucide-react';
import {
  PlanRequestSchema,
  type JobEvent,
  type PlanRequest,
  type ProgressEvent,
  type Region,
  type ServiceStatus,
  type Trip,
  type PlanningTaskSummary,
  type PlaceSuggestion,
  type LocatedRegion,
} from '@stree/shared';
import { api, isUnavailableEndpoint } from './api';
import { locateUserRegion } from './lib/location';
import TripView from './components/TripView';
import SettingsDialog from './components/SettingsDialog';
import OpeningScreen from './components/OpeningScreen';
import PlaceAutocomplete, { placeNames } from './components/PlaceAutocomplete';
import PlanningProgress from './components/PlanningProgress';
import HistoryDrawer from './components/HistoryDrawer';
import FieldHelp from './components/FieldHelp';

const interests = [
  '城市漫步',
  '历史文化',
  '自然风景',
  '当地美食',
  '拍照打卡',
  '艺术展馆',
  '亲子出游',
  '小众体验',
];
type SelectedPlace = Pick<PlaceSuggestion, 'id' | 'name' | 'address' | 'district'>;
const citiesToExplore = [
  {
    name: '杭州',
    province: '浙江',
    provinceCode: '330000',
    cityCode: '330100',
    tag: '湖山之间',
  },
  {
    name: '成都',
    province: '四川',
    provinceCode: '510000',
    cityCode: '510100',
    tag: '慢一点也很好',
  },
  {
    name: '上海',
    province: '上海',
    provinceCode: '310000',
    cityCode: '310000',
    tag: '街角的另一面',
  },
  {
    name: '大理',
    province: '云南',
    provinceCode: '530000',
    cityCode: '532900',
    tag: '去有风的地方',
  },
];
function prioritizeRegion(regions: Region[], adcode?: string) {
  const local = regions.find((item) => item.adcode === adcode);
  return local ? [local, ...regions.filter((item) => item !== local)] : regions;
}
export default function App() {
  const openingPreview = new URLSearchParams(window.location.search).get('opening') === 'preview';
  const [opening, setOpening] = useState(openingPreview);
  const [openingReplay, setOpeningReplay] = useState(0);
  const finishOpening = useCallback(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('opening') === 'preview') {
      url.searchParams.delete('opening');
      window.history.replaceState(null, '', url);
    }
    setOpening(false);
    requestAnimationFrame(() =>
      document.getElementById('planner-title')?.focus({ preventScroll: true }),
    );
  }, []);
  const [provinces, setProvinces] = useState<Region[]>([]);
  const [cities, setCities] = useState<Region[]>([]);
  const [provinceCode, setProvinceCode] = useState('330000');
  const [cityCode, setCityCode] = useState('330100');
  const [cityLoading, setCityLoading] = useState(false);
  const [regionError, setRegionError] = useState('');
  const [currentLocation, setCurrentLocation] = useState<LocatedRegion | null>(null);
  const destinationRevision = useRef(0);
  const locationController = useRef<AbortController | null>(null);
  const locationInFlight = useRef(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [days, setDays] = useState(2);
  const [budget, setBudget] = useState('1500');
  const [startDate, setStartDate] = useState('');
  const [origin, setOrigin] = useState('');
  const [mustVisit, setMustVisit] = useState('');
  const [originPlace, setOriginPlace] = useState<SelectedPlace | null>(null);
  const [mustVisitPlaces, setMustVisitPlaces] = useState<SelectedPlace[]>([]);
  const [selectedInterests, setSelectedInterests] = useState(['城市漫步', '当地美食']);
  const [pace, setPace] = useState<PlanRequest['pace']>('balanced');
  const [transport, setTransport] = useState<PlanRequest['transport']>('transit');
  const [includeHotel, setIncludeHotel] = useState(true);
  const [message, setMessage] = useState(
    '想看看这座城市的代表性风景，也想逛一些有当地生活气息的地方。路线尽量顺路，留出吃饭和休息的时间。',
  );
  const [busy, setBusy] = useState(false);
  const planningBusy = useRef(false);
  planningBusy.current = busy;
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activeTask, setActiveTask] = useState<PlanningTaskSummary | null>(null);
  const restoringRequest = useRef<PlanRequest | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [availablePanels, setAvailablePanels] = useState({ history: false, settings: false });
  const settingsButton = useRef<HTMLButtonElement>(null);
  const stream = useRef<EventSource | null>(null);
  const jobId = useRef<string | null>(null);
  const desiredCity = useRef('330100');
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const city = cities.find((item) => item.adcode === cityCode);
  const province = provinces.find((item) => item.adcode === provinceCode);
  const requestLocation = useCallback(async () => {
    if (locationInFlight.current || planningBusy.current) return;
    if (!window.isSecureContext || !navigator.geolocation) return;
    locationController.current?.abort();
    const controller = new AbortController();
    locationController.current = controller;
    locationInFlight.current = true;
    const revision = destinationRevision.current;
    try {
      const { region: located } = await locateUserRegion(controller.signal);
      if (controller.signal.aborted) return;
      setCurrentLocation(located);
      const unchanged = revision === 0 && destinationRevision.current === revision;
      if (unchanged) {
        desiredCity.current = located.city.adcode;
        setProvinceCode(located.province.adcode);
        setCityCode(located.city.adcode);
      }
    } catch {
      // Keep the selected destination when automatic location is unavailable.
    } finally {
      if (!controller.signal.aborted) locationInFlight.current = false;
    }
  }, []);
  useEffect(
    () => () => {
      locationController.current?.abort();
      locationInFlight.current = false;
    },
    [],
  );
  useEffect(() => {
    if (opening) return;
    const locateOnEnter = () => {
      if (document.visibilityState === 'visible') void requestLocation();
    };
    // Defer the first request so StrictMode's setup/cleanup cycle cannot duplicate it.
    const initial = setTimeout(locateOnEnter, 0);
    document.addEventListener('visibilitychange', locateOnEnter);
    return () => {
      clearTimeout(initial);
      document.removeEventListener('visibilitychange', locateOnEnter);
    };
  }, [opening, requestLocation]);
  useEffect(() => {
    const restoring = restoringRequest.current;
    if (restoring) {
      if (provinceCode === restoring.provinceCode && cityCode === restoring.cityCode) {
        setMustVisit(
          restoring.mustVisit
            .filter((name) => !restoring.mustVisitPlaces?.some((place) => place.name === name))
            .join('、'),
        );
        setMustVisitPlaces(
          (restoring.mustVisitPlaces ?? []).map((place) => ({
            ...place,
            address: '',
            district: '',
          })),
        );
        restoringRequest.current = null;
      }
      return;
    }
    setMustVisit('');
    setMustVisitPlaces([]);
  }, [provinceCode, cityCode]);
  const refreshHistory = () => setHistoryVersion((value) => value + 1);
  useEffect(() => {
    void api
      .provinces()
      .then((data) => setProvinces(data.regions))
      .catch(() => setRegionError('目的地目录加载失败，请检查服务并刷新页面。'));
    void api
      .status()
      .then(setStatus)
      .catch(() => undefined);
    // Hide optional entry points only when their backing route is permanently unavailable.
    // Transient service failures keep the panel available with its own retry state.
    let disposed = false;
    const checkPanel = async (name: 'history' | 'settings', load: () => Promise<unknown>) => {
      let available = true;
      try {
        await load();
      } catch (error) {
        available = !isUnavailableEndpoint(error);
      }
      if (!disposed) setAvailablePanels((current) => ({ ...current, [name]: available }));
    };
    void checkPanel('history', api.travelHistory);
    if (!import.meta.env.PROD) void checkPanel('settings', api.modelSettings);
    void refreshHistory();
    return () => {
      disposed = true;
      stream.current?.close();
      if (polling.current) clearTimeout(polling.current);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setCityLoading(true);
    setRegionError('');
    setCities([]);
    void api
      .cities(provinceCode, controller.signal)
      .then((data) => {
        setCities(data.regions);
        setCityCode(
          data.regions.find((item) => item.adcode === desiredCity.current)?.adcode ??
            data.regions[0]?.adcode ??
            '',
        );
        setCityLoading(false);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setRegionError(err.message);
          setCityLoading(false);
        }
      });
    return () => controller.abort();
  }, [provinceCode]);
  const handleEvent = (event: JobEvent) => {
    if (event.type === 'progress') {
      setProgress((items) =>
        items.some((item) => item.timestamp === event.timestamp && item.message === event.message)
          ? items
          : [...items.slice(-19), event],
      );
      return;
    }
    stream.current?.close();
    jobId.current = null;
    setBusy(false);
    if (polling.current) clearTimeout(polling.current);
    refreshHistory();
    if (event.type === 'result') {
      setTrip(event.trip);
      setError('');
      setTimeout(
        () =>
          document
            .getElementById('results')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        100,
      );
    } else if (event.type === 'error') setError(event.message);
  };
  const recoverEvents = async (id: string) => {
    if (jobId.current !== id) return;
    try {
      const job = await api.job(id);
      if (jobId.current !== id) return;
      job.events.forEach(handleEvent);
      if (job.status === 'running')
        polling.current = setTimeout(() => void recoverEvents(id), 3000);
    } catch {
      if (jobId.current !== id) return;
      setBusy(false);
      setError('暂时无法获取规划进度，请稍后在“我的行程”中查看结果。');
      jobId.current = null;
    }
  };
  const watchJob = (id: string) => {
    stream.current?.close();
    if (polling.current) clearTimeout(polling.current);
    jobId.current = id;
    stream.current = api.events(
      id,
      (event) => {
        if (jobId.current === id) handleEvent(event);
      },
      () => void recoverEvents(id),
    );
  };
  const startPlanning = async (input: PlanRequest, previousTripId?: string) => {
    if (busy) return;
    destinationRevision.current += 1;
    setError('');
    setBusy(true);
    setProgress([]);
    setActiveTask(null);
    stream.current?.close();
    if (polling.current) clearTimeout(polling.current);
    try {
      const { jobId: id } = await api.plan({
        ...input,
        ...(previousTripId ? { previousTripId } : {}),
      });
      watchJob(id);
      refreshHistory();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '规划未能开始，请稍后重试。');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const manualPlaces = placeNames(mustVisit).filter(
      (name) => !mustVisitPlaces.some((place) => place.name === name),
    );
    if (mustVisitPlaces.length + new Set(manualPlaces).size > 10) {
      setError('最多添加 10 个必去地点，请移除一些地点后再生成。');
      return;
    }
    const result = PlanRequestSchema.safeParse({
      provinceCode,
      cityCode,
      days,
      budget: budget.trim() ? Number(budget) : null,
      startDate: startDate || null,
      origin,
      originPoiId: originPlace?.id ?? null,
      mustVisit: [...new Set([...mustVisitPlaces.map((place) => place.name), ...manualPlaces])],
      mustVisitPlaces: mustVisitPlaces.map(({ id, name }) => ({ id, name })),
      interests: selectedInterests,
      pace,
      transport,
      includeHotel: includeHotel && days > 1,
      message,
    });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? '请检查填写内容。');
      return;
    }
    void startPlanning(result.data);
  };
  const cancel = async () => {
    if (jobId.current) {
      await api.cancel(jobId.current).catch(() => undefined);
      stream.current?.close();
      jobId.current = null;
    }
    if (polling.current) clearTimeout(polling.current);
    setBusy(false);
    setProgress([]);
    refreshHistory();
  };
  const revise = (text: string) => {
    if (trip) void startPlanning({ ...trip.request, message: text }, trip.id);
  };
  const explore = (destination: (typeof citiesToExplore)[number]) => {
    destinationRevision.current += 1;
    desiredCity.current = destination.cityCode;
    setProvinceCode(destination.provinceCode);
    if (provinceCode === destination.provinceCode) setCityCode(destination.cityCode);
    document.getElementById('planner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const openTrip = async (id: string) => {
    const loaded = await api.trip(id);
    setTrip(loaded);
    setHistoryOpen(false);
    setTimeout(
      () => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }),
      100,
    );
  };
  const openTask = async (task: PlanningTaskSummary) => {
    // Verify that the task still exists before replacing the current progress view.
    await api.job(task.id);
    const input = task.request;
    destinationRevision.current += 1;
    desiredCity.current = input.cityCode;
    restoringRequest.current =
      provinceCode !== input.provinceCode || cityCode !== input.cityCode ? input : null;
    setProvinceCode(input.provinceCode);
    setCityCode(input.cityCode);
    setDays(input.days);
    setBudget(input.budget === null ? '' : String(input.budget));
    setStartDate(input.startDate ?? '');
    setOrigin(input.origin);
    setOriginPlace(
      input.originPoiId
        ? { id: input.originPoiId, name: input.origin, address: '', district: '' }
        : null,
    );
    setMustVisit(
      input.mustVisit
        .filter((name) => !input.mustVisitPlaces?.some((place) => place.name === name))
        .join('、'),
    );
    setMustVisitPlaces(
      (input.mustVisitPlaces ?? []).map((place) => ({ ...place, address: '', district: '' })),
    );
    setSelectedInterests(input.interests);
    setPace(input.pace);
    setTransport(input.transport);
    setIncludeHotel(input.includeHotel);
    setMessage(input.message);
    setActiveTask(task);
    setError('');
    setProgress([]);
    setBusy(true);
    watchJob(task.id);
    setHistoryOpen(false);
    setTimeout(
      () =>
        document
          .getElementById('planning-progress')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      100,
    );
  };
  const modelReady = status?.model?.configured;
  return (
    <>
      {opening && (
        <OpeningScreen
          key={openingReplay}
          preview={openingPreview}
          onReplay={() => setOpeningReplay((value) => value + 1)}
          onComplete={finishOpening}
        />
      )}
      <div className="app-shell" inert={opening}>
        <header className="site-header">
          <a className="brand" href="/" aria-label="STREE 首页">
            <span className="brand-mark">
              <Route size={22} strokeWidth={2.4} />
            </span>
            STREE
            <span className="brand-separator" />
            <small>城市旅行手册</small>
          </a>
          <nav aria-label="主导航">
            {availablePanels.history && (
              <button
                aria-label="我的行程"
                aria-haspopup="dialog"
                onClick={() => {
                  void refreshHistory();
                  setHistoryOpen(true);
                }}
              >
                <History size={16} /> 我的行程
                {busy && <span className="history-nav-dot" aria-hidden="true" />}
              </button>
            )}
            {!import.meta.env.PROD && availablePanels.settings && (
              <button
                ref={settingsButton}
                onClick={() => setSettingsOpen(true)}
                aria-haspopup="dialog"
              >
                <Settings size={16} /> 设置
              </button>
            )}
          </nav>
        </header>
        <main>
          <section className="planner-section" id="planner">
            <div className="section-heading">
              <div>
                <h1 id="planner-title" tabIndex={-1}>
                  规划你的下一段旅程
                </h1>
              </div>
              <span className="workspace-badge">
                <Route size={14} /> 城市旅行规划
              </span>
            </div>
            <div className="planner-layout">
              <div className="planner-main">
                <form id="trip-planner-form" className="planner-card" onSubmit={submit}>
                  <fieldset disabled={busy}>
                    <section className="form-section" aria-labelledby="destination-heading">
                      <div className="form-section-heading">
                        <span className="step-index">01</span>
                        <div>
                          <h2 id="destination-heading">目的地与时间</h2>
                          <p>从哪里开始，这次想待多久？</p>
                        </div>
                        <MapPin size={19} />
                      </div>
                      <div className="destination-row">
                        <label>
                          <span>省份 / 直辖市</span>
                          <div className="select-wrap">
                            <select
                              aria-label="省份或直辖市"
                              value={provinceCode}
                              onChange={(event) => {
                                destinationRevision.current += 1;
                                desiredCity.current = '';
                                setProvinceCode(event.target.value);
                              }}
                            >
                              {provinces.length ? (
                                prioritizeRegion(provinces, currentLocation?.province.adcode).map(
                                  (item) => (
                                    <option key={item.adcode} value={item.adcode}>
                                      {item.name}
                                    </option>
                                  ),
                                )
                              ) : (
                                <option value="330000">加载目的地…</option>
                              )}
                            </select>
                            <ChevronDown size={16} />
                          </div>
                        </label>
                        <label>
                          <span>目的地城市</span>
                          <div className="select-wrap">
                            <select
                              aria-label="目的地城市"
                              value={cityCode}
                              disabled={cityLoading || !cities.length}
                              onChange={(event) => {
                                destinationRevision.current += 1;
                                desiredCity.current = event.target.value;
                                setCityCode(event.target.value);
                              }}
                            >
                              {cityLoading ? (
                                <option>正在查询城市…</option>
                              ) : cities.length ? (
                                prioritizeRegion(cities, currentLocation?.city.adcode).map(
                                  (item) => (
                                    <option key={item.adcode} value={item.adcode}>
                                      {item.name}
                                    </option>
                                  ),
                                )
                              ) : (
                                <option value="">请选择目的地</option>
                              )}
                            </select>
                            <ChevronDown size={16} />
                          </div>
                        </label>
                        <label>
                          <span>旅行天数</span>
                          <div className="select-wrap">
                            <select
                              aria-label="旅行天数"
                              value={days}
                              onChange={(event) => setDays(Number(event.target.value))}
                            >
                              {[1, 2, 3, 4, 5, 6, 7].map((value) => (
                                <option value={value} key={value}>
                                  {value} 天
                                </option>
                              ))}
                            </select>
                            <ChevronDown size={16} />
                          </div>
                        </label>
                        <label>
                          <span>
                            出发日期 <small>选填</small>
                          </span>
                          <input
                            aria-label="出发日期"
                            type="date"
                            value={startDate}
                            onChange={(event) => setStartDate(event.target.value)}
                          />
                        </label>
                      </div>
                      {regionError && (
                        <p className="inline-error" role="alert">
                          {regionError}
                        </p>
                      )}
                      <div className="form-row">
                        <label>
                          <span>
                            每人旅行总预算 <small>元 / 选填</small>
                          </span>
                          <input
                            aria-label="每人旅行总预算"
                            type="number"
                            min="100"
                            max="100000"
                            value={budget}
                            onChange={(event) => setBudget(event.target.value)}
                            placeholder="让路线自然展开"
                          />
                        </label>
                        <div className="place-field">
                          <div className="field-label-with-help">
                            <label htmlFor="origin-place">
                              <span>
                                从哪里出发 <small>选填</small>
                              </span>
                            </label>
                            <FieldHelp label="查看出发地说明">
                              <strong>从这里开始你的旅程</strong>
                              <span>
                                填写后，将以该地址作为旅途起点，把从这里出发的交通时间、路程和费用一并纳入行程与总预算。跨城出发，也会规划前往目的地的交通。
                              </span>
                              <span>
                                未填写时，默认从目的地市中心开始规划。时间和费用为参考，实际以出行时为准；未安排的返程不计入预算。
                              </span>
                            </FieldHelp>
                          </div>
                          <PlaceAutocomplete
                            id="origin-place"
                            label="出发地点"
                            disabled={busy}
                            value={origin}
                            selected={originPlace ? [originPlace] : []}
                            onChange={(value) => {
                              setOrigin(value);
                              setOriginPlace((place) => (place?.name === value ? place : null));
                            }}
                            onSelect={setOriginPlace}
                            onRemove={() => setOriginPlace(null)}
                          />
                        </div>
                        <div className="place-field must-visit-field">
                          <label htmlFor="must-visit-place">
                            <span>
                              一定想去的地方 <small>选填</small>
                            </span>
                          </label>
                          <PlaceAutocomplete
                            id="must-visit-place"
                            label="必去地点"
                            multiple
                            cityCode={cityCode}
                            disabled={busy || cityLoading || !city}
                            value={mustVisit}
                            selected={mustVisitPlaces}
                            onChange={setMustVisit}
                            onSelect={(place) =>
                              setMustVisitPlaces((items) =>
                                items.some((item) => item.id === place.id) || items.length >= 10
                                  ? items
                                  : [...items, place],
                              )
                            }
                            onRemove={(id) =>
                              setMustVisitPlaces((items) =>
                                items.filter((place) => place.id !== id),
                              )
                            }
                          />
                        </div>
                      </div>
                    </section>
                    <section className="form-section" aria-labelledby="preferences-heading">
                      <div className="form-section-heading">
                        <span className="step-index">02</span>
                        <div>
                          <h2 id="preferences-heading">旅行偏好</h2>
                          <p>按你的节奏，安排喜欢的体验。</p>
                        </div>
                        <Compass size={19} />
                      </div>
                      <div className="interests-row">
                        <span className="form-label">旅行的关键词</span>
                        <div className="interest-chips">
                          {interests.map((interest) => (
                            <button
                              type="button"
                              aria-pressed={selectedInterests.includes(interest)}
                              className={selectedInterests.includes(interest) ? 'selected' : ''}
                              onClick={() =>
                                setSelectedInterests((items) =>
                                  items.includes(interest)
                                    ? items.filter((item) => item !== interest)
                                    : [...items, interest],
                                )
                              }
                              key={interest}
                            >
                              {selectedInterests.includes(interest) && <Check size={13} />}{' '}
                              {interest}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="form-row preferences-row">
                        <div className="preference-field" role="group" aria-labelledby="pace-label">
                          <span className="form-label" id="pace-label">
                            喜欢的节奏
                          </span>
                          <div className="segmented">
                            {(
                              [
                                ['relaxed', '慢慢逛'],
                                ['balanced', '刚刚好'],
                                ['packed', '多看一点'],
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                type="button"
                                key={value}
                                className={pace === value ? 'active' : ''}
                                aria-pressed={pace === value}
                                onClick={() => setPace(value)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div
                          className="preference-field"
                          role="group"
                          aria-labelledby="transport-label"
                        >
                          <span className="form-label" id="transport-label">
                            主要交通方式
                          </span>
                          <div className="segmented">
                            {(
                              [
                                ['transit', '公共交通'],
                                ['walking', '步行'],
                                ['driving', '自驾'],
                                ['cycling', '骑行'],
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                type="button"
                                key={value}
                                className={transport === value ? 'active' : ''}
                                aria-pressed={transport === value}
                                onClick={() => setTransport(value)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <label className="hotel-toggle">
                          <input
                            type="checkbox"
                            checked={includeHotel && days > 1}
                            disabled={days === 1}
                            onChange={(event) => setIncludeHotel(event.target.checked)}
                          />
                          <span>
                            推荐顺路住宿<small>多日行程，价格需确认</small>
                          </span>
                        </label>
                      </div>
                    </section>
                    <section className="form-section" aria-labelledby="notes-heading">
                      <div className="form-section-heading">
                        <span className="step-index">03</span>
                        <div>
                          <h2 id="notes-heading">补充说明</h2>
                          <p>同行人、饮食偏好，或任何特别的期待。</p>
                        </div>
                      </div>
                      <label className="message-field">
                        <span>还有什么期待？</span>
                        <textarea
                          aria-label="旅行期待"
                          value={message}
                          onChange={(event) => setMessage(event.target.value)}
                          placeholder="比如：带父母出游，少走路；想看看老建筑，也想吃当地小吃…"
                          required
                          minLength={2}
                          maxLength={2000}
                        />
                      </label>
                      <span className="field-counter">{message.length} / 2000</span>
                    </section>
                    <div className="form-footer">
                      <span>
                        <MapPin size={15} />
                        {province?.name ?? '中国'} · {city?.name ?? '选择一座城'}
                        <small>生成后可继续调整行程</small>
                      </span>
                      <button
                        type="submit"
                        className="button button-primary"
                        disabled={cityLoading || !cityCode || !!regionError}
                      >
                        <Sparkles size={18} /> 生成我的路线 <ArrowUpRight size={18} />
                      </button>
                    </div>
                  </fieldset>
                </form>
                {error && (
                  <div className="error-banner" role="alert">
                    <div>
                      <strong>这次规划还差一步</strong>
                      <p>{error}</p>
                    </div>
                    <button
                      className="icon-button"
                      aria-label="关闭错误提示"
                      onClick={() => setError('')}
                    >
                      <X size={17} />
                    </button>
                  </div>
                )}
                {busy && (
                  <div id="planning-progress">
                    <PlanningProgress
                      key={activeTask?.id ?? 'new'}
                      progress={progress}
                      destination={activeTask?.cityName ?? city?.name ?? ''}
                      createdAt={activeTask?.createdAt}
                      onCancel={() => void cancel()}
                    />
                  </div>
                )}
              </div>
              <aside className="planner-sidebar" aria-label="行程预览与目的地灵感">
                <section className="trip-preview">
                  <div className="preview-heading">
                    <span>行程预览</span>
                    <span className="preview-live">实时更新</span>
                  </div>
                  <div className="preview-art" aria-hidden="true">
                    <div className="preview-grid" />
                    <svg viewBox="0 0 280 110" fill="none">
                      <path
                        d="M-10 85C45 85 30 30 85 30S150 100 195 65S225 15 290 15"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="5 6"
                      />
                      <circle cx="85" cy="30" r="6" fill="currentColor" />
                      <circle cx="195" cy="65" r="6" fill="currentColor" />
                    </svg>
                    <span>
                      <MapPin size={19} />
                    </span>
                  </div>
                  <div className="preview-destination">
                    <small>即将探索</small>
                    <h2>{city?.name ?? '选择目的地'}</h2>
                    <p>
                      {province?.name ?? '中国'} · {days} 天{days > 1 ? ` ${days - 1} 晚` : ''}
                    </p>
                  </div>
                  <dl className="preview-facts">
                    <div>
                      <dt>出发日期</dt>
                      <dd>{startDate || '日期待定'}</dd>
                    </div>
                    <div>
                      <dt>每人预算</dt>
                      <dd>{budget ? `¥ ${Number(budget).toLocaleString('zh-CN')}` : '灵活安排'}</dd>
                    </div>
                    <div>
                      <dt>出行方式</dt>
                      <dd>
                        {
                          {
                            transit: '公共交通',
                            walking: '步行',
                            driving: '自驾',
                            cycling: '骑行',
                          }[transport]
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>旅行节奏</dt>
                      <dd>{{ relaxed: '慢慢逛', balanced: '刚刚好', packed: '多看一点' }[pace]}</dd>
                    </div>
                  </dl>
                  {selectedInterests.length > 0 && (
                    <div className="preview-interests">
                      {selectedInterests.map((interest) => (
                        <span key={interest}>{interest}</span>
                      ))}
                    </div>
                  )}
                  <div className="preview-note">
                    <Sparkles size={15} />
                    <p>
                      路线、交通与逐站攻略，
                      <br />
                      一次规划，轻松出发。
                    </p>
                  </div>
                </section>
                <section className="quick-destinations" aria-labelledby="inspiration-heading">
                  <h2 id="inspiration-heading">
                    下一站灵感 <span>选一座喜欢的城</span>
                  </h2>
                  <div>
                    {citiesToExplore.map((destination) => (
                      <button
                        type="button"
                        key={destination.cityCode}
                        onClick={() => explore(destination)}
                        disabled={busy}
                        aria-label={`探索${destination.name}`}
                      >
                        <span>
                          <strong>{destination.name}</strong>
                          <small>{destination.tag}</small>
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                    ))}
                  </div>
                </section>
                <p className="sidebar-source">
                  <MapPin size={13} /> 地点与导航数据由高德地图提供
                </p>
              </aside>
            </div>
          </section>
          {trip && (
            <section id="results">
              <TripView key={trip.updatedAt} trip={trip} onRevise={revise} busy={busy} />
            </section>
          )}
        </main>
        <footer className="site-footer">
          <span className="footer-brand">
            STREE <small>好路线，是旅行的开始。</small>
          </span>
          <span className="footer-status">
            <span
              className={`live-dot ${modelReady && status?.amap.configured && status?.storage.available ? '' : 'muted'}`}
            />
            {modelReady && status?.amap.configured && status?.storage.available
              ? '规划服务已就绪'
              : '正在等待规划服务就绪'}
          </span>
        </footer>
        {!import.meta.env.PROD && settingsOpen && (
          <SettingsDialog
            onClose={() => {
              setSettingsOpen(false);
              requestAnimationFrame(() => settingsButton.current?.focus());
            }}
            onSaved={() => {
              void api
                .status()
                .then(setStatus)
                .catch(() => undefined);
            }}
          />
        )}
        {historyOpen && (
          <HistoryDrawer
            version={historyVersion}
            onClose={() => setHistoryOpen(false)}
            onOpenTrip={openTrip}
            onOpenTask={openTask}
          />
        )}
      </div>
    </>
  );
}
