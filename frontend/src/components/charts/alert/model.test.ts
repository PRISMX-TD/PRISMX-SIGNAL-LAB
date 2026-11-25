import { describe, expect, it } from 'vitest'
import type { Drawing } from '../draw/model'
import { ALERT_INDS, defaultMessage, drawTargets, priceLevels, sameGeometry, seg, serverInputs, serverIntervalOf, toIn } from './model'
import type { ChartAlert } from '../../../api/types'

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)
const dr = (over: Partial<Drawing>): Drawing => ({ id: 'd1', type: 'trend', pts: [{ t: 100, p: 10 }, { t: 200, p: 20 }], color: '#fff', ...over })

describe('chart alert model', () => {
  it('maps chart intervals to server intervals', () => {
    expect(serverIntervalOf('15')).toBe('15')
    expect(serverIntervalOf('30')).toBe('15')
    expect(serverIntervalOf('120')).toBe('60')
    expect(serverIntervalOf('480')).toBe('240')
    expect(serverIntervalOf('D')).toBe('D')
    expect(serverIntervalOf('W')).toBe('D')
    expect(serverIntervalOf('3M')).toBe('D')
  })

  it('orders segments by time and swaps the extension sides with them', () => {
    expect(seg({ t: 200, p: 20 }, { t: 100, p: 10 }, true, false)).toEqual({ t1: 100, p1: 10, t2: 200, p2: 20, extL: false, extR: true })
  })

  it('derives drawing targets', () => {
    expect(drawTargets(dr({ type: 'ray' }))[0].lines[0]).toMatchObject({ extL: false, extR: true })
    expect(drawTargets(dr({ type: 'hline', pts: [{ t: 5, p: 7 }] }))[0].lines[0]).toEqual({ t1: 5, p1: 7, t2: 5, p2: 7, extL: true, extR: true })
    const ch = drawTargets(dr({ type: 'channel', pts: [{ t: 100, p: 10 }, { t: 200, p: 20 }, { t: 100, p: 15 }] }))
    expect(ch.map((x) => x.part)).toEqual(['band', 'upper', 'lower', 'mid'])
    expect(ch[0].lines[0].p1).toBe(15)
    expect(ch[0].lines[1].p1).toBe(10)
    const box = drawTargets(dr({ type: 'rect', pts: [{ t: 200, p: 30 }, { t: 100, p: 10 }] }))
    expect(box[0].lines).toEqual([
      { t1: 100, p1: 30, t2: 200, p2: 30, extL: false, extR: false },
      { t1: 100, p1: 10, t2: 200, p2: 10, extL: false, extR: false },
    ])
    const fib = drawTargets(dr({ type: 'fib', levels: [{ v: 0, on: true }, { v: 0.5, on: true }, { v: 1, on: false }] }))
    expect(fib.map((x) => [x.part, x.lines[0].p1])).toEqual([['lv:0', 20], ['lv:0.5', 15]])
    expect(drawTargets(dr({ type: 'long', pts: [{ t: 1, p: 10 }, { t: 2, p: 12 }, { t: 1, p: 9 }] })).map((x) => x.part)).toEqual(['target', 'stop', 'entry'])
    expect(drawTargets(dr({ type: 'brush' }))).toEqual([])
  })

  it('compares geometry loosely', () => {
    const a = [{ t1: 1, p1: 2.000000001, t2: 3, p2: 4, extL: false, extR: true }]
    expect(sameGeometry(a, [{ t1: 1, p1: 2, t2: 3, p2: 4, extL: false, extR: true }])).toBe(true)
    expect(sameGeometry(a, [{ t1: 1, p1: 2.1, t2: 3, p2: 4, extL: false, extR: true }])).toBe(false)
  })

  it('keeps only the inputs the server knows', () => {
    expect(serverInputs('ema', { len: 20, src: 'close', offset: 0, color: 'x' })).toEqual({ len: 20, src: 'close', offset: 0 })
    expect(Object.keys(ALERT_INDS)).toContain('rsi')
  })

  it('builds default messages', () => {
    expect(defaultMessage({ symbol: 'XAUUSD', kind: 'price', cond: 'crossUp', spec: { level: 2650 } }, 2, t)).toBe('XAUUSD charts.alert.cond.crossUp 2650.00')
    expect(defaultMessage({ symbol: 'XAUUSD', kind: 'indicator', cond: 'gt', spec: { ind: { type: 'rsi', inputs: { len: 14 }, plot: 'rsi' }, target: { kind: 'value', v: 70 } } }, 2, t))
      .toBe('XAUUSD RSI 14 charts.alert.cond.gt 70')
  })

  it('round-trips stored alerts and lists price levels', () => {
    const a: ChartAlert = {
      id: 'a1', symbol: 'XAUUSD', kind: 'price', cond: 'enter', spec: { lo: 1, hi: 2 }, trigger: 'once', interval: '15', message: 'm',
      push: true, email: false, expiresAt: null, drawingId: null, status: 'paused', fireCount: 0, lastFiredAt: null, createdAt: '', updatedAt: '',
    }
    expect(toIn(a).active).toBe(false)
    expect(priceLevels(a)).toEqual([{ key: 'lo', price: 1 }, { key: 'hi', price: 2 }])
    expect(priceLevels({ ...a, cond: 'moveUp' })).toEqual([])
  })
})
