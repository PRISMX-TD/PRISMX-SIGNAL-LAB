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
import { useDocumentTitle } from '../utils/useDocumentTitle'

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

// 每个预设的一句话说明。这些文案 i18n 里一直有（templateXxxDesc），但自从模板
// 参数表单被条件编辑器取代后就没有出口了——预设选择器只显示名字，"MACD 金叉死叉"
// 对新手不构成信息。推荐卡片把它们放回界面上。
// One-line description per preset. These strings have always existed in i18n
// (templateXxxDesc) but lost their surface when the template param form gave way
// to the condition editor: the picker showed names only, and "MACD Cross" tells a
// beginner nothing. The recommendation cards put them back on screen.
const TEMPLATE_DESC_KEYS: Record<StrategyTemplateKey, string> = {
  ma_trend: 'strategy.templateMaTrendDesc',
  macd_cross: 'strategy.templateMacdCrossDesc',
  rsi_reversal: 'strategy.templateRsiReversalDesc',
  bollinger_breakout: 'strategy.templateBollingerBreakoutDesc',
  donchian_breakout: 'strategy.templateDonchianBreakoutDesc',
  macd_rsi_combo: 'strategy.templateMacdRsiComboDesc',
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
  // 这条策略是从旧 AST 结构载入的，条件已被换成初始值，需要用户重新配置后再保存。
  // 只用于在编辑器里显示提示，不参与提交。
  // This draft was loaded from a legacy AST strategy and its conditions were
  // replaced with a starting value, so the user has to reconfigure before saving.
  // Display-only; never submitted.
  legacyRules?: boolean
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

// 旧 AST 结构的策略在库里原样留着：迁移只把它们停用，没有重写 rules（旧 AST 的
// 表达力超出新结构，自动映射只能是猜测）。所以接口照样会把 { long, short } 这种
// 形状发过来，编辑器一读 rules.conditions 就是 undefined。
// 这里识别出来并换成一条合法初始条件，配合 legacyRules 提示让用户重新配置——直接
// 放行会让「点编辑就白屏」，而白屏比要求重配一次坏得多。
// Legacy-AST strategies stay in the database as-is: the migration only disabled
// them and left `rules` untouched (the old AST out-expresses the new structure,
// so any mapping would be guesswork). The API therefore still serves shapes like
// { long, short }, where the editor reads rules.conditions as undefined.
// This detects them and substitutes one valid starting condition, paired with the
// legacyRules notice so the user reconfigures — passing them through would mean a
// blank screen on clicking edit, which is far worse than asking for a redo.
const isLegacyRules = (rules: ConditionPayload | undefined | null): boolean =>
  !rules || !Array.isArray(rules.conditions) || rules.conditions.length === 0

function draftFromStrategy(s: UserStrategy, catalog: UsageCatalog): Draft {
  const legacy = isLegacyRules(s.rules)
  const base = emptyDraft(s.symbol, s.interval, catalog)
  return {
    id: s.id,
    template: s.template,
    name: s.name ?? '',
    rules: legacy ? base.rules : { ...s.rules, symbol: s.symbol, interval: s.interval },
    legacyRules: legacy,
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
  // 全部候选品种（含未接入的）：来自 /strategies/symbols，语义是"有历史数据、能
  // 回测"，刻意比 activeSymbols 更宽，让用户看到"这个品种存在但没接入"，而不是
  // 干脆看不到它。两者同源的话置灰永不生效。
  // Every candidate symbol including unfed ones, from /strategies/symbols, meaning
  // "has history, can be backtested" — deliberately wider than activeSymbols so the
  // user sees "this symbol exists but isn't fed" rather than not seeing it at all.
  // Were the two the same source, nothing would ever grey out.
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
  // 分步向导：4 步只切换显示，草稿始终是同一份对象——每一步的改动立刻写进 draft，
  // 不做"分步暂存、最后合并"，否则往回退一步就会丢掉刚填的东西。
  // A 4-step wizard that only switches what's visible: the draft stays one
  // object and every edit lands in it immediately. No per-step staging with a
  // merge at the end — that loses what you just typed the moment you step back.
  const [step, setStep] = useState(0)
  // 「下一步」被条件为空挡住时的说明。不显示原因的禁用按钮就是个坏掉的按钮。
  // Why "next" refused. A disabled button with no reason is a broken button.
  const [stepError, setStepError] = useState<string | null>(null)
  // 超时平仓 / 每日上限 / 冷却 / 交易时段四项默认收起：它们都可以留空，摊开会让
  // 风险这一步看起来有八个必填项。
  // Timeout / daily cap / cooldown / session start collapsed: all four are
  // optional, and unfolded they make the risk step look like eight required
  // fields.
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 编辑已有策略时四步全部解锁：这份配置早就是完整的，逼着人从第 1 步点到第 4 步
  // 只为了改一个止损数字，是把新手引导变成所有人的过路费。
  // Editing an existing strategy unlocks all four steps: that config is already
  // complete, and walking from step 1 to step 4 just to change one stop-loss value
  // would turn beginner guidance into a toll everyone pays.
  const editing = draft.id != null

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
        ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-neutral-500'
        : active
          ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
          : 'border-white/10 bg-white/5 text-neutral-400 hover:text-neutral-100'
    }`

  const steps = [
    { key: 'stepBasics', hint: 'stepBasicsHint' },
    { key: 'stepConditions', hint: 'stepConditionsHint' },
    { key: 'stepRisk', hint: 'stepRiskHint' },
    { key: 'stepReview', hint: 'stepReviewHint' },
  ] as const

  // 只有「条件为空」会挡住前进：品种与周期在新草稿里就有值（emptyDraft 给的），
  // 挡不住也没必要挡；条件是唯一能被用户删空、且删空必然导致保存 400 的一项。
  // Only an empty condition list blocks progress: the symbol and interval always
  // arrive filled from emptyDraft, while conditions are the one thing a user can
  // empty — and emptying them guarantees a 400 on save.
  const goNext = () => {
    if (step === 1 && draft.rules.conditions.length === 0) {
      setStepError(t('strategy.stepNeedConditions'))
      return
    }
    setStepError(null)
    setStep((s) => Math.min(steps.length - 1, s + 1))
  }

  const riskSummary = `${
    draft.stopLossMethod === 'percent'
      ? `${draft.stopLossValue}%`
      : draft.stopLossMethod === 'steps'
        ? `${draft.stopLossValue}p`
        : `${draft.stopLossValue}×ATR`
  } / ${
    draft.takeProfitMethod === 'rr'
      ? `${draft.takeProfitValue}R`
      : draft.takeProfitMethod === 'percent'
        ? `${draft.takeProfitValue}%`
        : draft.takeProfitMethod === 'steps'
          ? `${draft.takeProfitValue}p`
          : `${draft.takeProfitValue}×ATR`
  }`

  return (
    <section className="glass mb-5 p-5">
      {/* 步骤条：既是进度，也是导航——已经走过的步骤可以点回去改，没走到的不能跳，
          否则会跳过那一步的说明文字（新手唯一的解释来源）。
          The stepper is progress and navigation both: visited steps are clickable
          for edits, unvisited ones aren't, since jumping ahead skips that step's
          explanatory copy — a beginner's only source of it. */}
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
        {steps.map((s, i) => {
          const done = i < step
          const current = i === step
          const reachable = editing || i <= step
          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => { if (reachable) { setStepError(null); setStep(i) } }}
                disabled={!reachable}
                aria-current={current ? 'step' : undefined}
                className={`flex items-center gap-2 rounded-pill border px-3 py-1.5 text-xs transition ${
                  current
                    ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
                    : reachable
                      ? 'border-white/10 bg-white/5 text-neutral-300 hover:border-prism-400/40'
                      : 'cursor-default border-white/5 bg-white/[0.02] text-neutral-500'
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ${
                    current ? 'bg-prism-500 text-white' : done ? 'bg-up/20 text-up' : 'bg-white/5 text-neutral-500'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                {t(`strategy.${s.key}`)}
              </button>
              {i < steps.length - 1 && <span aria-hidden className="text-neutral-700">·</span>}
            </li>
          )
        })}
      </ol>

      <div className="mt-4">
        <p className="text-[11px] uppercase tracking-wide text-neutral-500">
          {t('strategy.stepOf', { n: step + 1, total: steps.length })}
        </p>
        <h4 className="mt-1 font-display text-base font-semibold text-neutral-100">{t(`strategy.${steps[step].key}`)}</h4>
        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-neutral-400">{t(`strategy.${steps[step].hint}`)}</p>
      </div>

      {/* 第 1 步 · 选市场：命名 + 品种（单选）+ 周期（单选）
          Step 1 · market: name, symbol (single), interval (single) */}
      <div className={step === 0 ? 'mt-5' : 'hidden'}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-neutral-500">{t('strategy.name')}</span>
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
        <p className="mt-3 text-xs leading-relaxed text-neutral-500">{t('strategy.singlePairHint')}</p>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-neutral-500" id="draft-symbol-label">
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
          <span className="text-[11px] uppercase tracking-wide text-neutral-500" id="draft-interval-label">
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

      {/* 第 2 步 · 设条件：只编辑做多方向的一列条件。做空侧由后端按每个用法登记的
          镜像用法推出，这里没有对应的编辑区，所以必须明说，否则用户会以为漏了一半。
          Step 2 · conditions: only the long direction's list is edited here. The
          short side is derived from each usage's registered mirror, and since
          there's no editor for it, that has to be stated or users assume half is
          missing. */}
      <div className={step === 1 ? 'mt-5' : 'hidden'}>
        {/* 当前盯的市场回显：条件这一步看不到第 1 步的选择，而「上穿均线」在
            XAUUSD 5 分钟和 EURUSD 日线上是完全不同的两回事。
            Echo the market being watched: step 2 hides step 1's choice, and "cross
            above the MA" means two different things on XAUUSD 5m and EURUSD 1d. */}
        <p className="text-xs text-neutral-500">
          {t('strategy.reviewMarket')}:{' '}
          <span className="text-neutral-300">{displaySymbol(draft.symbol)} · {intervalLabel(draft.interval)}</span>
        </p>
        {/* 旧结构策略的条件已被换成初始值，不说清楚的话用户会以为自己原来的条件
            还在，保存后才发现被替换了。
            A legacy strategy's conditions were replaced with a starting value;
            unsaid, the user assumes their original conditions survived and only
            finds out after saving. */}
        {draft.legacyRules && (
          <p className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-200/90">
            {t('strategy.legacyRulesReset')}
          </p>
        )}
        <div className="mt-3">
          <ConditionList
            logic={draft.rules.logic}
            conditions={draft.rules.conditions}
            indicators={catalog.indicators}
            maxConditions={catalog.maxConditions}
            onChange={({ logic, conditions }) => onChange({ ...draft, rules: { ...draft.rules, logic, conditions } })}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">{t('strategy.condShortHint')}</p>
      </div>

      {/* 第 3 步 · 管风险：止损 / 止盈各一张卡，方式与数值紧挨着，各带一句人话解释
          Step 3 · risk: one card each for SL and TP, method next to its value,
          each with a plain-language line under it */}
      <div className={step === 2 ? 'mt-5' : 'hidden'}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">{t('strategy.stopLossMethod')}</span>
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
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">{t('strategy.stopLossHint')}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <span className="text-[11px] uppercase tracking-wide text-neutral-500">{t('strategy.takeProfitMethod')}</span>
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
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">{t('strategy.takeProfitHint')}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-neutral-500">{t('strategy.oneTradeAtATime')}</span>
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
          <p className="text-xs leading-relaxed text-neutral-500">
            {draft.oneTradeAtATime ? t('strategy.oneTradeAtATimeOnHint') : t('strategy.oneTradeAtATimeOffHint')}
          </p>
          <p className="text-xs leading-relaxed text-prism-200/70">{t('strategy.oneTradeHint')}</p>
        </div>

        {/* 高级设置默认收起：超时平仓 / 每日上限 / 冷却 / 交易时段这四项全部可空，
            但摊在必填项旁边会被当成"还有四个要填的"。折叠不改变提交内容——收起时
            照样按当前值提交，只是不占视觉预算。
            The advanced group is collapsed by default: timeout / daily cap /
            cooldown / session are all nullable, yet sitting beside required fields
            they read as four more things to fill in. Collapsing changes nothing
            about what is submitted; it only stops them spending visual budget. */}
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02]">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
          >
            <span>
              <span className="text-sm text-neutral-200">{t('strategy.advancedToggle')}</span>
              {!showAdvanced && (
                <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500">{t('strategy.advancedHint')}</span>
              )}
            </span>
            <span aria-hidden className={`shrink-0 text-xs text-neutral-400 transition ${showAdvanced ? 'rotate-180' : ''}`}>▾</span>
          </button>

          <div className={showAdvanced ? 'border-t border-white/10 p-3' : 'hidden'}>
            {/* 超时平仓 / 每日上限 / 冷却：三个可空设定，0 视为不启用（写 null）
                Timeout exit / daily cap / cooldown: three nullable settings, where
                0 means "off" and is sent as null */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">{t('strategy.optionalZeroHint')}</p>

            {/* 交易时段过滤：与每日上限、冷却同属"什么时候允许入场"这一组约束。
                Session filter: same "when may we enter" group as the daily cap and
                cooldown. */}
            <div className="mt-4 border-t border-white/10 pt-4">
              <SessionFilterField
                value={draft.sessionFilter}
                onChange={(sessionFilter) => onChange({ ...draft, sessionFilter })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 第 4 步 · 回测并启用：先把前三步的选择摊成一句可核对的摘要，再是回测面板。
          回测跑的是这份摘要，摘要对不上就没必要跑。
          Step 4 · backtest and enable: the first three steps' choices condensed
          into one checkable summary, then the backtest panel. The run uses exactly
          this summary, so a wrong summary means there's nothing worth running. */}
      <div className={step === 3 ? 'mt-5' : 'hidden'}>
        <div className="rounded-lg border border-prism-500/20 bg-prism-600/5 p-3.5">
          <p className="text-sm font-medium text-neutral-200">{t('strategy.reviewTitle')}</p>
          <dl className="mt-2.5 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-neutral-500">{t('strategy.reviewMarket')}</dt>
              <dd className="mt-0.5 font-mono text-neutral-100">
                {displaySymbol(draft.symbol)} · {intervalLabel(draft.interval)}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">{t('strategy.reviewConditions')}</dt>
              <dd className="mt-0.5 text-neutral-100">
                {t('strategy.reviewConditionsValue', {
                  count: draft.rules.conditions.length,
                  logic: draft.rules.logic === 'OR' ? t('strategy.condLogicOr') : t('strategy.condLogicAnd'),
                })}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500">{t('strategy.reviewRisk')}</dt>
              <dd className="mt-0.5 font-mono text-neutral-100">{riskSummary}</dd>
            </div>
          </dl>
        </div>

        <div className="mt-5">
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
      </div>

      {stepError && <p className="mt-3 text-sm text-amber-200" role="alert">{stepError}</p>}
      {saveError && <p className="mt-3 text-sm text-down" role="alert">{saveError}</p>}

      {/* 导航条：前三步只有"下一步"，保存按钮只在最后一步出现——中途就能保存会让
          "先回测再启用"这条主张失去约束力。取消始终在最右，位置不随步骤移动。
          The nav bar: the first three steps only offer "next", and the save buttons
          appear only on the last one — a mid-flow save would strip all force from
          "backtest before you enable". Cancel stays far right at every step. */}
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
        {step > 0 && (
          <button
            type="button"
            onClick={() => { setStepError(null); setStep((s) => s - 1) }}
            disabled={saving}
            className="rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-neutral-300 transition hover:text-white disabled:opacity-40"
          >
            {t('strategy.stepPrev')}
          </button>
        )}
        {step < steps.length - 1 && (
          <button
            type="button"
            onClick={goNext}
            className={
              editing
                ? 'rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-neutral-300 transition hover:text-white'
                : 'btn-primary px-5 py-2 text-sm'
            }
          >
            {t('strategy.stepNext')}
          </button>
        )}
        {/* 保存按钮：新建时只在最后一步出现（先回测再启用），编辑时每一步都在
            ——改一个数字就得走到第 4 步才能存，是在惩罚会用的人。
            The save buttons appear only on the last step when creating (backtest
            before you enable), but on every step when editing: making someone walk
            to step 4 to save one changed number punishes the users who know how
            this works. */}
        {(editing || step === steps.length - 1) && (
          <>
            <button type="button" onClick={() => save(true)} disabled={saving || !canSave} className="btn-primary px-5 py-2 text-sm disabled:opacity-40">
              {t('strategy.saveAndEnable')}
            </button>
            <button
              type="button"
              onClick={() => save(false)}
              disabled={saving || !canSave}
              className="rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-neutral-300 transition hover:text-white disabled:opacity-40"
            >
              {t('strategy.saveOnly')}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="ml-auto rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm text-neutral-400 transition hover:text-white"
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
  // 分区加载态而非全页一个开关。此前是 Promise.all 全部落地才渲染，任何一个请求
  // 慢下来整页就是白屏加转圈——策略列表明明已经到手也不上屏。
  // 「已加载」与「数据为空」必须是两个独立状态：合成一个的话，新用户会先闪一次
  // 「还没有创建任何策略」，老用户会看到自己的策略凭空出现。
  // Per-section loading rather than one page-wide switch. It used to wait for all
  // of Promise.all before rendering, so one slow request meant a blank page with
  // a spinner even though the strategy list had already arrived.
  // "Loaded" and "empty" must stay separate: conflated, a new user sees a flash
  // of "no strategies yet" and an existing one watches their strategies pop in.
  const [strategiesLoaded, setStrategiesLoaded] = useState(false)
  const [signalsLoaded, setSignalsLoaded] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [signalsError, setSignalsError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [presets, setPresets] = useState<StrategyPresets | null>(null)
  const [presetError, setPresetError] = useState<string | null>(null)
  // 指标与用法目录。新建草稿的初始条件、可选周期、条件数上限都要用它，所以目录
  // 没到手之前不能进编辑器——凭空造条件就是在前端复制一份会漂移的规格副本。
  // The indicator/usage catalogue. A new draft's first condition, the selectable
  // intervals and the condition cap all come from it, so the editor stays shut
  // until it arrives: inventing a condition here would fork the spec.
  const [catalog, setCatalog] = useState<UsageCatalog | null>(null)
  // 目录拉取失败必须能看见。此前这里是静默 catch，结果是「点按钮毫无反应」——
  // 编辑器靠 catalog 才能开，拿不到就每次点击都被挡掉，而用户看不到任何原因。
  // A failed catalogue fetch has to be visible. This used to be a silent catch,
  // which surfaced as buttons that simply do nothing: the editor needs the
  // catalogue to open, so every click was refused with no reason shown.
  const [catalogError, setCatalogError] = useState<string | null>(null)
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
    // 每个请求自己落地、自己报错、自己结束加载态。不用 Promise.all 的返回值：
    // 那样又会退回"等最慢的那个"。此前 list/signals/coverage 三个共用失败路径，
    // 任一失败即整页空白且没有任何提示。
    // Each request lands, reports and clears its own loading state. The
    // Promise.all result isn't used, since that would go back to waiting for the
    // slowest. list/signals/coverage used to share a failure path, so any one of
    // them failing left the whole page blank with nothing explaining why.
    const list = strategyApi
      .list()
      .then((r) => {
        setStrategies(r.strategies)
        setListError(null)
      })
      .catch((e) => {
        setListError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
      })
      .finally(() => setStrategiesLoaded(true))

    const signals = strategyApi
      .signals(20)
      .then((r) => {
        setSignals(r.signals)
        setSignalsError(null)
      })
      .catch((e) => {
        setSignalsError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
      })
      .finally(() => setSignalsLoaded(true))

    // 品种名单走专用端点：coverage 不传参会对每个 (品种, 周期) 组合各算一行
    // （42 个），而这里只需要品种名。统计数字由回测面板按当前选中的那一对单独拉取。
    // The symbol list comes from a dedicated endpoint: an argument-less coverage
    // computes a row per (symbol, interval) pair (42 of them) when all that's
    // needed here are the names. The statistics are fetched by the backtest panel
    // for the one pair it's showing.
    const symbols = strategyApi
      .symbolsWithHistory()
      .then((r) => {
        // 候选集取并集：刚接入、还没落下第一根收盘 K 线的品种在推但表里没有，
        // 不能因此从候选里消失；反之断线品种表里有、不在推，正是要被置灰的那些。
        // Union of both: a freshly fed symbol with no closed bar yet is pushing
        // but absent from the table and must not vanish from the candidates; a
        // disconnected one is in the table but not pushing, which is exactly
        // what gets greyed out.
        setAllSymbols(Array.from(new Set([...r.symbols, ...r.activeSymbols])))
      })
      // 名单拿不到只影响编辑器里的品种按钮，页面其余部分照常。编辑器那边有
      // activeSymbols 兜底（见渲染处的 allSymbols.length > 0 判断）。
      // A missing list only affects the editor's symbol buttons; the rest of the
      // page carries on. The editor falls back to activeSymbols (see the
      // allSymbols.length > 0 check at the render site).
      .catch(() => {})

    // 预设与目录各自 catch，语义与此前一致：预设拿不到不该让整页失败，目录拿不到
    // 只该挡住编辑器。
    // Presets and the catalogue each catch on their own, as before: missing
    // presets must not fail the page, and a missing catalogue should only hold
    // the editor back.
    const templates = strategyApi
      .templates()
      .then((r) => {
        setPresets(r.presets)
        setPresetError(null)
      })
      .catch((e) => {
        setPresetError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
      })

    const usages = strategyApi
      .usages()
      .then((r) => {
        setCatalog(r)
        setCatalogError(null)
      })
      .catch((e) => {
        setCatalogError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
      })

    await Promise.all([list, signals, symbols, templates, usages])
  }, [])

  useDocumentTitle(t('strategy.title'))
  useEffect(() => { load() }, [load])

  // 绩效逐个策略拉取（端点是 /{id}/performance，没有批量形态）。失败的那个静默跳过，
  // 不能因为一个策略的绩效 500 就让整页没有绩效。
  // Performance is fetched per strategy (the endpoint is /{id}/performance, with no
  // batch form). A failing one is skipped silently: one strategy's 500 must not
  // strip performance from the whole page.
  useEffect(() => {
    if (strategies.length === 0) return
    let cancelled = false
    strategyApi
      .allPerformance()
      .then((r) => {
        if (cancelled) return
        const next: Record<string, StrategyPerformance> = {}
        r.performance.forEach((p) => { next[p.strategyId] = p })
        setPerformance(next)
      })
      // 绩效拿不到只让卡片少一行数字，策略本身照常可看可编辑。
      // Missing performance only costs the cards a line of numbers; the
      // strategies stay readable and editable.
      .catch(() => {})
    return () => { cancelled = true }
    // 依赖策略数量而非 strategies 本身：这个数组每次 load() 都是新引用，
    // 依赖它会让每轮 45 秒轮询都重拉一次绩效。数量变了才需要重拉。
    // Keyed on the count rather than `strategies`: that array is a fresh
    // reference after every load(), so depending on it would refetch on each
    // 45s poll. Only a change in count needs a refetch.
  }, [strategies.length])

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

  // 目录未到手时不开编辑器：旧结构策略要靠目录才能拿到合法的替代条件，没有它就
  // 只能塞一份空条件，反而把「点编辑就崩」换成「保存必然 400」。
  // Don't open the editor before the catalogue arrives: a legacy-structure
  // strategy needs it to obtain a valid replacement condition, and without one
  // we'd only trade "crashes on edit" for "guaranteed 400 on save".
  const openEditDraft = (s: UserStrategy) => {
    if (!catalog) return
    setDraft(draftFromStrategy(s, catalog))
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

  return (
    <div>
      <div className="mb-5">
        <h2 className="font-display text-2xl font-bold text-neutral-50">{t('strategy.title')}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-neutral-400">{t('strategy.subtitle')}</p>
      </div>

      {!isPro && (
        <div className="glass mb-5 border-prism-500/20 bg-prism-600/5 p-4 text-center text-sm text-neutral-300">
          {t('strategy.proOnlyHint')}{' '}
          <Link to="/upgrade" className="text-prism-300 underline hover:text-prism-200">{t('winrate.viewDetail')}</Link>
        </div>
      )}

      {/* 三步流程说明：这一页的核心误解是"建好就等着赚钱"，而实际流程是挑条件 →
          回测验证 → 才启用。所以说明只在还没有任何策略、或者正在新建时出现——已经
          有在跑的策略的用户不需要每次进来都被讲一遍。
          The three-step explainer: the standing misconception on this page is
          "build it and wait for money", when the real flow is pick → backtest →
          only then enable. It shows only when no strategy exists yet or one is
          being created; a user with running strategies doesn't need the lecture on
          every visit. */}
      {isPro && (strategies.length === 0 || draft != null || picking) && (
        <section className="glass mb-5 p-5">
          <h3 className="font-display text-base font-semibold text-neutral-100">{t('strategy.flowTitle')}</h3>
          <ol className="mt-3.5 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
            {([
              ['flowStep1', 'flowStep1Desc'],
              ['flowStep2', 'flowStep2Desc'],
              ['flowStep3', 'flowStep3Desc'],
            ] as const).map(([label, desc], i) => (
              <li key={label} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-prism-500/40 bg-prism-600/15 font-mono text-xs font-semibold text-prism-200">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-100">{t(`strategy.${label}`)}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-neutral-400">{t(`strategy.${desc}`)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 目录拉不到时新建与编辑都开不了，必须把原因摆在页面上。此前是静默失败，
          用户看到的是「按钮点了没反应」，无从判断是自己点错还是服务出问题。
          Without the catalogue neither creating nor editing can open, so the reason
          belongs on the page. This used to fail silently, leaving the user with
          buttons that do nothing and no way to tell a misclick from an outage. */}
      {catalogError && (
        <div className="glass mb-5 border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-200">
          {t('strategy.catalogUnavailable')} {catalogError}
        </div>
      )}

      {/* 我的策略列表 / my strategies */}
      <section className="glass mb-5 p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-semibold text-neutral-100">{t('strategy.myStrategies')}</h3>
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
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-prism-400/50 hover:text-prism-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('strategy.newStrategy')}
            </button>
          )}
        </div>

        {/* 四态而非两态：未加载显示骨架，失败说明原因，加载完为空才说"还没有策略"。
            把"未加载"与"空"合并会让新用户先看到一次误报的空状态。
            Four states, not two: a skeleton while loading, the reason on failure,
            and "no strategies" only once loaded and actually empty. Merging
            "loading" with "empty" flashes a false empty state at new users. */}
        {!strategiesLoaded ? (
          <div className="mt-4 flex flex-col gap-2" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg border border-white/5 bg-white/[0.03]" />
            ))}
          </div>
        ) : listError ? (
          <div className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-200">
            {t('strategy.listUnavailable')} {listError}
          </div>
        ) : strategies.length === 0 ? (
          <div className="mt-4 py-6 text-center text-sm text-neutral-500">{t('strategy.noStrategies')}</div>
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
                  desc: t(TEMPLATE_DESC_KEYS[key]),
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
        <section className="glass mb-5 p-5 text-center text-sm text-neutral-500">{t('common.loading')}</section>
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
          <h3 className="font-display text-lg font-semibold text-neutral-100">{t('strategy.mySignals')}</h3>
          {signals.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearSignals(true)}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-400 transition hover:border-down/30 hover:text-down"
            >
              {t('strategy.clearSignals')}
            </button>
          )}
        </div>
        {!signalsLoaded ? (
          <div className="mt-4 h-16 animate-pulse rounded-lg border border-white/5 bg-white/[0.03]" aria-busy="true" />
        ) : signalsError ? (
          <div className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-4 text-sm text-amber-200">
            {t('strategy.signalsUnavailable')} {signalsError}
          </div>
        ) : (
          <StrategySignalList signals={signals} now={now} onOrder={setOrderTarget} />
        )}
      </section>

      <p className="text-xs leading-relaxed text-neutral-500">{t('strategy.disclaimer')}</p>

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
