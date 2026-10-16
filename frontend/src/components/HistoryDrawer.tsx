import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clock3, Compass, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { PlanningTaskSummary, TravelHistory } from '@stree/shared';
import { api } from '../api';

const filters = ['全部', '生成中', '已完成', '未完成'] as const;
type Filter = (typeof filters)[number];
const dateLabel = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export default function HistoryDrawer({
  onClose,
  onOpenTrip,
  onOpenTask,
  version,
}: {
  onClose: () => void;
  onOpenTrip: (id: string) => Promise<void>;
  onOpenTask: (task: PlanningTaskSummary) => Promise<void>;
  version: number;
}) {
  const [data, setData] = useState<TravelHistory | null>(null);
  const [filter, setFilter] = useState<Filter>('全部');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const elements = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), summary, [href], [tabindex="0"]',
      );
      const first = elements?.[0];
      const last = elements?.[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api.travelHistory();
        if (!disposed) {
          setData(result);
          setError('');
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : '行程记录加载失败，请重试。');
      } finally {
        // Fetch after each response so slow requests cannot overlap.
        if (!disposed) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [version, retry]);

  const open = async (id: string, action: () => Promise<void>) => {
    if (openingId) return;
    setOpeningId(id);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : '暂时无法打开，请重试。');
    } finally {
      setOpeningId(null);
    }
  };
  const tasks = data?.tasks.filter((task) => task.status !== 'completed') ?? [];
  const running = tasks.filter((task) => task.status === 'running');
  const unfinished = tasks.filter((task) => task.status !== 'running');
  const trips = data?.trips ?? [];
  const counts: Record<Filter, number> = {
    全部: tasks.length + trips.length,
    生成中: running.length,
    已完成: trips.length,
    未完成: unfinished.length,
  };
  const visibleTasks =
    filter === '已完成'
      ? []
      : filter === '生成中'
        ? running
        : filter === '未完成'
          ? unfinished
          : tasks;
  const showTrips = filter === '全部' || filter === '已完成';
  const empty = data && visibleTasks.length === 0 && (!showTrips || trips.length === 0);
  const entries = [
    ...visibleTasks.map((task) => ({
      kind: 'task' as const,
      task,
      createdAt: task.createdAt,
      running: task.status === 'running',
    })),
    ...(showTrips
      ? trips.map((trip) => ({
          kind: 'trip' as const,
          trip,
          createdAt: trip.createdAt,
          running: false,
        }))
      : []),
  ].sort((a, b) => Number(b.running) - Number(a.running) || b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        ref={panel}
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
            ref={closeButton}
            className="icon-button"
            aria-label="关闭我的行程"
            onClick={onClose}
          >
            <X />
          </button>
        </header>
        <p className="history-intro">从正在成形的路线，到准备出发的旅程。</p>
        <div className="history-filters" role="group" aria-label="筛选行程状态">
          {filters.map((item) => (
            <button key={item} aria-pressed={filter === item} onClick={() => setFilter(item)}>
              {item}
              <span>{data ? counts[item] : '—'}</span>
            </button>
          ))}
        </div>
        {error && (
          <div className="history-feedback" role="alert">
            <p>{error}</p>
            <button onClick={() => setRetry((value) => value + 1)}>
              <RefreshCw size={13} /> 重试
            </button>
          </div>
        )}
        {!data && !error && (
          <p className="history-loading" role="status">
            <LoaderCircle size={16} className="spin" /> 正在读取行程记录…
          </p>
        )}
        {!!running.length && (filter === '全部' || filter === '生成中') && (
          <p className="history-live-note">
            <span className="history-live-dot" />
            {running.length} 个规划正在进行 · 进度自动更新
          </p>
        )}
        {entries.map((entry) => {
          if (entry.kind === 'task') {
            const task = entry.task;
            return (
              <article className={`history-task is-${task.status}`} key={task.id}>
                <div className="history-card-top">
                  <span>
                    {task.cityName} · {task.request.days} 天
                  </span>
                  <span className={`history-status is-${task.status}`}>
                    {task.status === 'running' ? (
                      <>
                        <LoaderCircle size={12} className="spin" /> 生成中
                      </>
                    ) : task.status === 'failed' ? (
                      '生成失败'
                    ) : (
                      '已取消'
                    )}
                  </span>
                </div>
                <h3>{task.cityName}旅行规划</h3>
                {task.status === 'running' ? (
                  <>
                    <p className="history-task-progress">
                      {task.progress?.message || '正在准备这次旅行的路线与攻略…'}
                    </p>
                    <div className="history-task-track" aria-hidden="true">
                      <span />
                    </div>
                  </>
                ) : task.status === 'failed' && task.error ? (
                  <details className="history-task-error">
                    <summary>查看失败原因</summary>
                    <p>{task.error}</p>
                  </details>
                ) : (
                  <p className="history-task-progress">
                    {task.status === 'cancelled'
                      ? '这次规划已取消，旅行灵感留待下次。'
                      : '规划未能完成，请重新生成。'}
                  </p>
                )}
                <div className="history-card-bottom">
                  <time dateTime={task.createdAt}>
                    <Clock3 size={12} />
                    {dateLabel(task.createdAt)}
                  </time>
                  {task.status === 'running' && (
                    <button
                      disabled={!!openingId}
                      onClick={() => void open(task.id, () => onOpenTask(task))}
                    >
                      {openingId === task.id ? '正在打开…' : '查看进度'}
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                </div>
              </article>
            );
          }
          return (
            <button
              className="history-item"
              key={entry.trip.id}
              disabled={!!openingId}
              onClick={() => void open(entry.trip.id, () => onOpenTrip(entry.trip.id))}
            >
              <span className="history-card-top">
                <span>
                  {entry.trip.city.name} · {entry.trip.days} 天
                </span>
                <span className="history-status is-completed">
                  <Check size={12} /> 已完成
                </span>
              </span>
              <strong>{entry.trip.title}</strong>
              <small>
                <time dateTime={entry.trip.createdAt}>{dateLabel(entry.trip.createdAt)}</time>
                <span>
                  {openingId === entry.trip.id ? '正在打开…' : '查看路线'}{' '}
                  <ArrowUpRight size={14} />
                </span>
              </small>
            </button>
          );
        })}
        {empty && (
          <div className="history-empty">
            <Compass size={38} />
            <h3>
              {filter === '全部'
                ? '下一段旅程，等你开启。'
                : filter === '生成中'
                  ? '暂时没有正在生成的行程'
                  : filter === '已完成'
                    ? '还没有保存的路线'
                    : '暂时没有未完成的规划'}
            </h3>
            <p>
              {filter === '全部'
                ? '开始规划后，就能在这里查看进度和路线。'
                : '每一次规划的状态，都会在这里留下记录。'}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
