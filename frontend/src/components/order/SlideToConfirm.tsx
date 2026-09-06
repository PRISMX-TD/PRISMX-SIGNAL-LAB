// 滑动确认轨道：拖到 95% 触发 onConfirm。两个下单弹窗共用。
//
// 拖动时直接操作 DOM（transform / width），不走 setState——频繁重渲染整张卡会卡顿。
// Pointer Capture 让拖动离开轨道也持续跟手；touch-action:none 防止移动端拖动时带动
// 页面滚动。
// Slide-to-confirm track shared by both order modals. Drives the DOM directly
// while dragging (no setState per move — re-rendering the whole card janks);
// pointer capture keeps the drag tracking outside the track.
import { useRef, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

const KNOB = 56
const CONFIRM_AT = 95

export default function SlideToConfirm({ disabled, onConfirm }: { disabled: boolean; onConfirm: () => void }) {
  const { t } = useTranslation()
  const trackRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const sliding = useRef(false)
  const pctRef = useRef(0)
  const travelRef = useRef(0)   // 轨道可滑动像素范围 / draggable pixel range
  const rectRef = useRef({ left: 0, width: 0 })

  const paint = (pct: number) => {
    pctRef.current = pct
    if (knobRef.current) knobRef.current.style.transform = `translate(${(pct / 100) * travelRef.current}px, -50%)`
    if (fillRef.current) fillRef.current.style.width = `${pct}%`
  }
  const getPct = (clientX: number) => {
    const { left, width } = rectRef.current
    const travel = width - KNOB
    if (travel <= 0) return 0
    const x = clientX - left - KNOB / 2   // 让滑块中心跟随手指 / keep the knob centered under the finger
    return Math.max(0, Math.min(100, (x / travel) * 100))
  }
  const finish = () => {
    sliding.current = false
    const el = trackRef.current
    el?.classList.remove('dragging')
    el?.classList.add('done')
    paint(100)
    onConfirm()
  }
  const onStart = (clientX: number) => {
    if (disabled) return
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    rectRef.current = { left: r.left, width: r.width }
    travelRef.current = r.width - KNOB
    sliding.current = true
    el.classList.add('dragging')
    paint(getPct(clientX))
  }
  const onMove = (clientX: number) => {
    if (!sliding.current || disabled) return
    const pct = getPct(clientX)
    paint(pct)
    if (pct >= CONFIRM_AT) finish()
  }
  const onEnd = () => {
    if (!sliding.current) return
    sliding.current = false
    trackRef.current?.classList.remove('dragging')
    if (pctRef.current >= CONFIRM_AT) finish()
    else paint(0)
  }

  return (
    <div ref={trackRef} className="slide-track" style={{ touchAction: 'none' }}>
      <div ref={fillRef} className="slide-track-fill" />
      <div className="slide-track-label">{t('order.slideToConfirm', '滑动确认下单')}</div>
      <div
        ref={knobRef}
        className="slide-knob"
        style={{ touchAction: 'none' }}
        onPointerDown={(e: RPointerEvent<HTMLDivElement>) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          onStart(e.clientX)
        }}
        onPointerMove={(e: RPointerEvent<HTMLDivElement>) => onMove(e.clientX)}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
      </div>
    </div>
  )
}
