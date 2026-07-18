// 自定义策略页：模板选参数 → 回测 → 启用 → 触发个人信号 → 一键下单。
// 只有触发这个用户自己的信号（strategy_signals 表，与全站信号表完全独立），
// 一键下单复用图表页同款的手动下单弹窗（ChartOrderModal + placeManualOrder），
// 不经过 signalId，没有任何 Order 相关的后端改动。
//
// Custom strategies page: pick a template, tune it, backtest, enable it, get
// personal signals on trigger, one-click order. Fires only this user's own
// signals (the strategy_signals table, fully separate from the shared
// signals table); one-click order reuses the same manual-order modal as the
// charts page (ChartOrderModal + placeManualOrder) — no signalId involved,
// no Order-side backend changes.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { createChart, ColorType, CandlestickSeries, LineSeries, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts'
import { useAuth } from '../store/auth'
import { useLive, useQuotes } from '../store/live'
import { strategyApi } from '../api/client'
import { displaySymbol, fmtDate, fmtTime, localizeApiError } from '../api/utils'
import type {
  StrategyBacktestResult,
  StrategyBacktestTrade,
  StrategyParamSpec,
  StrategySignal,
  StrategyTemplateKey,
  StrategyTemplateSchemas,
  UserStrategy,
} from '../api/types'
import ChartOrderModal from '../components/ChartOrderModal'
import ConfirmModal from '../components/ConfirmModal'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'

const INTERVALS = [
  { code: '1', label: '1m' },
  { code: '5', label: '5m' },
  { code: '15', label: '15m' },
  { code: '60', label: '1H' },
  { code: '240', label: '4H' },
  { code: 'D', label: '1D' },
] as const

const TEMPLATE_KEYS: StrategyTemplateKey[] = [
  'ma_cross', 'rsi_reversal', 'bollinger_reversion',
  'macd_cross', 'ma_pullback', 'bollinger_breakout', 'rsi_momentum',
  'donchian_breakout', 'momentum_breakout', 'trend_rsi_filter',
]
const TEMPLATE_LABEL_KEYS: Record<StrategyTemplateKey, string> = {
  ma_cross: 'strategy.templateMaCross',
  rsi_reversal: 'strategy.templateRsiReversal',
  bollinger_reversion: 'strategy.templateBollingerReversion',
  macd_cross: 'strategy.templateMacdCross',
  ma_pullback: 'strategy.templateMaPullback',
  bollinger_breakout: 'strategy.templateBollingerBreakout',
  rsi_momentum: 'strategy.templateRsiMomentum',
  donchian_breakout: 'strategy.templateDonchianBreakout',
  momentum_breakout: 'strategy.templateMomentumBreakout',
  trend_rsi_filter: 'strategy.templateTrendRsiFilter',
}
const TEMPLATE_DESC_KEYS: Record<StrategyTemplateKey, string> = {
  ma_cross: 'strategy.templateMaCrossDesc',
  rsi_reversal: 'strategy.templateRsiReversalDesc',
  bollinger_reversion: 'strategy.templateBollingerReversionDesc',
  macd_cross: 'strategy.templateMacdCrossDesc',
  ma_pullback: 'strategy.templateMaPullbackDesc',
  bollinger_breakout: 'strategy.templateBollingerBreakoutDesc',
  rsi_momentum: 'strategy.templateRsiMomentumDesc',
  donchian_breakout: 'strategy.templateDonchianBreakoutDesc',
  momentum_breakout: 'strategy.templateMomentumBreakoutDesc',
  trend_rsi_filter: 'strategy.templateTrendRsiFilterDesc',
}
const PARAM_LABEL_KEYS: Record<string, string> = {
  maType: 'strategy.maType',
  fastPeriod: 'strategy.fastPeriod',
  slowPeriod: 'strategy.slowPeriod',
  direction: 'strategy.direction',
  period: 'strategy.period',
  oversold: 'strategy.oversold',
  overbought: 'strategy.overbought',
  mult: 'strategy.bollMult',
  signalPeriod: 'strategy.signalPeriod',
  touchTolerancePct: 'strategy.touchTolerancePct',
  lookback: 'strategy.lookback',
  thresholdPct: 'strategy.thresholdPct',
  trendPeriod: 'strategy.trendPeriod',
  rsiPeriod: 'strategy.rsiPeriod',
}
const ENUM_OPTION_LABEL_KEYS: Record<string, Record<string, string>> = {
  maType: { SMA: 'strategy.maTypeSma', EMA: 'strategy.maTypeEma' },
  direction: { both: 'strategy.directionBoth', long: 'strategy.directionLong', short: 'strategy.directionShort' },
}

