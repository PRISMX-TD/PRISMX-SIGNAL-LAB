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
import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const openStack: number[] = []
let nextId = 1

interface Options {
  /** 默认 true。有自己的 Esc 处理（例如提交中不许关）或刻意不让 Esc 关的弹窗传 false。
   *  Default true; pass false when the dialog has its own Escape handling or must not
   *  be dismissable by Escape (e.g. "confirm you saved the token" dialogs). */
  closeOnEscape?: boolean
}

export function useDialogA11y(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  { closeOnEscape = true }: Options = {},
) {
  // 最新的 onClose 存 ref：每次渲染传新箭头函数很常见，不该让 effect 反复重挂。
  // Latest onClose in a ref so a fresh arrow function per render doesn't re-run the effect.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const root = ref.current
    if (!root) return

    const id = nextId++
    openStack.push(id)
    const isTop = () => openStack[openStack.length - 1] === id

    const previous = document.activeElement as HTMLElement | null
    const focusables = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('hidden'))

    // 初始焦点：第一个可聚焦元素，没有就落在容器上（容器需 tabIndex={-1}）。
    // Initial focus: the first focusable, else the container (which needs tabIndex={-1}).
    ;(focusables()[0] ?? root).focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return
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
        if (outside || active === first) {
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
      const i = openStack.lastIndexOf(id)
      if (i !== -1) openStack.splice(i, 1)
      // 焦点还给打开弹窗的那个控件（它可能已随列表刷新消失，那就不动）。
      // Hand focus back to the opener if it is still in the document.
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true })
    }
  }, [ref, closeOnEscape])
}
