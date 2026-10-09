// 游客预览的「门」：页面上任何一次操作性点击都在 document 的捕获阶段被拦下，换成注册弹窗。
//
// 拦在 document 捕获阶段而不是给每个按钮加判断：仪表盘的卡片组件原样复用，组件里不用知道
// 「我现在是不是游客」。document 捕获先于 React 根节点的监听，stopPropagation 之后 React 的
// onClick（含 react-router 的 Link）根本收不到；preventDefault 挡住 <a> 的原生跳转。
// 放行的只有「浏览」类操作：英雄卡切换品种、时段卡的两个下拉、带 data-guest-allow 的元素
// （弹窗本身、注册 / 登录按钮、语言、页脚条款）。
//
// The guest preview's gate: every action click is caught in document's capture phase and
// turned into the sign-up modal. Capturing at document rather than branching in each button
// means the dashboard cards are reused untouched. Document capture runs before React's root
// listener, so after stopPropagation React's onClick (react-router's Link included) never
// fires, and preventDefault stops native <a> navigation. Only "browsing" passes: the hero's
// symbol switcher, the session card's two dropdowns, and anything under data-guest-allow
// (the modal itself, sign-up / log-in buttons, language, footer legal links).
import { useEffect, useRef } from 'react'

export type GatePage = 'signals' | 'charts' | 'orders' | 'growth' | 'analysis'

export type GateReason =
  | { kind: 'trade'; signalId: string }
  | { kind: 'nav'; page: GatePage }
  | { kind: 'competition' }
  | { kind: 'personal' }
  | { kind: 'history' }
  | { kind: 'exit' }
  | { kind: 'generic' }

const ALLOW = [
  '[data-guest-allow]',
  '.hero-arrow-btn',
  '.hero-seg',
  '.select-picker',
  '.select-menu',
  '.select-backdrop',
].join(',')

const INTERACTIVE = 'a,button,[role="button"],[role="tab"],[role="link"],input,select,textarea,label,summary,[data-gate]'

function reasonOf(el: Element): GateReason {
  const sig = el.closest<HTMLElement>('[data-signal-id]')?.dataset.signalId
  if (sig) return { kind: 'trade', signalId: sig }
  const g = el.closest<HTMLElement>('[data-gate]')?.dataset.gate
  if (g?.startsWith('nav:')) return { kind: 'nav', page: g.slice(4) as GatePage }
  if (g === 'competition' || g === 'personal' || g === 'history') return { kind: g }
  if (el.closest('.dash-tk, .cmp-navlive')) return { kind: 'competition' }
  if (el.closest('.view-all-btn')) return { kind: 'nav', page: 'signals' }
  if (el.closest('.dh-link')) return { kind: 'nav', page: 'analysis' }
  return { kind: 'generic' }
}

export function useGateCapture(open: (r: GateReason) => void) {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (target.closest(ALLOW)) return
      const hit = target.closest(INTERACTIVE)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      openRef.current(reasonOf(hit))
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}

// 离开意图（仅桌面、仅一次）：鼠标从页面顶边移出去，多半是要去点标签页或地址栏。
// 进站不足 10 秒不触发——刚来就弹是打扰，不是挽留。
// Exit intent (desktop only, once): the pointer leaving through the top edge usually means
// a reach for the tab bar or address bar. Not within the first 10s — that's nagging.
export function useExitIntent(onExit: () => void, enabled: boolean) {
  const cb = useRef(onExit)
  cb.current = onExit
  useEffect(() => {
    if (!enabled || !window.matchMedia?.('(pointer: fine)').matches) return
    const since = Date.now()
    let fired = false
    try { fired = sessionStorage.getItem('guest-exit') === '1' } catch { /* private mode */ }
    if (fired) return
    const onOut = (e: MouseEvent) => {
      if (fired || e.relatedTarget || e.clientY > 0 || Date.now() - since < 10_000) return
      fired = true
      try { sessionStorage.setItem('guest-exit', '1') } catch { /* ignore */ }
      cb.current()
    }
    document.addEventListener('mouseout', onOut)
    return () => document.removeEventListener('mouseout', onOut)
  }, [enabled])
}
