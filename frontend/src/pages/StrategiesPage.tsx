// 自定义策略页：搭规则树 → 查数据覆盖 → 回测 → 启用 → 触发个人信号 → 一键下单。
// 只触发这个用户自己的信号（strategy_signals 表，与全站信号表完全独立），一键下单
// 复用图表页同款的手动下单弹窗（ChartOrderModal + placeManualOrder），不经过
// signalId，没有任何 Order 相关的后端改动。
//
// 本页只做编排：状态管理、数据加载、弹窗接线。规则构建器、回测面板、策略卡片、
// 信号列表都在 components/strategies/ 下——此前这些全挤在本文件的 1321 行里，
// 加入 AST 构建器与成本/样本外展示后必然失控。
//
// Custom strategies page: build a rule tree, check data coverage, backtest,
// enable, get personal signals on trigger, one-click order. Fires only this
// user's own signals (the strategy_signals table, fully separate from the shared
// signals table); one-click order reuses the charts page's manual-order modal
// (ChartOrderModal + placeManualOrder) — no signalId involved, no Order-side
// backend changes.
//
// This page is orchestration only: state, data loading, modal wiring. The rule
// builder, backtest panel, strategy card and signal list all live under
// components/strategies/ — they used to be crammed into this file's 1321 lines,
// which adding an AST builder plus cost/out-of-sample views would have made
// unmanageable.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { useLive, useQuotes } from '../store/live'
import { strategyApi } from '../api/client'
import { displaySymbol, localizeApiError } from '../api/utils'
import type {
  StopLossMethod,
  StrategyBacktestResult,
  StrategyPerformance,
  StrategySignal,
  StrategyTemplateKey,
  TakeProfitMethod,
  UserStrategy,
} from '../api/types'
import ChartOrderModal from '../components/ChartOrderModal'
import ConfirmModal from '../components/ConfirmModal'
import BacktestPanel from '../components/strategies/BacktestPanel'
import RuleGroupEditor from '../components/strategies/RuleGroup'
import StrategyCard from '../components/strategies/StrategyCard'
import StrategySignalList from '../components/strategies/StrategySignalList'
import { NumberField } from '../components/strategies/OperandPicker'
import {
  INTERVALS,
  RULE_LIMITS,
  collectIntervals,
  emptyGroup,
  ruleUsage,
  type RuleEnvelope,
} from '../components/strategies/ruleTypes'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'

// 模板名称仍需要：迁移过来的旧策略 template 非 null，未命名时用模板名作显示名。
// 模板的参数表单已被规则构建器取代，所以这里只留标签映射。
// Template names are still needed: a migrated strategy has a non-null template,
// and an unnamed one displays its template's name. The per-template param form is
// gone (replaced by the rule builder), so only the label map remains.
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

// 未保存草稿的回测结果归属键。用一个不可能与 UUID 冲突的字面量。
// Key under which an unsaved draft's backtest result is stored; a literal that
// can't collide with a UUID.
const NEW_DRAFT_KEY = '__draft__'

// 草稿：编辑中的策略。template 只记录"从哪个预设起步"，从零搭起时为 null。
// A draft strategy being edited. `template` only records which preset it started
// from, and is null when built from scratch.
interface Draft {
  id?: string
  template: StrategyTemplateKey | null
  name: string
  rules: RuleEnvelope
  symbols: string[]
  intervals: string[]
  stopLossMethod: StopLossMethod
  stopLossValue: number
  takeProfitMethod: TakeProfitMethod
  takeProfitValue: number
  oneTradeAtATime: boolean
  exitTimeoutBars: number | null
  dailySignalCap: number | null
  cooldownMinutes: number | null
}

function emptyDraft(symbol: string): Draft {
  return {
    template: null,
    name: '',
    rules: { long: emptyGroup(), short: null },
    symbols: [symbol],
    intervals: ['15'],
    stopLossMethod: 'percent',
    stopLossValue: 1.0,
    takeProfitMethod: 'rr',
    takeProfitValue: 2.0,
    oneTradeAtATime: true,
    exitTimeoutBars: null,
    dailySignalCap: null,
    cooldownMinutes: null,
  }
}

