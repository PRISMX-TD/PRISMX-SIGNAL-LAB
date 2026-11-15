// 加载指示的防闪烁：active 持续超过 delay 才显示；一旦显示，至少停 minVisible 毫秒。
//
// 两条规矩各治一种难看：① 大多数请求一两百毫秒就回来，眼睛还没看清骨架就没了，闪一下比什么都
// 不显示更糟——所以先等 delay；② 骨架刚出现 50ms 数据就到、立刻撤掉，读起来像出了故障——所以一旦
// 出现就至少停 minVisible。默认 200 / 400ms。
//
// Flicker guard for loading indicators: show only once `active` has lasted `delay`, and once shown
// keep it at least `minVisible` ms. Most requests return within a couple of hundred ms, and a
// skeleton flashing for 80ms is worse than nothing; one that appears and vanishes 50ms later reads
// as a glitch. Defaults 200 / 400ms.
//
// 用全局 setTimeout：单测跑在没有 window 的 node 里。/ Global setTimeout: the test runs in node.
import { useEffect, useRef, useState } from 'react'

export interface DelayedFlagOptions {
  delay?: number
  minVisible?: number
}

/** 纯逻辑控制器（给单测与 hook 共用）/ framework-free controller shared by the test and the hook */
export function createDelayedFlag(onChange: (visible: boolean) => void, { delay = 200, minVisible = 400 }: DelayedFlagOptions = {}) {
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let visible = false
  let shownAt = 0
  return {
    set(active: boolean) {
      if (active) {
        // 正在等着撤：又忙起来了，就继续显示。/ Waiting to hide but busy again: stay visible.
        if (hideTimer !== undefined) { clearTimeout(hideTimer); hideTimer = undefined; return }
        if (visible || showTimer !== undefined) return
        showTimer = setTimeout(() => {
          showTimer = undefined
          visible = true
          shownAt = Date.now()
          onChange(true)
        }, delay)
      } else {
        // 在 delay 之内就结束了：根本不显示。/ Finished within the delay: never shown.
        if (showTimer !== undefined) { clearTimeout(showTimer); showTimer = undefined; return }
        if (!visible || hideTimer !== undefined) return
        const remaining = Math.max(0, minVisible - (Date.now() - shownAt))
        hideTimer = setTimeout(() => {
          hideTimer = undefined
          visible = false
          onChange(false)
        }, remaining)
      }
    },
    dispose() {
      if (showTimer !== undefined) clearTimeout(showTimer)
      if (hideTimer !== undefined) clearTimeout(hideTimer)
      showTimer = undefined
      hideTimer = undefined
    },
  }
}

/** React 版：返回此刻该不该画加载指示。/ React wrapper: whether to draw the loading indicator now. */
export function useDelayedFlag(active: boolean, opts: DelayedFlagOptions = {}): boolean {
  const [visible, setVisible] = useState(false)
  const ctrl = useRef<ReturnType<typeof createDelayedFlag> | null>(null)
  if (ctrl.current == null) ctrl.current = createDelayedFlag(setVisible, opts)
  useEffect(() => {
    ctrl.current?.set(active)
  }, [active])
  useEffect(() => () => ctrl.current?.dispose(), [])
  return visible
}
