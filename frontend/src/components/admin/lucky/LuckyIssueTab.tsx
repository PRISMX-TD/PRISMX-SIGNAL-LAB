// 发券：按比赛名次 / 排行榜名次（分档）/ 手动搜索 → 合并进确认清单 → 填原因 → 二次确认发放。
// 名次在后端解析（/issue/preview），前端只展示、改张数、删人。v2：券发给当前选中的那一期（顶部显示期名），
// 已结束的期不能发；这一期没在用户端显示时提示「打开后再通知」。发放记录 / 收回也按这一期。
// Issue tickets: by competition rank / leaderboard rank (tiers) / manual search -> merge into one
// confirm list -> reason -> confirm twice. Ranks are resolved by the backend (/issue/preview); the UI
// only shows them and lets the admin edit counts or drop people. v2: tickets go to the selected round
// (named at the top); an ended round can't be issued to; while the round is hidden the page says users
// are notified once it is switched on. Batches and revoking are scoped to the round too.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyBatch, LuckyRoundAdmin, LuckyTier } from '../../../api/luckyTypes'
import type { AdminUser, CompetitionAdminRow } from '../../../api/types'
import { fmtTime, localizeApiError } from '../../../api/utils'
import { newRequestId } from '../../../utils/luckyWheel'
import { clampCount, limitProblem, merge, periodValid, tierProblem, totals, type DupMode, type IssueLine } from './luckyIssue'

type Mode = 'comp' | 'board' | 'manual'
type PeriodKind = 'week' | 'month' | 'custom'

// 数字输入：输入中允许暂时为空（不然删光就被改回 1，再打 5 变成 15），失焦时回到当前有效值。
// Numeric box: may be empty while typing (otherwise clearing snaps to 1 and typing 5 gives 15);
// on blur it falls back to the committed value.
function NumBox({ value, max, label, onCommit }: { value: number; max: number; label: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input className="input w-16 py-1 text-sm" inputMode="numeric" aria-label={label} value={text}
      onChange={(e) => {
        const s = e.target.value.replace(/\D/g, '').slice(0, 5)
        setText(s)
        if (s) onCommit(clampCount(Number(s), max))
      }}
      onBlur={() => setText(String(value))} />
  )
}

