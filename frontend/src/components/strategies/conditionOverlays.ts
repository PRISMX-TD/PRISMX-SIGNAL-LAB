// 从策略自己的条件列表推导「图上能画哪些指标」。
//
// 这里刻意不做成一套通用指标面板（像图表页那样给 MA/EMA/布林/RSI/MACD 全套开关
// 与自定义周期）：回测图要回答的问题只有一个——这笔信号为什么在这里触发。画一条
// 与条件无关的 EMA99 只会让人以为触发跟它有关。所以叠加层的种类与参数全部取自
// 条件本身：条件里写的是 EMA20，图上画的就是 EMA20。
//
// Derive "which indicators can be drawn" from the strategy's own conditions.
//
// Deliberately not a general indicator panel (the charts page already has one,
// with MA/EMA/Bollinger/RSI/MACD toggles and custom periods): this chart answers
// exactly one question — why did this signal fire here. Drawing an EMA99 that no
// condition references would only suggest the trigger had something to do with
// it. So both the kinds of overlay and their parameters come from the conditions
// themselves: a condition on EMA20 draws EMA20.
import type { StrategyCondition } from './conditionTypes'

// 主图叠加（画在蜡烛上，与价格同一刻度）与副图（自己一格，刻度与价格无关）。
// 这个区分决定 lightweight-charts 的 pane 归属，不是纯展示分类。
// Overlays go on the price pane (same scale as the candles); panels get their own
// pane (their scale has nothing to do with price). The distinction decides pane
// assignment in lightweight-charts; it isn't a cosmetic grouping.
export type OverlayKind = 'ma' | 'boll' | 'donchian' | 'rsi' | 'macd'

export interface DerivedOverlay {
  // 同一种指标不同参数算两个独立叠加项（EMA20 与 EMA50 各一条可单独开关），
  // 所以 id 要把参数带进去。
  // The same indicator with different params is a separate overlay (EMA20 and
  // EMA50 toggle independently), so the id has to carry the params.
  id: string
  kind: OverlayKind
  // 画线用的参数，已从条件的 params 里取出并转成数字。
  // Drawing parameters, pulled out of the condition params and coerced to number.
  period: number
  // 布林带的标准差倍数 / RSI 的超买超卖线：只有对应 kind 会用到。
  // Bollinger's std-dev multiple / RSI's overbought-oversold levels; only the
  // matching kind reads these.
  mult?: number
  overbought?: number
  oversold?: number
  // MACD 的三个周期 / MACD's three periods
  fast?: number
  slow?: number
  signal?: number
  // 均线类型（SMA/EMA），只有 kind === 'ma' 有意义
  // MA type (SMA/EMA); only meaningful when kind === 'ma'
  maType?: 'SMA' | 'EMA'
  // 图例上显示的短标签，如 "EMA 20"、"BOLL 20×2"。不走 i18n：这些是指标记号，
  // 中英文写法相同。
  // The short legend label, e.g. "EMA 20", "BOLL 20×2". Not i18n'd: these are
  // indicator notations, identical in every locale.
  label: string
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

// ATR 不出现在这里：它是"波动大小"，既不是价格刻度上的一条线，也没有惯例的
// 独立子图画法，硬画一格只会占掉高度而不解释任何触发。
// ATR is absent: it measures volatility magnitude, is not a line on the price
// scale, and has no conventional sub-pane rendering — a pane for it would spend
// height without explaining any trigger.
export function deriveOverlays(conditions: StrategyCondition[]): DerivedOverlay[] {
  const out: DerivedOverlay[] = []
  const seen = new Set<string>()

  const push = (o: DerivedOverlay) => {
    // 去重：两条条件用同一根 EMA20（比如"上穿"和"在上方"）时只画一条线。
    // De-dupe: two conditions on the same EMA20 (say "crosses above" and "is
    // above") draw one line, not two on top of each other.
    if (seen.has(o.id)) return
    seen.add(o.id)
    out.push(o)
  }

  for (const c of conditions) {
    const p = c.params ?? {}
    switch (c.indicator) {
      case 'ma': {
        const period = num(p.period, 20)
        const maType = p.maType === 'SMA' ? 'SMA' : 'EMA'
        push({
          id: `ma:${maType}:${period}`,
          kind: 'ma',
          period,
          maType,
          label: `${maType} ${period}`,
        })
        break
      }
      case 'bollinger': {
        const period = num(p.period, 20)
        const mult = num(p.mult, 2)
        push({
          id: `boll:${period}:${mult}`,
          kind: 'boll',
          period,
          mult,
          label: `BOLL ${period}×${mult}`,
        })
        break
      }
      case 'donchian': {
        const period = num(p.period, 20)
        push({ id: `donchian:${period}`, kind: 'donchian', period, label: `DC ${period}` })
        break
      }
      case 'rsi': {
        const period = num(p.period, 14)
        // 阈值类用法带一个 level（做多侧，默认 30），斜率类用法没有 level。
        // 两条参考线画 level 与 100-level：后端的镜像用法就是把 level 换成
        // 100-level 来得到做空侧判定（见 conditions.py 的 mirror_level_flip），
        // 只画一条会让做空方向的标记看起来没有依据。
        // Threshold usages carry a `level` (long side, default 30); slope usages
        // have none. Two reference lines at level and 100-level: the backend's
        // mirrored usage derives the short-side verdict by replacing level with
        // 100-level (see mirror_level_flip in conditions.py), so drawing only one
        // would leave short-side markers looking unsupported.
        const level = num(p.level, 30)
        push({
          id: `rsi:${period}:${level}`,
          kind: 'rsi',
          period,
          oversold: Math.min(level, 100 - level),
          overbought: Math.max(level, 100 - level),
          label: `RSI ${period}`,
        })
        break
      }
      case 'macd': {
        const fast = num(p.fast, 12)
        const slow = num(p.slow, 26)
        const signal = num(p.signal, 9)
        push({
          id: `macd:${fast}:${slow}:${signal}`,
          kind: 'macd',
          period: slow,
          fast,
          slow,
          signal,
          label: `MACD ${fast},${slow},${signal}`,
        })
        break
      }
      default:
        break
    }
  }
  return out
}

// 叠加线的配色。与蜡烛的涨绿跌红、交易标记的绿/红/琥珀刻意错开：指标线撞上这三
// 种颜色会让人把它读成盈亏信息。
// Overlay colors, deliberately clear of the candles' green/red and the trade
// markers' green/red/amber: an indicator line in those colors reads as P&L
// information.
export const OVERLAY_COLORS = ['#38bdf8', '#a78bfa', '#22d3ee', '#f472b6', '#facc15', '#94a3b8']

export const overlayColor = (index: number) => OVERLAY_COLORS[index % OVERLAY_COLORS.length]
