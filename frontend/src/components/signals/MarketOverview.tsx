// 市场概览卡（仪表盘右下）：环形图 + 图例 + 信号总数 + 每日信号量趋势
// Market overview card (dashboard bottom-right): donut + legend + total signals + daily signal-count sparkline
import { type FC, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal, Trend, SignalDailyCount } from '../../api/types'
import { signalApi } from '../../api/client'
import { trendStance } from './signalView'

interface Props {
  signals: Signal[]
  trends: Record<string, Trend>
}

// 品种分组：按多周期趋势立场统计 / group symbols by trend stance
function computeDistribution(signals: Signal[], trends: Record<string, Trend>) {
  let long = 0, short = 0, neutral = 0
  const seen = new Set<string>()
  for (const s of signals) {
    if (s.status !== 'ACTIVE') continue
    if (seen.has(s.symbol)) continue
    seen.add(s.symbol)
    const st = trendStance(trends[s.symbol])
    if (st === 'BULL') long++
    else if (st === 'BEAR') short++
    else neutral++
  }
  const total = long + short + neutral
  return { long, short, neutral, total }
}

const CIRCUMFERENCE = 2 * Math.PI * 47 // r=47
const SPARK_W = 259
const SPARK_H = 56
const SPARK_TOP_PAD = 6 // 顶部留白，避免峰值贴边 / top padding so the peak doesn't touch the edge

// 把每日计数映射为折线图坐标点 / map daily counts to sparkline coordinates
function buildSparkPoints(daily: SignalDailyCount[]): { points: string; areaPoints: string } {
  if (daily.length === 0) return { points: '', areaPoints: '' }
  const max = Math.max(1, ...daily.map((d) => d.count))
  const stepX = daily.length > 1 ? SPARK_W / (daily.length - 1) : 0
  const usableH = SPARK_H - SPARK_TOP_PAD
  const coords = daily.map((d, i) => {
    const x = Math.round(stepX * i)
    const y = Math.round(SPARK_H - (d.count / max) * usableH)
    return `${x},${y}`
  })
  const points = coords.join(' ')
  const areaPoints = `0,${SPARK_H} ${points} ${SPARK_W},${SPARK_H}`
  return { points, areaPoints }
}

const MarketOverview: FC<Props> = ({ signals, trends }) => {
  const { t } = useTranslation()
  const dist = useMemo(() => computeDistribution(signals, trends), [signals, trends])
  const total = Math.max(1, dist.total)
  const longFrac = dist.long / total
  const shortFrac = dist.short / total
  const neutralFrac = dist.neutral / total

  // 环形图各段 dasharray / donut segment dasharray
  const seg1Dash = `${longFrac * CIRCUMFERENCE} ${CIRCUMFERENCE}`
  const seg2Dash = `${shortFrac * CIRCUMFERENCE} ${CIRCUMFERENCE}`
  const seg2Offset = -longFrac * CIRCUMFERENCE
  const seg3Dash = `${neutralFrac * CIRCUMFERENCE} ${CIRCUMFERENCE}`
  const seg3Offset = -(longFrac + shortFrac) * CIRCUMFERENCE

  // 近 7 日每日信号发出量 / daily signal count for the last 7 days
  const [daily, setDaily] = useState<SignalDailyCount[]>([])
  useEffect(() => {
    let mounted = true
    signalApi.stats().then((r) => { if (mounted) setDaily(r.daily) }).catch(() => {})
    return () => { mounted = false }
  }, [])

  const weekTotal = useMemo(() => daily.reduce((sum, d) => sum + d.count, 0), [daily])
  const { points: sparkPoints, areaPoints } = useMemo(() => buildSparkPoints(daily), [daily])
  const dayLabels = useMemo(
    () => daily.map((d) => `${new Date(d.date).getMonth() + 1}/${new Date(d.date).getDate()}`),
    [daily]
  )

  return (
    <section className="card glass dash-overview p-4">
      <div className="flex items-center gap-2 px-0">
        <h3 className="text-[15px] font-bold">{t('signals.focus.overview', '市场概览')}</h3>
        <button className="ml-auto flex items-center gap-1 h-7 px-2.5 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 font-semibold cursor-pointer font-inherit">
          {t('signals.focus.period7d', '7日')}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>

      <div className="donut-wrap">
        <div className="donut">
          <svg width="116" height="116" viewBox="0 0 116 116">
            <circle cx="58" cy="58" r="47" fill="none" stroke="#26262e" strokeWidth="13" />
            <circle cx="58" cy="58" r="47" fill="none" stroke="#2ee07e" strokeWidth="13" strokeLinecap="round" strokeDasharray={seg1Dash} />
            <circle cx="58" cy="58" r="47" fill="none" stroke="#ff4d67" strokeWidth="13" strokeLinecap="round" strokeDasharray={seg2Dash} strokeDashoffset={seg2Offset} />
            <circle cx="58" cy="58" r="47" fill="none" stroke="#a855f7" strokeWidth="13" strokeLinecap="round" strokeDasharray={seg3Dash} strokeDashoffset={seg3Offset} />
          </svg>
          <div className="donut-center">
            <div>
              <b className="num">{signals.filter(s => s.status === 'ACTIVE').length}</b>
              <span>{t('signals.focus.signalTotal', '信号总数')}</span>
            </div>
          </div>
        </div>

        <div className="ov-legend">
          <div className="row">
            <span className="sw" style={{ background: '#2ee07e' }} />
            <span className="k">{t('signals.focus.bull')}</span>
            <span className="v num">{Math.round(longFrac * 100)}% <i>({dist.long})</i></span>
          </div>
          <div className="row">
            <span className="sw" style={{ background: '#ff4d67' }} />
            <span className="k">{t('signals.focus.bear')}</span>
            <span className="v num">{Math.round(shortFrac * 100)}% <i>({dist.short})</i></span>
          </div>
          <div className="row">
            <span className="sw" style={{ background: '#a855f7' }} />
            <span className="k">{t('signals.focus.neutral')}</span>
            <span className="v num">{Math.round(neutralFrac * 100)}% <i>({dist.neutral})</i></span>
          </div>
        </div>
      </div>

      <div className="acc-section">
        <div className="acc-row">
          <span className="k">{t('signals.focus.signalVolume7d', '信号发出量 (7日)')}</span>
          <span className="v num">{weekTotal}</span>
        </div>
        <svg className="acc-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none">
          {sparkPoints && (
            <>
              <polyline fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                points={sparkPoints}
              />
              <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#a855f7" stopOpacity="0.25" />
                <stop offset="1" stopColor="#a855f7" stopOpacity="0" />
              </linearGradient>
              <polygon fill="url(#sparkGrad)" points={areaPoints} />
            </>
          )}
        </svg>
        <div className="acc-x-labels">
          {dayLabels.map((label, i) => <span key={i}>{label}</span>)}
        </div>
      </div>
    </section>
  )
}

export default MarketOverview
