// 页面级浮层提示（components/Toast.tsx）的状态：一次一条、按种类决定停留多久、到点先播
// 退场动画再卸载、新的一条直接顶掉旧的。
//
// 注意和 utils/useToast.ts 区分：那个是管理后台面板顶部的提示条（ToastBar），不是这个。
//
// State for the page-level floating toast (components/Toast.tsx): one at a time, a duration
// per kind, an exit animation before unmount, and a new one simply replaces the old. Not to be
// confused with utils/useToast.ts, which drives the admin panels' ToastBar.
import { useCallback, useEffect, useRef, useState } from 'react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  /** 每条提示一个新 id，调用点拿它做 key：换一条就重新挂载、重播进场。
   *  A fresh id per toast; call sites use it as the key so a replacement re-mounts and replays the enter. */
  id: number
  kind: ToastKind
  msg: string
  /** 正在播退场动画 / playing the exit animation */
  leaving: boolean
}

// 停留时长。错误 6 秒：它通常带原因（券商原文、网络错误），要读完还要决定下一步；成功 3 秒：
// 用户只需要确认「成了」；info 4 秒介于两者（「已提交，等待回执」一类）。以前错误也只有 3 秒
// （交易页 4 秒），长一点的拒单原因读不完就没了。
// How long each kind stays. Errors 6s: they usually carry a reason (broker text, network error)
// to read and act on. Success 3s: the user only needs "it worked". Info 4s sits between. Errors
// used to get 3s (4s on the Orders page), too short for a longer broker reason.
export const TOAST_MS: Record<ToastKind, number> = { success: 3000, info: 4000, error: 6000 }

// 退场动画时长，必须与 styles/components-controls.css 里 .toast.leaving 的 0.1s 一致。
// The exit animation's length; must match the 0.1s on .toast.leaving in components-controls.css.
export const TOAST_EXIT_MS = 100

let nextId = 0

export function useToastState() {
  const [toast, setToast] = useState<ToastItem | null>(null)
  const timers = useRef<number[]>([])

  useEffect(
    () => () => {
      for (const tid of timers.current) window.clearTimeout(tid)
    },
    [],
  )

  const showToast = useCallback((msg: string, kind: ToastKind = 'success', ms?: number) => {
    for (const tid of timers.current) window.clearTimeout(tid)
    timers.current = []
    nextId += 1
    const id = nextId
    setToast({ id, kind, msg, leaving: false })
    timers.current.push(window.setTimeout(() => {
      setToast((cur) => (cur && cur.id === id ? { ...cur, leaving: true } : cur))
      timers.current.push(window.setTimeout(() => {
        setToast((cur) => (cur && cur.id === id ? null : cur))
      }, TOAST_EXIT_MS))
    }, ms ?? TOAST_MS[kind]))
  }, [])

  return { toast, showToast }
}