function draftFromStrategy(s: UserStrategy): Draft {
  return {
    id: s.id,
    template: s.template,
    name: s.name ?? '',
    rules: s.rules,
    symbols: s.symbols,
    intervals: s.intervals,
    stopLossMethod: s.stopLossMethod,
    stopLossValue: s.stopLossValue,
    takeProfitMethod: s.takeProfitMethod,
    takeProfitValue: s.takeProfitValue,
    oneTradeAtATime: s.oneTradeAtATime,
    exitTimeoutBars: s.exitTimeoutBars,
    dailySignalCap: s.dailySignalCap,
    cooldownMinutes: s.cooldownMinutes,
  }
}
interface StrategyEditorProps {
  draft: Draft
  // 有报价在推的品种。未接入的品种在下拉里置灰并标注原因（spec 验收标准第 4 条）。
  // Symbols with a live feed. Unfed ones grey out in the dropdown with the reason
  // stated (spec acceptance criterion 4).
  activeSymbols: string[]
  // 全部候选品种（含未接入的）：来自 coverage 端点，让用户看到"这个品种存在但没
  // 接入"，而不是干脆看不到它。
  // Every candidate symbol including unfed ones, from the coverage endpoint, so the
  // user sees "this symbol exists but isn't fed" rather than not seeing it at all.
  allSymbols: string[]
  onChange: (d: Draft) => void
  onCancel: () => void
  onSaved: (s: UserStrategy) => void
  onBacktestResult: (strategyId: string | null, result: StrategyBacktestResult) => void
}

