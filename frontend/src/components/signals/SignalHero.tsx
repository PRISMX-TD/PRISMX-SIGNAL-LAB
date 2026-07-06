// 英雄卡：当前聚焦品种的多周期趋势 + 各周期分布条 + 社区多空情绪
// Hero card: current focus symbol trend analysis + per-symbol TF distribution + community sentiment
import { memo, type FC, useRef, type TouchEvent as RTouchEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Trend, TrendDir, SentimentRatio } from '../../api/types'
import { TREND_TFS, type TrendStance } from './signalView'

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
  UP: { arrow: '↑', color: '#2ee07e' },
  DOWN: { arrow: '↓', color: '#ff4d67' },
  FLAT: { arrow: '→', color: '#64748b' },
}

const SignalHero: FC<Props> = ({
  symbol, cnName, focusIdx, focusTotal,
  stance, trend, sentiment, onPrev, onNext, onSelectIdx,
}) => {
  const { t } = useTranslation()
  const stanceLabel = stance === 'BULL' ? t('signals.focus.bull') : stance === 'BEAR' ? t('signals.focus.bear') : t('signals.focus.neutral')
  const stanceNote = stance === 'BULL' ? t('signals.focus.adviceBull') : stance === 'BEAR' ? t('signals.focus.adviceBear') : t('signals.focus.adviceNeutral')

  // 手机端左右滑动切换聚焦品种：左滑下一个 / 右滑上一个
  // Mobile swipe to switch focus symbol: swipe left → next, swipe right → prev
  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: RTouchEvent<HTMLElement>) => {
    const p = e.touches[0]
    touchStart.current = { x: p.clientX, y: p.clientY }
  }
  const onTouchEnd = (e: RTouchEvent<HTMLElement>) => {
    if (!touchStart.current || focusTotal <= 1) { touchStart.current = null; return }
    const p = e.changedTouches[0]
    const dx = p.clientX - touchStart.current.x
    const dy = p.clientY - touchStart.current.y
    touchStart.current = null
    // 仅当水平位移足够大且明显大于垂直位移时才切换，避免与纵向滚动冲突
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) onNext()
      else onPrev()
    }
  }

  return (
    <section
      className="card glass hero-card dash-hero p-5 select-none"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Header row：多周期趋势立场 */}
      <div className="flex items-center gap-2.5 relative z-10">
        <h2 className="text-[19px] font-bold text-white">{t('signals.focus.heading')}</h2>
        <div className="ml-auto hero-dots">
          {Array.from({ length: focusTotal }).map((_, i) => (
            <i key={i} className={i === focusIdx ? 'on' : ''} onClick={() => onSelectIdx(i)} />
          ))}
        </div>
        {/* Prev/Next nav */}
        <button type="button" onClick={onPrev} className="ml-1 grid h-7 w-7 place-items-center rounded-lg bg-white/5 text-white/60 hover:text-white" aria-label="prev">‹</button>
        <button type="button" onClick={onNext} className="grid h-7 w-7 place-items-center rounded-lg bg-white/5 text-white/60 hover:text-white" aria-label="next">›</button>
      </div>

      {/* Symbol + side chip */}
      <div className="mt-4 flex items-center gap-2.5 relative z-10">
        <b className="text-[27px] tracking-[0.02em] text-white">{symbol}</b>
        {cnName && <span className="text-sm text-slate-300">{cnName}</span>}
        <span className={`chip ${stance === 'BULL' ? 'chip-buy' : stance === 'BEAR' ? 'chip-sell' : 'chip-dim'}`}>
          {stanceLabel}
        </span>
      </div>

      {/* Stance word + confidence */}
      <div className="mt-2 flex items-end gap-8 relative z-10">
        <div className={`stance-word ${stance === 'BULL' ? 'bull' : stance === 'BEAR' ? 'bear' : 'neutral'}`}>
          {stanceLabel}
          {stance === 'BULL' && (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
          {stance === 'BEAR' && (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          )}
        </div>
      </div>

      {/* Stance note */}
      <div className="mt-2 text-[13px] text-slate-300 relative z-10">{stanceNote}</div>

      {/* Multi-TF tags */}
      <div className="mt-3.5 flex gap-2 flex-wrap relative z-10">
        {TREND_TFS.map((tf) => {
          const dir: TrendDir = trend?.timeframes?.[tf] ?? 'FLAT'
          const vis = TREND_VIS[dir]
          const cls = dir === 'UP' ? 'tf-tag' : dir === 'DOWN' ? 'tf-tag down' : 'tf-tag neutral'
          return (
            <span key={tf} className={cls}>
              {tf} {vis.arrow}
            </span>
          )
        })}
      </div>

      {/* 社区多空情绪条 —— BTC 无数据来源，显示灰色占位 / community sentiment bar — no data source for BTC, shows grey */}
      <div className="mt-5 relative z-10">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="text-slate-400">{t('signals.focus.communitySentiment')}</span>
        </div>
        {sentiment ? (
          <div className="senti-bar">
            <i className="a" style={{ width: `${sentiment.longPct}%` }} />
            <i className="b" style={{ width: `${sentiment.shortPct}%` }} />
          </div>
        ) : (
          <div className="senti-bar">
            <i className="a" style={{ width: '50%', background: '#334155' }} />
            <i className="b" style={{ width: '50%', background: '#334155' }} />
          </div>
        )}
        <div className="flex items-center justify-between text-xs mt-2">
          <span className="text-up font-bold">{t('signals.focus.bull')} {sentiment?.longPct ?? '-'}%</span>
          <span className="text-down font-bold">{t('signals.focus.bear')} {sentiment?.shortPct ?? '-'}%</span>
        </div>
      </div>
    </section>
  )
}

// memo：仪表盘每秒 tick 时 props 不变则跳过重渲染 / skip per-second parent re-renders
export default memo(SignalHero)
