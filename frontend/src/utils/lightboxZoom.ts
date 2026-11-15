// 工单大图的放大几何：倍数、平移上限、双击时让点到的那一点留在手指下、双击判定。纯函数。
// Ticket-image lightbox zoom geometry: the scale, the pan limit, keeping the tapped point
// under the finger on a double-tap, and the double-tap test. Pure functions.
export const LIGHTBOX_ZOOM = 2
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_PX = 24
// 走出这么远就不再是点按。/ Beyond this travel it is no longer a tap.
export const TAP_SLOP = 10

export interface Size { w: number; h: number }
export interface Tap { x: number; y: number; t: number }

// 图片居中显示；放大 scale 倍后，每个方向最多能平移多少才不露出边外。放大后仍放得下的方向为 0。
// The image is centred; how far it may pan on each axis at `scale` without showing past
// its edge. An axis that still fits after zooming gets 0.
export function panLimit(img: Size, view: Size, scale: number): { x: number; y: number } {
  return { x: Math.max(0, (img.w * scale - view.w) / 2), y: Math.max(0, (img.h * scale - view.h) / 2) }
}

export function clampPan(x: number, y: number, limit: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.max(-limit.x, Math.min(limit.x, x)), y: Math.max(-limit.y, Math.min(limit.y, y)) }
}

// 以中心为变换原点放大 scale 倍时，平移 (中心 − 点) × (scale − 1) 能让点到的那一点留在原处。
// With the centre as the transform origin, translating by (centre − point) × (scale − 1)
// keeps the tapped point where it was.
export function zoomPanAt(px: number, py: number, cx: number, cy: number, scale: number): { x: number; y: number } {
  return { x: (cx - px) * (scale - 1), y: (cy - py) * (scale - 1) }
}

export function isDoubleTap(prev: Tap | null, cur: Tap): boolean {
  return prev != null && cur.t - prev.t <= DOUBLE_TAP_MS && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= DOUBLE_TAP_PX
}
