// 判定幕的行情数据 / the verdict act's market data
//
// 四段 K 线序列，价格空间与第一幕手机屏里那条 XAUUSD 信号完全一致：
// 入场 3412.80 / 止损 3398.20 / 止盈 3445.60（盈亏比 1:2.26）。判定幕重演的
// 就是观众刚在手机里见过的那条信号——四种可能的结局，各对应一条判定规则。
// 数据确定性生成：这是四个固定判例，不是每次刷新换一份行情，而且只有可复现
// 的画面才能逐项核对。
//
// Four candlestick series in the exact price space of the XAUUSD signal shown
// on the phone in act I: entry 3412.80, stop 3398.20, target 3445.60 (1:2.26).
// The verdict act replays the very signal the viewer just saw, under its four
// possible endings - one per judgment rule. Deterministic: fixed case studies,
// not a fresh market per refresh, and only a reproducible frame verifies.

export interface Candle {
  o: number
  h: number
  l: number
  c: number
}

export const P_ENTRY = 3412.8
export const P_SL = 3398.2
export const P_TP = 3445.6

export type CaseKind = 'win' | 'loss' | 'both' | 'void'

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/* 一段行情：从入场价出发的随机游走 + 均值回归，后半程被拉向结局价位，最后
   一根强制触线。影线幅度独立于实体，K 线才有真实的「毛刺」。
   A walk from entry with mean reversion, pulled toward the ending level over
   the back half, final candle forced onto the line. Wicks are independent of
   bodies so the candles carry believable texture. */
function gen(seed: number, n: number, kind: CaseKind): Candle[] {
  const rnd = lcg(seed)
  const out: Candle[] = []
  let c = P_ENTRY
  const target = kind === 'win' ? P_TP : kind === 'loss' ? P_SL : P_ENTRY
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 0
    const o = c
    let step = (rnd() - 0.5) * 7.5 - (c - P_ENTRY) * 0.1
    if (kind !== 'void') step += (target - c) * Math.max(0, (k - 0.5) / 0.5) ** 1.7 * 0.42
    c = Math.min(P_TP - 2.4, Math.max(P_SL + 1.6, o + step))
    const h = Math.max(o, c) + rnd() * 2.6
    const l = Math.min(o, c) - rnd() * 2.6
    out.push({ o, h, l, c })
  }
  const last = out[n - 1]
  if (kind === 'win') {
    // 收在止盈之下、影线刺穿止盈：判定看的是「触及」，不是收盘。
    // Closing under TP with the wick through it: the rule reads touches, not closes.
    last.c = P_TP - 1.1
    last.h = P_TP + 0.7
  } else if (kind === 'loss') {
    last.c = P_SL + 0.9
    last.l = P_SL - 0.6
  } else if (kind === 'both') {
    // 同一根 K 线两头都碰：一根巨大振幅的长针，上下都刺穿。
    // Both sides inside one candle: one huge-range bar piercing both levels.
    last.o = P_ENTRY + 3
    last.c = P_ENTRY - 4.5
    last.h = P_TP + 0.8
    last.l = P_SL - 0.9
  }
  return out
}

export const CASES: { kind: CaseKind; candles: Candle[] }[] = [
  { kind: 'win', candles: gen(4021, 24, 'win') },
  { kind: 'loss', candles: gen(7919, 24, 'loss') },
  { kind: 'both', candles: gen(5477, 24, 'both') },
  /* 中断判例只走到一半：后面没有数据，正是这条规则要说的事。
     The outage case only runs halfway - there is no data after, which is the
     rule's whole point. */
  { kind: 'void', candles: gen(9203, 13, 'void') },
]
