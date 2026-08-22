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
// 堆叠分段之间的底色间隙（viewBox 单位）。dataviz 的 marks-and-anatomy.md 把
// "堆叠分段之间留间隙"列为非协商项，anti-patterns.md 也把"无间隙靠描边分隔"
// 列为反模式——当前两段矩形贴边画会踩中它。viewBox 宽度=100 且条形渲染宽度
// 约 96~150px（非 mini 的 w-24 ≈ 96px；mini 是 w-full，随消费方容器变化），
// 所以 1 个 viewBox 单位约等于 1px，2 个单位近似 2px 的物理间隙——不是像素
// 精确值（SVG 是矢量拉伸的，做不到精确匹配任意渲染宽度），但已经是这个纯函数
// 组件能达到的最佳近似。mini（3px 高）与非 mini 共用同一段间隙逻辑，不能只改
// 非 mini 分支。
// Surface gap between stacked segments (viewBox units). dataviz's
// marks-and-anatomy.md lists a gap between stacked segments as non-negotiable,
// and anti-patterns.md separately calls out "no gap, separated by a stroke
// instead" as an anti-pattern — the two flush rects were tripping it. With a
// 100-unit viewBox rendered at roughly 96-150px (non-mini's w-24 ≈ 96px; mini
// is w-full, sized by whatever consumes it), one viewBox unit is close enough
// to 1px that 2 units approximates a 2px physical gap — not pixel-exact (an
// SVG stretches, so it can't match an arbitrary render width precisely), but
// the best this stateless glyph can do. Mini (3px tall) and non-mini share the
// same gap math; this isn't a non-mini-only fix.
const GAP = 2

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
  const tpWRaw = (bucket.hitTp / bucket.resolved) * W
  // 两段各让出半个间隙；贴到 0/W 边界（0% 或 100% 胜率）时钳制到 0，避免负宽度
  // ——那种情况下本来就只有一段有内容，没有"缝"可留。
  // Each side gives up half the gap; clamp at the 0/W edge (a 0% or 100% split)
  // so it never goes negative — at that edge only one segment has content
  // anyway, so there's no seam to leave a gap for.
  const tpW = Math.max(0, tpWRaw - GAP / 2)
  const slX = Math.min(W, tpWRaw + GAP / 2)
  const slW = Math.max(0, W - slX)
  const wilsonX = (bucket.wilsonLow ?? 0) * W
  return (
    <span className={mini ? 'inline-block w-full' : 'inline-flex items-center gap-2'}>
      <svg viewBox={`0 0 ${W} ${h + (mini ? 0 : 4)}`} className={mini ? 'w-full' : 'w-24 shrink-0'}
           preserveAspectRatio="none" role="img" aria-label={`${(bucket.winRate * 100).toFixed(1)}%`}>
        <rect x={0} y={0} width={tpW} height={h} rx={1.5} fill="var(--up, #34d399)" opacity={0.85} />
        <rect x={slX} y={0} width={slW} height={h} rx={1.5} fill="var(--down, #fb7185)" opacity={0.6} />
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
