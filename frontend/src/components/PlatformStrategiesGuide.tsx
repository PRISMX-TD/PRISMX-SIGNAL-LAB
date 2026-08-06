// 平台策略介绍（用户端只读）：挂在信号面板页的第二个标签下。
//
// 内容由管理员在后台维护（管理者页面 → 策略介绍），不是从代码枚举出来的——
// 生产环境的全站信号来自 TradingView Webhook，判定逻辑在平台外部，后端只拿到
// 一个自由文本的 indicator 字段，无从知道"平台上共有哪些策略"。
//
// 刻意不展示胜率、盈亏比等业绩数字：真实战绩的唯一来源是信号自身的 result
// 判定（后端 services/signal_resolution.py），落地页也承诺过判定规则公开、
// 全量记录。这里只描述策略的设计特征——适用行情、持仓时长、风险回报比设计值、
// 所用指标。风险回报比是策略参数（下单时的止损止盈之比），不是业绩承诺。
//
// Platform strategy write-ups (read-only), the second tab of the signals page.
//
// Content is admin-maintained (Admin page → Strategy write-ups) rather than
// enumerated from code: in production every shared signal arrives via the
// TradingView webhook, the decision logic lives outside the platform, and the
// backend only receives a free-text indicator string.
//
// Deliberately shows no win-rate or profit-factor figures: the only source of
// real performance is each signal's own result adjudication (backend
// services/signal_resolution.py), and the landing page promises published rules
// and a complete record. This describes design characteristics only — market
// regime, holding time, designed risk:reward, indicators used. Risk:reward is a
// strategy parameter (the SL/TP ratio at order time), not a performance claim.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signalApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import type { PlatformStrategy } from '../api/types'

// 按当前界面语言取字段，缺失时回落到另一种语言——管理员可能只填了一种，
// 空白比串语言更糟。/ Pick the field for the current UI language, falling back
// to the other one: an admin may have filled in only one, and a blank reads
// worse than the wrong language.
function pick(zh: string, en: string, isZh: boolean): string {
  const primary = isZh ? zh : en
  const fallback = isZh ? en : zh
  return (primary || '').trim() || (fallback || '').trim()
}

function TagRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      {values.map((v) => (
        <span key={v} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-slate-300">
          {v}
        </span>
      ))}
    </div>
  )
}

function FactRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-xs text-slate-500">{label}</span>
      <span className="text-xs text-slate-300">{value}</span>
    </div>
  )
}

export default function PlatformStrategiesGuide() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const [items, setItems] = useState<PlatformStrategy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 详情默认折叠：简介一行就能扫完，全展开会把列表撑得没法比较。
  // Details collapsed by default: the summaries scan in one line each, and
  // expanding everything makes the list impossible to compare.
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    signalApi
      .platformStrategies()
      .then((res) => {
        if (alive) setItems(res.items)
      })
      .catch((err: unknown) => {
        // catch 绑定是 unknown；localizeApiError 只吃"中文 / English"双语串
        // A catch binding is unknown; localizeApiError takes the bilingual string
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  if (loading) {
    return (
      <div className="glass flat-card flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      </div>
    )
  }

  if (error) {
    return <div className="glass flat-card py-12 text-center text-sm text-down">{error}</div>
  }

  if (items.length === 0) {
    return (
      <div className="glass flat-card py-12 text-center text-sm text-slate-500">
        {t('signals.guide.empty')}
      </div>
    )
  }

  return (
    <div>
      <p className="mb-4 text-sm text-slate-400">{t('signals.guide.intro')}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((s) => {
          const name = pick(s.nameZh, s.nameEn, isZh)
          const summary = pick(s.summaryZh, s.summaryEn, isZh)
          const detail = pick(s.detailZh, s.detailEn, isZh)
          const regime = pick(s.marketRegimeZh, s.marketRegimeEn, isZh)
          const holding = pick(s.holdingTimeZh, s.holdingTimeEn, isZh)
          const isOpen = expanded === s.id

          return (
            <div key={s.id} className="glass flat-card overflow-hidden p-0">
              {s.imageUrl && (
                <img
                  src={s.imageUrl}
                  alt={name}
                  loading="lazy"
                  className="h-36 w-full object-cover"
                />
              )}
              <div className="p-5">
                <h3 className="font-display text-base font-bold text-slate-100">{name}</h3>
                {summary && <p className="mt-1.5 text-sm text-slate-400">{summary}</p>}

                <div className="mt-4 space-y-1.5">
                  <FactRow label={t('signals.guide.marketRegime')} value={regime} />
                  <FactRow label={t('signals.guide.holdingTime')} value={holding} />
                  {/* 风险回报比是下单参数（止损:止盈），不是历史业绩
                      Risk:reward is an order parameter (SL:TP), not past performance */}
                  <FactRow label={t('signals.guide.riskReward')} value={s.riskReward} />
                </div>

                <div className="mt-3 space-y-2">
                  <TagRow label={t('signals.guide.symbols')} values={s.symbols} />
                  <TagRow label={t('signals.guide.timeframes')} values={s.timeframes} />
                  <TagRow label={t('signals.guide.indicators')} values={s.indicators} />
                </div>

                {detail && (
                  <>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : s.id)}
                      aria-expanded={isOpen}
                      className="mt-4 text-xs text-prism-300 transition-colors hover:text-prism-200"
                    >
                      {isOpen ? t('signals.guide.collapse') : t('signals.guide.readMore')}
                    </button>
                    {isOpen && (
                      // 纯文本渲染：管理员输入不经过 HTML 解析，whitespace-pre-line
                      // 保留换行分段即可，不引入富文本/Markdown 解析面。
                      // Plain text only: admin input is never parsed as HTML;
                      // whitespace-pre-line keeps the paragraph breaks without
                      // opening a rich-text/Markdown parsing surface.
                      <p className="mt-3 whitespace-pre-line border-t border-white/10 pt-3 text-sm leading-relaxed text-slate-300">
                        {detail}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-slate-500">{t('signals.guide.disclaimer')}</p>
    </div>
  )
}