const CURVE_W = 600
const CURVE_H = 180

function fmtMoney(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function defaultParams(schema: Record<string, StrategyParamSpec>): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [k, spec] of Object.entries(schema)) out[k] = spec.default
  return out
}

// 净值曲线：与 SimulatorPage 同款纯 SVG 实现（该页无导出可复用组件，逻辑简单，
// 直接照抄比额外抽公共组件更省事）。
// Equity curve: same plain-SVG approach as SimulatorPage (that page exports
// nothing reusable; the logic is simple enough that copying it here beats
// extracting a shared component for one more caller).
function EquityCurve({ points, capital }: { points: Array<{ equity: number }>; capital: number }) {
  if (points.length < 2) return null
  const values = [...points.map((p) => p.equity), capital]
  const lo = Math.min(...values) * 0.98
  const hi = Math.max(...values) * 1.02
  const span = hi - lo || 1
  const y = (v: number) => CURVE_H - ((v - lo) / span) * CURVE_H
  const x = (i: number) => (i * CURVE_W) / (points.length - 1)
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ')
  const toneClass = points[points.length - 1].equity >= capital ? 'text-up' : 'text-down'
  const baselineY = y(capital)
  return (
    <div className={toneClass}>
      <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} className="w-full" preserveAspectRatio="none" role="img">
        <line x1="0" y1={baselineY} x2={CURVE_W} y2={baselineY} stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="4 4" className="text-slate-400" />
        <polyline fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={line} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}

const UP_COLOR = '#22c55e'
const DOWN_COLOR = '#ef4444'

