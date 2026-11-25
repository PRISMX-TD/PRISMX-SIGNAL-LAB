// 图表右键菜单（桌面）：点在价格轴上给坐标选项（自动 / 对数 / 百分比 / 翻转），点在图上给
// 重置视图、复制该处价格、跳转日期、截图、设置、快捷键。点在画线上时由 DrawLayer 自己的
// 菜单接管（它会 preventDefault，这里就不弹）。
// Chart right-click menu (desktop): on the price axis it offers scale options (auto / log /
// percent / invert); on the pane it offers reset view, copy the price there, go to date,
// screenshot, settings and shortcuts. A right-click on a drawing belongs to DrawLayer's own
// menu (it calls preventDefault, so this one stays shut).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { ScaleMode } from './chartPrefs'

export interface CtxState { x: number; y: number; zone: 'pane' | 'price'; price: number | null }

export interface CtxActions {
  reset: () => void
  copyPrice: (p: number) => void
  goto: () => void
  screenshot: () => void
  copyShot: (() => void) | null
  settings: () => void
  help: () => void
  autoScale: () => void
  scaleMode: ScaleMode
  setScaleMode: (m: ScaleMode) => void
  invert: boolean
  setInvert: (v: boolean) => void
  // 在这个价位开一张投影单（没有在线账户时为 null，菜单项不出现）与它的类型名。
  // Open a projected order at this price (null without an online account) and its type name.
  orderAt?: ((side: 'BUY' | 'SELL', price: number) => void) | null
  orderLabel?: (side: 'BUY' | 'SELL', price: number) => string
}

export default function ChartContextMenu({ state, onClose, actions, decimals }: { state: CtxState; onClose: () => void; actions: CtxActions; decimals: number }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: state.x, top: state.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    setPos({ left: Math.min(state.x, window.innerWidth - w - 8), top: Math.min(state.y, window.innerHeight - h - 8) })
    el.querySelector<HTMLButtonElement>('button')?.focus()
  }, [state])
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => { document.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onClose) }
  }, [onClose])
  const run = (fn: () => void) => () => { fn(); onClose() }
  const a = actions
  const item = (label: string, fn: () => void, extra?: { on?: boolean; kbd?: string }) => (
    <button type="button" role="menuitem" className={`chart-ctx-item ${extra?.on ? 'on' : ''}`} onClick={run(fn)}>
      <span>{label}</span>{extra?.kbd && <kbd>{extra.kbd}</kbd>}{extra?.on && <span aria-hidden>✓</span>}
    </button>
  )
  return createPortal(
    <div ref={ref} className="chart-ctx" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        const i = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }}>
      {state.zone === 'price' ? (
        <>
          {item(String(t('charts.scale.auto')), a.autoScale)}
          {item(String(t('charts.scale.log')), () => a.setScaleMode(a.scaleMode === 1 ? 0 : 1), { on: a.scaleMode === 1 })}
          {item(String(t('charts.scale.percent')), () => a.setScaleMode(a.scaleMode === 2 ? 0 : 2), { on: a.scaleMode === 2 })}
          {item(String(t('charts.scale.indexed')), () => a.setScaleMode(a.scaleMode === 3 ? 0 : 3), { on: a.scaleMode === 3 })}
          {item(String(t('charts.cs.invert')), () => a.setInvert(!a.invert), { on: a.invert })}
        </>
      ) : (
        <>
          {item(String(t('charts.ctx.reset')), a.reset, { kbd: 'Alt+R' })}
          {state.price != null && item(String(t('charts.ctx.copyPrice', { p: state.price.toFixed(decimals) })), () => a.copyPrice(state.price!))}
          {state.price != null && state.price > 0 && a.orderAt && a.orderLabel && (
            <>
              <hr />
              {item(String(t('charts.trade.ctxOrder', { type: a.orderLabel('BUY', state.price), p: state.price.toFixed(decimals) })), () => a.orderAt!('BUY', state.price!))}
              {item(String(t('charts.trade.ctxOrder', { type: a.orderLabel('SELL', state.price), p: state.price.toFixed(decimals) })), () => a.orderAt!('SELL', state.price!))}
            </>
          )}
          <hr />
          {item(String(t('charts.goto.title')), a.goto, { kbd: 'Alt+G' })}
          {item(String(t('charts.shot.save')), a.screenshot)}
          {a.copyShot && item(String(t('charts.shot.copy')), a.copyShot)}
          <hr />
          {item(String(t('charts.settings.title')), a.settings)}
          {item(String(t('charts.keys.title')), a.help)}
        </>
      )}
    </div>,
    document.body,
  )
}
