// 管理后台：平台策略介绍编辑器。用户端只读展示在信号面板页的「平台策略」标签下。
//
// 为什么是手工内容而不是从代码读：生产环境的全站信号来自 TradingView Webhook，
// 判定逻辑在平台外部，后端只拿到一个自由文本的 indicator 字段，无从枚举"平台上
// 共有哪些策略"。所以这份清单只能人工声明。
//
// 刻意没有胜率/盈亏比输入框：真实战绩的唯一来源是信号的 result 判定（后端
// services/signal_resolution.py），手填数字会与之冲突，也和落地页"判定规则公开、
// 全量记录"的承诺相抵。这里只填设计特征。riskReward 是下单时的止损止盈之比，
// 属于策略参数，不是业绩数字。
//
// 保存是整表覆盖（PUT /admin/platform-strategies）：编辑的是完整有序清单，
// 逐条 PATCH 反而要处理排序与删除的合并，没有必要。
//
// Admin: the platform strategy write-up editor. Users see these read-only under
// the signals page's "Platform strategies" tab.
//
// Why hand-authored rather than read from code: production signals arrive via
// the TradingView webhook, the decision logic lives outside the platform, and
// the backend only receives a free-text indicator string — it cannot enumerate
// strategies. So this list can only be declared by a human.
//
// Deliberately has no win-rate / profit-factor inputs: the only source of real
// performance is each signal's result adjudication (backend
// services/signal_resolution.py); hand-entered figures would contradict it and
// the landing page's promise of published rules and a complete record. Only
// design characteristics go here. riskReward is the SL/TP ratio used at order
// time — a strategy parameter, not a performance number.
//
// Saving replaces the whole list (PUT /admin/platform-strategies): the admin
// edits a complete ordered list, so per-item PATCH would only add ordering and
// deletion merge problems.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import ImageField from './ImageField'
import StrategyBlocksEditor from './StrategyBlocksEditor'
import type { PlatformStrategy } from '../../api/types'

// catch 里拿到的是 unknown；localizeApiError 只处理"中文 / English"双语串，
// 所以先取出 message 再交给它。/ A catch binding is `unknown`, and
// localizeApiError only handles the "中文 / English" bilingual form, so pull the
// message out first.
function errText(err: unknown): string {
  return localizeApiError(err instanceof Error ? err.message : String(err))
}

function emptyStrategy(order: number): PlatformStrategy {
  return {
    // crypto.randomUUID 在所有目标浏览器可用（本项目已要求 HTTPS 环境）。
    // id 只需稳定唯一，不面向用户展示。
    // crypto.randomUUID is available in every target browser (this project
    // already requires HTTPS). The id only needs to be stable and unique; it is
    // never shown to users.
    id: crypto.randomUUID(),
    order,
    published: false,
    nameZh: '',
    nameEn: '',
    summaryZh: '',
    summaryEn: '',
    blocks: [],
    detailZh: '',
    detailEn: '',
    symbols: [],
    indicators: [],
    timeframes: [],
    marketRegimeZh: '',
    marketRegimeEn: '',
    holdingTimeZh: '',
    holdingTimeEn: '',
    riskReward: '',
    imageUrl: '',
  }
}

// 逗号分隔的标签输入：编辑期保留原始字符串（否则输入中途的逗号会被吃掉），
// 只在提交时切分。/ Comma-separated tag input: the raw string is kept while
// editing (otherwise a comma mid-typing gets swallowed) and split on submit.
function splitTags(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      <input
        className="input w-full py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
      />
    </label>
  )
}

