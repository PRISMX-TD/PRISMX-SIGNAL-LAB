// 游客预览的数据：一份公开、全员共享的快照（GET /api/public/preview，服务端缓存 3 秒、
// 活跃信号的价位整个抹掉），页面每 4 秒轮询一次；外加几样只取一次的公开事实——时段胜率卡
// 的策略分析、当前公开比赛、试用开关。全部走不带身份的裸 fetch（publicGetJson）。
// Guest preview data: one public snapshot shared by everyone (GET /api/public/preview, 3s
// server cache, active-signal prices stripped), polled every 4s, plus a few public facts
// fetched once — the session card's strategy analysis, the featured public competition and
// the trial switch. All through the identity-free publicGetJson.
import { useEffect, useRef, useState } from 'react'
import type {
  AdminStrategyWinRate, CompetitionSummary, Quote, SentimentRatio, Signal, Trend,
} from '../api/types'
import { inviteApi, paymentApi, readRef } from '../api/client'
import { PublicHttpError, publicCompetitionApi, publicGetJson } from '../api/publicCompetition'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'

const POLL_MS = 4000

export interface GuestPreviewPayload {
  symbols: string[]
  quotes: Record<string, Quote>
  trends: Record<string, Trend>
  sentiment: Record<string, SentimentRatio>
  // 活跃信号：价位为 null，带 locked（盈亏比 + 尺的比例）/ active, prices null, with `locked`
  active: Signal[]
  // 最近结算的信号：价位完整（FREE 本来就看得到）/ recently settled, full prices (FREE sees these)
  recent: Signal[]
  recentStats: { hours: number; issued: number; hitTp: number; hitSl: number }
}

interface RawPayload {
  symbols?: string[]
  quotes?: Quote[]
  trends?: Trend[]
  sentiment?: Record<string, SentimentRatio>
  active?: Signal[]
  recent?: Signal[]
  recentStats?: GuestPreviewPayload['recentStats']
}

export interface GuestOffer {
  // 全局试用开关（/payments/plans 的公开事实）/ the global trial switch (public fact)
  trialDays: number | null
  // 带 ?ref= 进站且该链接送试用 / arrived via ?ref= and that link grants a trial
  inviteTrialDays: number | null
}

// 内容没变就沿用上一份的引用：卡片都是 memo 的，每 4 秒换一个新对象会让整页白白重渲染。
// 报价按品种逐个比，只有真正跳了价的那几行会重画。
// Keep the previous reference when nothing changed — the cards are memoized and a fresh object
// every 4s would re-render the page for nothing. Quotes compare per symbol, so only the rows
// that actually ticked repaint.
function same<T>(prev: T | undefined, next: T): T {
  return prev !== undefined && JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}

function merge(raw: RawPayload, prev: GuestPreviewPayload | null): GuestPreviewPayload {
  const quotes: Record<string, Quote> = {}
  let quotesChanged = !prev
  for (const q of raw.quotes ?? []) {
    const old = prev?.quotes[q.symbol]
    const keep = old && old.bid === q.bid && old.ask === q.ask && old.closed === q.closed && old.digits === q.digits
    quotes[q.symbol] = keep ? old : q
    if (!keep) quotesChanged = true
  }
  if (prev && Object.keys(prev.quotes).length !== Object.keys(quotes).length) quotesChanged = true
  const trends = Object.fromEntries((raw.trends ?? []).map((t) => [t.symbol, t]))
  const next: GuestPreviewPayload = {
    symbols: same(prev?.symbols, raw.symbols ?? []),
    quotes: quotesChanged || !prev ? quotes : prev.quotes,
    trends: same(prev?.trends, trends),
    sentiment: same(prev?.sentiment, raw.sentiment ?? {}),
    active: same(prev?.active, raw.active ?? []),
    recent: same(prev?.recent, raw.recent ?? []),
    recentStats: same(prev?.recentStats, raw.recentStats ?? { hours: 24, issued: 0, hitTp: 0, hitSl: 0 }),
  }
  return prev && (Object.keys(next) as (keyof GuestPreviewPayload)[]).every((k) => next[k] === prev[k]) ? prev : next
}

// onUnavailable：接口 404 = 开关已经关了（本地缓存还记着「预览」），交给上层换回落地页。
// onUnavailable: a 404 means the switch is off (the local cache still says preview); the parent
// falls back to the landing page.
export function useGuestPreviewData(onUnavailable: () => void): GuestPreviewPayload | null {
  const [data, setData] = useState<GuestPreviewPayload | null>(null)
  const unavailable = useRef(onUnavailable)
  unavailable.current = onUnavailable
  usePollWhileVisible(
    (isCurrent) => {
      publicGetJson<RawPayload>('/public/preview')
        .then((raw) => { if (isCurrent()) setData((prev) => merge(raw, prev)) })
        .catch((err) => { if (isCurrent() && err instanceof PublicHttpError && err.status === 404) unavailable.current() })
    },
    POLL_MS,
    [],
  )
  return data
}

// 时段胜率卡的策略分析：只取一次（它比实时快照大得多）。未取到前是 undefined——
// SessionWinrateCard 收到 undefined 会自己去请求需要登录的接口，所以这里先给 null（空态）。
// The session card's analysis, fetched once (far larger than the live snapshot). Starts as null
// rather than undefined: SessionWinrateCard treats undefined as "fetch it yourself", and that
// endpoint needs a session.
export function useGuestAnalysis(): AdminStrategyWinRate | null {
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  useEffect(() => {
    let alive = true
    publicGetJson<AdminStrategyWinRate>('/public/preview/analysis')
      .then((r) => { if (alive) setData(r) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return data
}

// 公开比赛 → 走马灯 / 顶栏徽标要的形状。匿名选手的名字由调用方给。
// Public competition → the shape the marquee / nav badge want.
export function useGuestCompetition(anonymous: string): CompetitionSummary | null {
  const [comp, setComp] = useState<CompetitionSummary | null>(null)
  useEffect(() => {
    let alive = true
    publicCompetitionApi
      .featured()
      .then((f) => (f.id ? publicCompetitionApi.detail(f.id) : null))
      .then((c) => {
        if (!alive || !c) return
        setComp({
          id: c.id, name: c.name, description: c.description, metric: c.metric, enrollment: c.enrollment,
          status: c.status, track: c.track, regOpensAt: c.regOpensAt, regClosesAt: c.regClosesAt,
          startsAt: c.startsAt, endsAt: c.endsAt, prizeNote: c.prizeNote, participants: c.participants,
          top: c.rows.slice(0, 3).map((r) => ({
            displayName: r.displayName ?? anonymous, score: r.score, equippedBadge: null,
          })),
        })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [anonymous])
  return comp
}

export function useGuestOffer(): GuestOffer {
  const [offer, setOffer] = useState<GuestOffer>({ trialDays: null, inviteTrialDays: null })
  useEffect(() => {
    let alive = true
    paymentApi
      .getPlans()
      .then((r) => { if (alive && r.trial?.enabled) setOffer((o) => ({ ...o, trialDays: r.trial!.days })) })
      .catch(() => {})
    const code = readRef()
    if (code) {
      inviteApi
        .getOffer(code)
        .then((r) => { if (alive && r.trialDays) setOffer((o) => ({ ...o, inviteTrialDays: r.trialDays })) })
        .catch(() => {})
    }
    return () => { alive = false }
  }, [])
  return offer
}
