// 已平仓交易明细：按 MT5 历史「仓位」视图的口径展示——一个仓位一行，列齐开仓时间 /
// 仓位号 / 品种 / 方向 / 手数 / 开仓价 / 止损 / 止盈 / 平仓时间 / 平仓价 / 手续费 /
// 隔夜利息 / 盈亏 / 净盈亏，点开一行看分批平仓的每一腿、成交号、平仓原因与注释。
//
// 后端存的是**平仓腿**（部分平仓一腿一条，各腿分摊手续费与隔夜利息），这里按
// (账号, 仓位号) 合成一行：手数与费用相加、开仓价取开仓腿、平仓价按手数加权、
// 平仓时间取最后一腿。2026-09-07 之前的旧记录只有净盈亏，没有开仓 / 费用明细，
// 对应格子显示"—"，等通道回扫补齐后自动出现。
//
// 纯展示组件：数据获取与账号选择由 OrdersPage 持有，这里只负责渲染 + 分页。
//
// Closed-trade history in MT5's "positions" layout: one row per position with
// the same columns MT5 shows, expandable to the individual closing legs, deal
// tickets, close reason and comment. The backend stores closing *legs* (one per
// partial close, fees allocated per leg); rows are assembled here by
// (login, position). Rows written before the detail columns existed show "—"
// until the channel's rescan fills them in. Presentational only.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Pager from './Pager'
import { displaySymbol, fmtTime } from '../api/utils'
import type { ClosedTrade } from '../api/types'

const PAGE_SIZE = 10

interface Props {
  trades: ClosedTrade[] | null // null = 加载中 / loading
}

/** 一个仓位 = 同一账号同一仓位号下的全部平仓腿（最新在前）。
 *  One position = every closing leg sharing (login, positionTicket), newest first. */
interface PositionRow {
  key: string
  legs: ClosedTrade[]
  symbol: string
  side: 'BUY' | 'SELL'
  positionTicket: number
  volume: number
  openTime: string | null
  openPrice: number | null
  sl: number | null
  tp: number | null
  closeTime: string | null
  closePrice: number | null
  gross: number | null
  commission: number | null
  swap: number | null
  net: number
  reason: string | null
  comment: string | null
  /** 有 MT5 完整字段（旧记录没有）/ detail columns present (legacy rows lack them) */
  detailed: boolean
}

function sumOrNull(legs: ClosedTrade[], pick: (l: ClosedTrade) => number | null | undefined): number | null {
  let total = 0
  for (const l of legs) {
    const v = pick(l)
    if (v == null) return null
    total += v
  }
  return total
}

function groupPositions(trades: ClosedTrade[]): PositionRow[] {
  // trades 已是最新在前；Map 按首次插入排序，所以仓位也按最后一腿的时间倒序
  // trades arrive newest first; Map keeps insertion order, so positions sort by their last leg
  const groups = new Map<string, ClosedTrade[]>()
  for (const t of trades) {
    const key = `${t.mt5Login}:${t.positionTicket}`
    const list = groups.get(key)
    if (list) list.push(t)
    else groups.set(key, [t])
  }
  const rows: PositionRow[] = []
  for (const [key, legs] of groups) {
    const volume = legs.reduce((s, l) => s + l.closeVolume, 0)
    const withOpen = legs.find((l) => l.openPrice != null)
    const withSl = legs.find((l) => l.sl != null)
    const withTp = legs.find((l) => l.tp != null)
    const openTimes = legs.map((l) => l.openTime).filter((x): x is string => !!x).sort()
    const closePrice = volume > 0 && legs.every((l) => l.closePrice != null)
      ? legs.reduce((s, l) => s + (l.closePrice ?? 0) * l.closeVolume, 0) / volume
      : legs[0].closePrice
    rows.push({
      key,
      legs,
      symbol: legs[0].symbol,
      side: legs[0].side,
      positionTicket: legs[0].positionTicket,
      volume: Math.round(volume * 100) / 100,
      openTime: openTimes[0] ?? null,
      openPrice: withOpen?.openPrice ?? null,
      sl: withSl?.sl ?? null,
      tp: withTp?.tp ?? null,
      closeTime: legs[0].closedAt,
      closePrice,
      gross: sumOrNull(legs, (l) => l.grossProfit),
      commission: sumOrNull(legs, (l) => l.commission),
      swap: sumOrNull(legs, (l) => l.swap),
      net: legs.reduce((s, l) => s + l.profit, 0),
      reason: legs[0].reason ?? null,
      comment: legs.find((l) => l.comment)?.comment ?? null,
      detailed: withOpen != null || legs.some((l) => l.grossProfit != null),
    })
  }
  return rows
}

