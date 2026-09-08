// 其他活跃信号列表（仪表盘右栏贯通）
// Other active signals list (dashboard right column, spans two rows)
//
// 2026-09-08 版式重做：仍是一张卡里的分隔行，但每行换成一张完整的紧凑牌——
// 身份行（芯片 + 品种 20px + 策略 + 方向 + 盈亏比）、止损｜入场｜止盈 + 风险｜
// 回报尺、页脚倒计时环 + 下单药丸。标题从卡外挪进卡里，计数改成一个紫色等宽数字。
// Relaid 2026-09-08: still divider rows inside one card, but each row is a full
// compact ticket (identity row, SL | entry | TP over the risk|reward rule,
// countdown ring + pill CTA). The header moves inside the card; the count is one
// violet tabular numeral.
import { memo, type CSSProperties, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal } from '../../api/types'
import { calcRiskReward, displaySymbol } from '../../api/utils'
import { fmtPx, priceDecimals, riskFraction, rrTone, type FocusState } from './SignalView'
import { symbolMeta } from '../../utils/symbolMeta'
import TtlRing from './TtlRing'

interface OtherEntry {
  symbol: string
  state: FocusState
  signal: Signal
  idx: number
}

interface Props {
  entries: OtherEntry[]
  now: number
  onTrade: (s: Signal) => void
  onFocus: (idx: number) => void
  onViewAll: () => void
}

const SignalOthers: FC<Props> = ({ entries, now, onTrade, onFocus, onViewAll }) => {
  const { t } = useTranslation()

  // 最多列 3 条，其余交给「其他活跃信号 ›」/ up to 3 rows; the rest live behind the button
  const visible = entries.slice(0, 3)

  return (
    <section className="dash-others flex flex-col gap-5">
      <div className="others-list">
        <div className="dh-others-head">
          <h3>
            {t('signals.focus.otherActive')}
            <b className="num">{entries.length}</b>
          </h3>
        </div>

        {visible.length === 0 && (
          <div className="sig-mini-card text-center text-sm text-neutral-400">
            {t('signals.focus.noExecutable')}
          </div>
        )}
        {visible.map(({ symbol, signal: sig, idx }) => {
          const oRr = calcRiskReward(sig.symbol, sig.entry, sig.stopLoss, sig.takeProfit)
          const isBuy = sig.side === 'BUY'
          const sideTag = isBuy ? t('common.buy') : t('common.sell')
          const meta = symbolMeta(symbol)
          const decimals = priceDecimals(sig.entry, sig.stopLoss, sig.takeProfit)
          const riskFrac = oRr ? riskFraction(oRr.riskPrice, oRr.rewardPrice) : null

          return (
            <div
              key={sig.id}
              className="sig-mini-card dh-mini cursor-pointer"
              onClick={() => onFocus(idx)}
            >
              <div className="dh-mini-top">
                <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                <div className="sym">
                  <b className="font-display">{displaySymbol(symbol)}</b>
                  <span>{sig.indicator || t('signals.indicatorNone')}</span>
                </div>
                <span className={`chip shrink-0 ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{sideTag}</span>
                <div className="rr">
                  <b className={`num ${rrTone(oRr?.rr ?? null)}`}>{oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}</b>
                  <span>{t('signals.focus.rrLabel')}</span>
                </div>
              </div>

              <div className="dh-ladder">
                <div className="row">
                  <div className="lv sl"><span className="dh-cap">{t('signals.colSl')}</span><b className="num">{fmtPx(sig.stopLoss, decimals)}</b></div>
                  <div className="lv en"><span className="dh-cap">{t('signals.colEntry')}</span><b className="num">{fmtPx(sig.entry, decimals)}</b></div>
                  <div className="lv tp"><span className="dh-cap">{t('signals.colTp')}</span><b className="num">{fmtPx(sig.takeProfit, decimals)}</b></div>
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

              <div className="dh-mini-foot">
                <TtlRing expireAt={sig.expireAt} now={now} label={t('signals.focus.remainingTtl')} />
                <button
                  onClick={(e) => { e.stopPropagation(); onTrade(sig) }}
                  className="btn btn-primary dh-mini-cta"
                >
                  {t('signals.trade')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* View all button */}
      <button className="view-all-btn" onClick={onViewAll}>
        {t('signals.focus.otherActive')}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </section>
  )
}

export default memo(SignalOthers)
