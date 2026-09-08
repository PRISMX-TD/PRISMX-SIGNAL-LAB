// 我的策略信号列表：10 分钟有效期，过期置灰并隐藏一键下单按钮。
//
// TTL 与平台信号一致固定 10 分钟：策略信号带的是触发那一刻的入场/止损/止盈价，
// 十分钟后行情已经走开，照着旧价格下单等于按一个不存在的位置进场。
//
// My-strategy signals: a fixed 10-minute lifespan, after which the row greys out
// and the one-click order button disappears. The TTL matches platform signals:
// a strategy signal carries the entry/SL/TP from the instant it fired, and ten
// minutes later the market has moved — ordering off the stale price means
// entering at a level that no longer exists.
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { displaySymbol, fmtTime, parseTime } from '../../api/utils'
import TtlRing from '../signals/TtlRing'
import { intervalLabel } from './conditionTypes'
import type { StrategySignal } from '../../api/types'

export const SIGNAL_TTL_MS = 10 * 60 * 1000

const RESULT_CLASS: Record<string, string> = { HIT_TP: 'tp', HIT_SL: 'sl', TIMEOUT: 'to' }

export interface StrategySignalListProps {
  signals: StrategySignal[]
  // 由页面每秒推进的时钟。过期判定必须吃这个 prop 而不是在组件内读 Date.now()：
  // 后者不会触发重渲染，信号到期时界面不会自己变灰。
  // A clock the page advances every second. Expiry must read this prop rather
  // than calling Date.now() inside: the latter doesn't trigger a re-render, so a
  // row would never grey out on its own.
  now: number
  onOrder: (signal: StrategySignal) => void
}

export default function StrategySignalList({ signals, now, onOrder }: StrategySignalListProps) {
  const { t } = useTranslation()

  if (signals.length === 0) {
    return <div className="stg-empty"><p>{t('strategy.noSignals')}</p></div>
  }

  return (
    <>
      {signals.map((sig, i) => {
        // createdAt 是不带时区的 UTC：直接 new Date() 会按浏览器本地时区解，UTC+8 下每条都提前 8 小时「过期」。
        // createdAt is naive UTC; new Date() would read it as browser-local and expire every row 8h early in UTC+8.
        const createdMs = parseTime(sig.createdAt)?.getTime() ?? 0
        const expired = now - createdMs > SIGNAL_TTL_MS
        // 已判定出结果的信号也不再能下单：结果已经出来了，再进场是另一笔交易。
        // A resolved signal can't be ordered either: its outcome already happened,
        // and entering now would be a different trade.
        const resolved = sig.result !== 'PENDING'
        const actionable = !expired && !resolved
        return (
          <div
            key={sig.id}
            className={`stg-sig${actionable ? '' : ' off'}`}
            style={{ '--i': i } as CSSProperties}
          >
            <span className={`chip ${sig.side === 'BUY' ? 'chip-buy' : 'chip-sell'}`}>
              {sig.side === 'BUY' ? t('common.buy') : t('common.sell')}
            </span>
            <div className="stg-sig-sym">
              <b className="font-display">{displaySymbol(sig.symbol)}</b>
              {sig.interval && <span className="tag">{intervalLabel(sig.interval)}</span>}
            </div>
            <div className="stg-sig-time">
              <span className="k">{t('strategy.signalTriggeredAt')}</span>
              <span className="num">{fmtTime(sig.createdAt)}</span>
            </div>
            <div className="stg-sig-end">
              {/* 有效期用信号板同一枚 22px 倒计时环：十分钟一到，行变灰、按钮换成「已过期」。
                  The board's 22px countdown ring; at ten minutes the row dims and the button
                  gives way to "expired". */}
              {actionable && <TtlRing expireAt={new Date(createdMs + SIGNAL_TTL_MS).toISOString()} now={now} label={t('strategy.ttlLabel')} />}
              {actionable ? (
                <button type="button" onClick={() => onOrder(sig)} className="btn btn-primary">
                  {t('strategy.oneClickOrder')}
                </button>
              ) : (
                // 已判定的信号显示结果（止盈涨色 / 止损跌色 / 超时中性），只有仍待判定却过了十分钟的才叫「已过期」。
                // A resolved signal shows its outcome (TP up-tone / SL down-tone / timeout neutral);
                // only a still-pending one past ten minutes reads "expired".
                <span className={`stg-sig-state${resolved ? ` ${RESULT_CLASS[sig.result] ?? ''}` : ''}`}>
                  {resolved ? t(`strategy.signalResult_${sig.result}`) : t('strategy.signalExpired')}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
