// 英雄卡：当前聚焦品种的多周期趋势 + 各周期分布轨道 + 社区多空情绪
// Hero card: current focus symbol trend analysis + per-symbol TF track + community sentiment
//
// 2026-09-08 版式重做（结构不变，仍不落卡、直接坐在画布上）：
// · 品种用 Archivo 展示字宽放到 40px，「看空 / 看多」同样 40px 用语义色放到右侧，
//   一左一右是这一屏的结论；原来跟在品种后面的立场芯片撤掉——同一件事不说两遍。
// · 六周期轨道放到满宽、格子等分（格子仍透明、只给箭头着色）。
// · 情绪条改成两段尺 + 两端等宽读数，与信号牌的风险｜回报尺同一套形。
// Relaid 2026-09-08, same structure (still card-less on the canvas): symbol at
// display width 40px with the stance word at 40px on the right (the redundant
// stance chip is gone), the six-period track stretched to full width with equal
// cells, and sentiment as a two-segment rule with tabular readings at both ends.
import { memo, type FC, useEffect, useRef, type TouchEvent as RTouchEvent, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { Trend, TrendDir, SentimentRatio } from '../../api/types'
import { displaySymbol } from '../../api/utils'
import { TREND_TFS, type TrendStance } from './SignalView'
import { onRovingKeyDown } from '../../utils/rovingTabs'
import { swipeCommits, type SwipeRule } from '../../utils/swipe'
import { EMPTY } from '../../utils/format'

interface Props {
  symbol: string
  cnName: string
  focusIdx: number
  focusTotal: number
  stance: TrendStance
  trend: Trend | undefined
  sentiment?: SentimentRatio | null
  onPrev: () => void
  onNext: () => void
  onSelectIdx: (i: number) => void
}

const TREND_VIS: Record<TrendDir, { arrow: string; color: string }> = {
  UP: { arrow: '↑', color: 'var(--up)' },
  DOWN: { arrow: '↓', color: 'var(--down)' },
  FLAT: { arrow: '→', color: 'var(--text-3)' },
}

// 聚焦品种左右滑动：判定阈值与切换动画。HERO_OUT_MS 必须等于 --dur-fast（0.14s）。
// Focus-symbol swipe: the commit rule and the switch motion. HERO_OUT_MS must equal --dur-fast (0.14s).
const HERO_SWIPE: SwipeRule = { distance: 45, flickMin: 16, flickVelocity: 0.3 }
const AXIS_SLOP = 10
const HERO_SHIFT = 24
const HERO_OUT_MS = 140
const HERO_OUT = 'transform var(--dur-fast) var(--ease-in), opacity var(--dur-fast) var(--ease-in)'
const HERO_IN = 'transform var(--dur-base) var(--ease-out), opacity var(--dur-base) var(--ease-out)'
const HERO_BACK = 'transform var(--dur-base) var(--ease-out)'

const SignalHero: FC<Props> = ({
  symbol, cnName, focusIdx, focusTotal,
  stance, trend, sentiment, onPrev, onNext, onSelectIdx,
}) => {
  const { t } = useTranslation()
  const stanceLabel = stance === 'BULL' ? t('signals.focus.bull') : stance === 'BEAR' ? t('signals.focus.bear') : t('signals.focus.neutral')

  // 手机端左右滑动切换聚焦品种：左滑下一个 / 右滑上一个。
  // 2026-11-15 起跟手：先走 10px 再定方向，竖向整段放给页面滚动；横向时标题与两条轨道
  // 1:1 跟着手指走。松手时滑过 45px、或短而快的一甩（超过 16px 且平均快于 0.3 px/ms）
  // 就切换：旧内容顺着手势再走 24px 淡出，新内容从另一侧 24px 处淡入归位，方向与手势
  // 一致；不够就弹回。以前只在抬手时判一次，手指底下什么都不动，切换是硬切。
  // 减弱动效：仍跟手，但切换与弹回都不做位移动画。
  // Mobile swipe to switch focus symbol: swipe left → next, swipe right → prev.
  // Since 2026-11-15 it tracks the finger: the axis is decided after 10px and a vertical
  // move is left entirely to page scrolling; horizontally the title and both rails follow
  // the finger 1:1. On release, past 45px or a short fast flick (over 16px, faster than
  // 0.3 px/ms on average) switches: the old content carries on 24px in the swipe's
  // direction and fades, the new one fades in from 24px on the other side, so the motion
  // matches the gesture; otherwise it springs back. It used to decide once on lift with
  // nothing moving under the finger, then hard-cut. Reduced motion: still tracks, but the
  // switch and the spring-back don't animate.
  const touchStart = useRef<{ x: number; y: number; t: number; axis: 'x' | 'y' | null } | null>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const railsRef = useRef<HTMLDivElement>(null)
  const swapTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(swapTimer.current), [])
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const paint = (x: number, opacity: string, transition: string) => {
    for (const el of [titleRef.current, railsRef.current]) {
      if (!el) continue
      el.style.transition = transition
      el.style.transform = x ? `translateX(${x}px)` : ''
      el.style.opacity = opacity
    }
  }
  const springBack = () => paint(0, '', reduced() ? 'none' : HERO_BACK)
  const onTouchStart = (e: RTouchEvent<HTMLElement>) => {
    // 切换动画进行中不接新手势；第二根手指放下不算滑动，弹回。
    // No new gesture mid-switch; a second finger landing is not a swipe, spring back.
    if (swapTimer.current) return
    if (e.touches.length > 1) {
      if (touchStart.current?.axis === 'x') springBack()
      touchStart.current = null
      return
    }
    const p = e.touches[0]
    touchStart.current = { x: p.clientX, y: p.clientY, t: e.timeStamp, axis: null }
  }
  const onTouchMove = (e: RTouchEvent<HTMLElement>) => {
    const s = touchStart.current
    if (!s || focusTotal <= 1) return
    const p = e.touches[0]
    const dx = p.clientX - s.x
    const dy = p.clientY - s.y
    if (!s.axis) {
      if (Math.hypot(dx, dy) < AXIS_SLOP) return
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (s.axis === 'x') paint(dx, '', 'none')
  }
  const onTouchEnd = (e: RTouchEvent<HTMLElement>) => {
    const s = touchStart.current
    touchStart.current = null
    if (!s || s.axis !== 'x' || focusTotal <= 1) return
    const p = e.changedTouches[0]
    const dx = p.clientX - s.x
    const dy = p.clientY - s.y
    if (!swipeCommits(dx, dy, e.timeStamp - s.t, HERO_SWIPE)) { springBack(); return }
    const go = dx < 0 ? onNext : onPrev
    if (reduced()) { paint(0, '', 'none'); go(); return }
    const dir = dx < 0 ? -1 : 1
    paint(dx + dir * HERO_SHIFT, '0', HERO_OUT)
    swapTimer.current = window.setTimeout(() => {
      swapTimer.current = 0
      go()
      // 新内容先停在另一侧（无过渡），等 React 换好内容、这一帧画出来，再过渡回原位。
      // Park the new content on the other side (no transition), let React swap it in and
      // that frame paint, then transition home.
      paint(-dir * HERO_SHIFT, '0', 'none')
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => paint(0, '', HERO_IN)))
    }, HERO_OUT_MS)
  }
  const onTouchCancel = () => {
    if (touchStart.current?.axis === 'x') springBack()
    touchStart.current = null
  }

  // 情绪尺的分割点。没有数据源（如 BTC）时整条尺是中性灰、两端读数为「-」，
  // 不画一条假的五五开。/ The sentiment split; with no source (e.g. BTC) the rule
  // stays neutral grey and both readings show "-" rather than a fake 50/50.
  const longPct = sentiment ? Math.max(0, Math.min(100, sentiment.longPct)) : null

  return (
    <section
      className="card glass hero-card dash-hero p-5 sm:p-6 select-none"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {/* Header row：多周期趋势立场（手机端隐藏标题文字，用故事式分段指示器切换）*/}
      <div className="flex items-center gap-3 relative z-10 hero-header-row">
        <h2 className="text-base font-bold text-white hero-heading">{t('signals.focus.heading')}</h2>
        {/* 故事式分段指示器：一排细条，当前项高亮，点按任意段直接跳转。
            视觉干净、跨端统一，替代原先的圆点 + "1/6" 计数器 + 左右箭头组合。
            Story-style segmented indicator: a row of thin bars, current one
            highlighted, tap any segment to jump. Clean and consistent across
            devices, replacing the old dots + "1/6" counter + prev/next combo. */}
        {focusTotal > 1 && (
          <div className="ml-auto flex items-center gap-2">
            {/* 桌面端左右箭头：无按钮背景，纯图标点击，手机端隐藏（靠滑动切换）*/}
            <button
              type="button"
              onClick={onPrev}
              aria-label={String(t('signals.focus.prev'))}
              className="hero-arrow-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <div className="hero-segs" role="tablist" onKeyDown={onRovingKeyDown}>
              {Array.from({ length: focusTotal }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === focusIdx}
                  tabIndex={i === focusIdx ? 0 : -1}
                  aria-label={`${i + 1}/${focusTotal}`}
                  className={`hero-seg ${i === focusIdx ? 'on' : ''}`}
                  onClick={() => onSelectIdx(i)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={onNext}
              aria-label={String(t('signals.focus.next'))}
              className="hero-arrow-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* 标题行：品种（展示字宽 40px）+ 中文名 ｜ 立场大字靠右
          Title row: symbol at display width, Chinese name, stance word on the right */}
      <div ref={titleRef} className="dh-hero-title relative z-10">
        <div className="dh-hero-sym">
          <b className="font-display-xl">{displaySymbol(symbol)}</b>
          {cnName && <span className="cn">{cnName}</span>}
        </div>
        <div className={`stance-word ${stance === 'BULL' ? 'bull' : stance === 'BEAR' ? 'bear' : 'neutral'}`}>
          {stanceLabel}
          {stance === 'BULL' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
          {stance === 'BEAR' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          )}
        </div>
      </div>

      <div ref={railsRef} className="dh-rails relative z-10">
        {/* 多周期轨道：这一排是同一个品种在多个周期上的方向，是一组同类读数而不是
            若干独立标签，所以排成一条轨道；这里把轨道放到满宽、格子等分。
            The row is one reading across periods, so it renders as a single
            segmented track — here stretched to the full width with equal cells. */}
        <div className="dh-rail">
          <span className="dh-cap">{t('signals.focus.tfRail')}</span>
          <div className="tf-row dh-tf" role="list">
            {TREND_TFS.map((tf) => {
              const dir: TrendDir = trend?.timeframes?.[tf] ?? 'FLAT'
              const vis = TREND_VIS[dir]
              // 三个方向都带显式修饰类：UP 原来走裸 `tf-tag`，靠缺省态表达，
              // CSS 里没法单独选中它。/ All three directions carry an explicit
              // modifier so each colour rule stands on its own.
              const cls = dir === 'UP' ? 'tf-tag up' : dir === 'DOWN' ? 'tf-tag down' : 'tf-tag neutral'
              return (
                <span key={tf} className={cls} role="listitem">
                  {tf} <span className="d">{vis.arrow}</span>
                </span>
              )
            })}
          </div>
        </div>

        {/* 社区多空情绪尺：绿段看多、红段看空，两端是等宽读数。BTC 无数据源时整条中性灰。
            Community sentiment rule: green long, red short, tabular readings at the
            ends; neutral grey when there is no source (BTC). */}
        <div className="dh-rail">
          <span className="dh-cap">{t('signals.focus.communitySentiment')}</span>
          <div className="dh-senti">
            <div className="v bull">
              <small>{t('signals.focus.bull')}</small>
              <b className="num">{sentiment ? `${sentiment.longPct}%` : EMPTY}</b>
            </div>
            <div
              className={`dh-senti-bar${longPct == null ? ' none' : ''}`}
              style={{ '--long': `${longPct ?? 50}%` } as CSSProperties}
              aria-hidden="true"
            >
              <i className="a" />
              <i className="b" />
            </div>
            <div className="v bear">
              <small>{t('signals.focus.bear')}</small>
              <b className="num">{sentiment ? `${sentiment.shortPct}%` : EMPTY}</b>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// memo：仪表盘每秒 tick 时 props 不变则跳过重渲染 / skip per-second parent re-renders
export default memo(SignalHero)
