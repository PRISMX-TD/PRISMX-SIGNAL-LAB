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
import { useTranslation } from 'react-i18next'
import { displaySymbol, fmtTime } from '../../api/utils'
import { intervalLabel } from './conditionTypes'
import type { StrategySignal } from '../../api/types'

export const SIGNAL_TTL_MS = 10 * 60 * 1000

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
    return <div className="mt-4 py-6 text-center text-sm text-neutral-500">{t('strategy.noSignals')}</div>
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      {signals.map((sig) => {
        const expired = now - new Date(sig.createdAt).getTime() > SIGNAL_TTL_MS
        // 已判定出结果的信号也不再能下单：结果已经出来了，再进场是另一笔交易。
        // A resolved signal can't be ordered either: its outcome already happened,
        // and entering now would be a different trade.
        const resolved = sig.result !== 'PENDING'
        const actionable = !expired && !resolved
        return (
          <div
            key={sig.id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-3 ${
              expired || resolved ? 'opacity-50' : ''
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`tag ${sig.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                {sig.side === 'BUY' ? t('common.buy') : t('common.sell')}
              </span>
              <span className="font-mono text-sm text-neutral-100">{displaySymbol(sig.symbol)}</span>
              {sig.interval && (
                <span className="tag bg-white/5 text-neutral-400">
                  {intervalLabel(sig.interval)}
                </span>
              )}
              <span className="text-xs text-neutral-500">{t('strategy.signalTriggeredAt')} {fmtTime(sig.createdAt)}</span>
              {resolved && <span className="tag bg-white/5 text-neutral-400">{t(`strategy.signalResult_${sig.result}`)}</span>}
            </div>
            {actionable ? (
              <button type="button" onClick={() => onOrder(sig)} className="btn-primary px-4 py-1.5 text-xs">
                {t('strategy.oneClickOrder')}
              </button>
            ) : (
              <span className="rounded-lg border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-neutral-500">
                {expired ? t('strategy.signalExpired') : t(`strategy.signalResult_${sig.result}`)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
