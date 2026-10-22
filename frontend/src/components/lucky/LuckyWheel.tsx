// 转盘本体（用户抽奖页与后台预览共用）。三层叠在一个正方形里：
//   ① 固定的外圈：深色轮缘 + 一圈灯珠（待机时两组交替闪，转动时追光，中奖时齐闪）；
//   ② 转子：各格扇区、奖品图标 / 图片、两行奖品名，由 spinTo() 用 rAF 直接写 transform 转动；
//   ③ 顶部指针（每拨过一格向后一弹，配「嗒」声与轻震）和中间的圆形按钮——按钮就是抽奖键。
// 结果由后端决定，这里只负责转到指定格并停准。节日皮肤（灯珠、轮缘、指针换色）由 festival 决定，
// 后台可以传任意节日预览。prefers-reduced-motion 时不转、不闪，直接落到结果。
// The wheel (shared by the user page and the admin preview), three layers in one square:
//   1. a fixed rim with a ring of bulbs (alternating while idle, chasing while spinning, flashing on a win);
//   2. the rotor: slices, prize glyphs / images and two-line names, turned by spinTo() via rAF writing
//      the transform directly;
//   3. the top pointer (kicks back at every slot it passes, with a tick and a light haptic) and the round
//      hub button, which is the spin button.
// The backend picks the result; this only lands on the given slot. The festival skin (bulb, rim and
// pointer colours) comes from `festival`; the admin can preview any festival. Reduced motion jumps straight
// to the result with no spin and no flashing.
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import type { LuckyPrizePublic } from '../../api/luckyTypes'
import type { FestivalKey } from '../../festival/calendar'
import { indexAtRotation, slotSpan, targetRotation } from '../../utils/luckyWheel'
import { playTick } from './luckySound'
import { playSpin } from './spinMotion'
import { KIND_GLYPH, STROKE_GLYPH, bulbCount, fitLabel, labelInk, labelMetrics, slicePath, slotColor } from './wheelArt'
import './lucky.css'

export { PALETTE } from './wheelArt'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export interface LuckyWheelHandle {
  /**
   * 转到第 index 格并停下；播完（或减弱动效时立刻）resolve。count 是这次要按几格算：刚拉了新奖品列表、
   * 转盘还没按新格数重画时必须传（否则按旧格数算角度，会停错格）；不传就用当前画着的格数。
   * Spin to slot `index`; resolves when it stops. `count` is the slot count to aim with: pass it right
   * after fetching a fresh prize list, before the wheel has re-rendered (aiming with the old count lands
   * on the wrong slot); omitted, the currently drawn count is used.
   */
  spinTo: (index: number, count?: number) => Promise<void>
  /** 灯珠齐闪一阵 / Flash every bulb for a moment. */
  celebrate: () => void
}

export interface WheelHub {
  label: string
  sub?: string
  ariaLabel?: string
  disabled?: boolean
  // 转动中：不可点，但保持品牌紫，不像「坏了」那样变灰 / mid-spin: not clickable, but stays violet instead of greying out
  busy?: boolean
  // 有券可抽、正在等用户：按钮轻轻「呼吸」一下 / waiting for a tap with tickets in hand: the hub breathes
  invite?: boolean
  onPress?: () => void
}

type Phase = 'idle' | 'spinning' | 'win'

