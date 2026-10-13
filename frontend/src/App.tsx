import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Compass,
  History,
  MapPin,
  RefreshCw,
  Route,
  Sparkles,
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
  type TripSummary,
} from '@stree/shared';
import { api } from './api';
import TripView from './components/TripView';

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
const citiesToExplore = [
  {
    name: '杭州',
    province: '浙江',
    provinceCode: '330000',
    cityCode: '330100',
    tag: '湖山之间',
    number: '01',
  },
  {
    name: '成都',
    province: '四川',
    provinceCode: '510000',
    cityCode: '510100',
    tag: '慢一点也很好',
    number: '02',
  },
  {
    name: '上海',
    province: '上海',
    provinceCode: '310000',
    cityCode: '310000',
    tag: '街角的另一面',
    number: '03',
  },
  {
    name: '大理',
    province: '云南',
    provinceCode: '530000',
    cityCode: '532900',
    tag: '去有风的地方',
    number: '04',
  },
];
export default function App() {
  const [provinces, setProvinces] = useState<Region[]>([]);
  const [cities, setCities] = useState<Region[]>([]);
  const [provinceCode, setProvinceCode] = useState('330000');
  const [cityCode, setCityCode] = useState('330100');
  const [cityLoading, setCityLoading] = useState(false);
  const [regionError, setRegionError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [days, setDays] = useState(2);
  const [budget, setBudget] = useState('1500');
  const [startDate, setStartDate] = useState('');
  const [origin, setOrigin] = useState('');
  const [mustVisit, setMustVisit] = useState('');
  const [selectedInterests, setSelectedInterests] = useState(['城市漫步', '当地美食']);
  const [pace, setPace] = useState<PlanRequest['pace']>('balanced');
  const [transport, setTransport] = useState<PlanRequest['transport']>('transit');
  const [includeHotel, setIncludeHotel] = useState(true);
  const [message, setMessage] = useState(
    '想看看这座城市的代表性风景，也想逛一些有当地生活气息的地方。路线尽量顺路，留出吃饭和休息的时间。',
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [history, setHistory] = useState<TripSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const stream = useRef<EventSource | null>(null);
  const jobId = useRef<string | null>(null);
  const desiredCity = useRef('330100');
  const polling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const city = cities.find((item) => item.adcode === cityCode);
  const province = provinces.find((item) => item.adcode === provinceCode);
  const refreshHistory = () =>
    api
      .history()
      .then((data) => setHistory(data.trips))
      .catch(() => undefined);
  useEffect(() => {
    void api
      .provinces()
      .then((data) => setProvinces(data.regions))
      .catch(() => setRegionError('目的地目录加载失败，请检查服务并刷新页面。'));
    void api
      .status()
      .then(setStatus)
      .catch(() => undefined);
    void refreshHistory();
    return () => {
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
    if (event.type === 'result') {
      setTrip(event.trip);
      setError('');
      void refreshHistory();
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
      setBusy(false);
      setError('暂时无法获取规划进度，请稍后在“我的行程”中查看结果。');
      jobId.current = null;
    }
  };
  const startPlanning = async (input: PlanRequest, previousTripId?: string) => {
    if (busy) return;
    setError('');
    setBusy(true);
    setProgress([]);
    stream.current?.close();
    try {
      const { jobId: id } = await api.plan({
        ...input,
        ...(previousTripId ? { previousTripId } : {}),
      });
      jobId.current = id;
      stream.current = api.events(
        id,
        (event) => {
          if (jobId.current === id) handleEvent(event);
        },
        () => void recoverEvents(id),
      );
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : '规划未能开始，请稍后重试。');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = PlanRequestSchema.safeParse({
      provinceCode,
      cityCode,
      days,
      budget: budget.trim() ? Number(budget) : null,
      startDate: startDate || null,
      origin,
      mustVisit: [
        ...new Set(
          mustVisit
            .split(/[，,、\n]/)
            .map((text) => text.trim())
            .filter(Boolean),
        ),
      ],
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
  };
  const revise = (text: string) => {
    if (trip) void startPlanning({ ...trip.request, message: text }, trip.id);
  };
  const explore = (destination: (typeof citiesToExplore)[number]) => {
    desiredCity.current = destination.cityCode;
    setProvinceCode(destination.provinceCode);
    if (provinceCode === destination.provinceCode) setCityCode(destination.cityCode);
    document.getElementById('planner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const openTrip = async (id: string) => {
    try {
      const loaded = await api.trip(id);
      setTrip(loaded);
      setHistoryOpen(false);
      setTimeout(
        () => document.getElementById('results')?.scrollIntoView({ behavior: 'smooth' }),
        100,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const latest = progress.at(-1);
  const stageIndex = ['places', 'planning', 'routing', 'saving'].indexOf(latest?.stage ?? 'places');
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="STREE 首页">
          <span className="brand-mark">
            <Route size={22} strokeWidth={2.4} />
          </span>
          STREE
          <span className="brand-separator" />
          <small>城市旅行手册</small>
        </a>
        <nav>
          <a href="#planner">
            规划旅行 <ArrowUpRight size={13} />
          </a>
          <button
            onClick={() => {
              void refreshHistory();
              setHistoryOpen(true);
            }}
          >
            <History size={16} /> 我的行程
          </button>
        </nav>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="tiny-cross">✳</span> LESS SEARCHING. MORE EXPLORING.
            </span>
            <h1>
              从一座城，
              <br />
              走进一段<span className="serif-accent">旅程。</span>
            </h1>
            <p>
              告诉我们你想去哪里，剩下的交给灵感与地图。
              <br />
              顺路的行程、真实的交通，还有每一站的游玩攻略。
            </p>
            <a className="hero-link" href="#planner">
              开始我的旅行 <ArrowRight size={19} />
            </a>
            <div className="hero-footnote">
              <span>01 / 选择一座城</span>
              <span>02 / 找到你的走法</span>
              <span>03 / 带着攻略出发</span>
            </div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-grid" />
            <span className="art-coordinate top">30°16′ N / 120°09′ E</span>
            <svg viewBox="0 0 560 430" className="art-map">
              <path className="art-river" d="M380 -30 C250 100 420 180 285 255 S195 430 120 500" />
              <path
                className="art-street"
                d="M30 130L490 80M50 260L450 200M80 360L500 300M80 0L210 410M240 -20L345 450M450 0L470 450"
              />
              <path
                className="art-route"
                d="M150 295 C85 210 160 165 235 180 S365 95 410 140 S370 310 295 320"
              />
              <circle cx="150" cy="295" r="10" />
              <circle cx="235" cy="180" r="10" />
              <circle cx="410" cy="140" r="10" />
              <circle cx="295" cy="320" r="10" />
            </svg>
            <span className="art-note note-one">
              <i>01</i> 转过这个街角
            </span>
            <span className="art-note note-two">
              <i>02</i> 遇见城市日常
            </span>
            <span className="art-note note-three">
              <i>03</i> 留一点时间给风景
            </span>
            <div className="art-stamp">
              <Compass size={32} />
              <span>
                WANDER
                <br />
                WITH PURPOSE
              </span>
            </div>
            <span className="art-coordinate bottom">一条路线，无数种遇见。 / 示意图</span>
          </div>
        </section>
        <section className="planner-section" id="planner">
          <div className="section-heading">
            <div>
              <span className="eyebrow">PLAN YOUR NEXT CHAPTER</span>
              <h2>这次，想去哪座城？</h2>
            </div>
            <span className="section-number">/ 01</span>
          </div>
          <form className="planner-card" onSubmit={submit}>
            <fieldset disabled={busy}>
              <div className="destination-row">
                <label>
                  <span>省份 / 直辖市</span>
                  <div className="select-wrap">
                    <select
                      aria-label="省份或直辖市"
                      value={provinceCode}
                      onChange={(event) => {
                        desiredCity.current = '';
                        setProvinceCode(event.target.value);
                      }}
                    >
                      {provinces.length ? (
                        provinces.map((item) => (
                          <option key={item.adcode} value={item.adcode}>
                            {item.name}
                          </option>
                        ))
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
                      onChange={(event) => setCityCode(event.target.value)}
                    >
                      {cityLoading ? (
                        <option>正在查询城市…</option>
                      ) : cities.length ? (
                        cities.map((item) => (
                          <option key={item.adcode} value={item.adcode}>
                            {item.name}
                          </option>
                        ))
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
                    每人市内总预算 <small>元 / 选填</small>
                  </span>
                  <input
                    aria-label="每人市内总预算"
                    type="number"
                    min="100"
                    max="100000"
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    placeholder="让路线自然展开"
                  />
                </label>
                <label>
                  <span>
                    从哪里出发 <small>选填</small>
                  </span>
                  <input
                    aria-label="出发地点"
                    value={origin}
                    onChange={(event) => setOrigin(event.target.value)}
                    placeholder="酒店、车站，或一个具体地点"
                    maxLength={100}
                  />
                </label>
                <label className="must-visit-field">
                  <span>
                    一定想去的地方 <small>选填</small>
                  </span>
                  <input
                    aria-label="必去地点"
                    value={mustVisit}
                    onChange={(event) => setMustVisit(event.target.value)}
                    placeholder="用逗号分隔，比如：西湖，灵隐寺"
                    maxLength={600}
                  />
                </label>
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
                      {selectedInterests.includes(interest) && <Check size={13} />} {interest}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-row preferences-row">
                <label>
                  <span>喜欢的节奏</span>
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
                </label>
                <label>
                  <span>主要交通方式</span>
                  <div className="segmented">
                    {(
                      [
                        ['transit', '公共交通'],
                        ['walking', '步行'],
                        ['driving', '自驾'],
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
                </label>
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
              <div className="form-footer">
                <span>
                  <MapPin size={15} />
                  {province?.name ?? '中国'} · {city?.name ?? '选择一座城'}
                  <small>高德实时地点与交通，搭配路线专属攻略</small>
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
            <div className="planning-progress" role="status" aria-live="polite">
              <div className="progress-head">
                <span className="progress-icon">
                  <Compass className="spin-slow" size={25} />
                </span>
                <div>
                  <span className="eyebrow">A GOOD JOURNEY TAKES A LITTLE THOUGHT</span>
                  <h3>{latest?.message ?? '正在准备你的旅行计划'}</h3>
                  <p>正在把地点、真实交通和游玩建议，整理成一份完整行程。</p>
                </div>
                <button
                  className="button button-secondary button-small"
                  onClick={() => void cancel()}
                >
                  取消规划
                </button>
              </div>
              <div className="progress-stages">
                {['寻找地点', '设计行程', '核对交通', '整理攻略'].map((label, index) => (
                  <span className={index <= stageIndex ? 'active' : ''} key={label}>
                    {index < stageIndex ? (
                      <Check size={14} />
                    ) : index === stageIndex ? (
                      <RefreshCw size={14} className="spin" />
                    ) : (
                      <span className="stage-dot" />
                    )}
                    {label}
                  </span>
                ))}
              </div>
              <p className="progress-recent">
                {progress
                  .slice(-3)
                  .map((item) => item.message)
                  .join(' · ')}
              </p>
            </div>
          )}
        </section>
        {trip && (
          <section id="results">
            <TripView key={trip.updatedAt} trip={trip} onRevise={revise} busy={busy} />
          </section>
        )}
        {!trip && (
          <section className="explore-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">SOMEWHERE NEW, SOMETHING FAMILIAR</span>
                <h2>灵感，可以从这里开始。</h2>
              </div>
              <span className="section-number">/ 02</span>
            </div>
            <div className="destination-cards">
              {citiesToExplore.map((destination, index) => (
                <button
                  className={`destination-card destination-${index}`}
                  key={destination.cityCode}
                  onClick={() => explore(destination)}
                  disabled={busy}
                >
                  <span className="destination-top">
                    {destination.province}
                    <span>0{index + 1}</span>
                  </span>
                  <div className="destination-lines" />
                  <div className="destination-bottom">
                    <span>
                      <small>{destination.tag}</small>
                      <strong>{destination.name}</strong>
                    </span>
                    <ArrowUpRight size={24} />
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="how-it-works">
          <div>
            <Compass size={22} />
            <h3>有方向，也有余地。</h3>
            <p>从省份到城市，按你的时间、预算与喜好，找到自己的旅行节奏。</p>
          </div>
          <div>
            <Route size={22} />
            <h3>把好走的路，排在一起。</h3>
            <p>查询实际交通，把每天的停靠点串起来，让时间留给体验。</p>
          </div>
          <div>
            <BookOpen size={22} />
            <h3>带着攻略，而不是疑问。</h3>
            <p>每条路线都有专属手册，每一站都有看点与游玩建议。</p>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span className="footer-brand">
          STREE <small>好路线，是旅行的开始。</small>
        </span>
        <span className="footer-status">
          <span
            className={`live-dot ${status?.codex.authenticated && status?.amap.configured && status?.storage.available ? '' : 'muted'}`}
          />
          {status?.codex.authenticated && status.amap.configured && status.storage.available
            ? '规划服务已就绪'
            : '正在等待规划服务就绪'}
        </span>
        <small>MADE FOR THE WAY YOU WANDER.</small>
      </footer>
      {historyOpen && (
        <div className="drawer-backdrop" onClick={() => setHistoryOpen(false)}>
          <aside
            className="history-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="我的行程"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">YOUR TRAVEL ARCHIVE</span>
                <h2>我的行程</h2>
              </div>
              <button
                className="icon-button"
                aria-label="关闭我的行程"
                onClick={() => setHistoryOpen(false)}
              >
                <X />
              </button>
            </header>
            {history.length ? (
              history.map((item) => (
                <button
                  className="history-item"
                  key={item.id}
                  onClick={() => void openTrip(item.id)}
                >
                  <span>
                    {item.city.name} · {item.days} 天
                  </span>
                  <strong>{item.title}</strong>
                  <small>
                    {new Date(item.createdAt).toLocaleDateString('zh-CN')}{' '}
                    <ArrowUpRight size={15} />
                  </small>
                </button>
              ))
            ) : (
              <div className="history-empty">
                <Compass size={38} />
                <h3>下一段旅程，等你开启。</h3>
                <p>完成规划后，路线和攻略会保存在这里。</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
