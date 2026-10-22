// 转盘的运动曲线：先往回蓄力一小下（像手拉了一把），再一把甩出去、长长地减速停准。
// 每一帧只算出角度交给回调，回调直接写 DOM 的 transform，不经过 React 状态（避免每帧重渲染）。
// The wheel's motion: a short wind-up backwards (like a hand pulling it), then a fling that decelerates
// for a long time and lands exactly. Each frame only computes an angle and hands it to a callback that
// writes the DOM transform directly, never React state (no per-frame re-render).

export const WINDUP_MS = 320
export const WINDUP_DEG = 9
export const SPIN_MS = 4900
export const TOTAL_MS = WINDUP_MS + SPIN_MS

const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
// 四次方缓出：起手快、尾段很长，最后一两格慢慢挪过去，悬念留在最后。
// Quartic ease-out: a fast start and a long tail, so the last slot or two creep past the pointer.
export const easeOutQuart = (t: number) => 1 - (1 - t) ** 4

/** 第 ms 毫秒时的角度 / The angle at `ms` into the spin. */
export function spinAngle(ms: number, from: number, to: number): number {
  if (ms <= 0) return from
  if (ms < WINDUP_MS) return from - WINDUP_DEG * easeInOutSine(ms / WINDUP_MS)
  const t = Math.min(1, (ms - WINDUP_MS) / SPIN_MS)
  const start = from - WINDUP_DEG
  return start + (to - start) * easeOutQuart(t)
}

/**
 * 用 requestAnimationFrame 播放一次转动；返回取消函数。onDone 只在自然播完时调用一次。
 * Plays one spin on requestAnimationFrame and returns a cancel function. onDone fires once, only when
 * the spin finishes on its own.
 */
export function playSpin(from: number, to: number, onFrame: (angle: number) => void, onDone: () => void): () => void {
  let raf = 0
  let t0 = -1
  let live = true
  const step = (now: number) => {
    if (!live) return
    if (t0 < 0) t0 = now
    const ms = now - t0
    onFrame(spinAngle(ms, from, to))
    if (ms >= TOTAL_MS) {
      live = false
      onFrame(to)
      onDone()
      return
    }
    raf = window.requestAnimationFrame(step)
  }
  raf = window.requestAnimationFrame(step)
  return () => {
    live = false
    window.cancelAnimationFrame(raf)
  }
}
