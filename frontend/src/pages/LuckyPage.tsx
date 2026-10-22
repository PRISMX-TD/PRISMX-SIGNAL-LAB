// 幸运轮盘 v2（rev 46）：可以同时有好几期。没有期 → 「暂未开放」卡片 + 我的奖品；一期 → 直接显示；
// 多期 → 顶部切换（期名 + 该期未用券数），记住上次选的期。每期：开放时间 + 作废说明、转盘、
// 奖品一览（不显示概率 / 份数）、我的抽奖券；我的奖品跨期列出。
// 结果由后端决定：点「抽奖」→ POST /lucky-wheel/spin {roundId} → 按返回的 slotIndex 转过去 → 停下再弹结果。
// 按概率模式抽中已抽完的格：转盘照样停在那一格，弹框说「这份奖品已经被抽完了，本次未中奖」。
// Lucky wheel page (v2, rev 46). Several rounds can run at once: none -> the "not open" card plus My
// prizes; one -> shown directly; several -> a switcher (round name + unused-ticket badge) that remembers
// the last pick. The backend picks the result; we spin to its slotIndex, then show it. A prob-mode hit
// on a sold-out slot still stops on that slot and the modal says it was a miss.
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { luckyApi } from '../api/client'
import type { LuckyDraw, LuckySpinResult, LuckyState } from '../api/luckyTypes'
import { fmtTime, localizeApiError } from '../api/utils'
import LuckyWheel, { SPIN_MS, prefersReducedMotion } from '../components/lucky/LuckyWheel'
import { useAuth } from '../store/auth'
import { countdownParts } from '../utils/luckyCountdown'
import { resolveSlot } from '../utils/luckySlot'
import { isWheelClosed, openRounds, pickRound, readLastRound, resultKey, withTicketsLeft, wonDraws, writeLastRound } from '../utils/luckyView'
import { newRequestId, targetRotation } from '../utils/luckyWheel'

function useCountdown(to: string | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return countdownParts(to, now)
}

