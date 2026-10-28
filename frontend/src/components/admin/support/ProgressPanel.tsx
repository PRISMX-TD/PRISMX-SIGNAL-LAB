// 跟进进度（2026-10-17）：管理员不进客服后台，客服跟得怎么样都在这里看。
//   ① 一排指标：进行中、待联系、停滞（超过 N 天没有记录）、近 7 天记录数；「待联系」「停滞」点一下就筛下面的列表。
//   ② 每位客服一张卡：进行中几位、标签分布条、近 7 天写了几条记录、最近一条在什么时候、有几条停滞；点卡只看这个人。
//   ③ 跟进列表：按最近动态排，每行带最近一条记录的摘要；点一行打开完整记录（FollowUpRecordSheet）。
//      勾选进行中的跟进可批量转派 / 延期 / 收回（原来在「分配跟进」底部，搬到这里，分配页只管分配）。
// 深链 /admin/progress?followUp=<id> 打开那条记录（管理员误进客服后台时由 adminTargetForDesk 换过来）。
// Follow-up progress (2026-10-17): admins don't use the support console, so this is where they see
// how the agents are doing.
//   ① KPIs: active, not contacted, stale (no note for N days), notes in 7 days; the middle two filter
//      the list below.
//   ② One card per agent: active count, label-mix bar, notes in 7 days, when the latest was, stale
//      count; clicking a card narrows to that agent.
//   ③ The list, ordered by latest activity, each row carrying its latest note; a row opens the full
//      record. Active rows can be bulk reassigned / extended / revoked (moved here from the bottom
//      of the assign section, which now only assigns).
// /admin/progress?followUp=<id> opens that record (adminTargetForDesk sends stray admins here).
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { adminSupportApi } from '../../../api/client'
import {
  FOLLOW_UP_STAFF_STATUSES,
  type FollowUp,
  type FollowUpStatus,
  type SupportMember,
  type SupportProgress,
  type SupportProgressRow,
} from '../../../api/supportTypes'
import { fmtDayShort, parseTime } from '../../../api/utils'
import ConfirmModal from '../../ConfirmModal'
import Select from '../../Select'
import { SkeletonLine } from '../../Skeleton'
import { Avatar, FU_PRIORITY_TONE, FU_STATUS_TONE, Tag, errText } from '../../support/supportUi'
import FollowUpRecordSheet from './FollowUpRecordSheet'
import Copyable from '../../Copyable'

const PAGE = 50
const DAY_MS = 86_400_000
type Scope = 'active' | 'closed' | 'all'
type Sort = 'activity' | 'created'
const SCOPES: Scope[] = ['active', 'closed', 'all']
const CLOSED_STATUSES: FollowUpStatus[] = ['revoked', 'expired']

// 分布条与图例的实色，与标签同一套色相 / solid colours for the bar and legend, same hues as the labels
const SOLID: Record<FollowUpStatus, string> = {
  pending: 'bg-amber-400',
  contacted: 'bg-blue-400',
  interested: 'bg-[var(--purple-hi)]',
  converted: 'bg-[var(--up)]',
  no_interest: 'bg-neutral-500',
  unreachable: 'bg-neutral-600',
  revoked: 'bg-neutral-700',
  expired: 'bg-[var(--down)]',
}

const ms = (iso: string | null | undefined) => parseTime(iso)?.getTime() ?? null

function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  )
}