// 外壳按 round.id 做 key：换期就整页重置（清单、requestId 都不跨期沿用）。
// The shell keys this by round.id, so switching rounds resets everything (list and requestId never carry over).
export default function LuckyIssueTab({ round, onIssued }: { round: LuckyRoundAdmin; onIssued: () => void }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('comp')
  const [comps, setComps] = useState<CompetitionAdminRow[]>([])
  const [compId, setCompId] = useState('')
  const [board, setBoard] = useState<'return_pct' | 'win_rate'>('return_pct')
  const [periodKind, setPeriodKind] = useState<PeriodKind>('month')
  const [customPeriod, setCustomPeriod] = useState('')
  const [tiers, setTiers] = useState<LuckyTier[]>([{ fromRank: 1, toRank: 10, count: 1 }])
  const [q, setQ] = useState('')
  const [found, setFound] = useState<AdminUser[] | null>(null)
  const [list, setList] = useState<IssueLine[]>([])
  const [dupMode, setDupMode] = useState<DupMode>('sum')
  const [reason, setReason] = useState('')
  // 同一份清单重试沿用同一个 requestId（后端按它去重），发放成功后才换新的。
  // A retry of the same list reuses its requestId (the backend dedupes on it); a new one only after success.
  const [requestId, setRequestId] = useState(newRequestId)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [batches, setBatches] = useState<LuckyBatch[]>([])
  const searchSeq = useRef(0)
  const loadBatches = () => adminApi.luckyBatches(round.id).then((r) => setBatches(r.batches))
  useEffect(() => {
    let live = true
    adminApi.luckyBatches(round.id).then((r) => { if (live) setBatches(r.batches) })
      .catch((e) => { if (live) setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) })
    adminApi.competitions().then((r) => { if (live) setComps(r.filter((c) => c.status !== 'draft')) })
      .catch((e) => { if (live) setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('')
    try { await fn() } catch (e) { setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) } finally { setBusy(false) }
  }
  if (round.phase === 'ended') {
    return <div className="card p-6 text-sm text-neutral-400">{t('admin.lucky.issue.ended')}</div>
  }
  const tot = totals(list)
  const over = limitProblem(list)
  const period = periodKind === 'custom' ? customPeriod.trim() : periodKind
  const tierErr = tierProblem(tiers)
  const loadBlocked = busy || tierErr !== null || (mode === 'comp' ? !compId : !periodValid(period))
  const patchTier = (i: number, p: Partial<LuckyTier>) => setTiers((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)))
  const search = () => {
    const my = ++searchSeq.current
    void run(async () => {
      const r = await adminApi.listUsers({ q: q.trim(), limit: 20 })
      if (my === searchSeq.current) setFound(r.users)
    })
  }
  const addManual = (u: AdminUser) => setList((l) => merge(l, [{
    userId: u.id, email: u.email, nickname: u.nickname ?? null, rank: null, count: 1,
    source: 'manual', sourceRef: null, label: t('admin.lucky.issue.manual'),
  }], dupMode))

  return (
    <div className="space-y-4">
      <p className="break-words text-sm text-neutral-300">{t('admin.lucky.issue.target', { name: round.name })}</p>
      {!round.visible && <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t('admin.lucky.issue.hiddenWarn')}</div>}
      <section className="card space-y-3 p-4">
        <div className="seg-tabs w-full sm:w-fit">
          {(['comp', 'board', 'manual'] as Mode[]).map((m) => (
            <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
              {t(`admin.lucky.issue.${m === 'comp' ? 'fromComp' : m === 'board' ? 'fromBoard' : 'manual'}`)}</button>
          ))}
        </div>
        {mode !== 'manual' ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {mode === 'comp' ? (
                <select className="input py-1.5 text-sm" aria-label={t('admin.lucky.issue.pickComp')} value={compId} onChange={(e) => setCompId(e.target.value)}>
                  <option value="">{t('admin.lucky.issue.pickComp')}</option>
                  {comps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : (
                <>
                  <select className="input py-1.5 text-sm" aria-label={t('admin.lucky.issue.fromBoard')} value={board}
                    onChange={(e) => setBoard(e.target.value as typeof board)}>
                    <option value="return_pct">{t('admin.lucky.issue.board.return_pct')}</option>
                    <option value="win_rate">{t('admin.lucky.issue.board.win_rate')}</option>
                  </select>
                  <select className="input py-1.5 text-sm" aria-label={t('admin.lucky.issue.period')} value={periodKind}
                    onChange={(e) => setPeriodKind(e.target.value as PeriodKind)}>
                    <option value="week">{t('admin.lucky.issue.week')}</option>
                    <option value="month">{t('admin.lucky.issue.month')}</option>
                    <option value="custom">{t('admin.lucky.issue.custom')}</option>
                  </select>
                  {periodKind === 'custom' && (
                    <input className="input w-full py-1.5 text-sm sm:w-60" maxLength={16} placeholder={t('admin.lucky.issue.periodKey')}
                      value={customPeriod} onChange={(e) => setCustomPeriod(e.target.value)} />
                  )}
                </>
              )}
            </div>
            {tiers.map((tr, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
                {t('admin.lucky.issue.from')}
                <NumBox value={tr.fromRank} max={1000} label={t('admin.lucky.issue.from')} onCommit={(n) => patchTier(i, { fromRank: n })} />
                {t('admin.lucky.issue.to')}
                <NumBox value={tr.toRank} max={1000} label={t('admin.lucky.issue.to')} onCommit={(n) => patchTier(i, { toRank: n })} />
                {t('admin.lucky.issue.count')}
                <NumBox value={tr.count} max={100} label={t('admin.lucky.issue.count')} onCommit={(n) => patchTier(i, { count: n })} />
                {tiers.length > 1 && (
                  <button type="button" className="text-down" aria-label={t('admin.lucky.remove')}
                    onClick={() => setTiers((xs) => xs.filter((_, j) => j !== i))}>✕</button>
                )}
              </div>
            ))}
            {tierErr && <p className="text-xs text-down">{t(`admin.lucky.issue.err.${tierErr}`)}</p>}
            <div className="flex gap-2">
              <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={tiers.length >= 20}
                onClick={() => setTiers((xs) => {
                  const end = Math.max(0, ...xs.map((x) => x.toRank))
                  return [...xs, { fromRank: Math.min(1000, end + 1), toRank: Math.min(1000, end + 10), count: 1 }]
                })}>
                {t('admin.lucky.issue.addTier')}</button>
              <button type="button" className="btn-primary px-3 py-1 text-xs disabled:opacity-40" disabled={loadBlocked}
                onClick={() => run(async () => {
                  const src = mode === 'comp' ? { type: 'comp' as const, compId, tiers } : { type: 'board' as const, board, period, tiers }
                  const r = await adminApi.luckyIssuePreview(src)
                  setList((l) => merge(l, r.rows, dupMode))
                  setMsg(r.rows.length ? t('admin.lucky.issue.loaded', { n: r.rows.length }) : t('admin.lucky.issue.none'))
                })}>{t('admin.lucky.issue.load')}</button>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input className="input min-w-0 flex-1 py-1.5 text-sm sm:w-64 sm:flex-none" placeholder={t('admin.lucky.issue.search')} value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && q.trim() && !busy) search() }} />
              <button type="button" className="btn-ghost px-3 py-1 text-xs" aria-label={t('admin.lucky.issue.search')}
                disabled={busy || !q.trim()} onClick={search}>⌕</button>
            </div>
            {found && !found.length && <p className="text-xs text-neutral-500">{t('admin.lucky.issue.none')}</p>}
            <ul className="space-y-1 text-sm">
              {(found ?? []).map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-neutral-200">{u.nickname || '—'} · {u.email}</span>
                  <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => addManual(u)}>{t('admin.lucky.issue.add')}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-display text-sm font-semibold text-neutral-100">{t('admin.lucky.issue.list')}</h3>
          <select className="input py-1 text-xs" aria-label={t('admin.lucky.issue.dup')} value={dupMode} onChange={(e) => setDupMode(e.target.value as DupMode)}>
            <option value="sum">{t('admin.lucky.issue.dupSum')}</option>
            <option value="once">{t('admin.lucky.issue.dupOnce')}</option>
          </select>
          <span className="text-xs text-neutral-500">{t('admin.lucky.issue.limit')}</span>
          {list.length > 0 && <button type="button" className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => setList([])}>{t('admin.lucky.issue.clear')}</button>}
        </div>
        {list.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('admin.lucky.issue.emptyList')}</p>
        ) : (
          <div className="max-h-[360px] overflow-auto">
            <table className="w-full text-sm">
              <tbody>
                {list.map((x) => (
                  <tr key={x.userId} className="border-b border-white/5 last:border-0">
                    <td className="px-2 py-1.5"><div className="truncate text-neutral-100">{x.nickname || '—'}</div><div className="text-xs text-neutral-500">{x.email}</div></td>
                    <td className="px-2 py-1.5 text-xs text-neutral-400">{x.label}{x.rank ? ` #${x.rank}` : ''}{x.dup && <span className="ml-1 text-amber-300">{t('admin.lucky.issue.dup')}</span>}</td>
                    <td className="px-2 py-1.5">
                      <NumBox value={x.count} max={100} label={t('admin.lucky.issue.count')}
                        onCommit={(n) => setList((l) => l.map((y) => (y.userId === x.userId ? { ...y, count: n } : y)))} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" className="text-xs text-down" aria-label={t('admin.lucky.remove')}
                        onClick={() => setList((l) => l.filter((y) => y.userId !== x.userId))}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <input className="input w-full py-1.5 text-sm sm:w-72" maxLength={80} placeholder={t('admin.lucky.issue.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="text-xs text-neutral-400">{t('admin.lucky.issue.summary', tot)}</span>
          {over && <span className="text-xs text-down">{t(`admin.lucky.issue.err.${over}`)}</span>}
          <button type="button" className="btn-primary ml-auto px-3 py-1.5 text-sm disabled:opacity-40"
            disabled={busy || !reason.trim() || !list.length || over !== null}
            onClick={() => run(async () => {
              if (!window.confirm(t('admin.lucky.issue.confirmAsk', tot))) return
              const r = await adminApi.luckyIssue({ roundId: round.id, reason: reason.trim(), requestId, items: list.map((x) => ({
                userId: x.userId, count: x.count, source: x.source, sourceRef: x.sourceRef, rank: x.rank })) })
              setMsg(t('admin.lucky.issue.done', { users: r.userCount, tickets: r.ticketCount }))
              setList([]); setReason(''); setRequestId(newRequestId()); onIssued()
              await loadBatches().catch(() => {})
            })}>{t('admin.lucky.issue.confirm')}</button>
        </div>
        {msg && <p className="text-xs text-neutral-300" role="status">{msg}</p>}
      </section>

      <section className="card p-4">
        <h3 className="mb-2 font-display text-sm font-semibold text-neutral-100">{t('admin.lucky.issue.batches')}</h3>
        {batches.length === 0 && <p className="text-xs text-neutral-500">{t('admin.lucky.issue.noBatches')}</p>}
        <ul className="space-y-1.5 text-sm">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-neutral-500">{fmtTime(b.createdAt)}</span>
              <span className="text-neutral-200">{b.reason}</span>
              <span className="font-mono text-xs text-neutral-400">{b.userCount} · {b.used}/{b.ticketCount}</span>
              <button type="button" className="btn-ghost ml-auto px-2 py-0.5 text-xs" disabled={busy}
                onClick={() => run(async () => {
                  if (!window.confirm(t('admin.lucky.issue.revokeAsk', { reason: b.reason }))) return
                  const r = await adminApi.luckyRevoke({ batchId: b.id, roundId: round.id })
                  setMsg(t('admin.lucky.issue.revoked', { n: r.revoked })); onIssued()
                  await loadBatches().catch(() => {})
                })}>
                {t('admin.lucky.issue.revoke')}</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
