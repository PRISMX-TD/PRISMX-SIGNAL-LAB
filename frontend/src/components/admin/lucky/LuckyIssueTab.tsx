// 发券：按比赛名次 / 排行榜名次（分档）/ 手动搜索 → 合并进确认清单 → 填原因 → 二次确认发放。
// 名次在后端解析（/issue/preview），前端只展示、改张数、删人。v2：券发给当前选中的那一期（卡头写着期名），
// 已结束的期不能发；这一期没在用户端显示时提示「打开后再通知」。发放记录 / 收回也按这一期。
// 三张卡：选人、确认清单、这一期的发放记录。
// Issue tickets: by competition rank / leaderboard rank (tiers) / manual search -> merge into one
// confirm list -> reason -> confirm twice. Ranks are resolved by the backend (/issue/preview); the UI
// only shows them and lets the admin edit counts or drop people. v2: tickets go to the selected round
// (named in the card head); an ended round can't be issued to; while the round is hidden the page says
// users are notified once it is switched on. Batches and revoking are scoped to the round too.
// Three cards: pick recipients, the confirm list, and this round's batches.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyBatch, LuckyRoundAdmin, LuckyTier } from '../../../api/luckyTypes'
import type { AdminUser, CompetitionAdminRow } from '../../../api/types'
import { fmtTime, localizeApiError } from '../../../api/utils'
import { newRequestId } from '../../../utils/luckyWheel'
import { clampCount, limitProblem, merge, periodValid, tierProblem, totals, type DupMode, type IssueLine } from './luckyIssue'
import Copyable from '../../Copyable'

type Mode = 'comp' | 'board' | 'manual'
type PeriodKind = 'week' | 'month' | 'custom'
const MODE_KEY: Record<Mode, string> = { comp: 'fromComp', board: 'fromBoard', manual: 'manual' }