// 回测 K 线图：真实蜡烛图 + 每笔交易的入场/出场标记 + 一条连接两点的细线，
// 这样用户看到的不只是一条抽象的净值曲线，而是"这笔单在当时的行情里到底
// 长什么样"。复用行情图表页已经在用的 lightweight-charts（v5），marker 用
// createSeriesMarkers 插件 API，连线用每笔交易各一条只有两个点的 LineSeries。
//
// Backtest candlestick chart: real candles + an entry/exit marker for every
// trade + a thin line connecting the two, so the user sees not just an
// abstract equity curve but what the market actually looked like when each
// trade fired. Reuses the same lightweight-charts (v5) already used by the
// charts page; markers go through the createSeriesMarkers plugin API, and
// each trade gets its own 2-point LineSeries for the connecting line.
function BacktestChart({ bars, trades }: { bars: StrategyBacktestResult['bars']; trades: StrategyBacktestTrade[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || bars.length === 0) return

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(139, 70, 255, 0.08)' },
        horzLines: { color: 'rgba(139, 70, 255, 0.08)' },
      },
      rightPriceScale: { borderColor: 'rgba(139, 70, 255, 0.15)' },
      timeScale: { borderColor: 'rgba(139, 70, 255, 0.15)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      // 故意先建成一个明显偏小的占位尺寸，而不是直接传 el.clientWidth——见下方
      // resize 那段注释的完整解释：真实根因是 lightweight-charts 在这类环境下
      // 如果 resize() 传的目标尺寸和创建时的尺寸"一样"，会被当成没有变化直接
      // 跳过，canvas 位图分辨率永远不会被真正刷新到位；创建时故意留一个必然
      // 不同的占位尺寸，后面第一次 resize() 才会被库判定为"真的变了"而生效。
      // Deliberately create at an obviously-too-small placeholder size instead
      // of el.clientWidth directly — see the full explanation in the resize
      // comment below. The real root cause: in this rendering environment,
      // lightweight-charts treats a resize() call whose target size matches
      // the size it was created with as a no-op and skips it, so the canvas
      // bitmap resolution never actually gets painted. Leaving a deliberately
      // different placeholder size at creation guarantees the first real
      // resize() call afterward is seen as an actual change and takes effect.
      width: 2,
      height: 2,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, borderVisible: false,
    })
    series.setData(bars.map((b) => ({ time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })))

    const markers = trades.flatMap((t) => {
      const win = t.result === 'HIT_TP'
      return [
        {
          time: t.entryTime as UTCTimestamp,
          position: (t.side === 'BUY' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
          shape: (t.side === 'BUY' ? 'arrowUp' : 'arrowDown') as 'arrowUp' | 'arrowDown',
          color: t.side === 'BUY' ? UP_COLOR : DOWN_COLOR,
        },
        {
          time: t.exitTime as UTCTimestamp,
          position: (t.side === 'BUY' ? 'aboveBar' : 'belowBar') as 'belowBar' | 'aboveBar',
          shape: 'circle' as const,
          color: win ? UP_COLOR : DOWN_COLOR,
        },
      ]
    })
    createSeriesMarkers(series, markers)

    // 每笔交易一条独立的两点连线,标出"从哪进、到哪出" / one 2-point line
    // series per trade, tracing "where it entered, where it exited"
    const tradeLines = trades.map((t) => {
      const line = chart.addSeries(LineSeries, {
        color: t.result === 'HIT_TP' ? 'rgba(34, 197, 94, 0.55)' : 'rgba(239, 68, 68, 0.55)',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      line.setData([
        { time: t.entryTime as UTCTimestamp, value: t.entryPrice },
        { time: t.exitTime as UTCTimestamp, value: t.exitPrice },
      ])
      return line
    })

    chart.timeScale().fitContent()

    // 立即把占位尺寸纠正成容器的真实尺寸。这一步必须存在——见上方 createChart
    // 里 width:2/height:2 占位的注释：lightweight-charts 在这类环境下，如果
    // resize() 的目标尺寸和"创建时的尺寸"一样会被当成没有变化直接跳过（canvas
    // 位图分辨率卡在浏览器默认的 300x150，即使容器自身的 CSS 尺寸完全正确）。
    // 用占位尺寸打底后，这里第一次 resize() 到真实宽高必然与创建时不同，
    // 会被库判定为"真的变了"而真正生效——手测反复验证过，同样的调用换成和
    // 创建时一样的尺寸就会被吞掉。之后的 ResizeObserver 只负责窗口真的发生
    // 尺寸变化时跟着调整，与 ChartsPage.tsx 同一套模式。全程用 chart.resize()
    // 而不是 chart.applyOptions()——后者只改 CSS 尺寸，不会刷新 canvas 位图。
    // Immediately correct the placeholder size to the container's real size.
    // This step is required — see the width:2/height:2 comment on createChart
    // above: in this rendering environment, lightweight-charts treats a
    // resize() call whose target size matches the size it was created with as
    // a no-op and skips it (the canvas bitmap resolution stays stuck at the
    // browser's default 300x150 even though the container's own CSS size is
    // fully correct). Starting from a placeholder size guarantees this first
    // resize() to the real dimensions is different from the creation size and
    // is genuinely applied — verified by repeated manual testing, where the
    // identical call with the creation-time size was silently swallowed. The
    // ResizeObserver below only needs to handle genuine later window resizes,
    // same pattern as ChartsPage.tsx. Everywhere uses chart.resize(), never
    // chart.applyOptions() — the latter only updates the CSS size, never the
    // canvas bitmap.
    // "打两下"：先 resize 到一个必然不同的临时值，再 resize 到真正目标值——
    // 不仅创建时的占位尺寸需要这样纠正，后续 ResizeObserver 报告的每一次真实
    // 尺寸变化（比如手机端从桌面宽度变窄）同样会撞上"目标尺寸和当前内部记录
    // 的尺寸一样就判定没变化、直接跳过"这个坑（哪怕这次真的是一次不同的变化，
    // 内部记录的状态有时也没能正确同步，手测时切到手机宽度就复现过一次）。
    // A "double kick": resize to a deliberately different transient value
    // first, then to the real target — not just the placeholder-size
    // correction at creation needs this; every later genuine size change
    // reported by the ResizeObserver (e.g. switching to a narrower mobile
    // width) can hit the same "target matches what the library thinks is
    // already the current size, so it's treated as a no-op" pitfall, because
    // its internal size bookkeeping doesn't always stay in sync — reproduced
    // once during manual testing by switching to the mobile viewport.
    const forceResize = (width: number, height: number) => {
      chart.resize(width - 1, height, true)
      chart.resize(width, height, true)
    }
    if (el.clientWidth > 0) forceResize(el.clientWidth, 320)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) forceResize(width, height)
    })
    ro.observe(el)
    // 双保险：ResizeObserver 在这类环境下偶尔连续两次都不触发（同一个页面里
    // 手测时，切到手机宽度那次生效了，切回桌面宽度那次又没触发），窗口级的
    // resize 事件作为独立的第二条路径兜底，两者中任何一个触发都够。
    // Belt-and-braces: the ResizeObserver occasionally misses two transitions
    // in a row in this kind of environment (manual testing: it caught the
    // switch to mobile width but missed the switch back to desktop width in
    // the same session) — a window-level resize listener is an independent
    // second path; either one firing is enough.
    const onWindowResize = () => {
      if (el.clientWidth > 0) forceResize(el.clientWidth, el.clientHeight || 320)
    }
    window.addEventListener('resize', onWindowResize)
    return () => {
      window.removeEventListener('resize', onWindowResize)
      ro.disconnect()
      tradeLines.forEach((l) => chart.removeSeries(l))
      chart.remove()
    }
  }, [bars, trades])

  return <div ref={containerRef} className="h-[320px] w-full" />
}

