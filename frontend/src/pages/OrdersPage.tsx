// 订单与回执页 / Orders & receipts page
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'
import { fmtTime } from '../api/utils'
import type { OrderStatus } from '../api/types'

const statusStyle: Record<OrderStatus, string> = {
  PENDING: 'bg-prism-600/15 text-prism-300',
  FILLED: 'bg-up/15 text-up',
  REJECTED: 'bg-down/15 text-down',
  FAILED: 'bg-down/15 text-down',
}

export default function OrdersPage() {
  const { t } = useTranslation()
  const { orders, positions } = useLive()

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">{t('orders.title')}</h2>
        <p className="mt-1 text-sm text-slate-400">{t('orders.subtitle')}</p>
      </div>

      {/* 持仓概览 / positions overview */}
      <div className="card mb-5 p-5">
        <h3 className="mb-3 font-display text-lg font-semibold text-slate-100">
          {t('orders.positions')}
        </h3>
        {positions.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">{t('orders.noPositions')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {positions.map((p, i) => (
              <div key={i} className="rounded-lg bg-ink-900/50 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-slate-100">{p.symbol}</span>
                  <span
                    className={`tag ${
                      p.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                    }`}
                  >
                    {p.side === 'BUY' ? t('common.buy') : t('common.sell')}
                  </span>
                </div>
                <div className="mt-1 font-mono text-xs text-slate-400">{p.volume} lots</div>
                <div
                  className={`mt-1 font-mono text-sm ${p.profit >= 0 ? 'text-up' : 'text-down'}`}
                >
                  {p.profit >= 0 ? '+' : ''}
                  {p.profit}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 订单表 / orders table */}
      <div className="card overflow-hidden">
        {orders.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-500">{t('orders.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">{t('orders.colTime')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colAccount')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colSymbol')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colSide')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colVolume')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colStatus')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colTicket')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colPrice')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colMessage')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-ink-800/60 transition hover:bg-prism-600/5"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                      {fmtTime(o.createdAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-300">{o.mt5Login ?? '-'}</td>
                    <td className="px-4 py-3 font-mono text-slate-100">{o.symbol}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`tag ${
                          o.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                        }`}
                      >
                        {o.side === 'BUY' ? t('common.buy') : t('common.sell')}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-200">{o.volume}</td>
                    <td className="px-4 py-3">
                      <span className={`tag ${statusStyle[o.status]}`}>
                        {t(`orders.status.${o.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-400">{o.mt5Ticket ?? '-'}</td>
                    <td className="px-4 py-3 font-mono text-slate-200">{o.filledPrice ?? '-'}</td>
                    <td className="max-w-[200px] truncate px-4 py-3 text-slate-400">
                      {o.message ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