export default function PlatformStrategiesPanel() {
  const { t } = useTranslation()
  const [items, setItems] = useState<PlatformStrategy[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const toastTimer = useRef<number>(undefined)

  const showToast = (kind: 'ok' | 'err', text: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ kind, text })
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => {
    adminApi
      .getPlatformStrategies()
      .then((res) => setItems(res.items))
      .catch((err) => showToast('err', errText(err)))
      .finally(() => setLoading(false))
  }, [])

  const patch = (id: string, changes: Partial<PlatformStrategy>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...changes } : it)))
    setDirty(true)
  }

  const addItem = () => {
    const next = emptyStrategy(items.length)
    setItems((prev) => [...prev, next])
    setOpenId(next.id)
    setDirty(true)
  }

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
    if (openId === id) setOpenId(null)
    setDirty(true)
  }

  // 上下移动：order 是展示排序的唯一依据，交换相邻项后整段重新编号，
  // 避免手工填 order 出现重复值。/ Move up/down: `order` is the sole basis for
  // display ordering; after swapping neighbours the whole list is renumbered so
  // hand-edited values can't collide.
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    setItems((prev) => {
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next.map((it, i) => ({ ...it, order: i }))
    })
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await adminApi.updatePlatformStrategies(items.map((it, i) => ({ ...it, order: i })))
      setItems(res.items)
      setDirty(false)
      showToast('ok', t('admin.strategyGuide.saved'))
    } catch (err) {
      showToast('err', errText(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="glass flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      </div>
    )
  }

  return (
    <div>
      {toast && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}

      <div className="glass mb-4 p-4">
        <p className="text-sm text-neutral-400">{t('admin.strategyGuide.hint')}</p>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">{t('admin.strategyGuide.noPerfHint')}</p>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <button type="button" onClick={addItem} className="btn-ghost px-4 py-1.5 text-sm">
          + {t('admin.strategyGuide.add')}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className="btn-primary px-5 py-1.5 text-sm disabled:opacity-40"
        >
          {saving ? '...' : t('common.save')}
        </button>
        {dirty && <span className="text-xs text-amber-300">{t('admin.strategyGuide.unsaved')}</span>}
      </div>

      {items.length === 0 ? (
        <div className="glass py-12 text-center text-sm text-neutral-500">{t('admin.strategyGuide.empty')}</div>
      ) : (
        <div className="space-y-3">
          {items.map((s, i) => (
            <div key={s.id} className="glass p-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpenId(openId === s.id ? null : s.id)}
                  className="flex-1 text-left text-sm font-medium text-neutral-100"
                >
                  {s.nameZh || s.nameEn || t('admin.strategyGuide.untitled')}
                </button>
                <span
                  className={`tag ${s.published ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'}`}
                >
                  {s.published ? t('admin.strategyGuide.published') : t('admin.strategyGuide.draft')}
                </span>
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={t('admin.strategyGuide.moveUp')}
                  className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-white/10 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === items.length - 1}
                  aria-label={t('admin.strategyGuide.moveDown')}
                  className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-white/10 disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => removeItem(s.id)}
                  className="rounded px-2 py-1 text-xs text-down hover:bg-down/10"
                >
                  {t('common.delete')}
                </button>
              </div>

              {openId === s.id && (
                <div className="mt-4 space-y-3 border-t border-white/10 pt-4">
                  <label className="flex items-center gap-2 text-sm text-neutral-300">
                    <input
                      type="checkbox"
                      checked={s.published}
                      onChange={(e) => patch(s.id, { published: e.target.checked })}
                    />
                    {t('admin.strategyGuide.publishedLabel')}
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label={t('admin.strategyGuide.nameZh')}
                      value={s.nameZh}
                      onChange={(v) => patch(s.id, { nameZh: v })}
                      maxLength={80}
                    />
                    <Field
                      label={t('admin.strategyGuide.nameEn')}
                      value={s.nameEn}
                      onChange={(v) => patch(s.id, { nameEn: v })}
                      maxLength={80}
                    />
                    <Field
                      label={t('admin.strategyGuide.summaryZh')}
                      value={s.summaryZh}
                      onChange={(v) => patch(s.id, { summaryZh: v })}
                      maxLength={300}
                    />
                    <Field
                      label={t('admin.strategyGuide.summaryEn')}
                      value={s.summaryEn}
                      onChange={(v) => patch(s.id, { summaryEn: v })}
                      maxLength={300}
                    />
                  </div>

                  <StrategyBlocksEditor
                    blocks={s.blocks ?? []}
                    onChange={(blocks) => patch(s.id, { blocks })}
                  />

                  {/* 旧的单段说明字段。只在还有内容时显示，让管理员能把它搬进
                      内容块后清空；不再作为新内容的录入口。
                      The legacy single-blob field. Shown only while it still has
                      content, so an admin can move it into blocks and clear it;
                      it is no longer an entry point for new content. */}
                  {(s.detailZh || s.detailEn) && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                      <p className="mb-2 text-xs text-amber-200/80">
                        {t('admin.strategyGuide.legacyDetailHint')}
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <textarea
                          className="input min-h-[80px] w-full resize-y text-sm"
                          value={s.detailZh}
                          onChange={(e) => patch(s.id, { detailZh: e.target.value })}
                          maxLength={8000}
                        />
                        <textarea
                          className="input min-h-[80px] w-full resize-y text-sm"
                          value={s.detailEn}
                          onChange={(e) => patch(s.id, { detailEn: e.target.value })}
                          maxLength={8000}
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label={t('admin.strategyGuide.marketRegimeZh')}
                      value={s.marketRegimeZh}
                      onChange={(v) => patch(s.id, { marketRegimeZh: v })}
                      placeholder={t('admin.strategyGuide.marketRegimePlaceholder')}
                      maxLength={120}
                    />
                    <Field
                      label={t('admin.strategyGuide.marketRegimeEn')}
                      value={s.marketRegimeEn}
                      onChange={(v) => patch(s.id, { marketRegimeEn: v })}
                      maxLength={120}
                    />
                    <Field
                      label={t('admin.strategyGuide.holdingTimeZh')}
                      value={s.holdingTimeZh}
                      onChange={(v) => patch(s.id, { holdingTimeZh: v })}
                      placeholder={t('admin.strategyGuide.holdingTimePlaceholder')}
                      maxLength={120}
                    />
                    <Field
                      label={t('admin.strategyGuide.holdingTimeEn')}
                      value={s.holdingTimeEn}
                      onChange={(v) => patch(s.id, { holdingTimeEn: v })}
                      maxLength={120}
                    />
                    <Field
                      label={t('admin.strategyGuide.riskReward')}
                      value={s.riskReward}
                      onChange={(v) => patch(s.id, { riskReward: v })}
                      placeholder="1:2"
                      maxLength={40}
                    />
                    <ImageField
                      label={t('admin.strategyGuide.imageUrl')}
                      value={s.imageUrl}
                      onChange={(v) => patch(s.id, { imageUrl: v })}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field
                      label={t('admin.strategyGuide.symbols')}
                      value={s.symbols.join(', ')}
                      onChange={(v) => patch(s.id, { symbols: splitTags(v) })}
                      placeholder="XAUUSD, EURUSD"
                    />
                    <Field
                      label={t('admin.strategyGuide.timeframes')}
                      value={s.timeframes.join(', ')}
                      onChange={(v) => patch(s.id, { timeframes: splitTags(v) })}
                      placeholder="M15, H1"
                    />
                    <Field
                      label={t('admin.strategyGuide.indicators')}
                      value={s.indicators.join(', ')}
                      onChange={(v) => patch(s.id, { indicators: splitTags(v) })}
                      placeholder="EMA(50), RSI(14)"
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