export default function ProgressPanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const [progress, setProgress] = useState<SupportProgress | null>(null)
  const [members, setMembers] = useState<SupportMember[]>([])

  const [agent, setAgent] = useState('')
  const [scope, setScope] = useState<Scope>('active')
  const [label, setLabel] = useState<FollowUpStatus | ''>('')
  const [staleOnly, setStaleOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('activity')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)

  const [rows, setRows] = useState<FollowUp[] | null>(null)
  const [total, setTotal] = useState(0)
  const [dist, setDist] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const ctrlRef = useRef<AbortController | null>(null)

  const [sel, setSel] = useState<Set<string>>(new Set())
  const [reassignTo, setReassignTo] = useState('')
  const [extendDays, setExtendDays] = useState('7')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [revokeConfirm, setRevokeConfirm] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  // 深链只读一次：打开那条记录，再把参数从地址栏拿掉，免得关掉抽屉后一刷新又弹出来。
  // The deep link is read once: open that record, then drop the param so a refresh after closing
  // the drawer doesn't reopen it.
  useEffect(() => {
    const id = params.get('followUp')
    if (!id) return
    setOpenId(id)
    setParams((p) => {
      p.delete('followUp')
      return p
    }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadProgress = useCallback(async () => {
    try {
      setProgress(await adminSupportApi.progress())
    } catch (err) {
      onToast('err', errText(err, t('admin.loadError')))
    }
  }, [onToast, t])

  useEffect(() => {
    void loadProgress()
    adminSupportApi
      .members()
      .then((r) => setMembers(r.items.filter((m) => !m.disabled)))
      .catch(() => {})
  }, [loadProgress])

  // 搜索框停手 300ms 再查 / search 300ms after typing stops
  useEffect(() => {
    const id = window.setTimeout(() => setQ(qInput.trim()), 300)
    return () => window.clearTimeout(id)
  }, [qInput])

  useEffect(() => setPage(0), [agent, scope, label, staleOnly, sort, q])

  const loadRows = useCallback(async () => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    try {
      const r = await adminSupportApi.followUps(
        {
          assigneeId: agent || undefined,
          status: staleOnly ? 'active' : label || (scope === 'all' ? undefined : scope),
          stale: staleOnly || undefined,
          q: q || undefined,
          sort,
          limit: PAGE,
          offset: page * PAGE,
        },
        ctrl.signal,
      )
      // 已被新的一次加载取代：结果作废（取消在响应头到了之后不一定拦得住正文）
      // superseded by a newer load: drop the result (aborting after the headers may not stop the body)
      if (ctrlRef.current !== ctrl) return
      // 批量操作后最后一页可能空了：退回仍有数据的最后一页，而不是停在空页上
      // after a bulk action the last page can empty out: step back to the last page that has rows
      if (r.items.length === 0 && page > 0 && r.total > 0) {
        setPage(Math.max(0, Math.ceil(r.total / PAGE) - 1))
        return
      }
      setRows(r.items)
      setTotal(r.total)
      setDist(r.distribution)
      setSel(new Set())
    } catch (err) {
      // 只有我们自己取消的才静默；请求超时也是 AbortError，要报错
      // stay quiet only for our own cancellation; a request timeout is an AbortError too and must surface
      if (ctrl.signal.aborted) return
      onToast('err', errText(err, t('admin.loadError')))
      setRows((prev) => prev ?? [])
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null
        setLoading(false)
      }
    }
  }, [agent, scope, label, staleOnly, q, sort, page, onToast, t])
  useEffect(() => { void loadRows() }, [loadRows])
  useEffect(() => () => ctrlRef.current?.abort(), [])

  // 选中的客服不在名单里了（停用后跟进全转走、管理员手上的跟进被收回）就取消筛选，免得下拉框显示一串 id
  // drop the agent filter once that person leaves the roster (disabled and emptied, or an admin whose
  // follow-ups were moved), so the picker never shows a raw id
  useEffect(() => {
    if (progress && agent && !progress.items.some((a) => a.staffId === agent)) setAgent('')
  }, [progress, agent])

  const refreshAll = () => {
    void loadProgress()
    void loadRows()
  }

  const bulk = async (fn: () => Promise<{ updated: number }>) => {
    setBulkBusy(true)
    try {
      const r = await fn()
      onToast('ok', t('admin.support.followUps.updated', { n: r.updated }))
      setReassignTo('')
      refreshAll()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setBulkBusy(false)
      setRevokeConfirm(false)
    }
  }

  const ago = (iso: string | null | undefined) => {
    const v = ms(iso)
    if (v == null) return ''
    const min = Math.max(0, Math.floor((Date.now() - v) / 60_000))
    if (min < 1) return t('admin.support.progress.ago.justNow')
    if (min < 60) return t('admin.support.progress.ago.min', { n: min })
    if (min < 60 * 24) return t('admin.support.progress.ago.hour', { n: Math.floor(min / 60) })
    return t('admin.support.progress.ago.day', { n: Math.floor(min / 1440) })
  }
  const idleDays = (f: FollowUp) => {
    const v = ms(f.lastNoteAt) ?? ms(f.createdAt)
    return v == null ? 0 : Math.max(0, Math.floor((Date.now() - v) / DAY_MS))
  }

  const staleDays = progress?.staleDays ?? 3
  const totals = progress?.totals
  const agents = progress?.items ?? []
  const chipStatuses: FollowUpStatus[] =
    scope === 'active' ? FOLLOW_UP_STAFF_STATUSES : scope === 'closed' ? CLOSED_STATUSES : [...FOLLOW_UP_STAFF_STATUSES, ...CLOSED_STATUSES]
  const selIds = Array.from(sel)
  const activeOnPage = (rows ?? []).filter((f) => f.active)
  const allOnPage = activeOnPage.length > 0 && activeOnPage.every((f) => sel.has(f.id))
  const extendN = Number(extendDays)
  // 延期只对有截止时间的跟进有意义（后端也会跳过不限期的）/ extending only applies to rows with a deadline (the API skips the rest)
  const selHasDeadline = (rows ?? []).some((f) => sel.has(f.id) && !!f.expiresAt)
  const memberOptions = members.map((m) => ({ value: m.id, label: m.nickname || m.email }))
  const agentOptions = [
    { value: '', label: t('admin.support.followUps.allStaff') },
    ...agents.map((a) => ({ value: a.staffId, label: a.nickname || a.email })),
  ]

  const toggle = (id: string) =>
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const pickLabel = (s: FollowUpStatus | '') => {
    setStaleOnly(false)
    setLabel(s)
    if (s && !chipStatuses.includes(s)) setScope(CLOSED_STATUSES.includes(s) ? 'closed' : 'active')
  }

  return (
    <div className="space-y-6">
      {/* ① 指标 / KPIs */}
      <div className="adm-kpis is-quad">
        <div className="adm-kpi">
          <span className="adm-kpi-label">{t('admin.support.progress.kpiActive')}</span>
          <span className="adm-kpi-value num">{totals ? totals.active : '—'}</span>
        </div>
        <button
          type="button"
          className={`adm-kpi adm-kpi-btn ${label === 'pending' && !staleOnly ? 'is-on' : ''}`}
          aria-pressed={label === 'pending' && !staleOnly}
          disabled={!totals}
          onClick={() => pickLabel(label === 'pending' ? '' : 'pending')}
        >
          <span className="adm-kpi-label">
            <i className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
            {t('admin.support.progress.kpiPending')}
          </span>
          <span className="adm-kpi-value num">{totals ? totals.pending : '—'}</span>
        </button>
        <button
          type="button"
          className={`adm-kpi adm-kpi-btn ${staleOnly ? 'is-on' : ''}`}
          aria-pressed={staleOnly}
          disabled={!totals}
          onClick={() => {
            setLabel('')
            setScope('active')
            setStaleOnly(!staleOnly)
          }}
        >
          <span className="adm-kpi-label">{t('admin.support.progress.kpiStale', { n: staleDays })}</span>
          <span className={`adm-kpi-value num ${totals && totals.stale > 0 ? 'is-warn' : ''}`}>{totals ? totals.stale : '—'}</span>
        </button>
        <div className="adm-kpi">
          <span className="adm-kpi-label">{t('admin.support.progress.kpiNotes')}</span>
          <span className="adm-kpi-value num">{totals ? totals.notes7d : '—'}</span>
        </div>
      </div>

      {/* ② 客服 / agents */}
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 className="text-[15px] font-semibold text-neutral-100">{t('admin.support.progress.agentsTitle')}</h3>
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500" aria-hidden="true">
            {FOLLOW_UP_STAFF_STATUSES.map((s) => (
              <li key={s} className="inline-flex items-center gap-1.5">
                <i className={`h-1.5 w-1.5 rounded-full ${SOLID[s]}`} />
                {t(`supportDesk.status.${s}`)}
              </li>
            ))}
          </ul>
          {agent && (
            <button type="button" className="adm-link-btn ml-auto" onClick={() => setAgent('')}>
              {t('admin.support.progress.clearAgent')}
            </button>
          )}
        </div>
        {!progress ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => <SkeletonLine key={i} height={132} />)}
          </div>
        ) : agents.length === 0 ? (
          <div className="adm-card adm-empty"><p className="adm-empty-title">{t('admin.support.staff.empty')}</p></div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {agents.map((a, i) => (
              <AgentCard
                key={a.staffId}
                row={a}
                index={i}
                on={agent === a.staffId}
                onPick={() => setAgent(agent === a.staffId ? '' : a.staffId)}
                ago={ago}
              />
            ))}
          </div>
        )}
      </section>

      {/* ③ 跟进列表 / the list */}
      <section className="space-y-3">
        <div className="adm-toolbar">
          <label className="adm-search">
            <IconSearch />
            <input
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder={t('admin.support.progress.searchPlaceholder')}
              aria-label={t('admin.support.progress.searchPlaceholder')}
            />
          </label>
          <div className="adm-seg" role="group" aria-label={t('admin.support.progress.listTitle')}>
            {SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={scope === s && !staleOnly}
                className={scope === s && !staleOnly ? 'is-on' : ''}
                onClick={() => {
                  setStaleOnly(false)
                  setLabel('')
                  setScope(s)
                }}
              >
                {t(`admin.support.progress.scope.${s}`)}
              </button>
            ))}
          </div>
          <div className="adm-toolbar-end">
            <span className="adm-count">{t('admin.support.progress.count', { n: total })}</span>
            <Select value={agent} onChange={setAgent} className="select-tight" ariaLabel={t('admin.support.assign.assignee')} options={agentOptions} />
            <Select
              value={sort}
              onChange={(v) => setSort(v as Sort)}
              className="select-tight"
              ariaLabel={t('admin.support.progress.sort.activity')}
              options={[
                { value: 'activity', label: t('admin.support.progress.sort.activity') },
                { value: 'created', label: t('admin.support.progress.sort.created') },
              ]}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('supportDesk.card.status')}>
          <button type="button" className={`adm-chip ${!label && !staleOnly ? 'is-on' : ''}`} aria-pressed={!label && !staleOnly} onClick={() => pickLabel('')}>
            {t('admin.support.progress.allLabels')}
          </button>
          {chipStatuses
            .filter((s) => (dist[s] ?? 0) > 0 || label === s)
            .map((s) => (
              <button key={s} type="button" className={`adm-chip ${label === s ? 'is-on' : ''}`} aria-pressed={label === s} onClick={() => pickLabel(label === s ? '' : s)}>
                <i className={`h-1.5 w-1.5 rounded-full ${SOLID[s]}`} aria-hidden="true" />
                {t(`supportDesk.status.${s}`)}
                <span className="num">{dist[s] ?? 0}</span>
              </button>
            ))}
          {staleOnly && (
            <button type="button" className="adm-chip is-on" aria-pressed="true" onClick={() => setStaleOnly(false)}>
              <i className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden="true" />
              {t('admin.support.progress.staleOnly')}
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>

        {!rows ? (
          <div className="adm-card space-y-3"><SkeletonLine /><SkeletonLine width="80%" /><SkeletonLine width="60%" /></div>
        ) : rows.length === 0 ? (
          <div className="adm-card adm-empty"><p className="adm-empty-title">{t('admin.support.followUps.empty')}</p></div>
        ) : (
          <>
            {/* 桌面：表格 / desktop: table */}
            <div className="adm-table-wrap hidden md:block">
              <table className={`adm-table min-w-[920px] ${loading ? 'is-loading' : ''}`}>
                <thead>
                  <tr>
                    <th className="adm-th-check">
                      <input
                        type="checkbox"
                        className="adm-check"
                        checked={allOnPage}
                        disabled={activeOnPage.length === 0}
                        aria-label={t('admin.bulkSelectAll')}
                        onChange={() => setSel(allOnPage ? new Set() : new Set(activeOnPage.map((f) => f.id)))}
                      />
                    </th>
                    <th>{t('admin.support.progress.col.customer')}</th>
                    <th>{t('admin.support.progress.col.agent')}</th>
                    <th>{t('admin.support.progress.col.label')}</th>
                    <th className="w-[34%]">{t('admin.support.progress.col.latest')}</th>
                    <th className="text-right">{t('admin.support.progress.col.notes')}</th>
                    <th className="text-right">{t('admin.support.progress.col.assigned')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f, i) => (
                    <tr
                      key={f.id}
                      className={`adm-rise cursor-pointer ${sel.has(f.id) ? 'is-sel' : ''}`}
                      style={{ ['--i' as string]: Math.min(i, 14) }}
                      onClick={() => setOpenId(f.id)}
                    >
                      <td className="adm-th-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="adm-check disabled:opacity-30"
                          disabled={!f.active}
                          checked={sel.has(f.id)}
                          aria-label={f.email ?? f.userId}
                          onChange={() => toggle(f.id)}
                        />
                      </td>
                      <td>
                        <div className="flex items-center gap-3">
                          <Avatar name={f.nickname || f.email} size={32} />
                          <div className="min-w-0">
                            <button
                              type="button"
                              className="block max-w-[200px] truncate text-left text-[13px] font-medium text-neutral-100 hover:text-white"
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenId(f.id)
                              }}
                            >
                              {f.nickname || f.email || '—'}
                            </button>
                            <div className="max-w-[200px] truncate font-mono text-[11px] text-neutral-500"><Copyable text={f.email} label={t('supportDesk.copy.email')} /></div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="text-xs text-neutral-200">{f.assigneeName || '—'}</div>
                        <div className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-neutral-500">
                          {t(`supportDesk.goal.${f.goal}`)}
                          {f.priority === 'high' && <Tag tone={FU_PRIORITY_TONE.high}>{t('supportDesk.priority.high')}</Tag>}
                        </div>
                      </td>
                      <td><Tag tone={FU_STATUS_TONE[f.status]}>{t(`supportDesk.status.${f.status}`)}</Tag></td>
                      <td>
                        <LatestNote f={f} ago={ago} idle={idleDays(f)} />
                      </td>
                      <td className="num text-right text-xs text-neutral-300">{f.notesCount ?? 0}</td>
                      <td className="num text-right text-xs text-neutral-500">{fmtDayShort(f.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 手机：一行一张 / phones: one card per row */}
            <ul className={`space-y-2 md:hidden ${loading ? 'opacity-60' : ''}`}>
              {rows.map((f, i) => (
                <li key={f.id} className="adm-rise" style={{ ['--i' as string]: Math.min(i, 14) }}>
                  <div className={`adm-card flex gap-3 !p-4 ${sel.has(f.id) ? 'ring-1 ring-[var(--purple-hi)]' : ''}`}>
                    {f.active && (
                      <input
                        type="checkbox"
                        className="adm-check mt-2"
                        checked={sel.has(f.id)}
                        aria-label={f.email ?? f.userId}
                        onChange={() => toggle(f.id)}
                      />
                    )}
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(f.id)}>
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-neutral-100">{f.nickname || f.email || '—'}</span>
                        <Tag tone={FU_STATUS_TONE[f.status]}>{t(`supportDesk.status.${f.status}`)}</Tag>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-neutral-500">
                        {f.assigneeName || '—'} · {t(`supportDesk.goal.${f.goal}`)}
                      </span>
                      <span className="mt-2.5 block">
                        <LatestNote f={f} ago={ago} idle={idleDays(f)} />
                      </span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {(total > PAGE || page > 0) && (
          <div className="flex items-center justify-center gap-3 pt-1 text-xs">
            <button type="button" className="adm-btn" disabled={page === 0 || loading} onClick={() => setPage(page - 1)}>{t('common.prevPage')}</button>
            <span className="num text-neutral-500">{page + 1} / {Math.ceil(total / PAGE)}</span>
            <button type="button" className="adm-btn" disabled={(page + 1) * PAGE >= total || loading} onClick={() => setPage(page + 1)}>{t('common.nextPage')}</button>
          </div>
        )}
      </section>

      {/* 批量操作坞 / bulk dock */}
      {selIds.length > 0 &&
        createPortal(
          <div data-fd-plain className="adm-dock-layer">
            <div className="adm-dock" role="region" aria-label={t('admin.bulkSelected', { n: selIds.length })}>
              <div className="adm-dock-count">
                {t('admin.console.selectedPre') && <span>{t('admin.console.selectedPre')}</span>}
                <span className="num">{selIds.length}</span>
                <span>{t('admin.console.selectedPost')}</span>
              </div>
              <span className="adm-dock-sep" aria-hidden="true" />
              <div className="adm-dock-fields">
                <Select
                  value={reassignTo}
                  onChange={setReassignTo}
                  openUpward
                  className="select-tight min-w-[140px]"
                  ariaLabel={t('admin.support.followUps.reassignTo')}
                  options={[{ value: '', label: t('admin.support.followUps.reassignTo') }, ...memberOptions]}
                />
                <button type="button" className="adm-btn" disabled={!reassignTo || bulkBusy} onClick={() => void bulk(() => adminSupportApi.reassign(selIds, reassignTo))}>
                  {t('admin.support.followUps.reassign')}
                </button>
                {selHasDeadline && (
                  <span className="adm-filter">
                    <input
                      className="adm-input w-14 text-center"
                      inputMode="numeric"
                      value={extendDays}
                      onChange={(e) => setExtendDays(e.target.value)}
                      aria-label={t('admin.support.followUps.extendDays')}
                    />
                    <button
                      type="button"
                      className="adm-btn"
                      disabled={!Number.isInteger(extendN) || extendN < 1 || extendN > 365 || bulkBusy}
                      onClick={() => void bulk(() => adminSupportApi.extend(selIds, extendN))}
                    >
                      {t('admin.support.followUps.extend')}
                    </button>
                  </span>
                )}
              </div>
              <div className="adm-dock-actions">
                <button type="button" className="adm-btn is-danger" disabled={bulkBusy} onClick={() => setRevokeConfirm(true)}>
                  {t('admin.support.followUps.revoke')}
                </button>
                <button type="button" className="adm-icon-btn" onClick={() => setSel(new Set())} title={t('admin.bulkClear')} aria-label={t('admin.bulkClear')}>
                  ×
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {revokeConfirm && (
        <ConfirmModal
          center
          danger
          busy={bulkBusy}
          title={t('admin.support.followUps.revoke')}
          message={t('admin.support.followUps.revokeBody', { n: selIds.length })}
          onConfirm={() => void bulk(() => adminSupportApi.revoke(selIds))}
          onCancel={() => setRevokeConfirm(false)}
        />
      )}

      {openId && (
        <FollowUpRecordSheet
          id={openId}
          members={members}
          onClose={() => setOpenId(null)}
          onChanged={refreshAll}
          onToast={onToast}
        />
      )}
    </div>
  )
}

function AgentCard({
  row,
  index,
  on,
  onPick,
  ago,
}: {
  row: SupportProgressRow
  index: number
  on: boolean
  onPick: () => void
  ago: (iso: string | null | undefined) => string
}) {
  const { t } = useTranslation()
  const segs = FOLLOW_UP_STAFF_STATUSES.map((s) => ({ s, n: row.distribution[s] ?? 0 })).filter((x) => x.n > 0)
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={`adm-agent adm-rise ${on ? 'is-on' : ''} ${row.disabled ? 'is-off' : ''}`}
      style={{ ['--i' as string]: Math.min(index, 12) }}
    >
      <span className="flex items-center gap-3">
        <Avatar name={row.nickname || row.email} size={36} tone="staff" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-neutral-100">{row.nickname || row.email}</span>
          <span className="mt-0.5 block truncate text-[11px] text-neutral-500">
            {row.role === 'admin' ? t('admin.support.role.admin') : t(`admin.support.tier.${row.tier}`)}
            {row.disabled ? ` · ${t('admin.support.progress.disabled')}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="num block text-[26px] font-semibold leading-none tracking-tight text-neutral-50">{row.active}</span>
          <span className="mt-1 block text-[11px] text-neutral-500">{t('admin.support.progress.activeLabel')}</span>
        </span>
      </span>
      <span className="adm-stack" aria-hidden="true">
        {segs.map((x) => (
          <i key={x.s} className={SOLID[x.s]} style={{ flexGrow: x.n, flexBasis: 0 }} />
        ))}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-neutral-500">
        <span className="truncate">
          {t('admin.support.progress.notes7d', { n: row.notes7d })}
          {' · '}
          {row.lastNoteAt ? t('admin.support.progress.lastNote', { t: ago(row.lastNoteAt) }) : t('admin.support.progress.noNotesYet')}
        </span>
        {row.stale > 0 && <span className="adm-pill is-warn ml-auto shrink-0">{t('admin.support.progress.staleN', { n: row.stale })}</span>}
      </span>
    </button>
  )
}

function LatestNote({ f, ago, idle }: { f: FollowUp; ago: (iso: string | null | undefined) => string; idle: number }) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0">
      {f.lastNote ? (
        <>
          <p className="line-clamp-2 break-words text-[12.5px] leading-relaxed text-neutral-300">{f.lastNote.content}</p>
          <p className="mt-1 truncate text-[11px] text-neutral-500">
            {t(`supportDesk.channel.${f.lastNote.channel}`)} · {f.lastNote.authorName || '—'} · {ago(f.lastNoteAt)}
          </p>
        </>
      ) : (
        <p className="text-xs text-neutral-500">{t('admin.support.progress.neverNoted')}</p>
      )}
      {f.stale && <span className="adm-pill is-warn mt-1.5">{t('admin.support.progress.idleDays', { n: idle })}</span>}
    </div>
  )
}
