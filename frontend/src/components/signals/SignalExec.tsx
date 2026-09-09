// 交易信号执行卡：入场价 + SL/TP + RR + 倒计时 + 下单按钮
// Signal exec card: entry + SL/TP + RR + countdown + trade button
//
// 2026-09-08 版式重做：桌面版与手机版原来是两套标记（桌面完整执行卡、手机套用旧
// 信号卡），现在合成一份——就是信号板那张牌的放大版。
//
// 2026-09-09 收高：原来是六段竖着摊开（牌头 / 身份 / 入场 / 阶梯 / 盈亏比+触发 / 下单），
// 近 460px 高，比旁边那栏所有卡片都高出一截。合成三段：
//   ① 入场价从「小字在上、40px 大数在下」的两行块，压成一条基线行——「入场」在左，
//      32px 大数靠右，右边缘与下面止盈的数字对齐；它仍是牌上最大的数，只是不再自己占两行；
//   ② 盈亏比移进价格阶梯当中间格——它正下方就是风险｜回报尺，那根尺画的就是这个数，
//      数字与图形放一起互为注解，不该隔着一条分割线；
//   ③ 触发指标那一格删掉——署名行已经写着同一个策略名，一张卡上不必说两遍。
// 入场价 40 → 32px（仍是牌上最大的数），下单 48 → 44px。
//
// Relaid 2026-09-08 as one markup for both breakpoints. Shortened 2026-09-09: six
// stacked bands (~460px, taller than every card in the neighbouring column) become
// three. Identity and entry share a row — together they are one sentence, "what to
// buy and where to get in". R:R moves into the price ladder as its middle cell,
// directly above the risk|reward rule that draws that very number, so figure and
// graphic annotate each other instead of sitting either side of a divider. The
// trigger-indicator cell is gone: the byline already names the same strategy.
// Entry drops 40 → 32px (still the biggest figure), the CTA 48 → 44px.
// With no signal the same skeleton shows "-" and a disabled button, so the card
// never changes size.
import { memo, type CSSProperties, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal } from '../../api/types'
import { calcRiskReward, displaySymbol } from '../../api/utils'
import { fmtIssueClock, fmtPx, priceDecimals, riskFraction, rrTone } from './SignalView'
import { symbolMeta } from '../../utils/symbolMeta'
import TtlRing from './TtlRing'

interface Props {
  signal: Signal | null
  now: number
  onTrade: (s: Signal) => void
}

const SignalExec: FC<Props> = ({ signal, now, onTrade }) => {
  const { t } = useTranslation()
  const rr = signal ? calcRiskReward(signal.symbol, signal.entry, signal.stopLoss, signal.takeProfit) : null
  const isBuy = signal?.side === 'BUY'
  const sideTag = isBuy ? t('common.buy') : t('common.sell')
  const indicatorLabel = signal ? signal.indicator ?? t('signals.indicatorNone') : t('signals.focus.noExecutable')
  const decimals = signal ? priceDecimals(signal.entry, signal.stopLoss, signal.takeProfit) : 0
  const riskFrac = rr ? riskFraction(rr.riskPrice, rr.rewardPrice) : null
  const meta = signal ? symbolMeta(signal.symbol) : null

  return (
    <section className="card glass dash-exec dh-exec">
      {/* 牌头：标题 + 倒计时环 / head: title + countdown ring */}
      <div className="dh-exec-head">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
          </svg>
          {t('signals.focus.signalHeading')}
        </h3>
        {signal ? (
          <TtlRing expireAt={signal.expireAt} now={now} label={t('signals.focus.remainingTtl')} />
        ) : (
          <span className="sig-ttl"><b className="num">--:--</b></span>
        )}
      </div>

      {/* 身份行：芯片 + 品种 + 方向；署名是策略名与发出时间
          Identity row: chip + symbol + side; byline is strategy and issue time */}
      <div className="dh-exec-id">
        <span
          className="sym-ava"
          style={meta ? { background: meta.color + '33', color: meta.ink } : { background: 'var(--nest)', color: 'var(--text-3)' }}
        >
          {meta ? meta.letter : '-'}
        </span>
        <div className="min-w-0">
          <div className="dh-exec-sym">
            <b className="font-display">{signal ? displaySymbol(signal.symbol) : '-'}</b>
            {signal && <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{sideTag}</span>}
          </div>
          <div className="dh-exec-by">
            <span className="s">{indicatorLabel}</span>
            {signal && <span className="num">{fmtIssueClock(signal.createdAt)}</span>}
          </div>
        </div>
      </div>

      {/* 入场价：一条基线行，说明字在左、大数靠右，右边缘与下面止盈的数字对齐。
          Entry as one baseline row: caption left, figure right, its right edge aligned with the
          take-profit value below it. */}
      <div className="dh-entry">
        <span className="dh-cap">{t('signals.colEntry')}</span>
        <b className="num">{signal ? fmtPx(signal.entry, decimals) : '-'}</b>
      </div>

      {/* 止损｜盈亏比｜止盈 + 风险｜回报尺。盈亏比放正中间：它正下方那根尺画的就是这个数。
          SL | R:R | TP over the risk|reward rule. R:R sits dead centre because the rule
          right below it is that number drawn to scale. */}
      <div className="dh-ladder">
        <div className="row">
          <div className="lv sl"><span className="dh-cap">{t('signals.colSl')}</span><b className="num">{signal ? fmtPx(signal.stopLoss, decimals) : '-'}</b></div>
          <div className="lv rr">
            <span className="dh-cap">{t('signals.focus.rrLabel')}</span>
            <b className={`num ${rrTone(rr?.rr ?? null)}`}>{rr?.rr != null ? `1:${rr.rr.toFixed(2)}` : '-'}</b>
          </div>
          <div className="lv tp"><span className="dh-cap">{t('signals.colTp')}</span><b className="num">{signal ? fmtPx(signal.takeProfit, decimals) : '-'}</b></div>
        </div>
        <div
          className={`sig-ladder-bar${riskFrac == null ? ' none' : ''}`}
          style={riskFrac != null ? ({ '--risk': `${(riskFrac * 100).toFixed(1)}%` } as CSSProperties) : undefined}
          aria-hidden="true"
        >
          <i className="risk" />
          <i className="reward" />
          <i className="mark" />
        </div>
      </div>

      <button
        onClick={() => signal && onTrade(signal)}
        disabled={!signal}
        className="btn btn-primary dh-exec-cta"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        {t('signals.trade')}
      </button>
    </section>
  )
}

export default memo(SignalExec)
