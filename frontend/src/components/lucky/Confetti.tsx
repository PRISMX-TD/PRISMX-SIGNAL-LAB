// 中奖彩纸：从揭晓卡上方迸出、受重力落下、淡出，约 2 秒后整组卸掉。这是**反馈**，只在中奖时放。
// 平时是品牌色的实色纸片（紫、浅紫、金、暖白），节日里换成那个节日的碎片图（与新信号迸发同一套，
// 从节日重包里取，取不到就用纸片）。只动 transform / opacity；减弱动效时不渲染。
// Win confetti: bursts from above the reveal card, falls under gravity and fades; the whole set is
// unmounted after ~2 s. It is feedback, shown only for a win. Normally flat paper in brand tones; in a
// festival the pieces become that festival's shards (the same art as the new-signal burst, from the heavy
// chunk; plain paper if it can't load). Only transform / opacity animate; nothing renders under reduced motion.
import { useEffect, useMemo, useState } from 'react'
import type { FestivalKey } from '../../festival/calendar'
import { loadFestivalHeavy } from '../../festival/load'
import { prefersReducedMotion } from './LuckyWheel'

const BRAND = ['#5A22EE', '#9284FF', '#E0A83C', '#EDEDF0', '#A88CFF', '#6E42FF']
const FEST: Record<FestivalKey, string[]> = {
  spring: ['#E8483C', '#F2CC72', '#F2A3AC', '#F4F4F6'],
  midautumn: ['#F4E3B0', '#F2B544', '#9284FF', '#F4F4F6'],
  halloween: ['#F28A3A', '#F4E3C8', '#9284FF', '#5A22EE'],
  christmas: ['#DBEAF5', '#F3CE6A', '#9284FF', '#F4F4F6'],
  newyear: ['#F1D08A', '#E6E8EE', '#9284FF', '#5A22EE'],
}

type Piece = { x: number; y: number; fall: number; r: number; delay: number; dur: number; shape: number; color: string; shard: boolean }

function makePieces(count: number, colors: string[]): Piece[] {
  return Array.from({ length: count }, (_, i) => {
    // 向上的扇形：-160° 到 -20°，越靠两边飞得越远 / an upward fan from -160° to -20°
    const a = ((-160 + Math.random() * 140) * Math.PI) / 180
    const d = 90 + Math.random() * 170
    return {
      x: Math.cos(a) * d,
      y: Math.sin(a) * d * 0.9,
      fall: 180 + Math.random() * 220,
      r: (Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 540),
      delay: Math.random() * 0.12,
      dur: 1.5 + Math.random() * 0.7,
      shape: i % 3,
      color: colors[i % colors.length],
      shard: i % 3 === 0,
    }
  })
}

export default function Confetti({ festival, count = 44 }: { festival: FestivalKey | null; count?: number }) {
  const [gone, setGone] = useState(false)
  const [art, setArt] = useState<string[] | null>(null)
  const reduce = prefersReducedMotion()
  const pieces = useMemo(() => makePieces(count, festival ? FEST[festival] : BRAND), [count, festival])

  useEffect(() => {
    if (reduce) return
    const t = window.setTimeout(() => setGone(true), 2600)
    let live = true
    if (festival) {
      loadFestivalHeavy().then((m) => { if (live) setArt(m.shards(festival)) }).catch(() => {})
    }
    return () => { live = false; window.clearTimeout(t) }
  }, [festival, reduce])

  if (reduce || gone) return null
  return (
    <div className="lk-confetti" aria-hidden>
      {pieces.map((p, i) => {
        const style = {
          ['--x' as string]: `${p.x.toFixed(1)}px`,
          ['--y' as string]: `${p.y.toFixed(1)}px`,
          ['--fall' as string]: `${p.fall.toFixed(1)}px`,
          ['--r' as string]: `${p.r.toFixed(0)}deg`,
          animationDelay: `${p.delay.toFixed(2)}s`,
          animationDuration: `${p.dur.toFixed(2)}s`,
        }
        if (art && p.shard) {
          return <span key={i} className="lk-bit lk-bit-art" style={style} dangerouslySetInnerHTML={{ __html: art[i % art.length] }} />
        }
        return <span key={i} className={`lk-bit lk-bit-${p.shape}`} style={{ ...style, background: p.color }} />
      })}
    </div>
  )
}
