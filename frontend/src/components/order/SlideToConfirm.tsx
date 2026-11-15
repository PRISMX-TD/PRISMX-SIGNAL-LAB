// 滑动确认轨道：拖到 95% 触发 onConfirm。两个下单弹窗共用。
//
// 拖动时直接操作 DOM（transform / opacity），不走 setState——频繁重渲染整张卡会卡顿。
// 填充层用 scaleX 而不是 width：width 每一帧都要重排，transform 只走合成。
// Pointer Capture 让拖动离开轨道也持续跟手；只有滑块是 touch-action:none，轨道本身
// 是 pan-y，手指落在轨道空白处照样能上下滚动弹窗。
// Slide-to-confirm track shared by both order modals. Drives the DOM directly
// while dragging (no setState per move — re-rendering the whole card janks); the
// fill scales with a transform instead of width so a move never forces layout.
// Pointer capture keeps the drag tracking outside the track; only the knob is
// touch-action:none, the track is pan-y so it is no longer a scroll dead zone.
//
// 只按距离成交（拖过 95%），不按甩动速度：这是花钱的动作，一次快速的误甩不能算数。
// 键盘 / 读屏 / 开关控制：滑块是真按钮，Enter、Space 与辅助技术的「激活」都会合成一次
// detail === 0 的 click，直接成交；真实手指或鼠标点一下 detail ≥ 1，不成交，必须滑。
// Commit is by distance only (past 95%), never by flick velocity: this spends
// money, and a fast accidental flick must not count. Keyboard / screen-reader /
// switch users: the knob is a real button; Enter, Space and an assistive-tech
// activation synthesize a click with detail === 0, which confirms. A real finger
// or mouse tap has detail >= 1 and does not; it has to slide.
import { useRef, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

const KNOB = 56
const CONFIRM_AT = 95
// 提示文字随进度淡出，到 70% 完全消失；到 80% 滑块轻微放大，提示「再推一点就成交」。
// The label fades with progress and is gone by 70%; at 80% the knob swells
// slightly to say "almost there".
const LABEL_GONE_AT = 70
const NEAR_AT = 80

// 读滑块此刻的水平位移。回弹过渡进行中时，computed transform 是插值后的矩阵，
// 所以中途重新按住也不会跳。
// The knob's current horizontal offset. Mid snap-back the computed transform is
// the interpolated matrix, so grabbing it mid-animation does not jump.
function currentTx(el: HTMLElement): number {
  const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform)
  return m ? parseFloat(m[1].split(',')[4]) || 0 : 0
}

