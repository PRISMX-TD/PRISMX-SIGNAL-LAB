// 灯箱放大几何：平移上限、夹紧、双击点留在手指下、双击判定。
// Lightbox zoom geometry: pan limit, clamping, the tapped point staying put, double-tap.
import { describe, expect, it } from 'vitest'
import { clampPan, isDoubleTap, panLimit, zoomPanAt } from './lightboxZoom'

describe('panLimit', () => {
  it('allows panning on the axes that overflow after zooming', () => {
    // 375×812 屏，图 327×600，放大 2 倍后 654×1200 / a 327×600 image on 375×812, 654×1200 at 2×
    expect(panLimit({ w: 327, h: 600 }, { w: 375, h: 812 }, 2)).toEqual({ x: 139.5, y: 194 })
  })
  it('keeps an axis centred when it still fits', () => {
    expect(panLimit({ w: 100, h: 600 }, { w: 375, h: 812 }, 2)).toEqual({ x: 0, y: 194 })
  })
})

describe('clampPan', () => {
  it('clamps each axis to plus or minus its limit', () => {
    expect(clampPan(200, -300, { x: 139.5, y: 194 })).toEqual({ x: 139.5, y: -194 })
    expect(clampPan(50, 60, { x: 139.5, y: 194 })).toEqual({ x: 50, y: 60 })
  })
  it('pins an axis with no room to 0', () => {
    const p = clampPan(-50, 30, { x: 0, y: 194 })
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBe(30)
  })
})

describe('zoomPanAt', () => {
  it('keeps the tapped point under the finger', () => {
    // 点在中心右下 (40, 100)：放大 2 倍后图往左上移同样的量 / tapped 40 right, 100 below centre
    expect(zoomPanAt(227.5, 506, 187.5, 406, 2)).toEqual({ x: -40, y: -100 })
    expect(zoomPanAt(187.5, 406, 187.5, 406, 2)).toEqual({ x: 0, y: 0 })
  })
})

describe('isDoubleTap', () => {
  it('needs two taps within 300ms and 24px', () => {
    const a = { x: 100, y: 100, t: 1000 }
    expect(isDoubleTap(null, a)).toBe(false)
    expect(isDoubleTap(a, { x: 110, y: 105, t: 1250 })).toBe(true)
    expect(isDoubleTap(a, { x: 110, y: 105, t: 1301 })).toBe(false)
    expect(isDoubleTap(a, { x: 130, y: 100, t: 1100 })).toBe(false)
  })
})
