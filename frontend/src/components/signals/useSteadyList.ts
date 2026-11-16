// 列表不在手指底下挪动（2026-11-16 体验报告 H3）。
//
// 信号网格按时间倒序，新信号插在最前面。实测：正要点黄金那张卡的「下单」，恰好一条新信号
// 推进来，整列往下挤了一张，手指落在了 BTC 那张上，弹出的是 BTC 的下单票。到期信号从列表
// 里拿掉时同样会让下面的卡往上跳。
//
// 规则：用户正在操作（手指按着，或刚碰过 / 滚过 ARRIVAL_HOLD_MS 之内）时，因**数据**引起的
// 增删先压住，列表保持原来的顺序与成员（已有卡片的内容照常更新）；手停下来后再一次性放进来。
// 用户自己改筛选 / 排序（resetKey 变了）立即生效——那是他要的变化。
// 放进来的那一刻记下时间：之后 SHIFT_GUARD_MS 内的「下单」点击不认（recentlyShifted），挡住
// 「刚好在挪动瞬间按下去」的那一下。
//
// Keep a list from moving under the user's finger (QA report H3). While the user is
// interacting (pointer down, or touched / scrolled within ARRIVAL_HOLD_MS), data-driven
// additions and removals are held and the list keeps its members and order (existing items
// still update); they land once the hands are still. A user-made filter / sort change
// (resetKey) applies at once. The landing time is recorded so taps within SHIFT_GUARD_MS of
// a shift can be ignored.

import { useEffect, useMemo, useRef, useState } from 'react'

export const ARRIVAL_HOLD_MS = 1200
export const SHIFT_GUARD_MS = 600

const touch = { last: 0, down: false, installed: false }

function installTouchTracking() {
  if (touch.installed || typeof window === 'undefined') return
  touch.installed = true
  const opts = { capture: true, passive: true } as const
  const mark = () => { touch.last = Date.now() }
  window.addEventListener('pointerdown', () => { touch.down = true; mark() }, opts)
  window.addEventListener('pointerup', () => { touch.down = false; mark() }, opts)
  window.addEventListener('pointercancel', () => { touch.down = false; mark() }, opts)
  window.addEventListener('scroll', mark, opts)
  window.addEventListener('wheel', mark, opts)
  window.addEventListener('keydown', mark, opts)
}

/** 还要再等多久手才算停下（0 = 已经停了）。/ How long until the user counts as idle (0 = idle). */
export function msUntilIdle(now = Date.now()): number {
  if (touch.down) return ARRIVAL_HOLD_MS
  return Math.max(0, touch.last + ARRIVAL_HOLD_MS - now)
}

/** 测试用：模拟一次触碰 / 抬手。/ Test hook: simulate a touch state. */
export function __setTouch(last: number, down = false) {
  touch.last = last
  touch.down = down
}

/**
 * 纯函数版：hold 时沿用上一版的成员与顺序（内容取最新的，已被拿掉的用缓存里最后一版），
 * 否则直接用新列表。/ Pure step: when holding, keep the previous members and order (latest
 * content, or the cached last version for removed ones); otherwise take the new list.
 */
export function steadyStep<T extends { id: string }>(
  prevIds: string[] | null,
  next: T[],
  hold: boolean,
  cache: Map<string, T>,
): { ids: string[]; items: T[] } {
  for (const it of next) cache.set(it.id, it)
  const nextIds = next.map((it) => it.id)
  if (prevIds === null || !hold || sameIds(prevIds, nextIds)) {
    // 缓存只留当前列表里的，别无限长 / keep the cache bounded to the current list
    for (const k of cache.keys()) if (!nextIds.includes(k)) cache.delete(k)
    return { ids: nextIds, items: next }
  }
  const byId = new Map(next.map((it) => [it.id, it]))
  const items: T[] = []
  for (const id of prevIds) {
    const it = byId.get(id) ?? cache.get(id)
    if (it) items.push(it)
  }
  return { ids: prevIds, items }
}

function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function useSteadyList<T extends { id: string }>(list: T[], resetKey: string) {
  useEffect(installTouchTracking, [])
  const [tick, setTick] = useState(0)
  const idsRef = useRef<string[] | null>(null)
  const keyRef = useRef(resetKey)
  const cache = useRef(new Map<string, T>())
  const shiftedAt = useRef(0)

  const out = useMemo(() => {
    void tick
    const reset = keyRef.current !== resetKey
    keyRef.current = resetKey
    const prev = idsRef.current
    const step = steadyStep(reset ? null : prev, list, msUntilIdle() > 0, cache.current)
    // 数据引起的挪动（不是首帧、不是用户改筛选）才记时间 / only data-driven shifts count
    if (!reset && prev !== null && !sameIds(prev, step.ids)) shiftedAt.current = Date.now()
    idsRef.current = step.ids
    return step
  }, [list, resetKey, tick])

  const pending = !sameIds(out.ids, list.map((it) => it.id))
  // 有压着的变化：等手停下来再算一次。/ Something is held: recompute once the user is idle.
  useEffect(() => {
    if (!pending) return
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.max(50, msUntilIdle() + 20))
    return () => window.clearTimeout(timer)
  }, [pending, out, tick])

  return {
    items: out.items,
    recentlyShifted: () => Date.now() - shiftedAt.current < SHIFT_GUARD_MS,
  }
}
