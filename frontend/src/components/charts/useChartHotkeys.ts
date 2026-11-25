// 图表页键盘快捷键（同 TradingView 的习惯，列表见 ShortcutsDialog）。只在焦点落在图表区
// （.term-cv：竖轨 + 工具条 + 图表）且不在输入框里时生效——与 DrawLayer 的单键规则一致
// （WCAG 2.1.4）。画线工具的 Alt+字母、Esc、Delete、Ctrl+Z 由 DrawLayer 自己处理。
// Charts-page keyboard shortcuts (TradingView's conventions; listed in ShortcutsDialog). Only
// while focus is inside the chart area (.term-cv: rail + toolbar + chart) and not in a text
// field — the same rule as DrawLayer's single keys (WCAG 2.1.4). Draw-tool Alt+letters, Esc,
// Delete and Ctrl+Z stay in DrawLayer.
import { useEffect, useRef } from 'react'

export interface ChartHotkeyHandlers {
  quickInput: (first: string) => void
  reset: () => void
  goto: () => void
  toggleLog: () => void
  togglePercent: () => void
  toggleInvert: () => void
  scroll: (bars: number) => void
  zoom: (factor: number) => void
  screenshot: () => void
  help: () => void
  // Alt+A：在现价添加警报 / Alt+A: add an alert at the current price
  alert?: () => void
}

function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useChartHotkeys(scopeRef: { current: HTMLElement | null }, handlers: ChartHotkeyHandlers, enabled = true) {
  const h = useRef(handlers)
  h.current = handlers
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inTextField(e.target)) return
      const scope = scopeRef.current
      const active = document.activeElement
      if (!scope || !active || !scope.contains(active)) return
      const mod = e.ctrlKey || e.metaKey
      // Ctrl+/ 或 ? → 快捷键一览 / shortcut list
      if ((mod && e.key === '/') || (!mod && !e.altKey && e.key === '?')) { e.preventDefault(); h.current.help(); return }
      if (mod && e.altKey && e.code === 'KeyS') { e.preventDefault(); h.current.screenshot(); return }
      if (e.altKey && !mod && !e.shiftKey) {
        const act: Record<string, () => void> = {
          KeyR: h.current.reset, KeyG: h.current.goto, KeyL: h.current.toggleLog, KeyP: h.current.togglePercent, KeyI: h.current.toggleInvert,
        }
        if (h.current.alert) act.KeyA = h.current.alert
        const fn = act[e.code]
        if (fn) { e.preventDefault(); fn() }
        return
      }
      if (mod || e.altKey) return
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); h.current.scroll(e.shiftKey ? -50 : -10); return
        case 'ArrowRight': e.preventDefault(); h.current.scroll(e.shiftKey ? 50 : 10); return
        case 'ArrowUp': e.preventDefault(); h.current.zoom(1.2); return
        case 'ArrowDown': e.preventDefault(); h.current.zoom(1 / 1.2); return
      }
      // 单个数字 / 字母 → 快速输入（周期或品种）/ a digit or letter → quick input
      if (e.key.length === 1 && /[0-9A-Za-z]/.test(e.key)) {
        e.preventDefault()
        h.current.quickInput(e.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [scopeRef, enabled])
}
