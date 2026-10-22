// 幸运轮盘（rev 45）：开放时间 + 作废说明、转盘、奖品一览（不显示概率）、我的抽奖券、我的奖品与领奖。
// 结果由后端决定：点「抽奖」→ POST /lucky-wheel/spin → 按返回的 slotIndex 转过去 → 停下再弹结果。
// Lucky wheel page. The backend picks the result; we spin to its slotIndex, then show it.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { luckyApi } from '../api/client'
import type { LuckyDraw, LuckySpinResult, LuckyState } from '../api/luckyTypes'
import { fmtTime, localizeApiError } from '../api/utils'
import LuckyWheel, { SPIN_MS, prefersReducedMotion } from '../components/lucky/LuckyWheel'
import { useAuth } from '../store/auth'
import { countdownParts } from '../utils/luckyCountdown'
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
  const timer = useRef<number>()
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))

  const load = () => Promise.all([luckyApi.state(), luckyApi.draws()])
    .then(([s, d]) => { setState(s); setDraws(d.draws) })
    .catch((e) => setErr(errText(e)))
  useEffect(() => {
    void load()
    return () => window.clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const round = state?.round
  const target = round?.phase === 'upcoming' ? round.startsAt : round?.endsAt
  const cd = useCountdown(target)

  const onSpin = async () => {
    if (!state || spinning) return
    setErr('')
    setSpinning(true)
    try {
      const r = await luckyApi.spin(newRequestId())
      const idx = r.slotIndex ?? 0
      setRotation((cur) => targetRotation(cur, idx, state.prizes.length, Math.random() * 2 - 1))
      timer.current = window.setTimeout(() => {
        setSpinning(false)
        setResult(r)
        setState((s) => s && { ...s, tickets: { ...s.tickets, unused: r.ticketsLeft } })
        void luckyApi.draws().then((d) => setDraws(d.draws)).catch(() => {})
        void refreshUser?.()
      }, prefersReducedMotion() ? 200 : SPIN_MS + 200)
    } catch (e) {
      setSpinning(false)
      setErr(errText(e))
      void load()
    }
  }

  if (!state) return <div className="py-16 text-center text-sm text-neutral-500">{err || t('common.loading')}</div>
  if (!state.visible || !round || round.phase === 'none') {
    return <div className="card mx-auto max-w-xl p-10 text-center text-neutral-400">{t('lucky.closed')}</div>
  }

  const canSpin = round.phase === 'active' && state.tickets.unused > 0 && !spinning
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="card min-w-0 p-5">
        <div className="mb-5 space-y-1 text-center">
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
        <LuckyWheel prizes={state.prizes} rotation={rotation} spinning={spinning} />
        <div className="mt-5 flex flex-col items-center gap-2">
          <button type="button" className="btn-primary min-w-[200px] py-2.5 text-base disabled:opacity-40"
            disabled={!canSpin} onClick={onSpin}>
            {round.phase === 'upcoming' ? t('lucky.notStarted')
              : spinning ? t('lucky.spinning')
              : t('lucky.spin', { n: state.tickets.unused })}
          </button>
          {state.tickets.unused === 0 && round.phase === 'active' && (
            <p className="text-center text-xs text-neutral-500">{t('lucky.noTickets')}</p>
          )}
          {err && <p className="text-center text-xs text-down">{err}</p>}
        </div>
      </section>

      <aside className="min-w-0 space-y-5">
        <section className="card p-4">
          <h2 className="mb-3 font-display text-sm font-semibold text-neutral-100">{t('lucky.prizes')}</h2>
          <ul className="space-y-2">
            {state.prizes.map((p) => (
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
          {state.tickets.batches.length === 0 ? <p className="text-xs text-neutral-500">{t('lucky.noTicketsHint')}</p> : (
            <ul className="space-y-1.5 text-xs text-neutral-300">
              {state.tickets.batches.map((b, i) => (
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

      {result && <ResultModal draw={result} onClose={() => setResult(null)} onChange={(d) => {
        setDraws((xs) => xs.map((x) => (x.id === d.id ? d : x)))
        setResult({ ...result, ...d })
      }} navigate={navigate} />}
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
  if (draw.prize.kind !== 'custom') return null
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
  const won = draws.filter((d) => d.prize.kind !== 'none')
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
              <div className="text-xs text-neutral-500">{fmtTime(d.createdAt)}</div>
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
  const title = draw.prize.kind === 'none' ? t('lucky.result.none')
    : draw.prize.kind === 'retry' ? t('lucky.result.retry')
    : draw.prize.kind === 'pro_days' ? t('lucky.result.proDays', { n: draw.prize.proDays })
    : t('lucky.result.custom', { name: draw.prize.name })
  return (
    <div role="dialog" aria-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card max-h-[90vh] w-full max-w-sm space-y-4 overflow-y-auto p-6 text-center" onClick={(e) => e.stopPropagation()}>
        {draw.prize.imageUrl && <img src={draw.prize.imageUrl} alt="" className="mx-auto h-20 w-20 rounded-lg object-cover" />}
        <div className="break-words font-display text-lg font-semibold text-neutral-100">{title}</div>
        {draw.prize.description && <p className="break-words text-sm text-neutral-400">{draw.prize.description}</p>}
        <div className="text-left"><ClaimActions draw={draw} onChange={onChange} navigate={navigate} /></div>
        <button type="button" className="btn-ghost w-full py-2" onClick={onClose}>{t('lucky.close')}</button>
      </div>
    </div>
  )
}