export default function LuckyPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { refreshUser } = useAuth()
  const [state, setState] = useState<LuckyState | null>(null)
  const [draws, setDraws] = useState<LuckyDraw[]>([])
  const [err, setErr] = useState('')
  const [rotation, setRotation] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [result, setResult] = useState<LuckySpinResult | null>(null)
  // 上次选的期（localStorage，读不到就是 null）/ the last picked round (null when storage is unavailable)
  const [selId, setSelId] = useState<string | null>(() => readLastRound())
  const timer = useRef<number>()
  // 同步锁：state 更新是异步的，连点两下时 spinning 还没变 true，靠它挡住第二个请求。
  // Synchronous lock: `spinning` only flips after a render, so a fast double-click would slip a second
  // request through; this ref closes that gap.
  const spinLock = useRef(false)
  // 抽奖请求发出到动画结束之间为 true：中途离开页面时要补一次 refreshUser，否则首页券数是旧的。
  // True from sending the request until the animation ends; if the user leaves in between we still
  // refresh the account so the dashboard ticket count isn't stale.
  const inFlight = useRef(false)
  const refreshRef = useRef(refreshUser)
  refreshRef.current = refreshUser
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))

  const load = () => Promise.all([luckyApi.state(), luckyApi.draws()])
    .then(([s, d]) => { setState(s); setDraws(d.draws) })
    .catch((e) => setErr(errText(e)))
  useEffect(() => {
    void load()
    return () => {
      window.clearTimeout(timer.current)
      if (inFlight.current) void refreshRef.current?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rounds = state ? openRounds(state) : []
  const cur = pickRound(rounds, selId)
  const round = cur?.round
  const target = round?.phase === 'upcoming' ? round.startsAt : round?.endsAt
  const cd = useCountdown(target)

  // 倒计时走到 0（开始 / 结束）时重新拉一次状态，阶段才会自己翻过去；每个目标时间只拉一次，
  // 万一服务器时钟略慢、阶段还没翻，也不会每秒重拉。切到另一期时按那一期的时间算。
  // When the countdown reaches zero (start / end) reload once so the phase flips by itself; once per
  // target time, so a server clock a hair behind can't turn this into a once-a-second refetch.
  // Switching rounds switches the target too.
  const reloadedFor = useRef<string | null>(null)
  const cdDone = !!cd?.done
  useEffect(() => {
    if (!cdDone || !target || reloadedFor.current === target) return
    reloadedFor.current = target
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdDone, target])

  const select = (id: string) => {
    // 转动中不许换期：转盘画的是这一期的格子 / no switching mid-spin: the wheel shows this round's slots
    if (spinning || spinLock.current) return
    setSelId(id)
    writeLastRound(id)
    setErr('')
  }

  const onSpin = async () => {
    if (!state || !cur || spinning || spinLock.current) return
    const roundId = cur.round.id
    spinLock.current = true
    inFlight.current = true
    setErr('')
    setSpinning(true)
    const finish = (r: LuckySpinResult) => {
      setSpinning(false)
      setResult(r)
      setState((s) => s && withTicketsLeft(s, r.round?.id ?? roundId, r.ticketsLeft))
      void luckyApi.draws().then((d) => setDraws(d.draws)).catch(() => {})
      void refreshUser?.()
      inFlight.current = false
      spinLock.current = false
    }
    try {
      const r = await luckyApi.spin(roundId, newRequestId())
      // 后端的 slotIndex 按它此刻这一期的上架顺序算；本地奖品列表可能已被管理员改过。对不上就先拉新状态
      // （转盘按新格子重画），再按新列表算要停的格；这一期不见了或仍找不到就不转，直接出结果。
      // The backend's slotIndex follows this round's current listing; our cached prizes may be stale.
      // On a mismatch refetch state first (the wheel redraws with the new slots), then resolve against
      // it; if the round is gone or there is still nowhere to land, skip the animation and show the result.
      let prizes = cur.prizes
      let slot = resolveSlot(prizes, r.prize.id, r.slotIndex)
      if (!slot.consistent) {
        try {
          const fresh = await luckyApi.state()
          setState(fresh)
          prizes = fresh.rounds.find((x) => x.round.id === roundId)?.prizes ?? []
          slot = resolveSlot(prizes, r.prize.id, r.slotIndex)
        } catch { /* 拉不到就按现有列表尽力而为 / best effort with what we have */ }
      }
      if (slot.index < 0) { finish(r); return }
      const idx = slot.index
      const n = prizes.length
      setRotation((c) => targetRotation(c, idx, n, Math.random() * 2 - 1))
      timer.current = window.setTimeout(() => finish(r), prefersReducedMotion() ? 200 : SPIN_MS + 200)
    } catch (e) {
      setSpinning(false)
      inFlight.current = false
      spinLock.current = false
      setErr(errText(e))
      void load()
    }
  }

  if (!state) return <div className="py-16 text-center text-sm text-neutral-500">{err || t('common.loading')}</div>
  // 结果弹框在两个分支里都要画：倒计时归零、重载后这一期不见了（关闭）时，不能把还没看的结果卸掉。
  // The result modal is rendered in both branches: when the countdown hits zero and the reload drops
  // the round (closed), an unseen result must not be unmounted.
  const modal = result && (
    <ResultModal draw={result} onClose={() => setResult(null)} onChange={(d) => {
      setDraws((xs) => xs.map((x) => (x.id === d.id ? d : x)))
      setResult({ ...result, ...d })
    }} navigate={navigate} />
  )
  if (isWheelClosed(state) || !cur || !round) {
    // 关闭时仍显示「我的奖品」：奖品没有系统领取期限，期结束后用户还要能领奖。
    // Still show "My prizes" while closed: no system claim deadline, winners claim after the round.
    return (
      <div className="mx-auto max-w-xl space-y-5">
        <div className="card p-10 text-center text-neutral-400">{t('lucky.closed')}</div>
        {draws.length > 0 && <MyPrizes draws={draws} onChange={setDraws} navigate={navigate} />}
        {modal}
      </div>
    )
  }

  const unused = cur.tickets.unused
  const canSpin = round.phase === 'active' && unused > 0 && !spinning
  return (
    <div className="space-y-4">
      {rounds.length > 1 && (
        <div role="tablist" aria-label={t('lucky.rounds')} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {rounds.map((r) => {
            const on = r.round.id === round.id
            return (
              <button key={r.round.id} type="button" role="tab" aria-selected={on} disabled={spinning && !on}
                onClick={() => select(r.round.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-40 ${
                  on ? 'border-prism-500/70 bg-prism-500/15 text-neutral-50' : 'border-white/10 text-neutral-300 hover:bg-white/5'}`}>
                <span className="max-w-[11rem] truncate">{r.round.name}</span>
                {r.round.phase === 'upcoming' && <span className="text-[11px] text-neutral-500">{t('lucky.notStarted')}</span>}
                {r.tickets.unused > 0 && (
                  <span className="rounded-full bg-amber-400/20 px-1.5 font-mono text-[11px] text-amber-300"
                    aria-label={t('lucky.ticketsBadge', { n: r.tickets.unused })}>{r.tickets.unused}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card min-w-0 p-5">
          <div className="mb-5 space-y-1 text-center">
            <h1 className="break-words font-display text-base font-semibold text-neutral-100">{round.name}</h1>
            <div className="break-words text-sm text-neutral-300">
              {t('lucky.window', { from: fmtTime(round.startsAt), to: fmtTime(round.endsAt) })}
            </div>
            <div className="text-xs text-amber-300">{t('lucky.voidNotice')}</div>
            {cd && !cd.done && (
              <div className="font-mono text-xs text-neutral-400">
                {t(round.phase === 'upcoming' ? 'lucky.startsIn' : 'lucky.endsIn', cd)}
              </div>
            )}
          </div>
          {/* 等分扇区，不暴露概率 / 份数；份数用完的格照常显示 / equal slices; sold-out slots look the same */}
          <LuckyWheel prizes={cur.prizes} rotation={rotation} spinning={spinning} />
          <div className="mt-5 flex flex-col items-center gap-2">
            <button type="button" className="btn-primary min-w-[200px] py-2.5 text-base disabled:opacity-40"
              disabled={!canSpin} onClick={onSpin}>
              {round.phase === 'upcoming' ? t('lucky.notStarted')
                : spinning ? t('lucky.spinning')
                : t('lucky.spin', { n: unused })}
            </button>
            {unused === 0 && round.phase === 'active' && (
              <p className="text-center text-xs text-neutral-500">{t('lucky.noTickets')}</p>
            )}
            {err && <p className="text-center text-xs text-down">{err}</p>}
          </div>
        </section>

        <aside className="min-w-0 space-y-5">
          <section className="card p-4">
            <h2 className="mb-3 font-display text-sm font-semibold text-neutral-100">{t('lucky.prizes')}</h2>
            <ul className="space-y-2">
              {cur.prizes.map((p) => (
                <li key={p.id} className="flex items-center gap-3 text-sm">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                    : <span className="h-8 w-8 shrink-0 rounded" style={{ background: p.color || '#334155' }} />}
                  <div className="min-w-0">
                    <div className="truncate text-neutral-100">{p.name}</div>
                    {p.description && <div className="truncate text-xs text-neutral-500">{p.description}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-4">
            <h2 className="mb-3 font-display text-sm font-semibold text-neutral-100">{t('lucky.myTickets')}</h2>
            {cur.tickets.batches.length === 0 ? <p className="text-xs text-neutral-500">{t('lucky.noTicketsHint')}</p> : (
              <ul className="space-y-1.5 text-xs text-neutral-300">
                {cur.tickets.batches.map((b, i) => (
                  <li key={`${b.reason ?? 'retry'}-${b.issuedAt}-${i}`} className="flex justify-between gap-2">
                    {/* reason 为 null = 「再来一次」退回的券 / null reason = a retry refund */}
                    <span className="truncate">{b.reason ?? t('lucky.retryTicket')}</span>
                    <span className="shrink-0 font-mono">×{b.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <MyPrizes draws={draws} onChange={setDraws} navigate={navigate} />
        </aside>
      </div>

      {modal}
    </div>
  )
}

function ClaimActions({ draw, onChange, navigate }: {
  draw: LuckyDraw; onChange: (d: LuckyDraw) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(draw.claimInfo ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const open = draw.fulfillmentStatus === 'pending' || draw.fulfillmentStatus === 'submitted'
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))
  // 已抽完未中奖不用领奖 / a sold-out miss has nothing to claim
  if (draw.prize.kind !== 'custom' || draw.soldOut) return null
  if (!open) {
    return draw.adminNote ? <p className="text-xs text-neutral-400">{draw.adminNote}</p> : null
  }
  if (draw.prize.claimMode === 'ticket') {
    return (
      <div className="space-y-1.5">
        <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={async () => {
          // 已有工单就直接去看，不再重复开 / an existing ticket is just opened, never re-created
          if (draw.supportTicketId) { navigate(`/support?ticket=${encodeURIComponent(draw.supportTicketId)}`); return }
          setBusy(true)
          setErr('')
          try {
            const r = await luckyApi.claimTicket(draw.id)
            onChange(r.draw)
            navigate(`/support?ticket=${encodeURIComponent(r.ticketId)}`)
          } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
        }}>
          {draw.supportTicketId ? t('lucky.viewTicket') : t('lucky.claimByTicket')}
        </button>
        {err && <p className="text-xs text-down">{err}</p>}
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {draw.prize.claimHint && <p className="break-words text-xs text-neutral-400">{draw.prize.claimHint}</p>}
      <textarea className="input w-full py-1.5 text-sm" rows={3} maxLength={1000} value={text}
        onChange={(e) => setText(e.target.value)} />
      <button type="button" className="btn-primary px-3 py-1 text-xs disabled:opacity-40"
        disabled={busy || !text.trim()} onClick={async () => {
          setBusy(true)
          setErr('')
          try { onChange(await luckyApi.claimInfo(draw.id, text)) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
        }}>
        {draw.fulfillmentStatus === 'submitted' ? t('lucky.updateClaim') : t('lucky.submitClaim')}
      </button>
      {err && <p className="text-xs text-down">{err}</p>}
    </div>
  )
}

function MyPrizes({ draws, onChange, navigate }: {
  draws: LuckyDraw[]; onChange: (xs: LuckyDraw[]) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const won = wonDraws(draws)
  return (
    <section className="card p-4">
      <h2 className="mb-3 font-display text-sm font-semibold text-neutral-100">{t('lucky.myPrizes')}</h2>
      {won.length === 0 ? <p className="text-xs text-neutral-500">{t('lucky.noPrizes')}</p> : (
        <ul className="space-y-3">
          {won.map((d) => (
            <li key={d.id} className="space-y-1.5 border-b border-white/5 pb-3 last:border-0">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-neutral-100">{d.prize.name}</span>
                <span className="shrink-0 text-xs text-neutral-400">{t(`lucky.status.${d.fulfillmentStatus}`)}</span>
              </div>
              <div className="break-words text-xs text-neutral-500">
                {fmtTime(d.createdAt)}{d.roundName ? ` · ${d.roundName}` : ''}
              </div>
              <ClaimActions draw={d} navigate={navigate}
                onChange={(nd) => onChange(draws.map((x) => (x.id === nd.id ? nd : x)))} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ResultModal({ draw, onClose, onChange, navigate }: {
  draw: LuckyDraw; onClose: () => void; onChange: (d: LuckyDraw) => void; navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  // 打开即把焦点交给「知道了」，Esc 关闭 / Focus the close button on open; Escape closes.
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const rk = resultKey(draw)
  const title = t(rk.key, rk.params)
  // 已抽完未中奖：不显示那份奖品的图和说明，免得像是中了 / a sold-out miss hides the prize art so it doesn't read as a win
  const showPrize = !draw.soldOut
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card max-h-[90vh] w-full max-w-sm space-y-4 overflow-y-auto p-6 text-center" onClick={(e) => e.stopPropagation()}>
        {showPrize && draw.prize.imageUrl && <img src={draw.prize.imageUrl} alt="" className="mx-auto h-20 w-20 rounded-lg object-cover" />}
        <div id={titleId} className="break-words font-display text-lg font-semibold text-neutral-100">{title}</div>
        {showPrize && draw.prize.description && <p className="break-words text-sm text-neutral-400">{draw.prize.description}</p>}
        <div className="text-left"><ClaimActions draw={draw} onChange={onChange} navigate={navigate} /></div>
        <button ref={closeRef} type="button" className="btn-ghost w-full py-2" onClick={onClose}>{t('lucky.close')}</button>
      </div>
    </div>
  )
}