const LuckyWheel = forwardRef<LuckyWheelHandle, {
  prizes: LuckyPrizePublic[]
  hub: WheelHub
  festival?: FestivalKey | null
  // 拨格时出「嗒」声（声音开关由页面管）/ tick sound while spinning (the page owns the on/off switch)
  sound?: boolean
  size?: 'md' | 'sm'
}>(function LuckyWheel({ prizes, hub, festival = null, sound = false, size = 'md' }, ref) {
  const uid = useId().replace(/:/g, '')
  const rotor = useRef<HTMLDivElement>(null)
  const flap = useRef<HTMLDivElement>(null)
  const angle = useRef(0)
  const cancel = useRef<(() => void) | null>(null)
  const settle = useRef<(() => void) | null>(null)
  const winTimer = useRef<number>()
  const lastBuzz = useRef(0)
  const soundRef = useRef(sound)
  soundRef.current = sound
  const [phase, setPhase] = useState<Phase>('idle')
  const n = Math.max(prizes.length, 2)
  const nRef = useRef(n)
  nRef.current = n

  const paint = (a: number) => {
    if (rotor.current) rotor.current.style.transform = `rotate(${a}deg)`
  }

  useEffect(() => {
    // 待机时指针落在第 1 格正中，不压在分隔线上 / at rest the pointer sits mid-slot 1, not on a divider
    angle.current = -slotSpan(nRef.current) / 2
    paint(angle.current)
    return () => {
      cancel.current?.()
      settle.current?.()
      window.clearTimeout(winTimer.current)
    }
  }, [])

  const kick = () => {
    const el = flap.current
    if (el && typeof el.animate === 'function') {
      el.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-24deg)', offset: 0.28 }, { transform: 'rotate(0deg)' }],
        { duration: 210, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      )
    }
    if (soundRef.current) {
      try { playTick() } catch { /* 声音出错不能卡住转盘 / a sound failure must never stall the wheel */ }
    }
    const now = Date.now()
    if (now - lastBuzz.current > 70) {
      lastBuzz.current = now
      try { navigator.vibrate?.(5) } catch { /* 不支持就算了 / unsupported is fine */ }
    }
  }

  useImperativeHandle(ref, () => ({
    spinTo: (index: number, slots?: number) => new Promise<void>((resolve) => {
      cancel.current?.()
      settle.current?.()
      window.clearTimeout(winTimer.current)
      const count = slots && slots > 0 ? Math.max(slots, 2) : nRef.current
      const from = angle.current
      const to = targetRotation(from, index, count, Math.random() * 2 - 1)
      angle.current = to
      settle.current = resolve
      const done = () => {
        cancel.current = null
        settle.current = null
        setPhase('idle')
        resolve()
      }
      if (prefersReducedMotion()) {
        paint(to)
        window.setTimeout(done, 150)
        return
      }
      setPhase('spinning')
      let last = indexAtRotation(from, count)
      cancel.current = playSpin(from, to, (a) => {
        paint(a)
        const i = indexAtRotation(a, count)
        if (i !== last) { last = i; kick() }
      }, done)
    }),
    celebrate: () => {
      if (prefersReducedMotion()) return
      window.clearTimeout(winTimer.current)
      setPhase('win')
      winTimer.current = window.setTimeout(() => setPhase('idle'), 1900)
    },
  }), [])

  const span = slotSpan(n)
  const lm = labelMetrics(n)
  const bulbs = bulbCount(n)
  const inviting = !!hub.invite && !hub.disabled && phase === 'idle'
  return (
    <div className={`lw lw-${size}`} data-phase={phase} data-fest={festival ?? undefined} data-invite={inviting ? '' : undefined}>
      <div className="lw-frame">
        <svg className="lw-rim" viewBox="-120 -120 240 240" aria-hidden>
          <circle r="118.5" className="lw-rim-body" />
          <circle r="106.5" className="lw-rim-line" />
          {Array.from({ length: bulbs }, (_, k) => {
            const a = ((k * 360) / bulbs - 90) * (Math.PI / 180)
            const x = (112 * Math.cos(a)).toFixed(2)
            const y = (112 * Math.sin(a)).toFixed(2)
            return (
              <g key={k} className={`lw-bulb ${k % 2 ? 'is-b' : 'is-a'}`} style={{ ['--k' as string]: k, ['--nb' as string]: bulbs }}>
                <circle cx={x} cy={y} r="3.1" className="lw-bulb-off" />
                <circle cx={x} cy={y} r="2.3" className="lw-bulb-on" />
              </g>
            )
          })}
        </svg>

        <div className="lw-rotor" ref={rotor} aria-hidden>
          <svg viewBox="-103 -103 206 206">
            <defs>
              <clipPath id={`lw-clip-${uid}`}><circle r="9.5" /></clipPath>
            </defs>
            <circle r="102.5" className="lw-gap" />
            {prizes.map((p, i) => {
              const fill = slotColor(p.color, i)
              const ink = labelInk(fill)
              const { lines, size: fs } = fitLabel(p.name, n)
              const mid = i * span + span / 2
              const glyph = KIND_GLYPH[p.kind] ?? KIND_GLYPH.none
              return (
                <g key={p.id}>
                  <path d={slicePath(i, n, 101)} fill={fill} className="lw-slice" />
                  <g transform={`rotate(${mid.toFixed(3)})`} fill={ink}>
                    {p.imageUrl ? (
                      <g transform="translate(0 -84)">
                        <circle r="10.6" fill={ink} opacity="0.18" />
                        <image href={p.imageUrl} x="-9.5" y="-9.5" width="19" height="19" preserveAspectRatio="xMidYMid slice"
                          clipPath={`url(#lw-clip-${uid})`} />
                      </g>
                    ) : (
                      <path d={glyph} transform="translate(0 -84) scale(0.92)" opacity="0.9"
                        {...(STROKE_GLYPH[p.kind]
                          ? { fill: 'none', stroke: ink, strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
                          : { fill: ink })} />
                    )}
                    {lines.map((line, k) => (
                      <text key={k} y={-lm.r + k * (fs + 2) + (lines.length === 1 ? fs * 0.4 : 0)} textAnchor="middle"
                        fontSize={fs} className="lw-label">{line}</text>
                    ))}
                  </g>
                </g>
              )
            })}
            <circle r="101" className="lw-edge" />
            <circle r="34" className="lw-plate" />
          </svg>
        </div>

        <div className="lw-pointer" ref={flap} aria-hidden>
          <svg viewBox="-12 -12 24 36">
            <path d="M0 23 L-7.6 2 A8.6 8.6 0 1 1 7.6 2 Z" className="lw-pointer-body" />
            <circle r="3.1" className="lw-pointer-cap" />
          </svg>
        </div>

        <button type="button" className={`lw-hub ${inviting ? 'is-invite' : ''} ${hub.busy ? 'is-busy' : ''}`}
          disabled={hub.disabled || hub.busy} aria-busy={hub.busy || undefined} aria-label={hub.ariaLabel ?? hub.label} onClick={hub.onPress}>
          <span className="lw-hub-label">{hub.label}</span>
          {hub.sub && <span className="lw-hub-sub">{hub.sub}</span>}
        </button>
      </div>
    </div>
  )
})

export default LuckyWheel
