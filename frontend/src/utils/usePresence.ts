// 让条件渲染的弹层有退场动画：值变成 null 之后，把「上一次的值」再留 ms 毫秒，同时给出
// closing = true，CSS 据此播退场；到时间才真正卸载。所有关闭途径（点遮罩、✕、Esc、
// 返回手势 useBackToClose、路由切换、拖拽甩走）最后都是把那个 state 置空，所以都走这一条，
// 退场写一处、处处生效。关闭途中又打开（值重新变成非 null）：立刻取消退场，显示新值。
//
// Gives a conditionally rendered sheet an exit: after the value turns null, the last
// value stays mounted for ms more with closing = true so CSS can play the exit, then it
// unmounts. Every close path (scrim, ✕, Escape, the useBackToClose back gesture,
// navigation, a drag fling) ends by nulling that state, so all of them go through here
// and the exit is written once. Reopening mid-exit cancels it and shows the new value.
import { useEffect, useState } from 'react'

// 退场时长，必须与 tokens.css 的 --dur-base（0.24s）一致：.closing 的过渡用的就是它。
// Exit length; must equal --dur-base (0.24s) in tokens.css, which .closing transitions use.
export const SHEET_EXIT_MS = 240

export function usePresence<T>(value: T | null, ms: number): { shown: T | null; closing: boolean; openSeq: number } {
  const [last, setLast] = useState<T | null>(value)
  // 每次从「关」变「开」加一。调用方把它拼进 key：退场途中重开同一个值（比如下单成功自动
  // 关闭后马上又点同一条信号）也会得到一个全新实例，不会复用上一次的回执和表单状态。
  // Bumps on every closed → open transition. Callers fold it into the key so reopening the
  // same value mid-exit (e.g. tapping the same signal right after an auto-close) mounts a
  // fresh instance instead of reusing the previous receipt and form state.
  const [openSeq, setOpenSeq] = useState(0)
  const [wasOpen, setWasOpen] = useState(value != null)
  if ((value != null) !== wasOpen) {
    setWasOpen(value != null)
    if (value != null) setOpenSeq((n) => n + 1)
  }
  // 渲染期同步「上一次的非空值」（React 文档认可的「按上一次渲染调整 state」写法）：
  // 比放在 effect 里早一帧，打开时不会空白一帧。
  // Sync the last non-null value during render (React's documented "adjust state on a
  // previous render" pattern): a frame earlier than an effect, so opening never blanks.
  if (value != null && value !== last) setLast(value)
  const closing = value == null && last != null
  useEffect(() => {
    if (!closing) return
    const id = window.setTimeout(() => setLast(null), ms)
    return () => window.clearTimeout(id)
  }, [closing, ms])
  return { shown: value ?? last, closing, openSeq }
}
