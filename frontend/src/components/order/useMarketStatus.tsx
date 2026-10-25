// 下单表单的「现在能不能下单」：问后端 /orders/market-status（后端按 MT5 品种配置里的
// 交易时段判，网关不可达时退回固定周末日历），休市就把三个下单入口一起禁掉并显示
// 预计开盘时间。为什么不只靠后端拒单：后端会拒（409），但用户滑动确认之后才看到一句
// 拒绝，不如打开表单就告诉他今天不能下、几点能下。
//
// 周末只有加密货币能下（BTCUSD 等 7x24 品种在 MT5 里配的是全周时段），后端判的就是
// MT5 的配置，这里不写任何品种名。
//
// "Can this symbol be traded right now" for the order forms: asks the backend's
// /orders/market-status (judged from MT5's own trade sessions, falling back to the
// fixed weekend calendar when the gateway is unreachable) and, when closed, disables
// all three order entry points with the expected reopen time. The backend refuses
// anyway (409), but telling the user up front beats a rejection after the slide.
// No symbol names here: weekends-crypto-only is simply what MT5's config says.
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../../api/client'
import type { MarketStatus } from '../../api/types'
import { parseTime } from '../../api/utils'

// 表单打开期间定期复查：休市 → 开盘的那一刻不用关掉重开。
// Re-check while the form is open so the open moment doesn't need a reopen.
const POLL_MS = 60_000

export interface MarketState {
  /** null = 还没查到（不拦）/ null = not known yet (does not block) */
  status: MarketStatus | null
  closed: boolean
  /** 预计开盘时间（UTC+8 文本），没有就空串 / expected reopen (UTC+8 text), '' when unknown */
  reopenText: string
}

// 与 api/utils fmtTime 同一套展示口径（UTC+8），但不带秒。
// Same display convention as fmtTime (UTC+8), without seconds.
function reopenLabel(iso: string | null | undefined): string {
  const d = parseTime(iso)
  if (!d) return ''
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC+8'
}

export function useMarketStatus(symbol: string): MarketState {
  const [status, setStatus] = useState<MarketStatus | null>(null)

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const s = await orderApi.marketStatus(symbol)
        if (!alive) return
        setStatus(s)
        // 休市且知道几点开盘：到点再查一次，比固定 60 秒更准。
        // Closed with a known reopen time: re-check right at that moment.
        const until = s.nextOpenAt ? parseTime(s.nextOpenAt)?.getTime() ?? 0 : 0
        const wait = !s.open && until > Date.now() ? Math.min(POLL_MS, until - Date.now() + 1000) : POLL_MS
        timer = window.setTimeout(tick, Math.max(wait, 5000))
      } catch {
        // 查不到就不拦（后端下单时仍会判）/ unknown → don't block; the backend still judges
        if (!alive) return
        timer = window.setTimeout(tick, POLL_MS)
      }
    }
    setStatus(null)
    void tick()
    return () => {
      alive = false
      if (timer != null) window.clearTimeout(timer)
    }
  }, [symbol])

  return {
    status,
    closed: status != null && !status.open,
    reopenText: status && !status.open ? reopenLabel(status.nextOpenAt) : '',
  }
}

/** 休市提示文案：有预计开盘时间就带上 / the closed message, with the reopen time when known */
export function useMarketClosedText(state: MarketState): string {
  const { t } = useTranslation()
  if (!state.closed) return ''
  return state.reopenText
    ? String(t('order.marketClosedUntil', { time: state.reopenText }))
    : String(t('order.marketClosed'))
}

/** 给 OrderSheet 的 blocked：休市时横幅 + 错误文案 / OrderSheet's `blocked` while closed */
export function useMarketClosedBlock(symbol: string): { banner: ReactNode; error: string } | null {
  const state = useMarketStatus(symbol)
  const text = useMarketClosedText(state)
  if (!state.closed) return null
  return {
    banner: <div className="mb-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">{text}</div>,
    error: text,
  }
}
