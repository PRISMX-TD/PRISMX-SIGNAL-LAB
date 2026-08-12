// 判决幕的行情数据 / the verdict act's price data
//
// 四个判例的价格路径，定义在 SVG 坐标系（viewBox 1600×900）里，被两个渲染层
// 共用：MarketStory 的 SVG 墙直接用，LandingSpace 的 3D 判决碑经线性映射转成
// 世界坐标。单一数据源保证两层画的是同一份行情——后备与正主永远一致。
//
// The four cases' price paths, defined in SVG space (a 1600 by 900 viewBox) and
// shared by both render layers: MarketStory's SVG wall uses them directly and
// LandingSpace's 3D verdict stone maps them linearly into world units. One
// source of truth means both layers draw the same market - the fallback and the
// primary can never disagree.

export type Pt = [number, number]

export const TP_Y = 200
export const EN_Y = 420
export const SL_Y = 640
export const X0 = 340
export const XT = 1300

/* 确定性伪随机：这是固定的四个判例，不是每次刷新换一份行情；而且只有可复现
   的画面才能逐项核对。/ Deterministic PRNG: fixed case studies, not a fresh
   market per refresh, and only a reproducible frame can be verified. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/* 一段行情：随机游走 + 均值回归，后半程被拉向判定价位，最后一点强制触线。
   A mean-reverting walk pulled toward the verdict level over the back half,
   with the final point forced onto the line. */
function walk(seed: number, n: number, endY: number | null, endX = XT): Pt[] {
  const rnd = lcg(seed)
  const pts: Pt[] = [[X0, EN_Y]]
  let y = EN_Y
  for (let i = 1; i <= n; i++) {
    const x = X0 + (endX - X0) * (i / n)
    const k = i / n
    y += (rnd() - 0.5) * 150 - (y - EN_Y) * 0.12
    if (endY != null) y += (endY - y) * Math.max(0, (k - 0.55) / 0.45) ** 1.6 * 0.5
    y = Math.min(SL_Y - 30, Math.max(TP_Y + 30, y))
    pts.push([x, y])
  }
  if (endY != null) pts[pts.length - 1] = [endX, endY]
  return pts
}

/* 判例一/二：先碰止盈记赢、先碰止损记输。/ Cases 1 and 2: TP first, SL first. */
export const CASE_WIN: Pt[] = walk(4021, 34, TP_Y)
export const CASE_LOSS: Pt[] = walk(7919, 34, SL_Y)

/* 判例三：一根行情里两头都碰——锐利的 V 形尖刺先刺穿止损、立刻反手刺穿止盈，
   然后回到中性收尾。保守记为输。/ Case 3: both sides in one move - a sharp V
   pierces stop-loss then take-profit back to back. Conservatively a loss. */
export const CASE_BOTH: Pt[] = [
  ...walk(5477, 22, null, 1140),
  [1170, 540],
  [1198, SL_Y],
  [1232, TP_Y],
  [1268, 380],
  [1300, 430],
]

/* 判例四：数据中断。路径画到 x=780 戛然而止。/ Case 4: the outage. */
export const CASE_VOID: Pt[] = walk(9203, 15, null, 780)
export const VOID_END_Y = Math.round(CASE_VOID[CASE_VOID.length - 1][1])