export default function SlideToConfirm({ disabled, onConfirm, label }: { disabled: boolean; onConfirm: () => void; label?: string }) {
  const { t } = useTranslation()
  const trackRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLButtonElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const labelRef = useRef<HTMLDivElement>(null)
  const sliding = useRef(false)
  const confirmed = useRef(false)   // 已成交：滑动与按键都不能再触发第二次 / fired once, no double submit
  const pointerRef = useRef<number | null>(null)   // 正在拖的那根手指 / the pointer that owns the drag
  const grabRef = useRef(0)   // 按下点减滑块中心 / press point minus knob centre
  const pctRef = useRef(0)
  const travelRef = useRef(0)   // 轨道可滑动像素范围 / draggable pixel range
  const rectRef = useRef({ left: 0, width: 0 })

  const paint = (pct: number) => {
    pctRef.current = pct
    const knob = knobRef.current
    if (knob) {
      knob.style.transform = `translate(${(pct / 100) * travelRef.current}px, -50%)`
      knob.classList.toggle('near', pct >= NEAR_AT)
    }
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${pct / 100})`
    if (labelRef.current) labelRef.current.style.opacity = String(Math.max(0, 1 - pct / LABEL_GONE_AT))
  }
  const getPct = (clientX: number) => {
    const { left, width } = rectRef.current
    const travel = width - KNOB
    if (travel <= 0) return 0
    // 减掉按下时的偏移：滑块停在手指按住它的那个位置上，不会跳到手指正下方。
    // Subtract the grab offset so the knob stays where the finger took hold of it.
    const x = clientX - grabRef.current - left - KNOB / 2
    return Math.max(0, Math.min(100, (x / travel) * 100))
  }
  const finish = () => {
    if (confirmed.current || disabled) return
    confirmed.current = true
    sliding.current = false
    const el = trackRef.current
    el?.classList.remove('dragging')
    el?.classList.add('done')
    // 键盘路径从没拖过，行程还是 0：先量一次，滑块才会走到头。
    // The keyboard path never dragged, so travel is still 0: measure it once.
    if (travelRef.current <= 0 && el) travelRef.current = el.getBoundingClientRect().width - KNOB
    paint(100)
    try { navigator.vibrate?.(10) } catch { /* 不支持就算了 / unsupported is fine */ }
    onConfirm()
  }
  const onStart = (clientX: number) => {
    const el = trackRef.current
    const knob = knobRef.current
    if (!el || !knob) return
    const r = el.getBoundingClientRect()
    rectRef.current = { left: r.left, width: r.width }
    travelRef.current = r.width - KNOB
    // 先读位置、再关过渡：正在回弹时按住，滑块就停在此刻的位置接着跟手。
    // Read the position before killing the transition, so a knob caught mid
    // snap-back stays exactly where it is.
    const tx = currentTx(knob)
    grabRef.current = clientX - (r.left + KNOB / 2 + tx)
    sliding.current = true
    el.classList.add('dragging')
    paint(travelRef.current > 0 ? Math.max(0, Math.min(100, (tx / travelRef.current) * 100)) : 0)
  }
  const onPointerDown = (e: RPointerEvent<HTMLButtonElement>) => {
    // 第二根手指、鼠标非左键、已经在拖、已经成交：一律不理。
    // Ignore a second finger, a non-left mouse button, an active drag, a fired confirm.
    if (disabled || confirmed.current || !e.isPrimary || pointerRef.current !== null) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    pointerRef.current = e.pointerId
    e.currentTarget.setPointerCapture(e.pointerId)
    onStart(e.clientX)
  }
  const onPointerMove = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.pointerId !== pointerRef.current || !sliding.current || disabled) return
    const pct = getPct(e.clientX)
    paint(pct)
    if (pct >= CONFIRM_AT) finish()
  }
  // 松手：没到 95% 就回弹。pointercancel（系统返回手势、来电、浏览器接管）走同一条路，
  // 但永远不成交。
  // Release: below 95% the knob springs back. pointercancel (system back gesture,
  // incoming call, the browser taking over) takes the same path but never confirms.
  const release = (e: RPointerEvent<HTMLButtonElement>, canCommit: boolean) => {
    if (e.pointerId !== pointerRef.current) return
    pointerRef.current = null
    if (!sliding.current) return
    sliding.current = false
    trackRef.current?.classList.remove('dragging')
    if (canCommit && pctRef.current >= CONFIRM_AT) finish()
    else paint(0)
  }
  const onClick = (e: RMouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return   // 真实点击：必须滑 / a real tap or click: sliding is required
    finish()
  }

  return (
    <div ref={trackRef} className="slide-track">
      <div ref={fillRef} className="slide-track-fill" />
      <div ref={labelRef} className="slide-track-label" aria-hidden="true">{t('order.slideToConfirm', '滑动确认下单')}</div>
      <button
        ref={knobRef}
        type="button"
        className="slide-knob"
        style={{ touchAction: 'none' }}
        aria-label={label ?? String(t('order.slideToConfirm', '滑动确认下单'))}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => release(e, true)}
        onPointerCancel={(e) => release(e, false)}
        onClick={onClick}
      >
        <span className="slide-knob-face">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </span>
      </button>
    </div>
  )
}
