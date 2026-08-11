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
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { signalApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import { pick } from './strategyGuide'
import type { PlatformStrategy } from '../api/types'

function TagRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="text-xs text-neutral-500">{label}</span>
      {values.map((v) => (
        <span key={v} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-neutral-300">
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
      <span className="shrink-0 text-xs text-neutral-500">{label}</span>
      <span className="text-xs text-neutral-300">{value}</span>
    </div>
  )
}

export default function PlatformStrategiesGuide() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const [items, setItems] = useState<PlatformStrategy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      <div className="glass flat-card py-12 text-center text-sm text-neutral-500">
        {t('signals.guide.empty')}
      </div>
    )
  }

  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((s) => {
          const name = pick(s.nameZh, s.nameEn, isZh)
          const summary = pick(s.summaryZh, s.summaryEn, isZh)
          const regime = pick(s.marketRegimeZh, s.marketRegimeEn, isZh)
          const holding = pick(s.holdingTimeZh, s.holdingTimeEn, isZh)

          // 整卡是一个链接，而不是卡内再放一个「查看详情」按钮：整卡可点的命中
          // 区域大得多，移动端尤其明显；而卡内嵌按钮又会让卡片本身该不该可点变
          // 得含混。/ The whole card is one link rather than carrying a "view
          // details" button: a full-card target is far easier to hit, especially
          // on mobile, and a nested button muddies whether the card itself is
          // clickable.
          return (
            <Link
              key={s.id}
              to={`/app/strategy/${s.id}`}
              className="glass flat-card group overflow-hidden p-0 transition-colors hover:bg-white/[0.04]"
            >
              {s.imageUrl && (
                <img
                  src={s.imageUrl}
                  alt={name}
                  loading="lazy"
                  className="h-36 w-full object-cover"
                />
              )}
              <div className="p-5">
                <h3 className="font-display text-base font-bold text-neutral-100">{name}</h3>
                {summary && <p className="mt-1.5 text-sm text-neutral-400">{summary}</p>}

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

                <span className="mt-4 inline-block text-xs text-prism-300 transition-colors group-hover:text-prism-200">
                  {t('signals.guide.readMore')} →
                </span>
              </div>
            </Link>
          )
        })}
      </div>

      <p className="mt-5 text-xs leading-relaxed text-neutral-500">{t('signals.guide.disclaimer')}</p>
    </div>
  )
}
