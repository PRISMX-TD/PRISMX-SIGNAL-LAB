// 市场概览卡（仪表盘右下）：环形图 + 图例 + 信号总数 + 每日信号量趋势
// Market overview card (dashboard bottom-right): donut + legend + total signals + daily signal-count sparkline
import { memo, type FC, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal, SignalDailyCount } from '../../api/types'
import { signalApi } from '../../api/client'

interface Props {
  signals: Signal[]
}

// 按信号方向统计所有活跃信号：买入=多头，卖出=空头，两段之和 = 活跃信号总数
// count active signals by their direction: BUY = long, SELL = short; segments sum to total
function computeDistribution(signals: Signal[]) {
  let long = 0, short = 0
  for (const s of signals) {
    if (s.status !== 'ACTIVE') continue
    if (s.side === 'BUY') long++
    else short++
  }
  const total = long + short
  return { long, short, total }
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

const MarketOverview: FC<Props> = ({ signals }) => {
  const { t } = useTranslation()
  const dist = useMemo(() => computeDistribution(signals), [signals])
  const total = Math.max(1, dist.total)
  const longFrac = dist.long / total
  const shortFrac = dist.short / total

  // 环形图各段 dasharray / donut segment dasharray
  const seg1Dash = `${longFrac * CIRCUMFERENCE} ${CIRCUMFERENCE}`
  const seg2Dash = `${shortFrac * CIRCUMFERENCE} ${CIRCUMFERENCE}`
  const seg2Offset = -longFrac * CIRCUMFERENCE

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
    <section className="card glass dash-overview p-[18px]">
      <div className="flex items-center gap-2 px-0">
        <h3 className="text-[15px] font-bold">{t('signals.focus.overview', '市场概览')}</h3>
      </div>

      <div className="donut-wrap">
        <div className="donut">
          <svg className="w-full h-full" viewBox="0 0 116 116">
            <circle cx="58" cy="58" r="47" fill="none" stroke="#26262e" strokeWidth="13" />
            <circle cx="58" cy="58" r="47" fill="none" stroke="#2ee07e" strokeWidth="13" strokeLinecap="round" strokeDasharray={seg1Dash} />
            <circle cx="58" cy="58" r="47" fill="none" stroke="#ff4d67" strokeWidth="13" strokeLinecap="round" strokeDasharray={seg2Dash} strokeDashoffset={seg2Offset} />
          </svg>
          <div className="donut-center">
            <div>
              {/* 活跃信号总数，且 = 多头 + 空头 / total active signals, equals bull + bear */}
              <b className="num">{dist.total}</b>
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
              <polyline fill="none" stroke="url(#sparkLineGrad)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                points={sparkPoints}
              />
              {/* 折线紫→青：极光谱系的色彩故事 / violet→cyan line, the aurora spectrum */}
              <linearGradient id="sparkLineGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#a78bfa" />
                <stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
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

// memo：仅在信号/趋势数据变化时重渲染 / re-render only when signals/trends change
export default memo(MarketOverview)
