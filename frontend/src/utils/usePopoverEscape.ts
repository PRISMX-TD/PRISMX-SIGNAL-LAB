// 非模态弹层（头部用户菜单、通知铃铛、网络信号详情、语言下拉、图表设置）的键盘收尾：
// Esc 关闭，关闭后如果焦点原本在弹层里（或已经掉到 body），还给触发按钮——否则键盘
// 用户的下一次 Tab 会从页面顶端重新开始。
// 监听挂在 document 的**捕获**阶段并 stopPropagation：弹层可能开在一个模态弹窗里
// （手机「更多」抽屉里的语言下拉），useDialogA11y 的 Esc 监听在冒泡阶段，这一下 Esc
// 只该收起弹层，不该连外面那层一起关掉。
// 与 useDialogA11y 的分工：那个是模态（困住焦点、背景不可达），这个只管 Esc 与还焦点，
// 不移焦点进来、不困住 Tab——Disclosure 模式的面板在 DOM 里紧跟按钮，Tab 自然进入。
//
// Keyboard wrap-up for non-modal popovers: Escape closes, and if focus was inside the
// popover (or already fell to body) it goes back to the trigger, so the next Tab does not
// restart from the top of the page. The listener runs in the document *capture* phase
// and stops propagation: a popover may sit inside a modal (the language list in the
// mobile "More" sheet) whose useDialogA11y Escape listener runs in the bubble phase, and
// one Escape should only close the popover. Unlike useDialogA11y this does not move
// focus in or trap Tab: the panel follows its button in the DOM, so Tab reaches it.
import { useEffect, useRef, type RefObject } from 'react'

export function usePopoverEscape(
  open: boolean,
  onClose: () => void,
  triggerRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      const active = document.activeElement
      const box = containerRef.current
      const wasInside = !active || active === document.body || (box != null && box.contains(active))
      onCloseRef.current()
      if (wasInside) triggerRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, triggerRef, containerRef])
}