const DASH = '—'
const money = (n: number | null | undefined): string => (n == null ? DASH : `${n > 0 ? '+' : ''}${n.toFixed(2)}`)
const price = (n: number | null | undefined): string => (n == null ? DASH : String(n))
const pnlClass = (n: number | null | undefined): string => (n == null ? 'text-neutral-500' : n >= 0 ? 'text-up' : 'text-down')

export default function ClosedTradesList({ trades }: Props) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(null)

  const rows = useMemo(() => groupPositions(trades ?? []), [trades])

  // 记录集合变化（含账号切换）时回到第一页并收起展开 / reset on record-set change
  useEffect(() => { setPage(0); setOpen(null) }, [trades])

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageRows = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const reasonLabel = (r: string | null): string => (r ? t(`orders.closed.reason.${r}`, { defaultValue: r }) : DASH)
  const sideTag = (side: 'BUY' | 'SELL') => (
    <span className={`tag ${side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
      {side === 'BUY' ? t('common.buy') : t('common.sell')}
    </span>
  )
  const toggle = (key: string) => setOpen((cur) => (cur === key ? null : key))

  /** 展开区：分批平仓各腿 + 成交号 / 原因 / 注释 / expanded legs & details */
  const details = (row: PositionRow) => (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-neutral-400">
        <span>{t('orders.closed.position')} <b className="font-mono text-neutral-200">#{row.positionTicket}</b></span>
        <span>{t('orders.closed.reasonLabel')} <b className="text-neutral-200">{reasonLabel(row.reason)}</b></span>
        <span>{t('orders.closed.comment')} <b className="font-mono text-neutral-200">{row.comment ?? DASH}</b></span>
        {!row.detailed && <span className="text-amber-400/80">{t('orders.closed.legacy')}</span>}
      </div>
      <div className="mt-2 space-y-1">
        {row.legs.length > 1 && <div className="text-neutral-500">{t('orders.closed.legs', { n: row.legs.length })}</div>}
        {row.legs.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-neutral-300">
            <span className="text-neutral-500">{t('orders.closed.deal')} #{l.dealTicket}</span>
            <span>{fmtTime(l.closedAt)}</span>
            <span>{l.closeVolume} {t('positions.lots')} @ {price(l.closePrice)}</span>
            {l.reason && <span className="text-neutral-500">{reasonLabel(l.reason)}</span>}
            <span className={`font-semibold ${pnlClass(l.profit)}`}>{money(l.profit)}</span>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div className="glass p-5">
      <h3 className="font-display text-lg font-semibold text-neutral-100">{t('winrate.closedTradesTitle')}</h3>
      <p className="mt-1 text-xs text-neutral-500">{t('winrate.closedTradesHint')}</p>

      {trades === null ? (
        <div className="flex items-center justify-center py-10">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-neutral-500">{t('winrate.closedTradesEmpty')}</p>
      ) : (
        <>
          {/* 桌面端表格：列与 MT5 历史「仓位」视图一致，窄屏横向滚动 / desktop table, MT5 columns */}
          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-neutral-500">
                  <th className="px-2 py-2 font-medium">{t('orders.closed.openTime')}</th>
                  <th className="px-2 py-2 font-medium">{t('orders.closed.position')}</th>
                  <th className="px-2 py-2 font-medium">{t('orders.colSymbol')}</th>
                  <th className="px-2 py-2 font-medium">{t('orders.colSide')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.colVolume')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.openPrice')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.sl')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.tp')}</th>
                  <th className="px-2 py-2 font-medium">{t('orders.closed.closeTime')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.closePrice')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.commission')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.swap')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.gross')}</th>
                  <th className="px-2 py-2 text-right font-medium">{t('orders.closed.net')}</th>
                  <th className="w-6 px-1 py-2" />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const expanded = open === row.key
                  return (
                    <Fragment key={row.key}>
                      <tr
                        className={`cursor-pointer border-b border-white/5 transition hover:bg-white/[0.03] ${expanded ? 'bg-white/[0.03]' : ''}`}
                        onClick={() => toggle(row.key)}
                      >
                        <td className="whitespace-nowrap px-2 py-2 text-neutral-400">{row.openTime ? fmtTime(row.openTime) : DASH}</td>
                        <td className="px-2 py-2 font-mono text-neutral-400">{row.positionTicket}</td>
                        <td className="px-2 py-2 font-mono text-neutral-100">{displaySymbol(row.symbol)}</td>
                        <td className="px-2 py-2">{sideTag(row.side)}</td>
                        <td className="px-2 py-2 text-right font-mono text-neutral-200">{row.volume}</td>
                        <td className="px-2 py-2 text-right font-mono text-neutral-200">{price(row.openPrice)}</td>
                        <td className="px-2 py-2 text-right font-mono text-down/90">{price(row.sl)}</td>
                        <td className="px-2 py-2 text-right font-mono text-up/90">{price(row.tp)}</td>
                        <td className="whitespace-nowrap px-2 py-2 text-neutral-400">{fmtTime(row.closeTime)}</td>
                        <td className="px-2 py-2 text-right font-mono text-neutral-200">{price(row.closePrice)}</td>
                        <td className="px-2 py-2 text-right font-mono text-neutral-400">{row.commission == null ? DASH : row.commission.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right font-mono text-neutral-400">{row.swap == null ? DASH : row.swap.toFixed(2)}</td>
                        <td className={`px-2 py-2 text-right font-mono ${pnlClass(row.gross)}`}>{money(row.gross)}</td>
                        <td className={`px-2 py-2 text-right font-mono font-semibold ${pnlClass(row.net)}`}>{money(row.net)}</td>
                        <td className="px-1 py-2 text-center text-neutral-500">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`inline transition-transform ${expanded ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-white/5">
                          <td colSpan={15} className="px-2 py-2">{details(row)}</td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 移动端卡片：主要字段一眼看，点开看止损止盈 / 费用 / 各腿 / mobile cards, expandable */}
          <div className="mt-3 divide-y divide-white/5 md:hidden">
            {pageRows.map((row) => {
              const expanded = open === row.key
              return (
                <div key={row.key} className="py-3" onClick={() => toggle(row.key)}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-neutral-100">{displaySymbol(row.symbol)}</span>
                      {sideTag(row.side)}
                      <span className="font-mono text-xs text-neutral-500">{row.volume} {t('positions.lots')}</span>
                    </div>
                    <span className={`font-mono text-sm font-semibold ${pnlClass(row.net)}`}>{money(row.net)}</span>
                  </div>
                  <div className="mt-1 flex justify-between font-mono text-xs text-neutral-400">
                    <span>{price(row.openPrice)} → {price(row.closePrice)}</span>
                    <span className="text-neutral-500">#{row.positionTicket}</span>
                  </div>
                  <div className="mt-0.5 flex justify-between text-xs text-neutral-500">
                    <span>{row.openTime ? fmtTime(row.openTime) : DASH}</span>
                    <span>{fmtTime(row.closeTime)}</span>
                  </div>
                  {expanded && (
                    <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                        <span className="text-neutral-500">{t('orders.closed.sl')}</span><span className="text-right text-down/90">{price(row.sl)}</span>
                        <span className="text-neutral-500">{t('orders.closed.tp')}</span><span className="text-right text-up/90">{price(row.tp)}</span>
                        <span className="text-neutral-500">{t('orders.closed.commission')}</span><span className="text-right text-neutral-300">{row.commission == null ? DASH : row.commission.toFixed(2)}</span>
                        <span className="text-neutral-500">{t('orders.closed.swap')}</span><span className="text-right text-neutral-300">{row.swap == null ? DASH : row.swap.toFixed(2)}</span>
                        <span className="text-neutral-500">{t('orders.closed.gross')}</span><span className={`text-right ${pnlClass(row.gross)}`}>{money(row.gross)}</span>
                      </div>
                      {details(row)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* 分页：每页 10 个仓位 / pagination: 10 positions per page */}
          {totalPages > 1 && (
            <Pager
              page={safePage}
              totalPages={totalPages}
              total={rows.length}
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            />
          )}
        </>
      )}
    </div>
  )
}
