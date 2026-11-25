// 收藏工具栏：在工具弹出列表里点星标收藏的工具，浮在图表上，按住把手可拖到任意位置（位置存 chartv2）。
// Favourites bar: tools starred in the rail flyouts float on the chart; drag the grip anywhere (position in chartv2).
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { DrawToolIcon } from '../DrawToolsRow'
import type { Tool } from './model'

interface Props {
  favorites: Tool[]
  tool: Tool
  onPick: (t: Tool) => void
  pos: { x: number; y: number } | null
  onPos: (p: { x: number; y: number }) => void
  host: HTMLElement
  t: (k: string) => unknown
}

export default function DrawFavoritesBar({ favorites, tool, onPick, pos, onPos, host, t }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const cur = drag ?? pos
  // 位置按宿主尺寸夹住，宿主变小时不会跑出去 / clamp to the host so a smaller chart can't lose the bar
  const clamp = (x: number, y: number) => {
    const w = ref.current?.offsetWidth ?? 120, h = ref.current?.offsetHeight ?? 32
    return { x: Math.max(0, Math.min(host.clientWidth - w, x)), y: Math.max(0, Math.min(host.clientHeight - h, y)) }
  }
  const style = cur ? (() => { const c = clamp(cur.x, cur.y); return { left: c.x, top: c.y } })() : { left: '50%', bottom: 40, transform: 'translateX(-50%)' }

  const onDown = (e: RPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation()
    const el = ref.current
    if (!el) return
    const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect()
    start.current = { px: e.clientX, py: e.clientY, x: r.left - hr.left, y: r.top - hr.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: RPointerEvent<HTMLSpanElement>) => {
    const s = start.current
    if (!s) return
    setDrag(clamp(s.x + e.clientX - s.px, s.y + e.clientY - s.py))
  }
  const onUp = () => {
    start.current = null
    if (drag) onPos(drag)
    setDrag(null)
  }

  return (
    <div ref={ref} className="draw-favs" style={style} role="toolbar" aria-label={String(t('charts.draw.favorites'))} onPointerDown={(e) => e.stopPropagation()}>
      <span className="draw-favs-grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-hidden>
        <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="3" r="1.2" /><circle cx="6" cy="3" r="1.2" /><circle cx="2" cy="7" r="1.2" /><circle cx="6" cy="7" r="1.2" /><circle cx="2" cy="11" r="1.2" /><circle cx="6" cy="11" r="1.2" /></svg>
      </span>
      {favorites.map((f) => (
        <button key={f} type="button" className={`term-tool-btn ${tool === f ? 'on' : ''}`} title={String(t(`charts.draw.${f}`))} aria-label={String(t(`charts.draw.${f}`))} aria-pressed={tool === f} onClick={() => onPick(f)}>
          <DrawToolIcon tool={f} />
        </button>
      ))}
    </div>
  )
}
