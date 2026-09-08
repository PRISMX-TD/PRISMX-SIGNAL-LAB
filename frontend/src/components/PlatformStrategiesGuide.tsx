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
// 2026-09-08 版式重做：原来是两列小卡片（三行灰字事实 + 三行标签），三条内容
// 时第三张孤零零挂在第二行。改成**整行目录牌**：每条策略一整行，左边策略名用
// 展示字宽放到 26px、一句话简介、品种身份芯片 / 周期轨道 / 指标；右边三项设计
// 参数，风险回报比用与信号牌同一条风险｜回报尺画出来。整行不受条目数影响。
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
//
// Relaid 2026-09-08 as full-width catalogue rows (name at display width, one-line
// summary, symbol chips / timeframe track / indicators on the left; three design
// facts on the right with the R:R drawn as the signal card's risk|reward rule).
// A row layout does not orphan the third entry the way a two-column grid did.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { signalApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import { IndicatorList, RiskRewardFigure, SpecFact, SymbolChips, TimeframeTrack, pick } from './strategyGuide'
import { SkeletonBlock } from './Skeleton'
import type { PlatformStrategy } from '../api/types'
import { safeHttpUrl } from '../utils/safeUrl'

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

  return (
    <div>
      {/* 页头与信号板同一套：标题 + 计数 + 副题。/ Same head recipe as the board. */}
      <div className="sig-board-head">
        <div className="sig-board-title">
          <h2 className="font-display">
            {t('signals.tabs.platformStrategies')}
            {!loading && !error && items.length > 0 && (
              <span className="sig-board-count">
                <b className="num">{items.length}</b>
                <span>{t('signals.guide.countUnit')}</span>
              </span>
            )}
          </h2>
          <p>{t('signals.guide.subtitle')}</p>
        </div>
      </div>

      {loading ? (
        // 骨架贴合最终形状（两整行牌），不用转圈。/ Skeleton in the final shape.
        <div className="guide-list" aria-busy="true">
          <SkeletonBlock height={188} radius={24} />
          <SkeletonBlock height={188} radius={24} />
        </div>
      ) : error ? (
        <div className="sig-empty text-down">{error}</div>
      ) : items.length === 0 ? (
        <div className="sig-empty">{t('signals.guide.empty')}</div>
      ) : (
        <div className="guide-list">
          {items.map((s) => {
            const name = pick(s.nameZh, s.nameEn, isZh)
            const summary = pick(s.summaryZh, s.summaryEn, isZh)
            const regime = pick(s.marketRegimeZh, s.marketRegimeEn, isZh)
            const holding = pick(s.holdingTimeZh, s.holdingTimeEn, isZh)
            const img = safeHttpUrl(s.imageUrl)

            // 整牌是一个链接，而不是牌内再放一个「查看详情」按钮：整牌可点的命中
            // 区域大得多，移动端尤其明显；而牌内嵌按钮又会让牌本身该不该可点变
            // 得含混。/ The whole card is one link rather than carrying a "view
            // details" button: a full-card target is far easier to hit, especially
            // on mobile, and a nested button muddies whether the card itself is
            // clickable.
            return (
              <Link
                key={s.id}
                to={`/app/strategy/${s.id}`}
                className={`card glass guide-row${img ? ' has-img' : ''}`}
              >
                {img && (
                  <img src={img} alt="" loading="lazy" className="guide-row-img" />
                )}
                <div className="guide-row-main">
                  <h3 className="font-display">{name}</h3>
                  {summary && <p>{summary}</p>}
                  <div className="guide-row-meta">
                    <SymbolChips symbols={s.symbols} />
                    <TimeframeTrack timeframes={s.timeframes} />
                    <IndicatorList indicators={s.indicators} />
                  </div>
                </div>

                {/* 三项设计参数。风险回报比是下单参数（止损:止盈），不是历史业绩。
                    Three design facts. Risk:reward is an order parameter (SL:TP),
                    not past performance. */}
                <div className="guide-row-spec">
                  <SpecFact caption={t('signals.guide.marketRegime')} value={regime} />
                  <SpecFact caption={t('signals.guide.holdingTime')} value={holding} />
                  <RiskRewardFigure raw={s.riskReward} caption={t('signals.guide.riskReward')} />
                </div>

                <span className="guide-row-more">
                  {t('signals.guide.readMore')}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
                </span>
              </Link>
            )
          })}
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <p className="guide-disclaimer">{t('signals.guide.disclaimer')}</p>
      )}
    </div>
  )
}
