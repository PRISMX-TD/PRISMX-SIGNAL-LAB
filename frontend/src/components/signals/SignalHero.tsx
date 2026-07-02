// 英雄卡：当前聚焦品种的多周期趋势 + 各周期分布条 + Myfxbook 社区情绪
// Hero card: current focus symbol trend analysis + per-symbol TF distribution + Myfxbook sentiment
import { type FC, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Trend, TrendDir } from '../../api/types'
import type { MyfxSentiment } from '../../api/myfxbook'
import { TREND_TFS, type TrendStance } from './signalView'

interface Props {
  symbol: string
  cnName: string
  focusIdx: number
  focusTotal: number
  stance: TrendStance
  trend: Trend | undefined
  myfxSentiment?: MyfxSentiment | null
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
  stance, trend, myfxSentiment, onPrev, onNext, onSelectIdx,
}) => {
  const { t } = useTranslation()
  const stanceLabel = stance === 'BULL' ? t('signals.focus.bull') : stance === 'BEAR' ? t('signals.focus.bear') : t('signals.focus.neutral')
  const stanceNote = stance === 'BULL' ? t('signals.focus.adviceBull') : stance === 'BEAR' ? t('signals.focus.adviceBear') : t('signals.focus.adviceNeutral')

  // 由当前品种的5个周期方向算出分布百分比 / per-symbol TF distribution
  const tfDist = useMemo(() => {
    let up = 0, down = 0, flat = 0
    for (const tf of TREND_TFS) {
      const dir = trend?.timeframes?.[tf]
      if (dir === 'UP') up++
      else if (dir === 'DOWN') down++
      else flat++
    }
    const total = Math.max(1, up + down + flat)
    return { upPct: Math.round((up / total) * 100), downPct: Math.round((down / total) * 100) }
  }, [trend])

  return (
    <section className="card glass hero-card dash-hero p-5">
      {/* Nebula background */}
      <svg className="hero-nebula" viewBox="0 0 460 320" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="hng1" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#4c1d95" stopOpacity="0" />
            <stop offset="0.45" stopColor="#7c3aed" stopOpacity="0.85" />
            <stop offset="0.8" stopColor="#a855f7" stopOpacity="0.9" />
            <stop offset="1" stopColor="#60a5fa" stopOpacity="0.5" />
          </linearGradient>
          <linearGradient id="hng2" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#7c3aed" stopOpacity="0" />
            <stop offset="0.6" stopColor="#c084fc" stopOpacity="0.9" />
            <stop offset="1" stopColor="#e879f9" stopOpacity="0.6" />
          </linearGradient>
        </defs>
        <path d="M40,300 C160,270 240,200 300,140 C350,90 400,60 450,40" stroke="url(#hng1)" strokeWidth="120" fill="none" strokeLinecap="round" opacity="0.10" />
        <path d="M40,300 C160,270 240,200 300,140 C350,90 400,60 450,40" stroke="url(#hng1)" strokeWidth="84" fill="none" strokeLinecap="round" opacity="0.14" />
        <path d="M40,300 C160,270 240,200 300,140 C350,90 400,60 450,40" stroke="url(#hng1)" strokeWidth="54" fill="none" strokeLinecap="round" opacity="0.20" />
        <path d="M40,300 C160,270 240,200 300,140 C350,90 400,60 450,40" stroke="url(#hng1)" strokeWidth="30" fill="none" strokeLinecap="round" opacity="0.30" />
        <path d="M60,310 C180,280 260,210 320,150 C370,100 415,70 460,50" stroke="url(#hng2)" strokeWidth="20" fill="none" strokeLinecap="round" opacity="0.35" />
        <path d="M60,310 C180,280 260,210 320,150 C370,100 415,70 460,50" stroke="url(#hng2)" strokeWidth="9" fill="none" strokeLinecap="round" opacity="0.7" />
        <path d="M60,310 C180,280 260,210 320,150 C370,100 415,70 460,50" stroke="url(#hng2)" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.95" />
        <path d="M120,320 C220,290 300,230 360,170" stroke="url(#hng1)" strokeWidth="46" fill="none" strokeLinecap="round" opacity="0.14" />
        <path d="M120,320 C220,290 300,230 360,170" stroke="url(#hng1)" strokeWidth="18" fill="none" strokeLinecap="round" opacity="0.25" />
        <circle cx="330" cy="130" r="1.6" fill="#fff" opacity="0.9" />
        <circle cx="380" cy="80" r="1.2" fill="#e9d5ff" opacity="0.8" />
        <circle cx="270" cy="180" r="1.4" fill="#fff" opacity="0.7" />
        <circle cx="415" cy="140" r="1.1" fill="#e9d5ff" opacity="0.7" />
        <circle cx="300" cy="90" r="1" fill="#fff" opacity="0.6" />
      </svg>

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

      {/* Per-symbol TF distribution bar */}
      <div className="mt-5 relative z-10">
        <div className="flex justify-between text-xs mb-2">
          <span className="text-slate-400">{t('signals.focus.tfDistribution')}</span>
          <span className="text-down font-bold">{t('signals.focus.bear')} {tfDist.downPct}%</span>
        </div>
        <div className="senti-bar">
          <i className="a" style={{ width: `${tfDist.upPct}%` }} />
          <i className="b" style={{ width: `${tfDist.downPct}%` }} />
        </div>
        <div className="mt-2 text-xs text-up font-bold">{t('signals.focus.bull')} {tfDist.upPct}%</div>
      </div>

      {/* Myfxbook community sentiment bar — BTC not on Myfxbook, show grey */}
      <div className="mt-4 relative z-10">
        <div className="flex justify-between text-xs mb-2">
          <span className="text-slate-400">{t('signals.focus.communitySentiment')}</span>
          {myfxSentiment ? (
            <span className="text-down font-bold">{t('signals.focus.bear')} {myfxSentiment.shortPct}%</span>
          ) : null}
        </div>
        {myfxSentiment ? (
          <>
            <div className="senti-bar senti-bar--myfx">
              <i className="a" style={{ width: `${myfxSentiment.longPct}%` }} />
              <i className="b" style={{ width: `${myfxSentiment.shortPct}%` }} />
            </div>
            <div className="mt-2 text-xs text-up font-bold">{t('signals.focus.bull')} {myfxSentiment.longPct}%</div>
          </>
        ) : (
          <div className="senti-bar senti-bar--myfx">
            <i className="a" style={{ width: '50%', background: '#334155' }} />
            <i className="b" style={{ width: '50%', background: '#334155' }} />
          </div>
        )}
      </div>
    </section>
  )
}

export default SignalHero
