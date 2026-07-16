// 已平仓交易明细：逐笔盈亏记录，落地"透明"承诺——不止给一个聚合胜率数字，
// 让用户能看到构成那个数字的每一笔真实成交。纯展示组件：数据获取与账号标签
// 状态由 OrdersPage 统一持有（同一个标签还要驱动上方的胜率卡），这里只负责
// 把已经按选中账号过滤好的记录渲染成表格/卡片 + 分页。
// Closed-trade detail list: per-trade P&L records — the "transparency" promise
// shouldn't stop at one aggregate win-rate number; users should be able to see
// every real fill it's built from. Presentational only: data fetching and the
// account-tab state live in OrdersPage (the same tab also drives the win-rate
// card above), this just renders whatever already-filtered records it's given
// as a table/card list + pagination.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { displaySymbol, fmtTime } from '../api/utils'
import type { ClosedTrade } from '../api/types'

const PAGE_SIZE = 10

interface Props {
  trades: ClosedTrade[] | null // null = 加载中 / loading
  showAccountColumn: boolean
}

export default function ClosedTradesList({ trades, showAccountColumn }: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)

  // 记录集合变化（含账号切换）时回到第一页 / reset to first page when the record set changes
  useEffect(() => { setPage(0) }, [trades])

  const totalPages = Math.max(1, Math.ceil((trades?.length ?? 0) / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageTrades = (trades ?? []).slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="glass p-5">
      <h3 className="font-display text-lg font-semibold text-slate-100">{t('winrate.closedTradesTitle')}</h3>
      <p className="mt-1 text-xs text-slate-500">{t('winrate.closedTradesHint')}</p>

      {trades === null ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
        </div>
      ) : trades.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">{t('winrate.closedTradesEmpty')}</p>
      ) : (
        <>
          {/* 桌面端表格 / desktop table */}
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2 font-medium">{t('orders.colTime')}</th>
                  {showAccountColumn && <th className="px-3 py-2 font-medium">{t('orders.colAccount')}</th>}
                  <th className="px-3 py-2 font-medium">{t('orders.colSymbol')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colSide')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colVolume')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colPrice')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('winrate.profit')}</th>
                </tr>
              </thead>
              <tbody>
                {pageTrades.map((tr) => (
                  <tr key={tr.id} className="border-b border-white/5">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fmtTime(tr.closedAt)}</td>
                    {showAccountColumn && <td className="px-3 py-2 font-mono text-slate-300">{tr.mt5Login}</td>}
                    <td className="px-3 py-2 font-mono text-slate-100">{displaySymbol(tr.symbol)}</td>
                    <td className="px-3 py-2">
                      <span className={`tag ${tr.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                        {tr.side === 'BUY' ? t('common.buy') : t('common.sell')}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-200">{tr.closeVolume}</td>
                    <td className="px-3 py-2 font-mono text-slate-200">{tr.closePrice ?? '-'}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${tr.profit >= 0 ? 'text-up' : 'text-down'}`}>
                      {tr.profit >= 0 ? '+' : ''}{tr.profit.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动端卡片列表 / mobile card list */}
          <div className="mt-3 divide-y divide-white/5 md:hidden">
            {pageTrades.map((tr) => (
              <div key={tr.id} className="py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-slate-100">{displaySymbol(tr.symbol)}</span>
                    <span className={`tag ${tr.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                      {tr.side === 'BUY' ? t('common.buy') : t('common.sell')}
                    </span>
                  </div>
                  <span className={`font-mono text-sm font-semibold ${tr.profit >= 0 ? 'text-up' : 'text-down'}`}>
                    {tr.profit >= 0 ? '+' : ''}{tr.profit.toFixed(2)}
                  </span>
                </div>
                <div className="mt-1 flex justify-between text-xs text-slate-500">
                  <span>{tr.closeVolume} {t('positions.lots')} @ {tr.closePrice ?? '-'}</span>
                  {showAccountColumn && <span className="font-mono">{tr.mt5Login}</span>}
                </div>
                <div className="mt-0.5 text-right text-xs text-slate-500">{fmtTime(tr.closedAt)}</div>
              </div>
            ))}
          </div>

          {/* 分页：每页 10 笔，其余翻页 / pagination: 10 per page */}
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
              <span>{t('orders.pageInfo', { page: safePage + 1, totalPages, total: trades.length })}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('common.prevPage')}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage + 1 >= totalPages}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('common.nextPage')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