// 数字输入：输入中允许暂时为空（不然删光就被改回 1，再打 5 变成 15），失焦时回到当前有效值。
// Numeric box: may be empty while typing (otherwise clearing snaps to 1 and typing 5 gives 15);
// on blur it falls back to the committed value.
function NumBox({ value, max, label, onCommit }: { value: number; max: number; label: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input className="input num w-16" inputMode="numeric" aria-label={label} value={text}
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
    return <div className="adm-card adm-empty"><p className="adm-empty-title">{t('admin.lucky.issue.ended')}</p></div>
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
    <div className="lka-issue space-y-4">
      {!round.visible && <div className="lka-warn-bar">{t('admin.lucky.issue.hiddenWarn')}</div>}

      <section className="adm-card">
        <div className="lka-card-head">
          <div className="min-w-0">
            <h4 className="lka-h">{t('admin.lucky.issue.pickTitle')}</h4>
            <p className="lka-sub break-words">{t('admin.lucky.issue.target', { name: round.name })}</p>
          </div>
        </div>
        <div className="adm-seg lka-scroll" role="radiogroup" aria-label={t('admin.lucky.issue.pickTitle')}>
          {(['comp', 'board', 'manual'] as Mode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'is-on' : ''}
              onClick={() => setMode(m)}>{t(`admin.lucky.issue.${MODE_KEY[m]}`)}</button>
          ))}
        </div>

        {mode !== 'manual' ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {mode === 'comp' ? (
                <select className="input w-full sm:w-72" aria-label={t('admin.lucky.issue.pickComp')} value={compId}
                  onChange={(e) => setCompId(e.target.value)}>
                  <option value="">{t('admin.lucky.issue.pickComp')}</option>
                  {comps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : (
                <>
                  <select className="input w-auto" aria-label={t('admin.lucky.issue.fromBoard')} value={board}
                    onChange={(e) => setBoard(e.target.value as typeof board)}>
                    <option value="return_pct">{t('admin.lucky.issue.board.return_pct')}</option>
                    <option value="win_rate">{t('admin.lucky.issue.board.win_rate')}</option>
                  </select>
                  <select className="input w-auto" aria-label={t('admin.lucky.issue.period')} value={periodKind}
                    onChange={(e) => setPeriodKind(e.target.value as PeriodKind)}>
                    <option value="week">{t('admin.lucky.issue.week')}</option>
                    <option value="month">{t('admin.lucky.issue.month')}</option>
                    <option value="custom">{t('admin.lucky.issue.custom')}</option>
                  </select>
                  {periodKind === 'custom' && (
                    <input className="input w-full sm:w-60" maxLength={16} placeholder={t('admin.lucky.issue.periodKey')}
                      aria-label={t('admin.lucky.issue.periodKey')} value={customPeriod} onChange={(e) => setCustomPeriod(e.target.value)} />
                  )}
                </>
              )}
            </div>
            <div className="space-y-2">
              {tiers.map((tr, i) => (
                <div key={i} className="lka-tier">
                  {t('admin.lucky.issue.from')}
                  <NumBox value={tr.fromRank} max={1000} label={t('admin.lucky.issue.from')} onCommit={(n) => patchTier(i, { fromRank: n })} />
                  {t('admin.lucky.issue.to')}
                  <NumBox value={tr.toRank} max={1000} label={t('admin.lucky.issue.to')} onCommit={(n) => patchTier(i, { toRank: n })} />
                  {t('admin.lucky.issue.count')}
                  <NumBox value={tr.count} max={100} label={t('admin.lucky.issue.count')} onCommit={(n) => patchTier(i, { count: n })} />
                  {tiers.length > 1 && (
                    <button type="button" className="adm-icon-btn ml-auto" aria-label={t('admin.lucky.remove')} title={t('admin.lucky.remove')}
                      onClick={() => setTiers((xs) => xs.filter((_, j) => j !== i))}><Cross /></button>
                  )}
                </div>
              ))}
            </div>
            {tierErr && <p className="lka-note is-down">{t(`admin.lucky.issue.err.${tierErr}`)}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="adm-btn" disabled={tiers.length >= 20}
                onClick={() => setTiers((xs) => {
                  const end = Math.max(0, ...xs.map((x) => x.toRank))
                  return [...xs, { fromRank: Math.min(1000, end + 1), toRank: Math.min(1000, end + 10), count: 1 }]
                })}>
                {t('admin.lucky.issue.addTier')}</button>
              <button type="button" className="adm-btn is-primary" disabled={loadBlocked}
                onClick={() => run(async () => {
                  const src = mode === 'comp' ? { type: 'comp' as const, compId, tiers } : { type: 'board' as const, board, period, tiers }
                  const r = await adminApi.luckyIssuePreview(src)
                  setList((l) => merge(l, r.rows, dupMode))
                  setMsg(r.rows.length ? t('admin.lucky.issue.loaded', { n: r.rows.length }) : t('admin.lucky.issue.none'))
                })}>{t('admin.lucky.issue.load')}</button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            <div className="flex gap-2">
              <input className="input min-w-0 flex-1 sm:w-72 sm:flex-none" placeholder={t('admin.lucky.issue.search')}
                aria-label={t('admin.lucky.issue.search')} value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && q.trim() && !busy) search() }} />
              <button type="button" className="adm-btn" aria-label={t('admin.lucky.issue.search')}
                disabled={busy || !q.trim()} onClick={search}><SearchIcon /></button>
            </div>
            {found && !found.length && <p className="lka-note">{t('admin.lucky.issue.none')}</p>}
            {found && found.length > 0 && (
              <ul className="lka-found">
                {found.map((u) => (
                  <li key={u.id}>
                    <span className="lka-cell-user">
                      <b>{u.nickname || '—'}</b>
                      <span>{u.email}</span>
                    </span>
                    <button type="button" className="adm-btn" onClick={() => addManual(u)}>{t('admin.lucky.issue.add')}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="adm-card">
        <div className="lka-card-head">
          <div className="min-w-0">
            <h4 className="lka-h">{t('admin.lucky.issue.list')}</h4>
            <p className="lka-sub">{t('admin.lucky.issue.limit')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="lka-field">
              {t('admin.lucky.issue.dup')}
              <select className="input w-auto" aria-label={t('admin.lucky.issue.dup')} value={dupMode}
                onChange={(e) => setDupMode(e.target.value as DupMode)}>
                <option value="sum">{t('admin.lucky.issue.dupSum')}</option>
                <option value="once">{t('admin.lucky.issue.dupOnce')}</option>
              </select>
            </label>
            {list.length > 0 && (
              <button type="button" className="adm-btn is-quiet" onClick={() => setList([])}>{t('admin.lucky.issue.clear')}</button>
            )}
          </div>
        </div>
        {list.length === 0 ? (
          <p className="lka-note">{t('admin.lucky.issue.emptyList')}</p>
        ) : (
          <div className="lka-scroll-y">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>{t('admin.lucky.issue.col.user')}</th>
                  <th>{t('admin.lucky.issue.col.source')}</th>
                  <th>{t('admin.lucky.issue.col.count')}</th>
                  <th><span className="sr-only">{t('admin.lucky.remove')}</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.userId}>
                    <td className="lka-cell-user"><b>{x.nickname ? <Copyable text={x.nickname} label={t('supportDesk.copy.nickname')} /> : '—'}</b><span><Copyable text={x.email} label={t('supportDesk.copy.email')} /></span></td>
                    <td className="text-xs text-neutral-400">
                      <span className="num">{x.label}{x.rank ? ` #${x.rank}` : ''}</span>
                      {x.dup && <span className="adm-pill is-warn ml-1.5">{t('admin.lucky.issue.dup')}</span>}
                    </td>
                    <td>
                      <NumBox value={x.count} max={100} label={t('admin.lucky.issue.count')}
                        onCommit={(n) => setList((l) => l.map((y) => (y.userId === x.userId ? { ...y, count: n } : y)))} />
                    </td>
                    <td className="text-right">
                      <button type="button" className="adm-icon-btn" aria-label={t('admin.lucky.remove')} title={t('admin.lucky.remove')}
                        onClick={() => setList((l) => l.filter((y) => y.userId !== x.userId))}><Cross /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="lka-slots-foot">
          <input className="input w-full sm:w-72" maxLength={80} placeholder={t('admin.lucky.issue.reason')}
            aria-label={t('admin.lucky.issue.reason')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="lka-total num">{t('admin.lucky.issue.summary', tot)}</span>
          {over && <span className="adm-pill is-down">{t(`admin.lucky.issue.err.${over}`)}</span>}
          <button type="button" className="adm-btn is-primary ml-auto"
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
        {msg && <p className="lka-note mt-3" role="status">{msg}</p>}
      </section>

      <section className="adm-card">
        <div className="lka-card-head">
          <h4 className="lka-h">{t('admin.lucky.issue.batches')}</h4>
        </div>
        {batches.length === 0 ? <p className="lka-note">{t('admin.lucky.issue.noBatches')}</p> : (
          <div className="overflow-x-auto">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>{t('admin.lucky.issue.col.time')}</th>
                  <th>{t('admin.lucky.issue.col.reason')}</th>
                  <th>{t('admin.lucky.issue.col.users')}</th>
                  <th>{t('admin.lucky.issue.col.used')}</th>
                  <th><span className="sr-only">{t('admin.lucky.issue.revoke')}</span></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td className="num whitespace-nowrap text-xs text-neutral-400">{fmtTime(b.createdAt)}</td>
                    <td className="min-w-[10rem] break-words text-neutral-200">{b.reason}</td>
                    <td className="num text-neutral-300">{b.userCount}</td>
                    <td className="num whitespace-nowrap text-neutral-300">{b.used} / {b.ticketCount}</td>
                    <td className="text-right">
                      <button type="button" className="adm-btn" disabled={busy}
                        onClick={() => run(async () => {
                          if (!window.confirm(t('admin.lucky.issue.revokeAsk', { reason: b.reason }))) return
                          const r = await adminApi.luckyRevoke({ batchId: b.id, roundId: round.id })
                          setMsg(t('admin.lucky.issue.revoked', { n: r.revoked })); onIssued()
                          await loadBatches().catch(() => {})
                        })}>
                        {t('admin.lucky.issue.revoke')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Cross() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      aria-hidden>
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </svg>
  )
}
