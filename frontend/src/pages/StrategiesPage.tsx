// 自定义策略页：挑条件 → 查数据覆盖 → 回测 → 启用 → 触发个人信号 → 一键下单。
// 只触发这个用户自己的信号（strategy_signals 表，与全站信号表完全独立），一键下单
// 复用图表页同款的手动下单弹窗（ChartOrderModal + placeManualOrder），不经过
// signalId，没有任何 Order 相关的后端改动。
//
// 本页只做编排：状态管理、数据加载、弹窗接线。条件编辑器、回测面板、策略卡片、
// 信号列表都在 components/strategies/ 下——此前这些全挤在本文件的 1321 行里，
// 加入条件编辑器与成本/样本外展示后必然失控。
//
// Custom strategies page: pick conditions, check data coverage, backtest,
// enable, get personal signals on trigger, one-click order. Fires only this
// user's own signals (the strategy_signals table, fully separate from the shared
// signals table); one-click order reuses the charts page's manual-order modal
// (ChartOrderModal + placeManualOrder) — no signalId involved, no Order-side
// backend changes.
//
// This page is orchestration only: state, data loading, modal wiring. The
// condition editor, backtest panel, strategy card and signal list all live under
// components/strategies/ — they used to be crammed into this file's 1321 lines,
// which adding a condition editor plus cost/out-of-sample views would have made
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
  StrategyPresets,
  StrategySessionFilter,
  StrategySignal,
  StrategyTemplateKey,
  TakeProfitMethod,
  UserStrategy,
} from '../api/types'
import ChartOrderModal from '../components/ChartOrderModal'
import ConfirmModal from '../components/ConfirmModal'
import BacktestPanel from '../components/strategies/BacktestPanel'
import ConditionList from '../components/strategies/ConditionList'
import PresetPicker from '../components/strategies/PresetPicker'
import SessionFilterField from '../components/strategies/SessionFilterField'
import StrategyCard from '../components/strategies/StrategyCard'
import StrategySignalList from '../components/strategies/StrategySignalList'
import { NumberField } from '../components/strategies/NumberField'
import {
  defaultParams,
  intervalLabel,
  type ConditionPayload,
  type UsageCatalog,
} from '../components/strategies/conditionTypes'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'

// 模板名称仍需要：从预设起步的策略 template 非 null，未命名时用模板名作显示名。
// 模板的参数表单已被条件编辑器取代，所以这里只留标签映射。
// Template names are still needed: a strategy started from a preset has a
// non-null template, and an unnamed one displays its template's name. The
// per-template param form is gone (replaced by the condition editor), so only the
// label map remains.
const TEMPLATE_LABEL_KEYS: Record<StrategyTemplateKey, string> = {
  ma_trend: 'strategy.templateMaTrend',
  macd_cross: 'strategy.templateMacdCross',
  rsi_reversal: 'strategy.templateRsiReversal',
  bollinger_breakout: 'strategy.templateBollingerBreakout',
  donchian_breakout: 'strategy.templateDonchianBreakout',
  macd_rsi_combo: 'strategy.templateMacdRsiCombo',
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
  // rules 里也带着 symbol / interval，必须与下面两个字段始终相等——后端把不一致
  // 当 400。所以改品种或周期的地方必须同时改这三处。
  // `rules` carries its own symbol/interval, which must always equal the two
  // fields below: the backend 400s on a mismatch. Every place that changes the
  // symbol or interval therefore has to update all three.
  rules: ConditionPayload
  symbol: string
  interval: string
  stopLossMethod: StopLossMethod
  stopLossValue: number
  takeProfitMethod: TakeProfitMethod
  takeProfitValue: number
  oneTradeAtATime: boolean
  exitTimeoutBars: number | null
  dailySignalCap: number | null
  cooldownMinutes: number | null
  sessionFilter: StrategySessionFilter | null
}

// 新草稿的初始条件只能由后端目录给出：合法的 (指标, 用法, 参数) 组合与参数默认值
// 都登记在 usages 里，前端凭空造一条就是在复制一份会漂移的副本。所以 emptyDraft
// 要求先拿到目录，页面在目录到手之前不渲染编辑器。
// A new draft's first condition can only come from the backend catalogue: the
// legal (indicator, usage, params) combinations and their defaults are registered
// in `usages`, and inventing one here would be a second copy that drifts. So
// emptyDraft demands the catalogue, and the page holds the editor back until it
// has arrived.
function emptyDraft(symbol: string, interval: string, catalog: UsageCatalog): Draft {
  const indicator = catalog.indicators[0]
  const usage = indicator?.usages[0]
  return {
    template: null,
    name: '',
    rules: {
      logic: 'AND',
      symbol,
      interval,
      conditions:
        indicator && usage
          ? [{ indicator: indicator.key, usage: usage.key, params: defaultParams(usage) }]
          : [],
    },
    symbol,
    interval,
    stopLossMethod: 'percent',
    stopLossValue: 1.0,
    takeProfitMethod: 'rr',
    takeProfitValue: 2.0,
    oneTradeAtATime: true,
    exitTimeoutBars: null,
    dailySignalCap: null,
    cooldownMinutes: null,
    sessionFilter: null,
  }
}

