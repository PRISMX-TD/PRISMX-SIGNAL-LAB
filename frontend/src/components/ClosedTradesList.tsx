// 已平仓交易明细：逐笔盈亏记录，落地"透明"承诺——不止给一个聚合胜率数字，
// 让用户能看到构成那个数字的每一笔真实成交。
// Closed-trade detail list: per-trade P&L records — the "transparency"
// promise shouldn't stop at one aggregate win-rate number; users should be
// able to see every real fill it's built from.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import { fmtTime } from '../api/utils'
import type { ClosedTrade } from '../api/types'

export default function ClosedTradesList() {
  const { t } = useTranslation()
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null)

  // 此前只在挂载时拉一次，用户开着这个页面去平仓、回来看到的还是打开页面
  // 那一刻的旧快照。改成和 PersonalWinRateCard 一样的节奏：定时轮询 + 切回
  // 页面时立即补一次，让新成交近实时出现，不用手动刷新整页。页面在后台时
  // 跳过轮询，省电。
  // This used to fetch only once on mount — if the user had this page open,
  // went and closed a position, then came back, they'd still see the stale
  // snapshot from when the page first loaded. Now matches PersonalWinRateCard's
  // cadence: poll + refetch on return-to-foreground, so a fresh close shows up
  // without a manual full-page reload. Skips polling while backgrounded.
  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.closedTrades()
        .then((r) => { if (mounted) setTrades(r.trades) })
        .catch(() => { if (mounted) setTrades((prev) => prev ?? []) })
    }
    load()
    const timer = window.setInterval(() => {
      if (!document.hidden) load()
    }, 45_000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

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
                  <th className="px-3 py-2 font-medium">{t('orders.colAccount')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colSymbol')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colSide')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colVolume')}</th>
                  <th className="px-3 py-2 font-medium">{t('orders.colPrice')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('winrate.profit')}</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((tr) => (
                  <tr key={tr.id} className="border-b border-white/5">
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fmtTime(tr.closedAt)}</td>
                    <td className="px-3 py-2 font-mono text-slate-300">{tr.mt5Login}</td>
                    <td className="px-3 py-2 font-mono text-slate-100">{tr.symbol}</td>
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
            {trades.map((tr) => (
              <div key={tr.id} className="py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-slate-100">{tr.symbol}</span>
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
                  <span className="font-mono">{tr.mt5Login}</span>
                </div>
                <div className="mt-0.5 text-right text-xs text-slate-500">{fmtTime(tr.closedAt)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
