// 订单与回执页 / Orders & receipts page
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { useLive, usePositions } from '../store/live'
import { orderApi, automationApi } from '../api/client'
import { fmtTime } from '../api/utils'
import type { AutoManageSettings, OrderStatus } from '../api/types'
import PositionCard from '../components/PositionCard'
import PersonalWinRateCard from '../components/PersonalWinRateCard'

const statusStyle: Record<OrderStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400',
  FILLED: 'bg-up/15 text-up',
  REJECTED: 'bg-down/15 text-down',
  FAILED: 'bg-down/15 text-down',
  CANCELLED: 'bg-white/10 text-slate-400',
}

type StatusFilter = 'ALL' | OrderStatus
type SideFilter = 'ALL' | 'BUY' | 'SELL'

export default function OrdersPage() {
  const { t } = useTranslation()
  const { user, refreshUser } = useAuth()
  const { orders, accounts, refreshAll } = useLive()
  const positions = usePositions()
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const [statusF, setStatusF] = useState<StatusFilter>('ALL')
  const [sideF, setSideF] = useState<SideFilter>('ALL')
  const [symbolF, setSymbolF] = useState('')

  // 自动仓位管理 / auto position management
  const [autoCfg, setAutoCfg] = useState<AutoManageSettings | null>(null)
  const [autoSaving, setAutoSaving] = useState(false)
  const [autoMsg, setAutoMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const isPro = user?.plan === 'PRO'

  useEffect(() => {
    refreshUser()                        // 每次进入页面刷新 plan，确保管理员升级后即时生效
    automationApi.getSettings().then(setAutoCfg).catch(() => {})
  }, [])

  async function saveAutoCfg() {
    if (!autoCfg) return
    setAutoSaving(true)
    setAutoMsg(null)
    try {
      const updated = await automationApi.putSettings(autoCfg)
      setAutoCfg(updated)
      setAutoMsg({ kind: "ok", text: t("account.autoSaved") })
    } catch (err: unknown) {
      setAutoMsg({ kind: "err", text: err instanceof Error ? err.message : t("account.autoSaveError") })
    } finally {
      setAutoSaving(false)
    }
  }

  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'success') => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ msg, kind })
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
    refreshAll()
  }

  const toastStyle =
    toast?.kind === 'error'
      ? 'border-down/40 bg-down/15 text-down'
      : toast?.kind === 'info'
        ? 'border-prism-600/40 bg-prism-600/15 text-prism-300'
        : 'border-up/40 bg-up/15 text-up'

  // 持仓汇总 / positions summary
  const posSummary = useMemo(() => {
    let pnl = 0
    let buy = 0
    let sell = 0
    for (const p of positions) {
      pnl += p.profit
      if (p.side === 'BUY') buy += 1
      else sell += 1
    }
    return { pnl, buy, sell, total: positions.length }
  }, [positions])

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (statusF !== 'ALL' && o.status !== statusF) return false
      if (sideF !== 'ALL' && o.side !== sideF) return false
      if (symbolF.trim() && !o.symbol.toLowerCase().includes(symbolF.trim().toLowerCase())) return false
      return true
    })
  }, [orders, statusF, sideF, symbolF])

  const doCancel = async (id: string) => {
    setCancellingId(id)
    try {
      await orderApi.cancel(id)
      showToast(t('orders.cancelSent'), 'info')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'error', 'error')
    } finally {
      setCancellingId(null)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('orders.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('orders.subtitle')}</p>
      </div>

      {/* MT5 账户详情 / MT5 account details */}
      {accounts.length > 0 && (
        <div className="glass mb-5 p-5">
          <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
            {t('orders.mt5Accounts')}
          </h3>
          <div className="mt-3 space-y-3">
            {accounts.map((a, i) => (
              <div key={i} className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-slate-100">
                    {a.login}
                    {a.server ? ` @${a.server}` : ""}
                  </span>
                  <span
                    className={`tag text-xs ${a.online ? "bg-up/15 text-up" : "bg-white/5 text-slate-500"}`}
                  >
                    {a.online ? t("common.online") : t("common.offline")}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-slate-500">{t("account.balance")}</span>
                    <div className="font-mono text-slate-100">{a.balance?.toFixed(2) ?? "-"}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">{t("account.equity")}</span>
                    <div className="font-mono text-slate-100">{a.equity?.toFixed(2) ?? "-"}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">{t("account.leverage")}</span>
                    <div className="font-mono text-slate-100">{a.leverage ? `1:${a.leverage}` : "-"}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 持仓概览 / positions overview */}
      <div className="glass mb-5 p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold text-slate-100">
            {t('orders.positions')}
          </h3>
          {positions.length > 0 && (
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-slate-400">
                {t('orders.summary.positions')}{' '}
                <b className="font-mono text-sm text-slate-100">{posSummary.total}</b>
              </span>
              <span className="text-slate-400">
                {t('common.buy')} <b className="font-mono text-sm text-up">{posSummary.buy}</b>
                {' '}/{' '}
                {t('common.sell')} <b className="font-mono text-sm text-down">{posSummary.sell}</b>
              </span>
              <span className="text-slate-400">
                {t('orders.summary.totalPnl')}{' '}
                <b className={`font-mono text-sm ${posSummary.pnl >= 0 ? 'text-up' : 'text-down'}`}>
                  {posSummary.pnl >= 0 ? '+' : ''}
                  {posSummary.pnl.toFixed(2)}
                </b>
              </span>
            </div>
          )}
        </div>
        {positions.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-500">{t('orders.noPositions')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {positions.map((p, i) => (
              <PositionCard key={p.ticket ?? i} position={p} onActionDone={showToast} />
            ))}
          </div>
        )}
      </div>

      {/* 个人跟单表现 / personal trading performance */}
      <div className="mb-5">
        <PersonalWinRateCard variant="detailed" />
      </div>

      {/* 自动仓位管理 / auto position management */}
      {autoCfg && (
        <div className={`glass mb-5 p-5 ${!isPro ? 'opacity-60' : ''}`}>
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
              {t('account.autoTitle')}
            </h3>
            {!isPro && (
              <span className="tag bg-white/10 text-slate-500">{t('orders.proExclusive')}</span>
            )}
            {isPro && (
              <span className="tag bg-prism-600/20 text-prism-300">PRO</span>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('account.autoHint')}</p>

          {!isPro ? (
            <p className="mt-3 text-xs text-slate-500">{t('account.autoUpgradeRequired')}</p>
          ) : (
            <div className="mt-4 space-y-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-100">
                <input
                  type="checkbox"
                  checked={autoCfg.enabled}
                  onChange={(e) => setAutoCfg({ ...autoCfg, enabled: e.target.checked })}
                  className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                />
                {t('account.autoEnable')}
              </label>

              {autoCfg.enabled && (
                <div className="space-y-4 rounded-lg border border-white/5 bg-white/[0.03] p-4">
                  {/* 保本 / break-even */}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={autoCfg.beEnabled}
                        onChange={(e) => setAutoCfg({ ...autoCfg, beEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      />
                      {t('account.autoBe')}
                    </label>
                    <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.beTriggerR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, beTriggerR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R</span>
                  </div>

                  {/* 追踪止损 / trailing stop */}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={autoCfg.trailEnabled}
                        onChange={(e) => setAutoCfg({ ...autoCfg, trailEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      />
                      {t('account.autoTrail')}
                    </label>
                    <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.trailTriggerR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, trailTriggerR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R · {t('account.autoTrailDistance')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.trailDistanceR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, trailDistanceR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R</span>
                  </div>

                  {/* 分批止盈 / partial take-profit */}
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={autoCfg.ptpEnabled}
                        onChange={(e) => setAutoCfg({ ...autoCfg, ptpEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      />
                      {t('account.autoPtp')}
                    </label>
                    <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                    <input
                      type="number" step={0.1} min={0.1} max={10}
                      className="input h-8 w-20 text-xs"
                      value={autoCfg.ptpTriggerR}
                      onChange={(e) => setAutoCfg({ ...autoCfg, ptpTriggerR: Number(e.target.value) })}
                    />
                    <span className="text-xs text-slate-500">R · {t('account.autoPtpFraction')}</span>
                    <input
                      type="number" step={5} min={10} max={90}
                      className="input h-8 w-20 text-xs"
                      value={Math.round(autoCfg.ptpFraction * 100)}
                      onChange={(e) => setAutoCfg({ ...autoCfg, ptpFraction: Number(e.target.value) / 100 })}
                    />
                    <span className="text-xs text-slate-500">%</span>
                  </div>

                  <p className="text-[11px] leading-relaxed text-slate-600">{t('account.autoScopeNote')}</p>
                </div>
              )}

              <button
                onClick={saveAutoCfg}
                disabled={autoSaving}
                className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
              >
                {autoSaving ? t('common.loading') : t('common.save')}
              </button>
              {autoMsg && (
                <p className={`text-sm ${autoMsg.kind === "err" ? "text-down" : "text-up"}`}>
                  {autoMsg.text}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* 筛选条 / filter bar */}
      <div className="glass mb-3 flex flex-wrap items-center gap-3 p-3">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterStatus')}</span>
          <select
            value={statusF}
            onChange={(e) => setStatusF(e.target.value as StatusFilter)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          >
            <option value="ALL">{t('signals.all')}</option>
            <option value="PENDING">{t('orders.status.PENDING')}</option>
            <option value="FILLED">{t('orders.status.FILLED')}</option>
            <option value="REJECTED">{t('orders.status.REJECTED')}</option>
            <option value="FAILED">{t('orders.status.FAILED')}</option>
            <option value="CANCELLED">{t('orders.status.CANCELLED')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterSide')}</span>
          <select
            value={sideF}
            onChange={(e) => setSideF(e.target.value as SideFilter)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          >
            <option value="ALL">{t('signals.all')}</option>
            <option value="BUY">{t('common.buy')}</option>
            <option value="SELL">{t('common.sell')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-slate-500">{t('orders.filterSymbol')}</span>
          <input
            value={symbolF}
            onChange={(e) => setSymbolF(e.target.value)}
            placeholder={t('orders.symbolPlaceholder')}
            className="w-28 rounded-lg border border-white/10 bg-ink-800/80 px-2 py-1 text-xs text-slate-100 outline-none transition focus:border-prism-500"
          />
        </label>
      </div>

      {/* 订单表 / orders table */}
      <div className="glass overflow-hidden">
        {filteredOrders.length === 0 ? (
          <p className="py-16 text-center text-sm text-slate-500">{t('orders.empty')}</p>
        ) : (
          <>
            {/* 桌面端表格 / desktop table */}
            <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3 font-medium">{t('orders.colTime')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colType')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colAccount')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colSymbol')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colSide')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colVolume')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colStatus')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colTicket')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colPrice')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colMessage')}</th>
                  <th className="px-4 py-3 font-medium">{t('orders.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-white/5 transition hover:bg-prism-600/10"
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                      {fmtTime(o.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="tag border border-white/10 bg-white/[0.05] text-slate-300">
                        {t(`orders.action.${o.action ?? 'ORDER'}`)}
                      </span>
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
                    <td className="px-4 py-3">
                      {o.status === 'PENDING' && (
                        <button
                          onClick={() => doCancel(o.id)}
                          disabled={cancellingId === o.id}
                          className="rounded-lg border border-down/40 bg-down/10 px-2.5 py-1 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
                        >
                          {t('common.cancel')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* 移动端卡片列表 / mobile card list */}
            <div className="divide-y divide-white/5 md:hidden">
              {filteredOrders.map((o) => (
                <div key={o.id} className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base font-bold text-slate-100">{o.symbol}</span>
                      <span
                        className={`tag ${
                          o.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'
                        }`}
                      >
                        {o.side === 'BUY' ? t('common.buy') : t('common.sell')}
                      </span>
                    </div>
                    <span className={`tag ${statusStyle[o.status]}`}>
                      {t(`orders.status.${o.status}`)}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colType')}</span>
                      <span className="text-slate-300">{t(`orders.action.${o.action ?? 'ORDER'}`)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colVolume')}</span>
                      <span className="font-mono text-slate-200">{o.volume}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colAccount')}</span>
                      <span className="font-mono text-slate-300">{o.mt5Login ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colPrice')}</span>
                      <span className="font-mono text-slate-200">{o.filledPrice ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colTicket')}</span>
                      <span className="font-mono text-slate-400">{o.mt5Ticket ?? '-'}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-slate-500">{t('orders.colTime')}</span>
                      <span className="text-slate-400">{fmtTime(o.createdAt)}</span>
                    </div>
                  </div>

                  {o.message && (
                    <p className="mt-2 break-words text-xs text-slate-500">{o.message}</p>
                  )}

                  {o.status === 'PENDING' && (
                    <button
                      onClick={() => doCancel(o.id)}
                      disabled={cancellingId === o.id}
                      className="mt-3 w-full rounded-lg border border-down/40 bg-down/10 py-1.5 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
                    >
                      {t('common.cancel')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {toast && (
        <div
          className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastStyle}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}
