import { describe, it, expect } from 'vitest'
import { reconnectDelay, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './reconnectBackoff'

describe('reconnectDelay', () => {
  it('首次重连约 300ms（抖动 ±50%）/ first retry is ~300ms with ±50% jitter', () => {
    expect(reconnectDelay(0, 0.5)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelay(0, 0)).toBe(150)
    expect(reconnectDelay(0, 0.999999)).toBeLessThanOrEqual(450)
    expect(reconnectDelay(0, 0.999999)).toBeGreaterThan(400)
  })
  it('连续失败按 2 倍退避 / doubles on each consecutive failure', () => {
    expect(reconnectDelay(1, 0.5)).toBe(600)
    expect(reconnectDelay(2, 0.5)).toBe(1200)
    expect(reconnectDelay(3, 0.5)).toBe(2400)
  })
  it('封顶 10 秒，抖动之后也不超过 / capped at 10s, jitter included', () => {
    expect(reconnectDelay(10, 0.5)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelay(10, 0.999999)).toBe(RECONNECT_MAX_MS)
    expect(reconnectDelay(10, 0)).toBe(RECONNECT_MAX_MS / 2)
    expect(reconnectDelay(5000, 0.9)).toBe(RECONNECT_MAX_MS)
  })
  it('负数 / 小数 attempt 当 0 处理 / negative or fractional attempts clamp', () => {
    expect(reconnectDelay(-3, 0.5)).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelay(1.7, 0.5)).toBe(600)
  })
  it('默认用 Math.random 且落在区间内 / default rand stays in range', () => {
    for (let i = 0; i < 50; i++) {
      const d = reconnectDelay(0)
      expect(d).toBeGreaterThanOrEqual(150)
      expect(d).toBeLessThanOrEqual(450)
    }
  })
})
