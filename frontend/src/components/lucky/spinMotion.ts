// 转盘的运动曲线：先往回蓄力一小下（像手拉了一把），再一把甩出去、长长地减速停准。
// 每一帧只算出角度交给回调，回调直接写 DOM 的 transform，不经过 React 状态（避免每帧重渲染）。
// The wheel's motion: a short wind-up backwards (like a hand pulling it), then a fling that decelerates
// for a long time and lands exactly. Each frame only computes an angle and hands it to a callback that
// writes the DOM transform directly, never React state (no per-frame re-render).

export const WINDUP_MS = 320
export const WINDUP_DEG = 9
export const SPIN_MS = 4200
// 甩出后的起速段：蓄力结束时速度是 0，以前下一帧直接满速（第一帧就跳 23.5°）；现在用
// 100ms 把速度从 0 线性提上去，总时长因此多 RAMP_MS / 2。
// The launch ramp: the wind-up ends at zero speed and the next frame used to be full
// speed (a 23.5° jump in the first frame); speed now rises linearly from 0 over 100ms,
// which adds RAMP_MS / 2 to the total.
export const RAMP_MS = 100
export const TOTAL_MS = WINDUP_MS + SPIN_MS + RAMP_MS / 2

const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
// 三次方缓出：尾段仍长，最后一两格慢慢挪过指针，但最后一秒还在看得见地转（约 24°）。以前
// 的四次方缓出最后一秒只走 3°，转盘读起来早停了，接着干等将近一秒才出结果。
// Cubic ease-out: still a long tail, the last slot or two creep past the pointer, but the
// last second still visibly turns (about 24°). The old quartic moved 3° in its last second,
// so the wheel read as stopped and then sat for nearly a second before the result.
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/** 第 ms 毫秒时的角度 / The angle at `ms` into the spin. */
export function spinAngle(ms: number, from: number, to: number): number {
  if (ms <= 0) return from
  if (ms < WINDUP_MS) return from - WINDUP_DEG * easeInOutSine(ms / WINDUP_MS)
  const e = ms - WINDUP_MS
  // 时间扭曲：前 RAMP_MS 内 u = e² / (2·RAMP_MS)，du/de 从 0 线性升到 1；之后 u = e − RAMP_MS / 2。
  // 接缝处位置与速度都连续。/ Time warp: u = e² / (2·RAMP_MS) for the first RAMP_MS, so du/de
  // rises linearly from 0 to 1; then u = e − RAMP_MS / 2. Position and speed are continuous at the seam.
  const u = e < RAMP_MS ? (e * e) / (2 * RAMP_MS) : e - RAMP_MS / 2
  const t = Math.min(1, u / SPIN_MS)
  const start = from - WINDUP_DEG
  return start + (to - start) * easeOutCubic(t)
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