function draftFromStrategy(s: UserStrategy): Draft {
  return {
    id: s.id,
    template: s.template,
    name: s.name ?? '',
    rules: s.rules,
    symbol: s.symbol,
    interval: s.interval,
    stopLossMethod: s.stopLossMethod,
    stopLossValue: s.stopLossValue,
    takeProfitMethod: s.takeProfitMethod,
    takeProfitValue: s.takeProfitValue,
    oneTradeAtATime: s.oneTradeAtATime,
    exitTimeoutBars: s.exitTimeoutBars,
    dailySignalCap: s.dailySignalCap,
    cooldownMinutes: s.cooldownMinutes,
    sessionFilter: s.sessionFilter,
  }
}

// 预设条件必须深拷贝再进 Draft：`templates()` 的响应被缓存在页面 state 里，
// 直接把同一个对象引用塞进 Draft，用户改条件参数时会就地改掉这份缓存——下次再
// 从同一个预设起步就不是原始预设了。
// Deep-copy a preset's conditions before they enter a Draft: the templates()
// response is cached in page state, so handing the same object reference to the
// Draft would let param edits mutate that cache in place — starting from the same
// preset a second time would no longer give the original.
function cloneEnvelope(payload: ConditionPayload): ConditionPayload {
  return JSON.parse(JSON.stringify(payload)) as ConditionPayload
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
  // 指标与用法目录：可选周期、条件数上限、指标清单全部来自它，前端不带副本。
  // The indicator/usage catalogue: selectable intervals, the condition cap and the
  // indicator list all come from it; the frontend keeps no copy.
  catalog: UsageCatalog
  onChange: (d: Draft) => void
  onCancel: () => void
  onSaved: (s: UserStrategy) => void
  onBacktestResult: (strategyId: string | null, result: StrategyBacktestResult) => void
}

