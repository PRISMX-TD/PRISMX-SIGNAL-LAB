import { useCallback, useEffect, useRef, useState } from 'react'

export type Toast = { kind: 'ok' | 'err'; text: string }

// 管理后台各面板共用的轻提示：显示一条、几秒后自动消失、新的一条会顶掉旧的
// 定时器。此前同一段 state + ref + 定时器在六个组件里各写一份，其中一份漏了
// 卸载时清定时器，另一份漏了"新提示先清旧定时器"（过期的红条会赖着不走）。
// Shared toast for the admin panels: show one, auto-dismiss, a new one cancels
// the previous timer. Six components used to carry their own copy, one without
// unmount cleanup and one that let a stale failure banner linger.
export function useToast(ms = 4000) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    [],
  )

  const showToast = useCallback(
    (kind: Toast['kind'], text: string) => {
      if (timer.current) window.clearTimeout(timer.current)
      setToast({ kind, text })
      timer.current = window.setTimeout(() => setToast(null), ms)
    },
    [ms],
  )

  return { toast, showToast }
}
