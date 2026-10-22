// 转盘几何：第 i 格从 i*span 度开始顺时针画，指针固定在正上方（0 度）。
// 轮盘顺时针转 rotation 度后，指针下面是原先 -rotation 处的那一格。停的位置在格内随机偏移
// （jitter ∈ [-1, 1)，乘 0.4 个格宽），每次至少多转 5 圈。结果由后端定，这里只负责停准。
// Wheel geometry: slot i is drawn clockwise from i*span degrees; the pointer sits at the top
// (0°). After rotating clockwise by `rotation`, the slot under the pointer is the one that was
// at -rotation. The stop point is jittered within the slot and we always add ≥5 full turns.
export const slotSpan = (n: number) => 360 / n
export const slotCenter = (i: number, n: number) => i * slotSpan(n) + slotSpan(n) / 2

const mod360 = (x: number) => ((x % 360) + 360) % 360

export function indexAtRotation(rotation: number, n: number): number {
  return Math.floor(mod360(-rotation) / slotSpan(n)) % n
}

export function targetRotation(current: number, index: number, n: number, jitter: number): number {
  const offset = slotCenter(index, n) + jitter * 0.4 * slotSpan(n)
  const want = mod360(-offset)             // 停下时 rotation 模 360 应等于它 / final rotation mod 360
  const base = current - mod360(current) + 360 * 5
  return base + want + (base + want <= current + 360 * 4 ? 360 : 0)
}

export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