function StrategyEditor({
  draft, activeSymbols, allSymbols, catalog, onChange, onCancel, onSaved, onBacktestResult,
}: StrategyEditorProps) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const canSave = draft.rules.conditions.length > 0 && draft.symbol !== '' && draft.interval !== ''

  // 品种与周期各改三处：顶层两个字段 + rules 里那一份。后端要求两处完全相等，
  // 只改顶层会在保存时 400。
  // Changing the symbol or interval touches three places: the two top-level
  // fields plus the copy inside `rules`. The backend requires them to be equal,
  // so updating only the top level would 400 on save.
  const pickSymbol = (symbol: string) => {
    onChange({ ...draft, symbol, rules: { ...draft.rules, symbol } })
  }

  const pickInterval = (interval: string) => {
    onChange({ ...draft, interval, rules: { ...draft.rules, interval } })
  }

  const save = async (enabled: boolean) => {
    setSaving(true)
    setSaveError(null)
    try {
      const payload = {
        name: draft.name.trim() || null,
        rules: draft.rules,
        symbol: draft.symbol,
        interval: draft.interval,
        stopLossMethod: draft.stopLossMethod,
        stopLossValue: draft.stopLossValue,
        takeProfitMethod: draft.takeProfitMethod,
        takeProfitValue: draft.takeProfitValue,
        oneTradeAtATime: draft.oneTradeAtATime,
        exitTimeoutBars: draft.exitTimeoutBars,
        dailySignalCap: draft.dailySignalCap,
        cooldownMinutes: draft.cooldownMinutes,
        // 恒定传出（含 null）：后端 update_strategy 用 model_fields_set 判断，
        // 显式 null 才能把已设的时段过滤清回不限制。
        // Always sent (null included): the backend's update_strategy keys off
        // model_fields_set, so an explicit null is what clears a set session.
        sessionFilter: draft.sessionFilter,
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
      {/* 基本信息：命名 + 品种（单选）+ 周期（单选）
          Basics: name, symbol (single), interval (single) */}
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
        {/* 从预设起步的新草稿：说清规则已经载入且完全可改，预设不是黑盒。
            A new draft started from a preset: state that the rules are loaded and
            fully editable — a preset isn't an opaque box. */}
        {!draft.id && draft.template && (
          <p className="mt-1.5 text-xs text-prism-200/80">{t('strategy.presetLoaded')}</p>
        )}

        {/* 一条策略只盯一个组合，所以品种与周期都是单选。说清这一点，用户才知道
            "想覆盖更多组合" 的做法是多建几条而不是在这里多选。
            One strategy watches one pair, so both pickers are single-select. Saying
            so is what tells the user that covering more pairs means creating more
            strategies rather than multi-selecting here. */}
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{t('strategy.singlePairHint')}</p>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-slate-500" id="draft-symbol-label">
            {t('strategy.symbolLabel')}
          </span>
          {/* 一组互斥选项用 radiogroup 语义，读屏能播报"n 项中的第 m 项"以及当前选中
              的是哪一个，而不是把它们读成一堆孤立按钮。
              A mutually exclusive set gets radiogroup semantics so a screen reader
              announces "m of n" and which one is selected, rather than reading a
              pile of unrelated buttons. */}
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="draft-symbol-label">
            {/* 未接入行情的品种置灰并标注原因（spec 验收标准第 4 条）：此前用户能选
                中它，然后只得到一个没有解释的 insufficientData。
                Symbols without a live feed grey out with the reason stated (spec
                acceptance criterion 4): they used to be selectable, yielding only an
                unexplained insufficientData later. */}
            {allSymbols.map((sym) => {
              const fed = activeSymbols.includes(sym)
              const on = draft.symbol === sym
              return (
                <button
                  key={sym}
                  type="button"
                  role="radio"
                  disabled={!fed}
                  title={fed ? undefined : t('strategy.symbolNotFed')}
                  aria-checked={on}
                  onClick={() => pickSymbol(sym)}
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
          <span className="text-[11px] uppercase tracking-wide text-slate-500" id="draft-interval-label">
            {t('strategy.intervalLabel')}
          </span>
          {/* 可选周期来自 usages 目录，不是前端常量：后端加减一档周期时这里跟着变。
              The selectable intervals come from the usages catalogue rather than a
              frontend constant, so adding or dropping one backend-side lands here. */}
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="draft-interval-label">
            {catalog.intervals.map((code) => (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={draft.interval === code}
                onClick={() => pickInterval(code)}
                className={segBtn(draft.interval === code)}
              >
                {intervalLabel(code)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 入场条件：只编辑做多方向的一列条件。做空侧由后端按每个用法登记的镜像
          用法推出，这里没有对应的编辑区，所以必须明说，否则用户会以为漏了一半。
          Entry conditions: only the long direction's list is edited here. The short
          side is derived from each usage's registered mirror, and since there's no
          editor for it, that has to be stated or users assume half is missing. */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <h4 className="text-sm font-semibold text-slate-300">{t('strategy.sectionConditions')}</h4>
        <div className="mt-3">
          <ConditionList
            logic={draft.rules.logic}
            conditions={draft.rules.conditions}
            indicators={catalog.indicators}
            maxConditions={catalog.maxConditions}
            onChange={({ logic, conditions }) => onChange({ ...draft, rules: { ...draft.rules, logic, conditions } })}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('strategy.condShortHint')}</p>
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

        {/* 交易时段过滤：与每日上限、冷却同属"什么时候允许入场"这一组约束。
            Session filter: same "when may we enter" group as the daily cap and
            cooldown. */}
        <div className="mt-4">
          <SessionFilterField
            value={draft.sessionFilter}
            onChange={(sessionFilter) => onChange({ ...draft, sessionFilter })}
          />
        </div>
      </div>

      {/* 回测 / backtest */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <BacktestPanel
          rules={draft.rules}
          symbol={draft.symbol}
          interval={draft.interval}
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
  const [presets, setPresets] = useState<StrategyPresets | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)
  // 指标与用法目录。新建草稿的初始条件、可选周期、条件数上限都要用它，所以目录
  // 没到手之前不能进编辑器——凭空造条件就是在前端复制一份会漂移的规格副本。
  // The indicator/usage catalogue. A new draft's first condition, the selectable
  // intervals and the condition cap all come from it, so the editor stays shut
  // until it arrives: inventing a condition here would fork the spec.
  const [catalog, setCatalog] = useState<UsageCatalog | null>(null)
  // 打开「新建」时先进预设选择，选完才进编辑器 / show the preset picker first
  const [picking, setPicking] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<UserStrategy | null>(null)
  const [orderTarget, setOrderTarget] = useState<StrategySignal | null>(null)
  const [clearingSignals, setClearingSignals] = useState(false)
  const [confirmClearSignals, setConfirmClearSignals] = useState(false)
  // 每秒走一次的时钟，驱动信号 TTL 到期时的实时置灰。
  // A 1s clock driving live grey-out when a signal's TTL expires.
  const [now, setNow] = useState(() => Date.now())

  useBackToClose(draft != null, () => setDraft(null))
  useBackToClose(picking, () => setPicking(false))
  useBackToClose(deleteTarget != null, () => setDeleteTarget(null))
  useBackToClose(orderTarget != null, () => setOrderTarget(null))
  useBackToClose(confirmClearSignals, () => setConfirmClearSignals(false))

  const isPro = user?.plan === 'PRO'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // coverage 不传参：拿"当前有报价的全部品种"，用于把未接入品种也列出来并置灰。
      // 这几个请求互不依赖，并行发出。
      // coverage with no args returns every currently quoted symbol, so unfed ones
      // can still be listed (greyed out). These requests are all independent.
      // templates() 单独 catch：预设拿不到不该让整页加载失败——策略列表、信号、
      // 覆盖度都与它无关。
      // templates() catches on its own: failing to fetch presets must not fail
      // the whole page — the list, signals and coverage don't depend on them.
      // usages() 也单独 catch：目录拿不到只该挡住编辑器，策略列表与信号照样能看。
      // usages() catches on its own too: a missing catalogue should only hold the
      // editor back, leaving the list and signals readable.
      const [tRes, uRes, sRes, sigRes, covRes] = await Promise.all([
        strategyApi.templates().catch((e) => {
          setPresetError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
          return null
        }),
        strategyApi.usages().catch(() => null),
        strategyApi.list(),
        strategyApi.signals(20),
        strategyApi.coverage(),
      ])
      if (tRes) {
        setPresets(tRes.presets)
        setPresetError(null)
      }
      if (uRes) setCatalog(uRes)
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

  const openNewDraft = () => {
    setPresetError(null)
    setPicking(true)
  }

  // template 为 null 表示从空白开始；否则载入该预设的条件列表（深拷贝）。
  // 预设只有 logic + conditions，品种与周期得用草稿当前选中的那一对补齐才是一份
  // 完整的 rules——后端要求 rules 里的两项与顶层完全相等。
  // A null template means start blank; otherwise load that preset's conditions
  // (deep-copied). A preset carries only logic + conditions, so the draft's own
  // symbol/interval are spliced in to make a complete `rules`: the backend
  // requires those two to equal the top-level fields exactly.
  const startFromPreset = (template: StrategyTemplateKey | null) => {
    if (!catalog) return
    // 默认周期优先 15m：目录按周期长短排序，第一项是 1m，而 1m 上噪声远多于信号，
    // 拿它当新手默认值只会让第一次回测看起来一塌糊涂。目录里没有 15 才退回首项。
    // Default to 15m when offered: the catalogue is ordered by length so the first
    // entry is 1m, where noise swamps signal — a poor default that would make a
    // beginner's first backtest look broken. Falls back to the first entry.
    const interval = catalog.intervals.includes('15') ? '15' : catalog.intervals[0] ?? '15'
    const base = emptyDraft(activeSymbols[0] ?? allSymbols[0] ?? 'XAUUSD', interval, catalog)
    const preset = template != null ? presets?.[template] : null
    setDraft(
      preset != null
        ? {
            ...base,
            template,
            rules: cloneEnvelope({ ...preset, symbol: base.symbol, interval: base.interval }),
          }
        : base,
    )
    setPicking(false)
  }

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
          {/* 目录拿不到时禁用新建：新草稿的第一条条件必须由目录给出，放进去只会
              得到一个编不出合法条件的空编辑器。
              New drafts are disabled without the catalogue: a new draft's first
              condition has to come from it, and going ahead would only open an
              editor that can't produce a valid condition. */}
          {isPro && !draft && (
            <button
              type="button"
              onClick={openNewDraft}
              disabled={!catalog}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-prism-400/50 hover:text-prism-200 disabled:cursor-not-allowed disabled:opacity-40"
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

      {picking && (
        <PresetPicker
          options={
            presets
              ? (Object.keys(presets) as StrategyTemplateKey[]).map((key) => ({
                  key,
                  label: t(TEMPLATE_LABEL_KEYS[key]),
                }))
              : []
          }
          loading={presets == null && presetError == null}
          error={presetError}
          onStart={startFromPreset}
          onCancel={() => setPicking(false)}
        />
      )}

      {/* 目录未到手（拉取失败）时不渲染编辑器：指标清单、可选周期、条件数上限全靠
          它，缺了只能编出必然被后端拒掉的条件。这里显示加载态而不是空白编辑器。
          No editor without the catalogue (i.e. its fetch failed): the indicator
          list, selectable intervals and condition cap all come from it, and without
          them the only thing editable is a payload the backend will reject. Show a
          loading state rather than an empty editor. */}
      {draft && !catalog && (
        <section className="glass mb-5 p-5 text-center text-sm text-slate-500">{t('common.loading')}</section>
      )}

      {draft && catalog && (
        <StrategyEditor
          draft={draft}
          activeSymbols={activeSymbols}
          allSymbols={allSymbols.length > 0 ? allSymbols : activeSymbols}
          catalog={catalog}
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
