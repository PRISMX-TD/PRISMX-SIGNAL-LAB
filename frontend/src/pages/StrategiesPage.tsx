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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { useLive, useQuotes } from '../store/live'
import { strategyApi } from '../api/client'
import { displaySymbol, fmtTime, localizeApiError } from '../api/utils'
import type {
  StrategyBacktestResult,
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

const TEMPLATE_KEYS: StrategyTemplateKey[] = ['ma_cross', 'rsi_reversal', 'bollinger_reversion']
const TEMPLATE_LABEL_KEYS: Record<StrategyTemplateKey, string> = {
  ma_cross: 'strategy.templateMaCross',
  rsi_reversal: 'strategy.templateRsiReversal',
  bollinger_reversion: 'strategy.templateBollingerReversion',
}
const TEMPLATE_DESC_KEYS: Record<StrategyTemplateKey, string> = {
  ma_cross: 'strategy.templateMaCrossDesc',
  rsi_reversal: 'strategy.templateRsiReversalDesc',
  bollinger_reversion: 'strategy.templateBollingerReversionDesc',
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
          <label key={key} className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t(PARAM_LABEL_KEYS[key] ?? key)}</span>
            {spec.type === 'enum' ? (
              <div className="flex flex-wrap gap-2">
                {spec.options.map((opt) => (
                  <button key={opt} onClick={() => setParam(key, opt)} className={segBtn(draft.params[key] === opt)}>
                    {t(ENUM_OPTION_LABEL_KEYS[key]?.[opt] ?? opt)}
                  </button>
                ))}
              </div>
            ) : (
              <input
                type="number"
                className="input"
                min={spec.min}
                max={spec.max}
                step={spec.type === 'float' ? 0.1 : 1}
                value={draft.params[key] ?? spec.default}
                onChange={(e) => setParam(key, spec.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value, 10))}
              />
            )}
          </label>
        ))}
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.stopLossPct')}</span>
          <input type="number" className="input" min={0.1} max={10} step={0.1} value={draft.stopLossPct}
            onChange={(e) => onChange({ ...draft, stopLossPct: Math.min(10, Math.max(0.1, parseFloat(e.target.value) || 0.1)) })} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.takeProfitR')}</span>
          <input type="number" className="input" min={0.5} max={10} step={0.1} value={draft.takeProfitR}
            onChange={(e) => onChange({ ...draft, takeProfitR: Math.min(10, Math.max(0.5, parseFloat(e.target.value) || 0.5)) })} />
        </label>
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
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.capital')}</span>
            <input type="number" className="input w-32" min={1} value={btCapital} onChange={(e) => setBtCapital(Math.max(1, parseInt(e.target.value, 10) || 1))} />
          </label>
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
          <div className="mt-4">
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
            <div className="mt-4">
              <EquityCurve points={result.points} capital={btCapital} />
            </div>
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
