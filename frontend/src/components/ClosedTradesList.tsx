// 已平仓交易明细：逐笔盈亏记录，落地"透明"承诺——不止给一个聚合胜率数字，
// 让用户能看到构成那个数字的每一笔真实成交。链接多个 MT5 账号时按账号分标签，
// 每个账号每页只显示最近 10 笔，其余翻页，避免多账号记录混在一起分不清。
// Closed-trade detail list: per-trade P&L records — the "transparency"
// promise shouldn't stop at one aggregate win-rate number; users should be
// able to see every real fill it's built from. With more than one MT5 account
// linked, records are split into per-account tabs; each account shows the
// latest 10 per page and pages the rest, so multi-account rows never mix.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import { fmtTime } from '../api/utils'
import type { ClosedTrade } from '../api/types'

const PAGE_SIZE = 10

export default function ClosedTradesList() {
  const { t } = useTranslation()
  const [trades, setTrades] = useState<ClosedTrade[] | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null)
  const [page, setPage] = useState(0)

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

  // 记录里出现过的账号（去重、排序）；只有超过一个才需要分账号标签。
  // Distinct account logins seen in the records; tabs only appear when >1.
  const logins = useMemo(() => {
    if (!trades) return []
    return [...new Set(trades.map((tr) => tr.mt5Login))].sort()
  }, [trades])
  const multiAccount = logins.length > 1

  // 多账号时默认选中第一个账号；数据变化后若当前选中账号已不存在则回退到第一个。
  // Default to the first account when multi-account; fall back if the selected
  // one vanishes after a refresh.
  useEffect(() => {
    if (!multiAccount) {
      if (selectedAccount !== null) setSelectedAccount(null)
      return
    }
    if (selectedAccount === null || !logins.includes(selectedAccount)) {
      setSelectedAccount(logins[0])
    }
  }, [multiAccount, logins, selectedAccount])

  // 切换账号时回到第一页 / reset to first page when switching account
  useEffect(() => { setPage(0) }, [selectedAccount])

  const accountTrades = useMemo(() => {
    if (!trades) return []
    if (multiAccount && selectedAccount) return trades.filter((tr) => tr.mt5Login === selectedAccount)
    return trades
  }, [trades, multiAccount, selectedAccount])

  const totalPages = Math.max(1, Math.ceil(accountTrades.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageTrades = accountTrades.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="glass p-5">
      <h3 className="font-display text-lg font-semibold text-slate-100">{t('winrate.closedTradesTitle')}</h3>
      <p className="mt-1 text-xs text-slate-500">{t('winrate.closedTradesHint')}</p>

      {/* 账号标签：多账号时把记录按账号拆开，点一个只看那个账号 /
          account tabs: split records per account when more than one is linked */}
      {multiAccount && (
        <div className="mt-3 flex flex-wrap gap-2">
          {logins.map((login) => (
            <button
              key={login}
              onClick={() => setSelectedAccount(login)}
              className={`rounded-lg border px-3 py-1.5 font-mono text-xs transition ${
                selectedAccount === login
                  ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
                  : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
              }`}
            >
              {t('winrate.closedTradesAccount', { login })}
            </button>
          ))}
        </div>
      )}

      {trades === null ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
        </div>
      ) : accountTrades.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">{t('winrate.closedTradesEmpty')}</p>
      ) : (
        <>
          {/* 桌面端表格 / desktop table */}
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2 font-medium">{t('orders.colTime')}</th>
                  {!multiAccount && <th className="px-3 py-2 font-medium">{t('orders.colAccount')}</th>}
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
                    {!multiAccount && <td className="px-3 py-2 font-mono text-slate-300">{tr.mt5Login}</td>}
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
            {pageTrades.map((tr) => (
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
                  {!multiAccount && <span className="font-mono">{tr.mt5Login}</span>}
                </div>
                <div className="mt-0.5 text-right text-xs text-slate-500">{fmtTime(tr.closedAt)}</div>
              </div>
            ))}
          </div>

          {/* 分页：每页 10 笔，其余翻页 / pagination: 10 per page */}
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
              <span>{t('orders.pageInfo', { page: safePage + 1, totalPages, total: accountTrades.length })}</span>
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
