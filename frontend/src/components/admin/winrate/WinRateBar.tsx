// 全站唯一的胜率图元：绿(止盈)/红(止损)堆叠条 + 50% 参考线 + Wilson 下限刻度。
// 真实胜率与三角刻度的距离就是置信区间的宽窄——"为什么 70% 排在 55% 后面"
// 不用文字解释。resolved < MIN_SAMPLES 不画条只给笔数，克制口径到所有层级。
// The one win-rate glyph: stacked TP/SL bar, 50% guide, Wilson-bound tick.
import { useTranslation } from 'react-i18next'
import type { WinRateBucket } from '../../../api/types'
import { MIN_SAMPLES } from './shared'

const W = 100
const H = 10
const H_MINI = 3

export default function WinRateBar({ bucket, mini = false }: { bucket: WinRateBucket; mini?: boolean }) {
  const { t } = useTranslation()
  if (bucket.samples === 0) return <span className="text-neutral-600">—</span>
  if (bucket.winRate === null || bucket.resolved < MIN_SAMPLES) {
    return (
      <span className="text-[11px] text-neutral-500"
            title={t('admin.winrate.thinSampleHint', { resolved: bucket.resolved, samples: bucket.samples })}>
        {t('admin.winrate.thinSample', { count: bucket.resolved })}
      </span>
    )
  }
  const h = mini ? H_MINI : H
  const tpW = (bucket.hitTp / bucket.resolved) * W
  const wilsonX = (bucket.wilsonLow ?? 0) * W
  return (
    <span className={mini ? 'inline-block w-full' : 'inline-flex items-center gap-2'}>
      <svg viewBox={`0 0 ${W} ${h + (mini ? 0 : 4)}`} className={mini ? 'w-full' : 'w-24 shrink-0'}
           preserveAspectRatio="none" role="img" aria-label={`${(bucket.winRate * 100).toFixed(1)}%`}>
        <rect x={0} y={0} width={tpW} height={h} rx={1.5} fill="var(--up, #34d399)" opacity={0.85} />
        <rect x={tpW} y={0} width={W - tpW} height={h} rx={1.5} fill="var(--down, #fb7185)" opacity={0.6} />
        <line x1={W / 2} y1={-1} x2={W / 2} y2={h + 1} stroke="rgba(255,255,255,0.35)"
              strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {!mini && bucket.wilsonLow !== null && (
          <path d={`M ${wilsonX} ${h + 1} l 3 3 l -6 0 z`} fill="#e5e5e5"
                aria-label={t('admin.winrate.wilsonTick')} />
        )}
      </svg>
      {!mini && (
        <span className="whitespace-nowrap">
          <span className="font-medium tabular-nums text-neutral-100">{(bucket.winRate * 100).toFixed(1)}%</span>
          <span className="ml-1.5 text-[10px] tabular-nums text-neutral-500">{bucket.hitTp}/{bucket.resolved}</span>
        </span>
      )}
    </span>
  )
}