function StrategyEditor({
  draft, activeSymbols, allSymbols, onChange, onCancel, onSaved, onBacktestResult,
}: StrategyEditorProps) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  // 回测目标：策略可订阅多个品种/周期，但回测一次只跑一个组合。
  // Backtest target: a strategy may subscribe to several symbols/intervals, but one
  // run covers a single pair.
  const [btSymbol, setBtSymbol] = useState(draft.symbols[0] ?? activeSymbols[0] ?? 'XAUUSD')
  const [btInterval, setBtInterval] = useState(draft.intervals[0] ?? '15')

  const usage = ruleUsage(draft.rules)
  // 规则引用的周期必须是订阅周期的子集，否则那一路指标永远取不到数据，后端创建时
  // 会 400。在这里先说清楚，用户不必靠报错才知道。
  // Intervals referenced by the rules must be a subset of the subscribed ones, or
  // that indicator branch never has data and the backend 400s on create. Say it
  // here so the user doesn't need the error to find out.
  const unsubscribed = collectIntervals(draft.rules).filter((iv) => !draft.intervals.includes(iv))
  const noSide = !draft.rules.long && !draft.rules.short
  const canSave = !noSide && unsubscribed.length === 0 && draft.symbols.length > 0 && draft.intervals.length > 0

  const toggleSymbol = (sym: string) => {
    const has = draft.symbols.includes(sym)
    if (!has && draft.symbols.length >= RULE_LIMITS.maxSymbols) return
    // 最后一个品种不允许取消：策略必须至少盯一个品种，允许清空只会让保存必然 400。
    // The last symbol can't be deselected: a strategy must watch at least one, and
    // allowing an empty list would only guarantee a 400 on save.
    if (has && draft.symbols.length === 1) return
    onChange({ ...draft, symbols: has ? draft.symbols.filter((s) => s !== sym) : [...draft.symbols, sym] })
  }

  const toggleInterval = (code: string) => {
    const has = draft.intervals.includes(code)
    if (!has && draft.intervals.length >= RULE_LIMITS.maxIntervals) return
    if (has && draft.intervals.length === 1) return
    onChange({ ...draft, intervals: has ? draft.intervals.filter((c) => c !== code) : [...draft.intervals, code] })
  }

  const save = async (enabled: boolean) => {
    setSaving(true)
    setSaveError(null)
    try {
      const payload = {
        name: draft.name.trim() || null,
        rules: draft.rules,
        symbols: draft.symbols,
        intervals: draft.intervals,
        stopLossMethod: draft.stopLossMethod,
        stopLossValue: draft.stopLossValue,
        takeProfitMethod: draft.takeProfitMethod,
        takeProfitValue: draft.takeProfitValue,
        oneTradeAtATime: draft.oneTradeAtATime,
        exitTimeoutBars: draft.exitTimeoutBars,
        dailySignalCap: draft.dailySignalCap,
        cooldownMinutes: draft.cooldownMinutes,
      }
      let saved: UserStrategy
      if (draft.id) {
        saved = await strategyApi.update(draft.id, { ...payload, enabled })
      } else {
        saved = await strategyApi.create({ ...payload, template: draft.template })
        if (enabled) saved = await strategyApi.update(saved.id, { enabled: true })
      }
      onSaved(saved)
    } catch (e) {
      setSaveError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const segBtn = (active: boolean, disabled = false) =>
    `rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
      disabled
        ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-slate-600'
        : active
          ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
          : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
    }`

  return (
    <section className="glass mb-5 p-5">
      {/* 基本信息：命名 + 品种（多选）+ 周期（多选）
          Basics: name, symbols (multi), intervals (multi) */}
      <div>
        <h4 className="mb-3 text-sm font-semibold text-slate-300">{t('strategy.sectionBasics')}</h4>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.name')}</span>
          <input
            type="text"
            className="input"
            maxLength={60}
            placeholder={draft.template ? t(TEMPLATE_LABEL_KEYS[draft.template]) : t('strategy.nameplaceholderCustom')}
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </label>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            {t('strategy.symbolsLabel', { used: draft.symbols.length, max: RULE_LIMITS.maxSymbols })}
          </span>
          <div className="flex flex-wrap gap-2">
            {/* 未接入行情的品种置灰并标注原因（spec 验收标准第 4 条）：此前用户能选
                中它，然后只得到一个没有解释的 insufficientData。
                Symbols without a live feed grey out with the reason stated (spec
                acceptance criterion 4): they used to be selectable, yielding only an
                unexplained insufficientData later. */}
            {allSymbols.map((sym) => {
              const fed = activeSymbols.includes(sym)
              const on = draft.symbols.includes(sym)
              return (
                <button
                  key={sym}
                  type="button"
                  disabled={!fed}
                  title={fed ? undefined : t('strategy.symbolNotFed')}
                  aria-pressed={on}
                  onClick={() => toggleSymbol(sym)}
                  className={segBtn(on, !fed)}
                >
                  {displaySymbol(sym)}
                  {!fed && <span className="ml-1 text-[10px]">· {t('strategy.symbolNotFedShort')}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">
            {t('strategy.intervalsLabel', { used: draft.intervals.length, max: RULE_LIMITS.maxIntervals })}
          </span>
          <div className="flex flex-wrap gap-2">
            {INTERVALS.map((iv) => (
              <button
                key={iv.code}
                type="button"
                aria-pressed={draft.intervals.includes(iv.code)}
                onClick={() => toggleInterval(iv.code)}
                className={segBtn(draft.intervals.includes(iv.code))}
              >
                {iv.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 入场规则：多空两侧各一棵树，任一侧可关闭
          Entry rules: one tree per side, either side can be turned off */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h4 className="text-sm font-semibold text-slate-300">{t('strategy.sectionRules')}</h4>
          <span className="text-[11px] text-slate-500">
            {t('strategy.ruleUsageConditions', { used: usage.conditions, max: RULE_LIMITS.maxConditions })}
            {' · '}
            {t('strategy.ruleUsageIndicators', { used: usage.indicatorInstances, max: RULE_LIMITS.maxIndicatorInstances })}
          </span>
        </div>

        {(['long', 'short'] as const).map((side) => (
          <div key={side} className="mt-3">
            <div className="flex flex-wrap items-center gap-3">
              <h5 className="text-xs font-semibold text-slate-200">
                {side === 'long' ? t('strategy.rulesLong') : t('strategy.rulesShort')}
              </h5>
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={draft.rules[side] != null}
                  onChange={(e) =>
                    onChange({ ...draft, rules: { ...draft.rules, [side]: e.target.checked ? emptyGroup() : null } })
                  }
                  className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-prism-500"
                />
                {t('strategy.rulesSideEnable')}
              </label>
            </div>
            {draft.rules[side] ? (
              <div className="mt-2">
                <RuleGroupEditor
                  group={draft.rules[side]!}
                  onChange={(next) => onChange({ ...draft, rules: { ...draft.rules, [side]: next } })}
                  depth={1}
                  usage={usage}
                  availableIntervals={draft.intervals}
                />
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-slate-500">{t('strategy.rulesSideDisabled')}</p>
            )}
          </div>
        ))}

        {noSide && <p className="mt-3 text-xs text-down" role="alert">{t('strategy.rulesNeedOneSide')}</p>}
        {unsubscribed.length > 0 && (
          <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200" role="alert">
            {t('strategy.rulesUnsubscribedInterval', { intervals: unsubscribed.join(', ') })}
          </p>
        )}
      </div>

      {/* 风险管理：止损 / 止盈各一张卡，方式与数值紧挨着
          Risk management: one card each for SL and TP, method next to its value */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <h4 className="mb-3 text-sm font-semibold text-slate-300">{t('strategy.sectionRisk')}</h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.stopLossMethod')}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {(['percent', 'steps', 'atr'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={draft.stopLossMethod === m}
                  onClick={() => onChange({ ...draft, stopLossMethod: m })}
                  className={segBtn(draft.stopLossMethod === m)}
                >
                  {t(m === 'percent' ? 'strategy.methodPercent' : m === 'steps' ? 'strategy.methodSteps' : 'strategy.methodAtr')}
                </button>
              ))}
            </div>
            <div className="mt-3">
              <NumberField
                label={
                  draft.stopLossMethod === 'percent'
                    ? t('strategy.stopLossPct')
                    : draft.stopLossMethod === 'steps'
                      ? t('strategy.stopLossSteps')
                      : t('strategy.stopLossAtr')
                }
                value={draft.stopLossValue}
                min={draft.stopLossMethod === 'steps' ? 1 : 0.1}
                max={draft.stopLossMethod === 'steps' ? 1000000 : 10}
                isFloat={draft.stopLossMethod !== 'steps'}
                onChange={(v) => onChange({ ...draft, stopLossValue: v })}
              />
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.takeProfitMethod')}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {(['rr', 'percent', 'steps', 'atr'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={draft.takeProfitMethod === m}
                  onClick={() => onChange({ ...draft, takeProfitMethod: m })}
                  className={segBtn(draft.takeProfitMethod === m)}
                >
                  {t(
                    m === 'rr'
                      ? 'strategy.methodRR'
                      : m === 'percent'
                        ? 'strategy.methodPercent'
                        : m === 'steps'
                          ? 'strategy.methodSteps'
                          : 'strategy.methodAtr'
                  )}
                </button>
              ))}
            </div>
            <div className="mt-3">
              <NumberField
                label={
                  draft.takeProfitMethod === 'rr'
                    ? t('strategy.takeProfitR')
                    : draft.takeProfitMethod === 'percent'
                      ? t('strategy.takeProfitPct')
                      : draft.takeProfitMethod === 'steps'
                        ? t('strategy.takeProfitSteps')
                        : t('strategy.takeProfitAtr')
                }
                value={draft.takeProfitValue}
                min={draft.takeProfitMethod === 'steps' ? 1 : draft.takeProfitMethod === 'rr' ? 0.5 : 0.1}
                max={draft.takeProfitMethod === 'steps' ? 1000000 : draft.takeProfitMethod === 'percent' ? 50 : 10}
                isFloat={draft.takeProfitMethod !== 'steps'}
                onChange={(v) => onChange({ ...draft, takeProfitValue: v })}
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.oneTradeAtATime')}</span>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={draft.oneTradeAtATime}
              onClick={() => onChange({ ...draft, oneTradeAtATime: true })}
              className={segBtn(draft.oneTradeAtATime)}
            >
              {t('strategy.oneTradeAtATimeOn')}
            </button>
            <button
              type="button"
              aria-pressed={!draft.oneTradeAtATime}
              onClick={() => onChange({ ...draft, oneTradeAtATime: false })}
              className={segBtn(!draft.oneTradeAtATime)}
            >
              {t('strategy.oneTradeAtATimeOff')}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            {draft.oneTradeAtATime ? t('strategy.oneTradeAtATimeOnHint') : t('strategy.oneTradeAtATimeOffHint')}
          </p>
        </div>

        {/* 超时平仓 / 每日上限 / 冷却：三个可空设定，0 视为不启用（写 null）
            Timeout exit / daily cap / cooldown: three nullable settings, where 0
            means "off" and is sent as null */}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumberField
            label={t('strategy.exitTimeoutBars')}
            value={draft.exitTimeoutBars ?? 0}
            min={0}
            max={1000}
            isFloat={false}
            onChange={(v) => onChange({ ...draft, exitTimeoutBars: v > 0 ? v : null })}
          />
          <NumberField
            label={t('strategy.dailySignalCap')}
            value={draft.dailySignalCap ?? 0}
            min={0}
            max={100}
            isFloat={false}
            onChange={(v) => onChange({ ...draft, dailySignalCap: v > 0 ? v : null })}
          />
          <NumberField
            label={t('strategy.cooldownMinutes')}
            value={draft.cooldownMinutes ?? 0}
            min={0}
            max={1440}
            isFloat={false}
            onChange={(v) => onChange({ ...draft, cooldownMinutes: v > 0 ? v : null })}
          />
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{t('strategy.optionalZeroHint')}</p>
      </div>

      {/* 回测 / backtest */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <BacktestPanel
          rules={draft.rules}
          symbol={btSymbol}
          interval={btInterval}
          symbolOptions={draft.symbols}
          intervalOptions={draft.intervals}
          onTargetChange={(sym, itv) => { setBtSymbol(sym); setBtInterval(itv) }}
          stopLossMethod={draft.stopLossMethod}
          stopLossValue={draft.stopLossValue}
          takeProfitMethod={draft.takeProfitMethod}
          takeProfitValue={draft.takeProfitValue}
          oneTradeAtATime={draft.oneTradeAtATime}
          exitTimeoutBars={draft.exitTimeoutBars}
          onResult={(res) => onBacktestResult(draft.id ?? null, res)}
        />
      </div>

      {saveError && <p className="mt-3 text-sm text-down" role="alert">{saveError}</p>}
      <div className="mt-5 flex flex-wrap gap-3 border-t border-white/10 pt-4">
        <button type="button" onClick={() => save(true)} disabled={saving || !canSave} className="btn-primary px-5 py-2 text-sm disabled:opacity-40">
          {t('strategy.saveAndEnable')}
        </button>
        <button
          type="button"
          onClick={() => save(false)}
          disabled={saving || !canSave}
          className="rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-slate-300 transition hover:text-white disabled:opacity-40"
        >
          {t('strategy.saveOnly')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="ml-auto rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-slate-400 transition hover:text-white"
        >
          {t('common.cancel')}
        </button>
      </div>
    </section>
  )
}

export default function StrategiesPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { accounts, activeSymbols, refreshAll } = useLive()
  const quotesByAccount = useQuotes()
  const { toast, placeManualOrder } = useOrderPlacement()

  const [strategies, setStrategies] = useState<UserStrategy[]>([])
  const [signals, setSignals] = useState<StrategySignal[]>([])
  // 每个策略一份实盘绩效。按 id 存 map 而不是塞进 strategies：绩效来自另一个端点，
  // 混进策略对象会让"策略没变但绩效变了"也触发整列表重渲染。
  // One live-performance record per strategy, keyed by id rather than merged into
  // `strategies`: it comes from a separate endpoint, and merging would re-render
  // the whole list whenever only a win rate moved.
  const [performance, setPerformance] = useState<Record<string, StrategyPerformance>>({})
  // 本次会话内每个策略最近一次回测的胜率。key 用 strategy id；新建（未保存）策略
  // 的回测结果无处归属，用 NEW_DRAFT_KEY 兜着，保存后不迁移——它对比的是"这一版
  // 规则"，保存后的策略应该重新跑一次才有意义。
  // Win rate of the latest backtest per strategy in this session, keyed by id. A
  // run on an unsaved draft has no id, so it lands under NEW_DRAFT_KEY and is not
  // migrated on save: it reflects that draft's rules, and a saved strategy
  // deserves a fresh run.
  const [backtestWinRates, setBacktestWinRates] = useState<Record<string, number | null>>({})
  const [allSymbols, setAllSymbols] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<UserStrategy | null>(null)
  const [orderTarget, setOrderTarget] = useState<StrategySignal | null>(null)
  const [clearingSignals, setClearingSignals] = useState(false)
  const [confirmClearSignals, setConfirmClearSignals] = useState(false)
  // 每秒走一次的时钟，驱动信号 TTL 到期时的实时置灰。
  // A 1s clock driving live grey-out when a signal's TTL expires.
  const [now, setNow] = useState(() => Date.now())

  useBackToClose(draft != null, () => setDraft(null))
  useBackToClose(deleteTarget != null, () => setDeleteTarget(null))
  useBackToClose(orderTarget != null, () => setOrderTarget(null))
  useBackToClose(confirmClearSignals, () => setConfirmClearSignals(false))

  const isPro = user?.plan === 'PRO'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // coverage 不传参：拿"当前有报价的全部品种"，用于把未接入品种也列出来并置灰。
      // 三个请求互不依赖，并行发出。
      // coverage with no args returns every currently quoted symbol, so unfed ones
      // can still be listed (greyed out). The three requests are independent.
      const [sRes, sigRes, covRes] = await Promise.all([
        strategyApi.list(),
        strategyApi.signals(20),
        strategyApi.coverage(),
      ])
      setStrategies(sRes.strategies)
      setSignals(sigRes.signals)
      const syms = Array.from(new Set(covRes.coverage.map((c) => c.symbol)))
      setAllSymbols(syms.length > 0 ? syms : covRes.activeSymbols)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { document.title = t('strategy.title') }, [t])
  useEffect(() => { load() }, [load])

  // 绩效逐个策略拉取（端点是 /{id}/performance，没有批量形态）。失败的那个静默跳过，
  // 不能因为一个策略的绩效 500 就让整页没有绩效。
  // Performance is fetched per strategy (the endpoint is /{id}/performance, with no
  // batch form). A failing one is skipped silently: one strategy's 500 must not
  // strip performance from the whole page.
  useEffect(() => {
    if (strategies.length === 0) return
    let cancelled = false
    Promise.all(
      strategies.map((s) => strategyApi.performance(s.id).then((p) => p).catch(() => null)),
    ).then((rows) => {
      if (cancelled) return
      const next: Record<string, StrategyPerformance> = {}
      rows.forEach((p) => { if (p) next[p.strategyId] = p })
      setPerformance(next)
    })
    return () => { cancelled = true }
  }, [strategies])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  // 我的策略信号轮询：与胜率卡/纪律分卡同一节奏（45 秒 + 切回页面立即刷）。
  // Poll my strategy signals on the same 45s cadence as the win-rate/discipline
  // cards, plus an immediate refresh when the tab regains focus.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) strategyApi.signals(20).then((r) => setSignals(r.signals)).catch(() => {})
    }
    const timer = window.setInterval(refresh, 45_000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const openNewDraft = () => setDraft(emptyDraft(activeSymbols[0] ?? allSymbols[0] ?? 'XAUUSD'))
  const openEditDraft = (s: UserStrategy) => setDraft(draftFromStrategy(s))

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

  // 回测结果只取胜率一项存下来供卡片对比。insufficientData 时 summary 缺席，
  // 必须先判这一项，否则读到 undefined。
  // Only the win rate is kept for the card comparison. With insufficientData the
  // summary is absent, so that flag has to be checked first or this reads undefined.
  const onBacktestResult = (strategyId: string | null, result: StrategyBacktestResult) => {
    const rate = result.insufficientData ? null : result.summary.winRate
    setBacktestWinRates((prev) => ({ ...prev, [strategyId ?? NEW_DRAFT_KEY]: rate }))
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

  const doClearSignals = async () => {
    setClearingSignals(true)
    try {
      await strategyApi.clearSignals()
      setSignals([])
      // 仪表盘/信号面板页也读同一份 strategySignals（live.tsx），一并刷新，
      // 避免清空后那两处还挂着旧数据。
      // The dashboard/signals page read the same strategySignals slice
      // (live.tsx); refresh it too, so cleared signals don't linger there.
      await refreshAll()
    } finally {
      setClearingSignals(false)
      setConfirmClearSignals(false)
    }
  }

  const handleOrderConfirm = async (
    volume: number, mt5Login: string | null, stopLoss: number | null,
    takeProfit: number | null, clientOrderId: string,
  ) => {
    if (!orderTarget) return
    await placeManualOrder(orderTarget.symbol, orderTarget.side, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      </div>
    )
  }

  return (
    <div>
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
            <button
              type="button"
              onClick={openNewDraft}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-prism-400/50 hover:text-prism-200"
            >
              {t('strategy.newStrategy')}
            </button>
          )}
        </div>

        {strategies.length === 0 ? (
          <div className="mt-4 py-6 text-center text-sm text-slate-500">{t('strategy.noStrategies')}</div>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            {strategies.map((s) => (
              <StrategyCard
                key={s.id}
                strategy={s}
                performance={performance[s.id] ?? null}
                backtestWinRate={backtestWinRates[s.id] ?? null}
                fallbackName={s.template ? t(TEMPLATE_LABEL_KEYS[s.template]) : t('strategy.nameplaceholderCustom')}
                onEdit={() => openEditDraft(s)}
                onToggle={() => toggleEnabled(s)}
                onDelete={() => setDeleteTarget(s)}
              />
            ))}
          </div>
        )}
      </section>

      {draft && (
        <StrategyEditor
          draft={draft}
          activeSymbols={activeSymbols}
          allSymbols={allSymbols.length > 0 ? allSymbols : activeSymbols}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSaved={onSaved}
          onBacktestResult={onBacktestResult}
        />
      )}

      {/* 我的策略信号 / my strategy signals */}
      <section className="glass mb-5 p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-slate-100">{t('strategy.mySignals')}</h3>
          {signals.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearSignals(true)}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 transition hover:border-down/30 hover:text-down"
            >
              {t('strategy.clearSignals')}
            </button>
          )}
        </div>
        <StrategySignalList signals={signals} now={now} onOrder={setOrderTarget} />
      </section>

      <p className="text-xs leading-relaxed text-slate-500">{t('strategy.disclaimer')}</p>

      {confirmClearSignals && (
        <ConfirmModal
          title={t('strategy.clearSignals')}
          message={t('strategy.clearSignalsConfirm')}
          danger
          busy={clearingSignals}
          onConfirm={doClearSignals}
          onCancel={() => setConfirmClearSignals(false)}
        />
      )}

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

      {toast && (
        <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
