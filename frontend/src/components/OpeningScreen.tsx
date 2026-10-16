import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Compass, RefreshCw, Plane, MapPin } from 'lucide-react';

const seenKey = 'stree-opening-seen';
const routePath = 'M150 295 C85 210 160 165 235 180 S365 95 410 140 S370 310 295 320';

export function shouldShowOpening() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    return sessionStorage.getItem(seenKey) !== 'true';
  } catch {
    return true;
  }
}

export default function OpeningScreen({
  onComplete,
  preview = false,
  onReplay,
}: {
  onComplete: () => void;
  preview?: boolean;
  onReplay: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const screen = useRef<HTMLElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const replayButton = useRef<HTMLButtonElement>(null);
  const maskId = useId();

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    screen.current?.focus({ preventScroll: true });
    const timer = preview ? null : setTimeout(() => setLeaving(true), 3000);
    return () => {
      if (timer) clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
    };
  }, [preview]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      try {
        if (!preview) sessionStorage.setItem(seenKey, 'true');
      } catch {
        // Storage restrictions should never prevent entering the planner.
      }
      onComplete();
    }, 450);
    return () => clearTimeout(timer);
  }, [leaving, onComplete, preview]);

  return (
    <section
      ref={screen}
      tabIndex={-1}
      className={`opening-screen${preview ? ' is-preview' : ''}${leaving ? ' is-leaving' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="opening-title"
      aria-describedby="opening-description"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setLeaving(true);
        if (event.key === 'Tab') {
          event.preventDefault();
          const buttons = [startButton.current, replayButton.current, skipButton.current].filter(
            (button): button is HTMLButtonElement => button !== null,
          );
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.shiftKey
            ? current < 0
              ? buttons.length - 1
              : (current + buttons.length - 1) % buttons.length
            : (current + 1) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      <div className="opening-atmosphere" aria-hidden="true">
        <div className="opening-glow glow-peach" />
        <div className="opening-glow glow-sage" />
        <div className="opening-grain" />
      </div>

      <div className="hero opening-content">
        <div className="hero-copy">
          <div className="opening-edition">
            <span>STREE</span>
            <i /> 城市旅行手册 · VOL. 01
          </div>
          <span className="eyebrow">
            <span className="tiny-cross">✳</span> LESS SEARCHING. MORE EXPLORING.
          </span>
          <h1 id="opening-title">
            <span className="opening-line">从一座城，</span>
            <span className="opening-line">
              走进一段<span className="serif-accent">旅程。</span>
            </span>
          </h1>
          <p id="opening-description">
            告诉我们你想去哪里，剩下的交给灵感与地图。
            <br />
            把时间留给风景，把惊喜留给沿途。
          </p>
          <button ref={startButton} className="hero-link" onClick={() => setLeaving(true)}>
            开始我的旅行{' '}
            <span className="opening-button-arrow">
              <ArrowUpRight size={19} />
            </span>
          </button>
          <div className="hero-footnote">
            <span>01 / 选择一座城</span>
            <span>02 / 找到你的走法</span>
            <span>03 / 带着攻略出发</span>
          </div>
        </div>
        <div className="hero-art opening-scene" aria-hidden="true">
          <div className="opening-sun">
            <span />
          </div>
          <svg className="opening-flight" viewBox="0 0 560 560">
            <path d="M25 160 C-20 50 115 45 90 130 S15 240 90 285 S350 450 510 120" />
          </svg>
          <div className="opening-airmail">
            <Plane size={19} />
            <span>
              下一站
              <br />
              <strong>随心出发</strong>
            </span>
          </div>
          <div className="opening-map-card">
            <div className="opening-map-caption">
              <span>
                <MapPin size={12} /> 城市漫游地图
              </span>
              <span>EXPLORE / 001</span>
            </div>
            <div className="opening-map-surface">
              <div className="art-grid" />
              <span className="art-coordinate top">30°16′ N / 120°09′ E</span>
              <svg viewBox="0 0 560 430" className="art-map">
                <defs>
                  <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="560" height="430">
                    <path className="opening-route-reveal" d={routePath} pathLength="1" />
                  </mask>
                </defs>
                <g className="opening-map-blocks">
                  <rect x="95" y="60" width="97" height="50" rx="12" />
                  <rect x="205" y="228" width="66" height="66" rx="16" />
                  <rect x="389" y="290" width="75" height="49" rx="10" />
                  <rect x="12" y="164" width="86" height="66" rx="10" />
                </g>
                <g className="opening-map-parks">
                  <path d="M192 35 Q221 8 252 32 L276 107 Q238 133 210 102 Z" />
                  <path d="M380 216 Q425 183 450 230 L458 260 Q417 284 385 260 Z" />
                  <path d="M85 340 Q118 306 164 340 L178 387 L97 400 Z" />
                </g>
                <path
                  className="art-river"
                  d="M380 -30 C250 100 420 180 285 255 S195 430 120 500"
                />
                <path
                  className="art-street"
                  d="M30 130L490 80M50 260L450 200M80 360L500 300M80 0L210 410M240 -20L345 450M450 0L470 450"
                />
                <path className="art-route" d={routePath} mask={`url(#${maskId})`} />
                <circle className="opening-stop stop-one" cx="150" cy="295" r="10" />
                <circle className="opening-stop stop-two" cx="235" cy="180" r="10" />
                <circle className="opening-stop stop-three" cx="410" cy="140" r="10" />
                <circle className="opening-stop stop-four" cx="295" cy="320" r="10" />
                <circle className="opening-traveler" r="6">
                  <animateMotion
                    path={routePath}
                    dur={preview ? '9s' : '1.8s'}
                    begin={preview ? '2.6s' : '0.5s'}
                    repeatCount={preview ? 'indefinite' : '1'}
                    fill="freeze"
                  />
                </circle>
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
              <span className="art-coordinate bottom">一条路线，无数种遇见。</span>
            </div>
            <div className="opening-map-bottom">
              <span>跟着好奇心，走一走。</span>
              <Compass size={21} />
            </div>
          </div>
          <div className="opening-postcard">
            <svg viewBox="0 0 220 120">
              <rect width="220" height="120" fill="#eddcb5" />
              <circle cx="160" cy="36" r="20" fill="#df8962" />
              <path d="M0 81 Q45 14 95 65 T220 50 V120 H0Z" fill="#819a75" />
              <path d="M0 99 Q60 58 120 91 T220 75 V120 H0Z" fill="#416e5f" />
              <path d="M0 113 Q65 83 120 110 T220 98 V120 H0Z" fill="#92bec0" />
            </svg>
            <span>
              走走停停，也很好。<i>✳</i>
            </span>
          </div>
          <div className="opening-discovery">
            <span>✳</span> 好风景，在路上。
          </div>
        </div>
      </div>

      <div className="opening-signoff" aria-hidden="true">
        <span className="opening-signoff-dot" /> LESS SEARCHING. MORE EXPLORING.
      </div>
      {preview ? (
        <button
          ref={replayButton}
          className="opening-replay"
          onClick={onReplay}
          aria-label="重播动画"
          title="重播动画"
        >
          <RefreshCw size={18} />
        </button>
      ) : (
        <button ref={skipButton} className="opening-skip" onClick={() => setLeaving(true)}>
          跳过 <ArrowRight size={14} />
        </button>
      )}
    </section>
  );
}
