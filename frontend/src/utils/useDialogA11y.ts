// 弹窗的键盘与读屏可达性：Esc 关闭、Tab 焦点困在弹窗内、打开时把焦点移进来、
// 关闭时还回打开前的元素。配合 role="dialog" aria-modal="true" 使用。
//
// 为什么需要：ConfirmModal 是平仓确认的载体，此前它对浏览器只是一个 div——按 Esc
// 没反应、Tab 会走到遮罩后面页面上的按钮、读屏不知道这是个弹窗。在一个「点错就是
// 真金白银」的确认框上这是功能缺陷，不是规范洁癖。项目里 6 个弹窗已各自做了
// role/Esc，5 个没做；这里收成一个 hook，新弹窗直接挂。
//
// 与 useBackToClose 的分工：那个管手机的「返回」手势（历史记录占位），本 hook 管键盘
// 与焦点。两者都由渲染弹窗的一方决定要不要挂：嵌套弹窗（弹窗里的确认框）时只有
// 最上面那层响应 Esc / Tab，靠下面这个栈判断「我是不是栈顶」——与 useBackToClose
// 的 openStack 同一个理由：document 级监听没有「只通知最后注册者」的机制。
//
// Keyboard and screen-reader affordances for a modal: Escape closes, Tab is trapped
// inside, focus moves in on open and back to the opener on close. Pair with
// role="dialog" aria-modal="true". Nested dialogs: only the topmost instance handles
// Escape/Tab, tracked by the stack below (same reasoning as useBackToClose's
// openStack — document-level listeners have no "notify only the last one").
//
// 2026-11 补充：① 栈挪到 utils/dialogStack，并负责在栈顶弹窗位于 #root 外时给 #root 加
// aria-hidden（TalkBack 不认 aria-modal）；② open 选项给「同一组件里条件渲染弹窗」的调用方
// （effect 依赖原来只有 ref，挂载时为空就再也不跑）；③ initialFocus: 'container' 给第一个
// 控件就是提交动作、或第一个控件是输入框（手机会弹软键盘）的弹窗；④ 可聚焦列表跳过不可见
// 元素（display:none 的按钮 focus() 会静默失败）；⑤ 关闭时焦点已被别人移走就不抢回。
// 2026-11 additions: (1) the stack moved to utils/dialogStack, which also aria-hides #root
// while the top dialog is outside it (TalkBack ignores aria-modal); (2) `open` for callers
// that conditionally render the dialog in the same component (the effect used to depend
// on the ref only and never re-ran); (3) initialFocus 'container' for dialogs whose first
// control commits an action or is a text input (opens the soft keyboard on phones);
// (4) invisible elements are skipped (focus() on display:none fails silently); (5) focus
// is not pulled back on close if something else already moved it.
import { useEffect, useRef, type RefObject } from 'react'
import { isTopDialog, popDialog, pushDialog, settleFocus } from './dialogStack'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface Options {
  /** 默认 true。有自己的 Esc 处理（例如提交中不许关）或刻意不让 Esc 关的弹窗传 false。
   *  Default true; pass false when the dialog has its own Escape handling or must not
   *  be dismissable by Escape (e.g. "confirm you saved the token" dialogs). */
  closeOnEscape?: boolean
  /** 默认 true。弹窗由调用方组件自己条件渲染时传「是否打开」，effect 随之重跑。
   *  Default true. Pass the open state when the caller renders the dialog conditionally. */
  open?: boolean
  /** 默认 'first'（第一个可见的可聚焦元素）；'container' 聚焦容器本身（需 tabIndex={-1}）。
   *  Default 'first' (first visible focusable); 'container' focuses the dialog itself. */
  initialFocus?: 'first' | 'container'
}

export function useDialogA11y(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { closeOnEscape = true, open = true, initialFocus = 'first' }: Options = {},
) {
  // 最新的 onClose 存 ref：每次渲染传新箭头函数很常见，不该让 effect 反复重挂。
  // Latest onClose in a ref so a fresh arrow function per render doesn't re-run the effect.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const root = ref.current
    if (!root) return
    // 弹窗自己没渲染出来（被媒体查询藏成 display:none，例如图表页的 .term-sheet 在 ≥1024
    // 不显示；图表页现在桌面不再打开它，这里是兜底）就什么都不做：否则 #root 被标
    // aria-hidden，而 Tab 找不到可聚焦元素、被整个吞掉，键盘用户困在一个看不见的弹窗里。
    // Do nothing when the dialog itself is not rendered (hidden by a media query, e.g. the
    // chart page's .term-sheet is display:none at ≥1024; that page no longer opens it on
    // desktop, so this is a safety net). Otherwise #root would be aria-hidden and Tab,
    // finding nothing to focus, would be swallowed entirely.
    if (root.getClientRects().length === 0) return

    const previous = document.activeElement as HTMLElement | null
    // 跳过不可见元素：display:none 的按钮 focus() 会静默失败，Tab 回绕就卡住。
    // Skip invisible elements: focus() on a display:none button fails silently.
    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0,
      )

    // 先移焦点、再入栈（入栈会给 #root 加 aria-hidden；Chrome 拒绝给焦点元素的祖先加）。
    // Focus first, then push (pushing may aria-hide #root, which Chrome refuses while a
    // descendant still holds focus).
    const target = initialFocus === 'container' ? root : focusables()[0] ?? root
    target.focus({ preventScroll: true })
    settleFocus(root, document)
    const id = pushDialog(root)

    const onKey = (e: KeyboardEvent) => {
      if (!isTopDialog(id)) return
      if (e.key === 'Escape') {
        if (!closeOnEscape) return
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) {
        e.preventDefault()
        root.focus({ preventScroll: true })
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      const outside = !root.contains(active)
      if (e.shiftKey) {
        if (outside || active === first || active === root) {
          e.preventDefault()
          last.focus()
        }
      } else if (outside || active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      // 先出栈（撤掉 #root 的 aria-hidden），再把焦点还回 #root 里的打开者。
      // Pop first (un-hides #root), then hand focus back to the opener inside it.
      popDialog(id)
      // 只在焦点丢了（落在 body）或还在弹窗里时才还：路由切换时 Layout 已把焦点移到
      // <main>（计划 037），这里不该再抢回到已经消失的菜单按钮上。
      // Return focus only if it was lost (body) or is still inside; if something else
      // already moved it (Layout focuses <main> on navigation) leave it there.
      const active = document.activeElement
      const lost = !active || active === document.body || root.contains(active)
      if (lost && previous && document.contains(previous)) previous.focus({ preventScroll: true })
    }
  }, [ref, closeOnEscape, open, initialFocus])
}
