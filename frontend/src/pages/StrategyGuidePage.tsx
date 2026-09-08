// 平台策略详情页（/app/strategy/:id）。从信号面板页的「策略介绍」标签点进来。
//
// 数据来源是同一个只读端点 GET /signals/platform-strategies（只返回已发布条目），
// 拉全量后按 id 取。没有做单条端点：整个清单是管理员手工维护的十几条内容，一次
// 取回比多加一个端点划算，而且返回里带着上一条/下一条，页脚的翻页不用再发请求。
//
// 刻意不展示胜率、盈亏比等业绩数字：真实战绩的唯一来源是信号自身的 result 判定
//（后端 services/signal_resolution.py）。这里只描述策略的设计特征。
//
// 2026-09-08 版式重做：大标题（40px 展示字宽）+ 一句话；正文在左，右侧一栏
// **规格栏**（风险回报比大数字 + 风险｜回报尺、适用行情、典型持仓、品种、周期、
// 指标）在桌面端随滚动吸顶——读长文时设计参数一直在手边。窄屏规格栏排在正文前。
//
// Platform strategy detail page (/app/strategy/:id), reached from the "Strategy
// guide" tab on the signals page.
//
// Data comes from the same read-only GET /signals/platform-strategies (published
// entries only); the list is fetched whole and the entry picked by id. There is
// no single-item endpoint on purpose: the list is a dozen-odd hand-maintained
// entries, so one fetch beats adding another endpoint, and having the full list
// means the prev/next footer links need no extra request.
//
// Deliberately shows no win-rate or profit-factor figures: the only source of
// real performance is each signal's own result adjudication (backend
// services/signal_resolution.py). This describes design characteristics only.
//
// Relaid 2026-09-08: display headline plus lede; article on the left, a sticky
// spec column on the right (R:R figure over the risk|reward rule, regime,
// holding time, symbols, timeframes, indicators). Narrow screens put the spec
// column first.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { safeHttpUrl } from '../utils/safeUrl'
import { signalApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import {
  IndicatorList, RiskRewardFigure, SpecFact, StrategyDetail, SymbolChips, TimeframeTrack, pick,
} from '../components/strategyGuide'
import { SkeletonPage } from '../components/Skeleton'
import type { PlatformStrategy } from '../api/types'

export default function StrategyGuidePage() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const { id } = useParams<{ id: string }>()
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
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // 切换策略时回到顶部：路由参数变了但组件实例没换，浏览器会保留原滚动位置，
  // 从长文末尾点「下一条」会落在新页面的中间。
  // Scroll to top when switching strategies: the route param changes without
  // remounting, so the browser keeps the old scroll offset and clicking "next"
  // from the end of a long write-up would land mid-page.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [id])

  if (loading) {
    return (
      <div className="guide-detail">
        <SkeletonPage cards={2} />
      </div>
    )
  }

  const sorted = [...items].sort((a, b) => a.order - b.order)
  const index = sorted.findIndex((s) => s.id === id)
  const strategy = index >= 0 ? sorted[index] : null

  if (error || !strategy) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-sm text-neutral-400">{error || t('signals.guide.notFound')}</p>
        <Link to="/app?tab=strategies" className="btn btn-ghost mt-5 inline-flex">
          {t('signals.guide.backToList')}
        </Link>
      </div>
    )
  }

  const name = pick(strategy.nameZh, strategy.nameEn, isZh)
  const summary = pick(strategy.summaryZh, strategy.summaryEn, isZh)
  const img = safeHttpUrl(strategy.imageUrl)
  const prev = index > 0 ? sorted[index - 1] : null
  const next = index < sorted.length - 1 ? sorted[index + 1] : null

  return (
    <div className="guide-detail">
      {/* 返回到策略介绍页签本身，而不是信号板：来处就是那个页签。
          Back to the guide tab itself, not the board: that is where the reader came from. */}
      <Link to="/app?tab=strategies" className="guide-back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        {t('signals.guide.backToList')}
      </Link>

      <header className="guide-detail-head">
        <h1 className="font-display-xl">{name}</h1>
        {summary && <p className="lede">{summary}</p>}
      </header>

      <div className="guide-detail-body">
        <article className="guide-article">
          {img && <img src={img} alt={name} className="guide-hero-img" />}
          <StrategyDetail strategy={strategy} isZh={isZh} />
        </article>

        {/* 规格栏。风险回报比是下单时的止损止盈之比，属于策略参数，不是业绩。
            Spec column. Risk:reward is the SL/TP ratio at order time — a strategy
            parameter, not performance. */}
        <aside className="card glass guide-aside" aria-label={t('signals.guide.riskReward')}>
          <RiskRewardFigure raw={strategy.riskReward} caption={t('signals.guide.riskReward')} />
          <div className="guide-aside-row">
            <SpecFact caption={t('signals.guide.marketRegime')} value={pick(strategy.marketRegimeZh, strategy.marketRegimeEn, isZh)} />
            <SpecFact caption={t('signals.guide.holdingTime')} value={pick(strategy.holdingTimeZh, strategy.holdingTimeEn, isZh)} />
          </div>
          {strategy.symbols.length > 0 && (
            <div className="guide-aside-grp">
              <span className="cap">{t('signals.guide.symbols')}</span>
              <SymbolChips symbols={strategy.symbols} />
            </div>
          )}
          {strategy.timeframes.length > 0 && (
            <div className="guide-aside-grp">
              <span className="cap">{t('signals.guide.timeframes')}</span>
              <TimeframeTrack timeframes={strategy.timeframes} />
            </div>
          )}
          {strategy.indicators.length > 0 && (
            <div className="guide-aside-grp">
              <span className="cap">{t('signals.guide.indicators')}</span>
              <IndicatorList indicators={strategy.indicators} />
            </div>
          )}
        </aside>
      </div>

      <p className="guide-disclaimer">{t('signals.guide.disclaimer')}</p>

      {(prev || next) && (
        <nav className="guide-pager" aria-label={`${t('signals.guide.prev')} / ${t('signals.guide.next')}`}>
          {prev ? (
            <Link to={`/app/strategy/${prev.id}`} className="card glass prev">
              <span className="cap">{t('signals.guide.prev')}</span>
              <b className="font-display">{pick(prev.nameZh, prev.nameEn, isZh)}</b>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={`/app/strategy/${next.id}`} className="card glass next">
              <span className="cap">{t('signals.guide.next')}</span>
              <b className="font-display">{pick(next.nameZh, next.nameEn, isZh)}</b>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  )
}
