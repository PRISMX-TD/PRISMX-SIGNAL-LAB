// 页签 / 分段单选的方向键漫游（roving tabindex），全站共用。
//
// 约定（WAI-ARIA 的 tablist / radiogroup 模式）：组内只有选中的那一项 tabIndex=0，
// 其余 -1，所以 Tab 键进组只停一次，再按 Tab 就离开去下面的内容；在组里用 ←/→
// （↑/↓ 同义）循环移动，Home / End 跳到两端。以前全站的 tablist 都宣告了「标签 1/N」
// 却不接方向键，每个页签各占一个 Tab 停靠点；只有排行榜的 SegChoice 做对了
// （LeaderboardPage.tsx 的注释讲过原因），这里把它的做法抽出来。
//
// 两种激活方式：
// - onRovingKeyDown（自动）：焦点移到哪项就选中哪项，等于替用户点了一下。切换只改
//   本页视图时用这个，与 SegChoice 原来的行为一致。
// - onRovingFocusKeyDown（手动）：方向键只移焦点，Enter / 空格（按钮的原生行为）才
//   选中。切换会换路由、写地址栏、或者可能弹确认框的地方用这个，免得方向键扫一遍
//   就推了三条历史记录或弹三次确认。
//
// 组内的项按 DOM 查找（role="tab" / role="radio"、未禁用、直接属于这个组），不按数据
// 下标：调用方不用把选项数组传进来，项里带着计数、徽标也不受影响。带 Alt / Ctrl /
// Meta 的组合键不接管，Alt+← 照样是浏览器后退。只处理从左到右的书写方向：现有五种
// 界面语言都不是从右到左。
//
// Arrow-key roving (roving tabindex) for tab strips and segmented radio groups.
//
// Contract (the WAI-ARIA tablist / radiogroup patterns): only the selected item has
// tabIndex=0 and the rest -1, so Tab stops once in the group and the next Tab leaves for
// the content below; inside the group ←/→ (↑/↓ alike) move with wrap-around and
// Home / End jump to the ends. Every tablist announced "tab 1 of N" without arrow keys,
// each tab costing a Tab stop; only the leaderboard's SegChoice got it right (see the
// comment in LeaderboardPage.tsx), and this extracts its approach.
//
// Two activation modes:
// - onRovingKeyDown (automatic): the item that receives focus is selected, as if
//   clicked. Use it where switching only changes the view on the page; it is what
//   SegChoice did.
// - onRovingFocusKeyDown (manual): arrows only move focus; Enter / Space (native button
//   behaviour) select. Use it where switching changes the route, writes the URL or may
//   raise a confirm dialog, so sweeping the arrows doesn't push three history entries
//   or raise three confirms.
//
// Items are found in the DOM (role="tab" / role="radio", not disabled, owned by this
// group), not by data index: callers pass no option array, and counts or badges inside
// an item don't matter. Alt / Ctrl / Meta chords are left alone, so Alt+← is still
// browser Back. Left-to-right only: none of the five UI languages is right-to-left.
import type { KeyboardEvent } from 'react'

/** 按键 → 目标下标；不是漫游键（或组是空的）返回 null。两端循环。
 *  Key → target index; null for keys that don't rove (or an empty group). Wraps at both ends. */
export function rovingNext(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

const ITEMS = '[role="tab"], [role="radio"]'
const GROUPS = '[role="tablist"], [role="radiogroup"]'

function rove(e: KeyboardEvent<HTMLElement>, activate: boolean): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return
  const group = e.currentTarget
  const items = Array.from(group.querySelectorAll<HTMLElement>(ITEMS)).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.closest(GROUPS) === group,
  )
  const current = items.indexOf(document.activeElement as HTMLElement)
  if (current < 0) return
  const next = rovingNext(e.key, current, items.length)
  if (next == null) return
  e.preventDefault()
  const target = items[next]
  target.focus()
  if (activate && next !== current) target.click()
}

/** 自动激活：挂在 role="tablist" / role="radiogroup" 的容器上。
 *  Automatic activation; attach to the role="tablist" / role="radiogroup" container. */
export function onRovingKeyDown(e: KeyboardEvent<HTMLElement>): void {
  rove(e, true)
}

/** 手动激活：方向键只移焦点，Enter / 空格才选中。
 *  Manual activation: arrows move focus only; Enter / Space select. */
export function onRovingFocusKeyDown(e: KeyboardEvent<HTMLElement>): void {
  rove(e, false)
}
