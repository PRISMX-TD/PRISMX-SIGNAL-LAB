import { describe, expect, it } from 'vitest'
import { ExecPrimitive } from './ExecutionMarkers'
import { groupExecutions, type Execution } from './tradeMath'

// 画一遍，收集写到画布上的文字 / draw once and collect the text written to the canvas
function labels(execs: Execution[], barSpacing = 10): string[] {
  const prim = new ExecPrimitive()
  const chart = { timeScale: () => ({ options: () => ({ barSpacing }), timeToCoordinate: () => 100 }) }
  const series = { priceToCoordinate: () => 200 }
  prim.attached({ chart, series, requestUpdate: () => {} } as never)
  prim.fills = (n) => `${n} 笔`
  prim.groups = groupExecutions(execs, [0, 60, 120])
  const out: string[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (o, k) => (k === 'fillText' ? (s: string) => out.push(s) : k in o ? o[k as string] : () => {}),
    set: (o, k, v) => { o[k as string] = v; return true },
  })
  ;(prim as unknown as { _draw: (c: unknown, w: number, h: number) => void })._draw(ctx, 800, 400)
  return out
}

const fill = (t: number, volume: number, side: 'BUY' | 'SELL' = 'SELL'): Execution => ({ t, price: 2700, side, kind: 'close', volume })

describe('ExecPrimitive labels', () => {
  it('single fill shows just its lots', () => {
    expect(labels([fill(60, 0.05)])).toEqual(['0.05'])
  })

  it('merged fills show the total lots and the fill count, not lots×count', () => {
    expect(labels([fill(60, 0.05), fill(70, 0.05)])).toEqual(['0.1 · 2 笔'])
  })

  it('narrow bars draw no text', () => {
    expect(labels([fill(60, 0.05), fill(70, 0.05)], 5)).toEqual([])
  })
})
