// 纯展示的 SVG 转盘：rotation 由父组件控制（CSS transition 减速），指针固定在顶部。
// prefers-reduced-motion 时 transition 为 0，直接跳到结果。
// A display-only SVG wheel; the parent owns `rotation` (CSS transition eases it out).
// With prefers-reduced-motion the transition is off and the wheel jumps straight to the result.
import type { LuckyPrizePublic } from '../../api/luckyTypes'
import { slotSpan } from '../../utils/luckyWheel'

const PALETTE = ['#7c5cff', '#2dd4bf', '#f59e0b', '#ef4444', '#3b82f6', '#22c55e', '#ec4899', '#a855f7']
export const SPIN_MS = 4800

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function arc(i: number, n: number, r: number) {
  const a0 = ((i * slotSpan(n) - 90) * Math.PI) / 180
  const a1 = (((i + 1) * slotSpan(n) - 90) * Math.PI) / 180
  const large = slotSpan(n) > 180 ? 1 : 0
  return `M0 0 L${r * Math.cos(a0)} ${r * Math.sin(a0)} A${r} ${r} 0 ${large} 1 ${r * Math.cos(a1)} ${r * Math.sin(a1)} Z`
}

export default function LuckyWheel({ prizes, rotation, spinning }: {
  prizes: LuckyPrizePublic[]
  rotation: number
  spinning: boolean
}) {
  const n = Math.max(prizes.length, 2)
  const reduce = prefersReducedMotion()
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[360px]">
      <svg viewBox="-110 -110 220 220" className="h-full w-full drop-shadow-xl"
        style={{ transform: `rotate(${rotation}deg)`,
                 transition: spinning && !reduce ? `transform ${SPIN_MS}ms cubic-bezier(0.17, 0.67, 0.12, 1)` : 'none' }}>
        <circle r="106" fill="#0f1220" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
        {prizes.map((p, i) => {
          const mid = i * slotSpan(n) + slotSpan(n) / 2
          return (
            <g key={p.id}>
              <path d={arc(i, n, 100)} fill={p.color || PALETTE[i % PALETTE.length]} stroke="#0f1220" strokeWidth="1.5" />
              <g transform={`rotate(${mid}) translate(0 -64)`}>
                {p.imageUrl && <image href={p.imageUrl} x="-11" y="-30" width="22" height="22" preserveAspectRatio="xMidYMid meet" />}
                <text textAnchor="middle" fontSize={n > 8 ? 7 : 8.5} fill="#fff" fontWeight={600}>
                  {p.name.length > 8 ? `${p.name.slice(0, 7)}…` : p.name}
                </text>
              </g>
            </g>
          )
        })}
        <circle r="16" fill="#0f1220" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
      </svg>
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1
        border-x-[10px] border-t-[18px] border-x-transparent border-t-white drop-shadow" />
    </div>
  )
}
