import { useEffect, useState } from 'react';
import { Check, MapPin } from 'lucide-react';
import type { ProgressEvent } from '@stree/shared';

const stages = [
  { id: 'places', label: '确认地点', detail: '寻找真实地点，把想去的地方放进地图。' },
  { id: 'planning', label: 'AI 规划', detail: 'AI 正在安排地点顺序、每段交通与游玩时间。' },
  {
    id: 'routing',
    label: '准备地图',
    detail: '载入地点与已有导航数据，保留 AI 给出的最终安排。',
  },
  { id: 'saving', label: '保存行程', detail: '路线与攻略已完成，正在保存这份旅行计划。' },
] as const;

export default function PlanningProgress({
  progress,
  destination,
  onCancel,
  createdAt,
}: {
  progress: ProgressEvent[];
  destination: string;
  onCancel: () => void;
  createdAt?: string;
}) {
  const [startedAt] = useState(() => (createdAt ? Date.parse(createdAt) : Date.now()));
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const latest = progress.at(-1);
  const stageIndex = Math.max(
    0,
    stages.findIndex((stage) => stage.id === latest?.stage),
  );
  const stage = stages[stageIndex]!;
  const duration =
    elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;

  return (
    <div className="planning-progress" aria-label="旅行规划进度">
      <div className="journey-animation" aria-hidden="true">
        <span className="journey-map-label">YOUR NEXT CHAPTER</span>
        <svg viewBox="0 0 280 170" fill="none">
          <path
            className="journey-map-street"
            d="M-10 30L290 140M-10 105L290 15M35-10L100 180M150-10L215 180M-10 155L290 65"
          />
          <path
            className="journey-map-river"
            d="M-10 155C55 110 30 70 115 90S165 125 210 45S250 5 290 15"
          />
          <path
            className="journey-route-track"
            d="M48 125C85 125 68 53 118 53S151 124 195 104S215 57 241 42"
          />
          <path
            className="journey-route-line"
            pathLength="1"
            d="M48 125C85 125 68 53 118 53S151 124 195 104S215 57 241 42"
          />
          <g className="journey-map-pin pin-one">
            <circle cx="48" cy="125" r="12" />
            <circle cx="48" cy="125" r="4" />
          </g>
          <g className="journey-map-pin pin-two">
            <circle cx="118" cy="53" r="12" />
            <circle cx="118" cy="53" r="4" />
          </g>
          <g className="journey-map-pin pin-three">
            <circle cx="195" cy="104" r="12" />
            <circle cx="195" cy="104" r="4" />
          </g>
          <circle className="journey-traveler" r="5">
            <animateMotion
              dur="6s"
              repeatCount="indefinite"
              path="M48 125C85 125 68 53 118 53S151 124 195 104S215 57 241 42"
            />
          </circle>
          <path
            className="journey-map-destination"
            d="M241 22C230 22 227 37 241 47C255 37 252 22 241 22Z"
          />
          <circle cx="241" cy="32" r="3" fill="#fbfcf7" />
        </svg>
        <span className="journey-destination">
          <MapPin size={12} />
          {destination || '下一座城'}
          <span className="journey-ellipsis">
            <i />
            <i />
            <i />
          </span>
        </span>
      </div>
      <div className="journey-progress-content">
        <div className="journey-progress-topline">
          <span className="eyebrow">A LITTLE THOUGHT, A BETTER JOURNEY</span>
          <span className="journey-elapsed" aria-live="off">
            已等待 {duration}
          </span>
        </div>
        <div
          className="journey-progress-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <h3>
            好路线，正在成形<span className="journey-title-dots">…</span>
          </h3>
          <p>{stage.detail}</p>
          <div className="journey-current">
            <span className="journey-current-dot" />
            {latest?.message || '正在连接规划服务'}
          </div>
        </div>
        <ol className="progress-stages" aria-label="规划阶段">
          {stages.map((item, index) => (
            <li
              className={index < stageIndex ? 'done' : index === stageIndex ? 'active' : ''}
              key={item.id}
              aria-current={index === stageIndex ? 'step' : undefined}
            >
              <span className="journey-stage-number">
                {index < stageIndex ? <Check size={12} /> : `0${index + 1}`}
              </span>
              {item.label}
            </li>
          ))}
        </ol>
        <div className="journey-progress-footer">
          <span>
            {elapsed >= 60 && stage.id === 'planning'
              ? '完整攻略仍在生成中，你可以继续等待或取消。'
              : '按实际完成阶段更新，每一站都值得认真安排。'}
          </span>
          <button className="journey-cancel" onClick={onCancel}>
            取消规划
          </button>
        </div>
      </div>
    </div>
  );
}