// 数字输入框：自己维护一份文本缓冲，只在失焦（或回车）时才解析+夹紧+回传。
// 沿用回放模拟器的 CapitalField 同款修法（见产品需求文档 6.18 节）——每敲一个
// 字符就立刻解析夹紧，会让用户清空重打或改动带下限的字段时被强制弹回旧值，
// 根本删不掉、也打不进新数字。这里所有可调参数（模板参数、止损止盈比例、
// 回测本金）统一用这一个组件，不再各自手写一份 parseInt/parseFloat。
// Number input: keeps its own text buffer, parsing/clamping/propagating only
// on blur (or Enter). Mirrors the replay simulator's CapitalField fix —
// parsing on every keystroke bounces the user back to the old value mid-edit,
// making it impossible to clear the field or type past a lower bound. Every
// tunable number here (template params, SL/TP ratios, backtest capital)
// shares this one component instead of each hand-rolling parseInt/parseFloat.
function NumberField({
  label, value, onChange, min, max, isFloat,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  isFloat: boolean
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  const commit = () => {
    const n = isFloat ? parseFloat(text) : parseInt(text, 10)
    const clamped = !Number.isFinite(n) ? value : Math.min(max, Math.max(min, n))
    setText(String(clamped))
    if (clamped !== value) onChange(clamped)
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      <input
        type="number"
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
    </label>
  )
}

interface Draft {
  id?: string
  template: StrategyTemplateKey
  symbol: string
  interval: string
  params: Record<string, string | number>
  stopLossPct: number
  takeProfitR: number
}

function StrategyBuilder({
  draft, templates, activeSymbols, onChange, onCancel, onSaved,
}: {
  draft: Draft
  templates: StrategyTemplateSchemas
  activeSymbols: string[]
  onChange: (d: Draft) => void
  onCancel: () => void
  onSaved: (s: UserStrategy) => void
}) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [btDays, setBtDays] = useState(90)
  const [btRisk, setBtRisk] = useState(1.0)
  const [btCapital, setBtCapital] = useState(10000)
  const [btMode, setBtMode] = useState<'compound' | 'flat'>('compound')
  const [backtesting, setBacktesting] = useState(false)
  const [backtestError, setBacktestError] = useState<string | null>(null)
  const [result, setResult] = useState<StrategyBacktestResult | null>(null)
  const [tradePage, setTradePage] = useState(0)
  const TRADE_PAGE_SIZE = 20
  // 逐单明细按新到旧展示；后端按回放顺序（旧到新）返回，这里单独倒一份供表格用，
  // 图表标记仍然吃原始顺序（时间正序），互不影响。
  // The trade table shows newest first; the backend returns replay order
  // (oldest first). Reverse a separate copy for the table only — the chart's
  // markers still consume the original ascending-time order.
  const tradesDesc = result ? [...result.trades].reverse() : []

  const schema = templates[draft.template]

  const switchTemplate = (template: StrategyTemplateKey) => {
    onChange({ ...draft, template, params: defaultParams(templates[template]) })
    setResult(null)
  }

  const setParam = (key: string, value: string | number) => {
    onChange({ ...draft, params: { ...draft.params, [key]: value } })
  }

  const runBacktest = async () => {
    setBacktesting(true)
    setBacktestError(null)
    try {
      const res = await strategyApi.backtest({
        template: draft.template, symbol: draft.symbol, interval: draft.interval, params: draft.params,
        stopLossPct: draft.stopLossPct, takeProfitR: draft.takeProfitR,
        days: btDays, riskPct: btRisk, capital: btCapital, mode: btMode,
      })
      setResult(res)
      setTradePage(0)
    } catch (e) {
      setBacktestError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
    } finally {
      setBacktesting(false)
    }
  }

  const save = async (enabled: boolean) => {
    setSaving(true)
    setSaveError(null)
    try {
      let saved: UserStrategy
      if (draft.id) {
        saved = await strategyApi.update(draft.id, {
          params: draft.params, stopLossPct: draft.stopLossPct, takeProfitR: draft.takeProfitR, enabled,
        })
      } else {
        saved = await strategyApi.create({
          template: draft.template, symbol: draft.symbol, interval: draft.interval,
          params: draft.params, stopLossPct: draft.stopLossPct, takeProfitR: draft.takeProfitR,
        })
        if (enabled) saved = await strategyApi.update(saved.id, { enabled: true })
      }
      onSaved(saved)
    } catch (e) {
      setSaveError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const segBtn = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
      active ? 'border-prism-500/50 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
    }`

  return (
    <section className="glass mb-5 p-5">
      {/* 模板选择：随时可切换,切换会重置该模板的参数为默认值 */}
      <div className="mb-4">
        <span className="mb-1.5 block text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.template')}</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {TEMPLATE_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => switchTemplate(key)}
              className={`rounded-lg border p-3 text-left transition ${
                draft.template === key ? 'border-prism-500/50 bg-prism-600/10' : 'border-white/10 bg-white/[0.02] hover:border-white/20'
              }`}
            >
              <div className="text-sm font-semibold text-slate-100">{t(TEMPLATE_LABEL_KEYS[key])}</div>
              <div className="mt-1 text-xs leading-relaxed text-slate-500">{t(TEMPLATE_DESC_KEYS[key])}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.symbol')}</span>
          <select className="input" value={draft.symbol} onChange={(e) => onChange({ ...draft, symbol: e.target.value })}>
            {activeSymbols.map((s) => (
              <option key={s} value={s}>{displaySymbol(s)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.interval')}</span>
          <div className="flex flex-wrap gap-2">
            {INTERVALS.map((iv) => (
              <button key={iv.code} onClick={() => onChange({ ...draft, interval: iv.code })} className={segBtn(draft.interval === iv.code)}>
                {iv.label}
              </button>
            ))}
          </div>
        </label>
      </div>

      {/* 模板专属参数：完全按后端模板 schema 动态渲染,不写死字段列表 */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Object.entries(schema).map(([key, spec]) => (
          spec.type === 'enum' ? (
            <div key={key} className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">{t(PARAM_LABEL_KEYS[key] ?? key)}</span>
              <div className="flex flex-wrap gap-2">
                {spec.options.map((opt) => (
                  <button key={opt} onClick={() => setParam(key, opt)} className={segBtn(draft.params[key] === opt)}>
                    {t(ENUM_OPTION_LABEL_KEYS[key]?.[opt] ?? opt)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <NumberField
              key={key}
              label={t(PARAM_LABEL_KEYS[key] ?? key)}
              value={typeof draft.params[key] === 'number' ? draft.params[key] as number : spec.default as number}
              min={spec.min}
              max={spec.max}
              isFloat={spec.type === 'float'}
              onChange={(v) => setParam(key, v)}
            />
          )
        ))}
        <NumberField label={t('strategy.stopLossPct')} value={draft.stopLossPct} min={0.1} max={10} isFloat
          onChange={(v) => onChange({ ...draft, stopLossPct: v })} />
        <NumberField label={t('strategy.takeProfitR')} value={draft.takeProfitR} min={0.5} max={10} isFloat
          onChange={(v) => onChange({ ...draft, takeProfitR: v })} />
      </div>

      {/* 回测参数与结果 */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.range')}</span>
            <div className="flex flex-wrap gap-2">
              {[30, 90, 180, 365].map((d) => (
                <button key={d} onClick={() => setBtDays(d)} className={segBtn(btDays === d)}>{d}</button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.risk')} · {btRisk.toFixed(1)}%</span>
            <input type="range" min={0.1} max={3} step={0.1} value={btRisk} onChange={(e) => setBtRisk(parseFloat(e.target.value))} className="w-32 accent-prism-500" />
          </label>
          <div className="w-32">
            <NumberField label={t('simulator.capital')} value={btCapital} min={1} max={1e9} isFloat={false} onChange={setBtCapital} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.mode')}</span>
            <div className="flex gap-2">
              <button onClick={() => setBtMode('compound')} className={segBtn(btMode === 'compound')}>{t('simulator.modeCompound')}</button>
              <button onClick={() => setBtMode('flat')} className={segBtn(btMode === 'flat')}>{t('simulator.modeFlat')}</button>
            </div>
          </div>
          <button onClick={runBacktest} disabled={backtesting} className="btn-primary ml-auto px-5 py-2 text-sm disabled:opacity-40">
            {backtesting ? t('strategy.backtesting') : t('strategy.runBacktest')}
          </button>
        </div>

        {backtestError && <p className="mt-3 text-sm text-down">{backtestError}</p>}

        {result?.insufficientData && (
          <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">{t('strategy.insufficientData')}</p>
        )}

        {result && !result.insufficientData && (
          <div className="mt-5 border-t border-white/10 pt-4">
            <h4 className="mb-3 text-sm font-semibold text-slate-200">{t('strategy.resultsTitle')}</h4>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.finalEquity')}</div>
                <div className="num mt-1 text-lg font-bold text-slate-100">${fmtMoney(result.summary.finalEquity)}</div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.returnPct')}</div>
                <div className={`num mt-1 text-lg font-bold ${result.summary.returnPct >= 0 ? 'text-up' : 'text-down'}`}>
                  {result.summary.returnPct >= 0 ? '+' : ''}{result.summary.returnPct.toFixed(2)}%
                </div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.maxDrawdown')}</div>
                <div className="num mt-1 text-lg font-bold text-down">-{result.summary.maxDrawdownPct.toFixed(2)}%</div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.maxLossStreak')}</div>
                <div className="num mt-1 text-lg font-bold text-down">{result.summary.maxLossStreak}</div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.winRate')}</div>
                <div className="num mt-1 text-lg font-bold text-slate-100">
                  {result.summary.winRate == null ? '-' : `${Math.round(result.summary.winRate * 100)}%`}
                  <span className="ml-1.5 text-xs font-normal text-slate-500">{result.summary.wins}/{result.summary.wins + result.summary.losses}</span>
                </div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.avgRr')}</div>
                <div className="num mt-1 text-lg font-bold text-slate-100">{result.summary.avgRr == null ? '-' : `${result.summary.avgRr.toFixed(2)}R`}</div>
              </div>
            </div>
            {/* K 线图 + 每笔交易的入场/出场标记与连线——"这笔单在当时的行情里
                长什么样",而不只是一条抽象的净值曲线。
                Candlestick chart + each trade's entry/exit markers and
                connecting line — what the trade actually looked like against
                real price action, not just an abstract equity curve. */}
            <div className="mt-5 border-t border-white/10 pt-4">
              <h4 className="text-sm font-semibold text-slate-200">{t('strategy.chartTitle')}</h4>
              <p className="mt-1 text-xs text-slate-500">{t('strategy.chartHint', { n: result.trades.length })}</p>
              <div className="mt-3">
                <BacktestChart bars={result.bars} trades={result.trades} />
              </div>
            </div>

            <div className="mt-5 border-t border-white/10 pt-4">
              <h4 className="text-sm font-semibold text-slate-200">{t('simulator.equityCurve')}</h4>
              <div className="mt-3">
                <EquityCurve points={result.points} capital={btCapital} />
              </div>
            </div>

            {result.trades.length > 0 && (
              <div className="mt-5 border-t border-white/10 pt-4">
                <h4 className="text-sm font-semibold text-slate-200">{t('simulator.trades')}</h4>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                        <th className="px-3 py-2 font-medium">{t('orders.colTime')}</th>
                        <th className="px-3 py-2 font-medium">{t('orders.colSide')}</th>
                        <th className="px-3 py-2 font-medium">{t('simulator.result')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('simulator.tradeRr')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('simulator.tradePnl')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('simulator.equityAfter')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* 新到旧排列：最近的一笔交易最先看到，与订单页/成交明细的既有约定一致
                          Newest first, consistent with the orders page's existing convention */}
                      {tradesDesc.slice(tradePage * TRADE_PAGE_SIZE, tradePage * TRADE_PAGE_SIZE + TRADE_PAGE_SIZE).map((tr) => (
                        <tr key={tr.id} className="border-b border-white/5">
                          <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fmtDate(tr.createdAt)}</td>
                          <td className="px-3 py-2">
                            <span className={`tag ${tr.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                              {tr.side === 'BUY' ? t('common.buy') : t('common.sell')}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`tag ${tr.result === 'HIT_TP' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                              {t(`winrate.${tr.result === 'HIT_TP' ? 'hitTp' : 'hitSl'}`)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-300">{tr.rr.toFixed(2)}R</td>
                          <td className={`px-3 py-2 text-right font-mono font-semibold ${tr.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>
                            {tr.pnlPct >= 0 ? '+' : ''}{tr.pnlPct.toFixed(2)}%
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-200">${fmtMoney(tr.equityAfter)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.trades.length > TRADE_PAGE_SIZE && (
                  <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                    <span>
                      {t('orders.pageInfo', {
                        page: tradePage + 1,
                        totalPages: Math.ceil(result.trades.length / TRADE_PAGE_SIZE),
                        total: result.trades.length,
                      })}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setTradePage((p) => Math.max(0, p - 1))}
                        disabled={tradePage === 0}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t('common.prevPage')}
                      </button>
                      <button
                        onClick={() => setTradePage((p) => Math.min(Math.ceil(result.trades.length / TRADE_PAGE_SIZE) - 1, p + 1))}
                        disabled={(tradePage + 1) * TRADE_PAGE_SIZE >= result.trades.length}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {t('common.nextPage')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {saveError && <p className="mt-3 text-sm text-down">{saveError}</p>}
      <div className="mt-5 flex flex-wrap gap-3">
        <button onClick={() => save(true)} disabled={saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-40">
          {t('strategy.saveAndEnable')}
        </button>
        <button onClick={() => save(false)} disabled={saving} className="rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-slate-300 transition hover:text-white disabled:opacity-40">
          {t('strategy.saveOnly')}
        </button>
        <button onClick={onCancel} disabled={saving} className="ml-auto rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-slate-400 transition hover:text-white">
          {t('common.cancel')}
        </button>
      </div>
    </section>
  )
}

export default function StrategiesPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { accounts, activeSymbols } = useLive()
  const quotesByAccount = useQuotes()
  const { toast, placeManualOrder } = useOrderPlacement()

  const [templates, setTemplates] = useState<StrategyTemplateSchemas | null>(null)
  const [strategies, setStrategies] = useState<UserStrategy[]>([])
  const [signals, setSignals] = useState<StrategySignal[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserStrategy | null>(null)
  const [orderTarget, setOrderTarget] = useState<StrategySignal | null>(null)

  useBackToClose(draft != null, () => setDraft(null))
  useBackToClose(deleteTarget != null, () => setDeleteTarget(null))
  useBackToClose(orderTarget != null, () => setOrderTarget(null))

  const isPro = user?.plan === 'PRO'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [tRes, sRes, sigRes] = await Promise.all([strategyApi.templates(), strategyApi.list(), strategyApi.signals(20)])
      setTemplates(tRes.templates)
      setStrategies(sRes.strategies)
      setSignals(sigRes.signals)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { document.title = t('strategy.title') }, [t])
  useEffect(() => { load() }, [load])

  // 我的策略信号轮询：与胜率卡/纪律分卡同一节奏(45 秒 + 切回页面立即刷)
  // Poll my strategy signals: same 45s cadence as the win-rate/discipline cards
  useEffect(() => {
    const refresh = () => { if (!document.hidden) strategyApi.signals(20).then((r) => setSignals(r.signals)).catch(() => {}) }
    const timer = window.setInterval(refresh, 45_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const openNewDraft = (template: StrategyTemplateKey) => {
    if (!templates) return
    setDraft({
      template, symbol: activeSymbols[0] ?? 'XAUUSD', interval: '15',
      params: defaultParams(templates[template]), stopLossPct: 1.0, takeProfitR: 2.0,
    })
  }

  const openEditDraft = (s: UserStrategy) => {
    setDraft({ id: s.id, template: s.template, symbol: s.symbol, interval: s.interval, params: s.params, stopLossPct: s.stopLossPct, takeProfitR: s.takeProfitR })
  }

  const onSaved = (s: UserStrategy) => {
    setStrategies((prev) => {
      const idx = prev.findIndex((p) => p.id === s.id)
      if (idx === -1) return [...prev, s]
      const next = [...prev]
      next[idx] = s
      return next
    })
    setDraft(null)
  }

  const toggleEnabled = async (s: UserStrategy) => {
    const updated = await strategyApi.update(s.id, { enabled: !s.enabled })
    setStrategies((prev) => prev.map((p) => (p.id === s.id ? updated : p)))
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    await strategyApi.remove(deleteTarget.id)
    setStrategies((prev) => prev.filter((p) => p.id !== deleteTarget.id))
    setDeleteTarget(null)
  }

  const handleOrderConfirm = async (volume: number, mt5Login: string | null, stopLoss: number | null, takeProfit: number | null) => {
    if (!orderTarget) return
    await placeManualOrder(orderTarget.symbol, orderTarget.side, volume, mt5Login, stopLoss, takeProfit)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="mb-5">
        <h2 className="font-display text-2xl font-bold text-slate-50">{t('strategy.title')}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">{t('strategy.subtitle')}</p>
      </div>

      {!isPro && (
        <div className="glass mb-5 border-prism-500/20 bg-prism-600/5 p-4 text-center text-sm text-slate-300">
          {t('strategy.proOnlyHint')}{' '}
          <Link to="/upgrade" className="text-prism-300 underline hover:text-prism-200">{t('winrate.viewDetail')}</Link>
        </div>
      )}

      {/* 我的策略列表 / my strategies */}
      <section className="glass mb-5 p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-slate-100">{t('strategy.myStrategies')}</h3>
          {isPro && !draft && (
            <div className="flex flex-wrap gap-2">
              {TEMPLATE_KEYS.map((key) => (
                <button key={key} onClick={() => openNewDraft(key)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-prism-400/50 hover:text-prism-200">
                  {t('strategy.newStrategy')} · {t(TEMPLATE_LABEL_KEYS[key])}
                </button>
              ))}
            </div>
          )}
        </div>

        {strategies.length === 0 ? (
          <div className="mt-4 py-6 text-center text-sm text-slate-500">{t('strategy.noStrategies')}</div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {strategies.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{t(TEMPLATE_LABEL_KEYS[s.template])}</span>
                    <span className="tag bg-white/5 text-slate-400">{displaySymbol(s.symbol)}</span>
                    <span className="tag bg-white/5 text-slate-400">{INTERVALS.find((iv) => iv.code === s.interval)?.label ?? s.interval}</span>
                    <span className={`tag ${s.enabled ? 'bg-up/15 text-up' : 'bg-white/5 text-slate-500'}`}>
                      {s.enabled ? t('strategy.enabled') : t('strategy.disabled')}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => openEditDraft(s)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white">
                    {t('strategy.editStrategy')}
                  </button>
                  <button onClick={() => toggleEnabled(s)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white">
                    {s.enabled ? t('strategy.disable') : t('strategy.enable')}
                  </button>
                  <button onClick={() => setDeleteTarget(s)} className="rounded-lg border border-down/30 bg-down/5 px-3 py-1.5 text-xs text-down transition hover:bg-down/10">
                    {t('strategy.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {draft && templates && (
        <StrategyBuilder draft={draft} templates={templates} activeSymbols={activeSymbols} onChange={setDraft} onCancel={() => setDraft(null)} onSaved={onSaved} />
      )}

      {/* 我的策略信号 / my strategy signals */}
      <section className="glass mb-5 p-5">
        <h3 className="font-display text-lg font-semibold text-slate-100">{t('strategy.mySignals')}</h3>
        {signals.length === 0 ? (
          <div className="mt-4 py-6 text-center text-sm text-slate-500">{t('strategy.noSignals')}</div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {signals.map((sig) => (
              <div key={sig.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <div className="flex items-center gap-2">
                  <span className={`tag ${sig.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                    {sig.side === 'BUY' ? t('common.buy') : t('common.sell')}
                  </span>
                  <span className="font-mono text-sm text-slate-100">{displaySymbol(sig.symbol)}</span>
                  <span className="text-xs text-slate-500">{t('strategy.signalTriggeredAt')} {fmtTime(sig.createdAt)}</span>
                </div>
                <button onClick={() => setOrderTarget(sig)} className="btn-primary px-4 py-1.5 text-xs">
                  {t('strategy.oneClickOrder')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs leading-relaxed text-slate-500">{t('strategy.disclaimer')}</p>

      {deleteTarget && (
        <ConfirmModal
          title={t('strategy.delete')}
          message={t('strategy.deleteConfirm')}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {orderTarget && (
        <ChartOrderModal
          symbol={orderTarget.symbol}
          side={orderTarget.side}
          accounts={accounts}
          quotesByAccount={quotesByAccount}
          refPrice={orderTarget.entry}
          initialStopLoss={orderTarget.stopLoss}
          initialTakeProfit={orderTarget.takeProfit}
          onCancel={() => setOrderTarget(null)}
          onConfirm={handleOrderConfirm}
        />
      )}

      {toast && <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>{toast.msg}</div>}
    </div>
  )
}
