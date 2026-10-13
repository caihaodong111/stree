import { useState } from 'react';
import {
  ArrowUpRight,
  BedDouble,
  BookOpen,
  Camera,
  ChevronDown,
  Clock3,
  Download,
  Footprints,
  MapPin,
  Ticket,
  Utensils,
  Wallet,
} from 'lucide-react';
import type { Trip } from '@stree/shared';
import MapView from './MapView';

export default function TripView({
  trip,
  onRevise,
  busy,
}: {
  trip: Trip;
  onRevise: (message: string) => void;
  busy: boolean;
}) {
  const [routeIndex, setRouteIndex] = useState(0);
  const [dayIndex, setDayIndex] = useState(0);
  const [selectedPoi, setSelectedPoi] = useState<string | null>(null);
  const [tab, setTab] = useState<'itinerary' | 'guide'>('itinerary');
  const [revision, setRevision] = useState('');
  const route = trip.routes[routeIndex] ?? trip.routes[0]!;
  const day = route.days[dayIndex] ?? route.days[0]!;
  const selectPoi = (id: string) => {
    setTab('itinerary');
    setSelectedPoi(id);
    document.getElementById(`stop-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  return (
    <div className="trip-workspace">
      <section className="result-intro">
        <div>
          <span className="eyebrow">YOUR JOURNEY / {trip.city.name}</span>
          <h2>这座城，有了你的走法。</h2>
          <p>{trip.summary}</p>
        </div>
        <button className="button button-secondary" onClick={() => exportGuide(trip, routeIndex)}>
          <Download size={16} /> 导出攻略
        </button>
      </section>
      <div className="route-options" role="tablist" aria-label="候选路线">
        {trip.routes.map((option, index) => (
          <button
            role="tab"
            aria-selected={routeIndex === index}
            className={`route-option ${routeIndex === index ? 'selected' : ''}`}
            key={option.id}
            onClick={() => {
              setRouteIndex(index);
              setDayIndex(0);
              setSelectedPoi(null);
            }}
          >
            <span className="route-option-tag">
              方案 {String(index + 1).padStart(2, '0')} · {option.label}
            </span>
            <strong>{option.title}</strong>
            <span>{option.suitableFor}</span>
            <div>
              <span>约 ¥{option.totalEstimatedBudget}</span>
              <ArrowUpRight size={18} />
            </div>
          </button>
        ))}
      </div>
      <div className="route-summary">
        <p>{route.summary}</p>
        <div className="route-metrics">
          <span>
            <Wallet size={17} /> ¥{route.totalEstimatedBudget}
            <small>每人参考总预算</small>
          </span>
          <span>
            <Footprints size={17} /> {(route.distanceMeters / 1000).toFixed(1)} km
            <small>交通路线距离</small>
          </span>
          <span>
            <Clock3 size={17} /> {Math.round((route.transitMinutes / 60) * 10) / 10} h
            <small>累计交通时间</small>
          </span>
        </div>
      </div>
      <div className="day-navigation">
        <div role="tablist" aria-label="行程天数">
          {route.days.map((item, index) => (
            <button
              role="tab"
              aria-selected={dayIndex === index}
              className={dayIndex === index ? 'active' : ''}
              key={item.day}
              onClick={() => {
                setDayIndex(index);
                setSelectedPoi(null);
              }}
            >
              <span>DAY {String(item.day).padStart(2, '0')}</span>
              {item.title}
            </button>
          ))}
        </div>
      </div>
      <MapView
        trip={trip}
        route={route}
        dayIndex={dayIndex}
        selectedPoi={selectedPoi}
        onSelect={selectPoi}
      />
      <div className="detail-grid">
        <section className="itinerary-panel">
          <div className="detail-tabs" role="tablist" aria-label="行程详情">
            <button
              role="tab"
              aria-selected={tab === 'itinerary'}
              className={tab === 'itinerary' ? 'active' : ''}
              onClick={() => setTab('itinerary')}
            >
              <MapPin size={17} /> 每日行程
            </button>
            <button
              role="tab"
              aria-selected={tab === 'guide'}
              className={tab === 'guide' ? 'active' : ''}
              onClick={() => setTab('guide')}
            >
              <BookOpen size={17} /> 路线攻略
            </button>
          </div>
          {tab === 'itinerary' ? (
            <>
              <div className="day-intro">
                <span className="eyebrow">{day.date ?? `第 ${day.day} 天`}</span>
                <h3>{day.title}</h3>
                <p>{day.overview}</p>
              </div>
              <div className="timeline">
                {day.stops.map((stop, index) => {
                  const incoming = day.segments.find((segment) => segment.to === stop.poi.name);
                  return (
                    <article
                      className={`stop-card ${selectedPoi === stop.poiId ? 'focused' : ''}`}
                      id={`stop-${stop.poiId}`}
                      key={stop.poiId}
                    >
                      <span className="stop-number">{String(index + 1).padStart(2, '0')}</span>
                      <div className="stop-main">
                        {incoming && (
                          <div className="incoming-route">
                            <Footprints size={13} />
                            {incoming.summary} · {incoming.durationMinutes} 分钟 ·{' '}
                            {(incoming.distanceMeters / 1000).toFixed(1)} km
                          </div>
                        )}
                        <div className="stop-heading">
                          <div>
                            <span className="stop-time">
                              {stop.arrival} — {stop.departure}
                            </span>
                            <h4>{stop.poi.name}</h4>
                          </div>
                          <button
                            className="icon-button"
                            title="在地图定位"
                            aria-label={`在地图定位${stop.poi.name}`}
                            onClick={() => setSelectedPoi(stop.poiId)}
                          >
                            <MapPin size={18} />
                          </button>
                        </div>
                        <p>{stop.reason}</p>
                        <span className="stop-address">
                          {stop.poi.district} · {stop.poi.address}
                        </span>
                        <details open={selectedPoi === stop.poiId}>
                          <summary
                            onClick={(event) => {
                              event.preventDefault();
                              setSelectedPoi(selectedPoi === stop.poiId ? null : stop.poiId);
                            }}
                          >
                            <BookOpen size={15} /> 这一站怎么玩 <ChevronDown size={15} />
                          </summary>
                          <div className="stop-guide">
                            <p>{stop.guide.introduction}</p>
                            <strong>值得留意</strong>
                            <ul>
                              {stop.guide.highlights.map((text) => (
                                <li key={text}>{text}</li>
                              ))}
                            </ul>
                            <strong>游玩建议</strong>
                            <ul>
                              {stop.guide.tips.map((text) => (
                                <li key={text}>{text}</li>
                              ))}
                            </ul>
                            <p className="guide-note">
                              <Ticket size={15} />
                              {stop.guide.reservation}
                            </p>
                            {stop.guide.photography && (
                              <p className="guide-note">
                                <Camera size={15} />
                                {stop.guide.photography}
                              </p>
                            )}
                          </div>
                        </details>
                      </div>
                    </article>
                  );
                })}
              </div>
              {day.hotel && (
                <article className="hotel-card">
                  <BedDouble size={23} />
                  <div>
                    <span className="eyebrow">今晚住这里</span>
                    <h4>{day.hotel.name}</h4>
                    <p>{day.hotelReason}</p>
                    <small>{day.hotel.address} · 房价与可订状态需确认</small>
                  </div>
                </article>
              )}
              {day.foodTips.length > 0 && (
                <div className="food-tips">
                  <h4>
                    <Utensils size={17} /> 吃点当地的
                  </h4>
                  <ul>
                    {day.foodTips.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="full-guide">
              <span className="eyebrow">FIELD NOTES / 路线专属攻略</span>
              <h3>{route.title}</h3>
              <p>{route.guide.overview}</p>
              <GuideSection title="出发前，先准备好" items={route.guide.beforeYouGo} />
              <GuideSection title="像当地人一样逛" items={route.guide.localTips} />
              <GuideSection title="行李清单" items={route.guide.packingList} />
              <GuideSection title="需要确认的事情" items={route.caveats} />
            </div>
          )}
        </section>
        <aside className="trip-aside">
          <section className="budget-card">
            <span className="eyebrow">TRAVEL BUDGET</span>
            <h3>每一笔，都有数。</h3>
            <strong className="budget-total">
              <small>约</small> ¥{route.totalEstimatedBudget}
            </strong>
            <p>每人 · 市内行程参考费用</p>
            <dl>
              <div>
                <dt>门票参考</dt>
                <dd>¥{route.estimatedTicketBudget}</dd>
              </div>
              <div>
                <dt>餐饮参考</dt>
                <dd>¥{route.estimatedFoodBudget}</dd>
              </div>
              <div>
                <dt>住宿分摊参考</dt>
                <dd>¥{trip.request.includeHotel ? route.estimatedHotelBudget : 0}</dd>
              </div>
              <div>
                <dt>高德已知交通费</dt>
                <dd>¥{route.transportCost.toFixed(0)}</dd>
              </div>
            </dl>
            <small>
              门票、餐饮和住宿为 AI 估算；不含往返目的地的交通。驾车费用仅统计已知路桥费。
            </small>
          </section>
          <section className="revision-card">
            <BookOpen size={22} />
            <h3>让它更像你的旅行。</h3>
            <p>节奏慢一点、加一处景点，或换种走法，都可以继续调整。</p>
            <textarea
              aria-label="修改行程的要求"
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="比如：第二天轻松一点，多留些时间逛街。"
              maxLength={1500}
            />
            <button
              className="button"
              disabled={busy || revision.trim().length < 2}
              onClick={() => onRevise(revision)}
            >
              调整这份行程 <ArrowUpRight size={16} />
            </button>
          </section>
          {route.warnings.length > 0 && (
            <section className="route-warnings">
              <strong>行程提醒</strong>
              <ul>
                {route.warnings.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </section>
          )}
          <p className="data-caption">
            地点与交通来自高德地图。攻略由 AI
            根据本次路线编写，开放时间、预约与价格以官方当日信息为准。
          </p>
        </aside>
      </div>
    </div>
  );
}
function GuideSection({ title, items }: { title: string; items: string[] }) {
  return items.length ? (
    <section>
      <h4>{title}</h4>
      <ul>
        {items.map((text, index) => (
          <li key={index}>{text}</li>
        ))}
      </ul>
    </section>
  ) : null;
}
function exportGuide(trip: Trip, index: number) {
  const route = trip.routes[index]!;
  const lines = [
    `# ${route.title}`,
    `${trip.province.name} · ${trip.city.name} | ${trip.request.days} 天`,
    route.summary,
    `每人参考预算：¥${route.totalEstimatedBudget}`,
    `\n## 路线攻略\n${route.guide.overview}`,
  ];
  for (const day of route.days) {
    lines.push(`\n## 第 ${day.day} 天：${day.title}`, day.overview);
    for (const stop of day.stops) {
      lines.push(
        `\n### ${stop.arrival}–${stop.departure} ${stop.poi.name}`,
        stop.poi.address,
        stop.guide.introduction,
        ...stop.guide.highlights.map((t) => `- ${t}`),
        ...stop.guide.tips.map((t) => `- ${t}`),
        `预约：${stop.guide.reservation}`,
        `拍照：${stop.guide.photography}`,
      );
    }
    if (day.hotel) lines.push(`\n住宿参考：${day.hotel.name}，${day.hotelReason}`);
    lines.push(...day.foodTips.map((t) => `- 餐饮：${t}`));
  }
  lines.push(
    '\n## 出发前准备',
    ...route.guide.beforeYouGo.map((t) => `- ${t}`),
    '\n## 当地建议',
    ...route.guide.localTips.map((t) => `- ${t}`),
    '\n## 携带物品',
    ...route.guide.packingList.map((t) => `- ${t}`),
    '\n## 需确认',
    ...route.caveats.concat(route.warnings).map((t) => `- ${t}`),
    '\n地点与交通来源：高德地图。攻略由 AI 编写；政策、预约与价格请以官方当日信息为准。',
  );
  const url = URL.createObjectURL(
    new Blob([lines.join('\n\n')], { type: 'text/markdown;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `STREE-${trip.city.name}-${route.title.replace(/[\\/:*?"<>|]/g, '')}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
