// 图表类型 → K 线变换的适配层：引擎只认 runTransform，具体算法在 barTransforms.ts。
// Chart type → bar transform adapter: the engine only calls runTransform; the algorithms
// live in barTransforms.ts.
import type { Candle } from '../../api/types'
import type { ChartPrefs, ChartType } from './chartPrefs'
import { autoBoxSize, transformBars, type BoxSizeMode, type TransformKind, type XBar } from './barTransforms'

export type { TransformKind }

export function transformKindOf(t: ChartType): TransformKind {
  switch (t) {
    case 'heikinAshi': return 'heikinAshi'
    case 'renko': return 'renko'
    case 'lineBreak': return 'lineBreak'
    case 'kagi': return 'kagi'
    case 'pnf': return 'pointFigure'
    default: return 'none'
  }
}

// 偏好里的 0 = 自动（ATR 14），正数 = 固定价格单位。自动档只用**已收盘**的 K 线算 ATR：
// 形成中那根每跳都在变，用它算出来的格子大小跟着抖，整张砖形图每 300ms 重排一次。
// In prefs 0 means auto (ATR 14), a positive number a fixed price amount. Auto uses only
// *closed* bars: the forming bar changes every tick, and a box computed from it would jitter
// and reflow the whole chart every 300ms.
function fixedBox(v: number, src: Candle[]): BoxSizeMode {
  if (v > 0) return { type: 'fixed', size: v }
  const closed = src.length > 1 ? src.slice(0, -1) : src
  return { type: 'fixed', size: autoBoxSize(closed, { type: 'atr', length: 14 }) }
}

export function runTransform(kind: TransformKind, src: Candle[], tf?: ChartPrefs['transform']): XBar[] {
  if (kind === 'none') return src.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }))
  const t = tf ?? { renkoBox: 0, renkoWicks: false, lineBreak: 3, kagiReversal: 0, pnfBox: 0, pnfReversal: 3, pnfSource: 'close' as const }
  return transformBars(kind, src, {
    renko: kind === 'renko' ? { boxMode: fixedBox(t.renkoBox, src), wicks: t.renkoWicks, source: 'close' } : undefined,
    lineBreak: { lines: t.lineBreak },
    kagi: kind === 'kagi' ? { reversalMode: fixedBox(t.kagiReversal, src), source: 'close' } : undefined,
    pointFigure: kind === 'pointFigure' ? { boxMode: fixedBox(t.pnfBox, src), reversal: t.pnfReversal, source: t.pnfSource } : undefined,
  })
}
