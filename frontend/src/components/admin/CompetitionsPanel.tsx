// 管理后台「比赛」页签（Phase 3）：① 比赛列表卡（含 draft，行内状态推进 + 终审）
// + ② 创建/编辑表单卡（draft 全字段可改，非 draft 仅文案与报名窗口可改，与
// 后端 admin_patch_competition 的 _NON_DRAFT_ALLOWED 逐字对齐）+ ③ 选中比赛的
// 参赛者表（取消/恢复资格）+ 实时榜预览。照 GamificationPanel 的结构与配色。
//
// 关键约束（后端 routers/competitions.py 强制，前端只是照着来）：
// - status 只能按 draft→upcoming→running→ended 相邻推进，settled 只能走
//   POST .../settle；这两条分属两个按钮，不共用「保存」。
// - 非 draft 状态下 PATCH 请求体里出现的字段集合由 model_fields_set 判断
//   （不看值），出现不在白名单里的键一律 400——所以非 draft 编辑时压根不把
//   metric/enrollment/startsAt/endsAt 放进 patch 对象，而不是"传但禁用"。
// - 推进状态的请求只带 { status }，不与文案/时间字段的编辑混在同一次 PATCH。
//
// The admin "competitions" tab (Phase 3): ① a competition list card (drafts
// included, inline status-advance + settle) + ② a create/edit form card (all
// fields editable in draft; only copy + registration window once non-draft,
// matching admin_patch_competition's _NON_DRAFT_ALLOWED verbatim) + ③ the
// selected competition's participant table (disqualify/restore) + a live
// board preview. Follows GamificationPanel's structure and styling.
//
// Key constraints (enforced server-side in routers/competitions.py; the
// frontend just follows them):
// - status only advances one adjacent step (draft→upcoming→running→ended);
//   settled is reachable only via POST .../settle — two separate buttons,
//   never combined with the "save" action.
// - Once non-draft, the backend checks which *keys* are present in the PATCH
//   body (model_fields_set) regardless of value — an unlisted key 400s. So a
//   non-draft edit never puts metric/enrollment/startsAt/endsAt into the
//   patch object at all, rather than sending-but-disabling them.
// - The advance action's request carries only { status }, never bundled with
//   the copy/time-field edit.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { fmtDate, localizeApiError } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import Select from '../Select'
import ConfirmModal from '../ConfirmModal'
import { useToast } from '../../utils/useToast'
import type {
  CompetitionAdminRow,
  CompetitionEnrollment,
  CompetitionMetric,
  CompetitionPatch,
  CompetitionStatus,
  CompetitionTrack,
  LeaderboardPayload,
  ParticipantAdminRow,
} from '../../api/types'

const TRACKS: CompetitionTrack[] = ['real', 'demo']
const METRICS: CompetitionMetric[] = ['return_pct', 'win_rate']
const ENROLLMENTS: CompetitionEnrollment[] = ['signup', 'auto']

// 状态只进不退：draft→upcoming→running→ended，与后端 _ADVANCE 逐字对应；
// ended 之后走 settle 端点，这里没有它的下一步。
// Status only advances: draft→upcoming→running→ended, mirroring the
// backend's _ADVANCE verbatim; ended's next step is the settle endpoint, not
// represented here.
const NEXT_STATUS: Partial<Record<CompetitionStatus, CompetitionStatus>> = {
  draft: 'upcoming',
  upcoming: 'running',
  running: 'ended',
}
const ADVANCE_LABEL_KEY: Partial<Record<CompetitionStatus, string>> = {
  draft: 'toUpcoming',
  upcoming: 'toRunning',
  running: 'toEnded',
}
// admin 端的 status 字面量是 ended（内部状态名），i18n competition.status 只有
// 用户端措辞 "finished"——同 CompetitionsPage 的 statusTagKey 做同一次映射。
// The admin-side status literal is "ended" (internal state name); the i18n
// competition.status set only has the user-facing wording "finished" — same
// mapping CompetitionsPage's statusTagKey does.
const STATUS_LABEL_KEY: Record<CompetitionStatus, string> = {
  draft: 'draft',
  upcoming: 'upcoming',
  running: 'running',
  ended: 'finished',
  settled: 'settled',
}
const STATUS_TAG_CLASS: Record<CompetitionStatus, string> = {
  draft: 'bg-white/5 text-neutral-500',
  upcoming: 'bg-neutral-500/15 text-neutral-400',
  running: 'bg-up/15 text-up',
  ended: 'bg-neutral-500/15 text-neutral-400',
  settled: 'bg-blue-400/15 text-blue-300',
}

// score 是分数（0.124 = 12.4%），同 CompetitionsPage/LeaderboardPage 的口径——
// 各自维护一份而不抽公共模块，理由同 GamificationPanel 文件头的说明。
// score is a fraction (0.124 = 12.4%), matching CompetitionsPage/
// LeaderboardPage — kept local rather than shared, same reasoning as
// GamificationPanel's file-header comment.
function fmtScorePct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

// datetime-local <input> 往返：读时把 ISO 转成输入框要的本地时间字符串，
// 写时用 Date 解析输入框的本地时间字符串再转回 ISO——本地时区两头一致，
// 提交给后端的是标准 UTC ISO。
// datetime-local <input> round-trip: reading converts an ISO string to the
// local-time string the input wants; writing parses that local-time string
// back through Date into a UTC ISO string for the API. The local timezone
// cancels out on both ends.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

interface FormDraft {
  name: string
  description: string
  metric: CompetitionMetric
  enrollment: CompetitionEnrollment
  regOpensAt: string
  regClosesAt: string
  startsAt: string
  endsAt: string
  prizeNote: string
  track: CompetitionTrack
  // 两个门槛在表单里是字符串（空串 = 跟随全局），提交时才转数字/null——
  // 数字输入框清空后是 ''，不是 0，两者语义完全不同。
  // Both gates are strings in the form (empty = follow the global settings) and
  // only become numbers/null on submit: a cleared number input is '', not 0, and
  // the two mean entirely different things.
  minBaselineUsd: string
  minTrades: string
}

const EMPTY_DRAFT: FormDraft = {
  name: '',
  description: '',
  metric: 'return_pct',
  enrollment: 'signup',
  regOpensAt: '',
  regClosesAt: '',
  startsAt: '',
  endsAt: '',
  prizeNote: '',
  track: 'real',
  minBaselineUsd: '',
  minTrades: '',
}

function toFormDraft(c: CompetitionAdminRow): FormDraft {
  return {
    name: c.name,
    description: c.description ?? '',
    metric: c.metric,
    enrollment: c.enrollment,
    regOpensAt: isoToLocalInput(c.regOpensAt),
    regClosesAt: isoToLocalInput(c.regClosesAt),
    startsAt: isoToLocalInput(c.startsAt),
    endsAt: isoToLocalInput(c.endsAt),
    prizeNote: c.prizeNote ?? '',
    track: c.track,
    minBaselineUsd: c.minBaselineUsd == null ? '' : String(c.minBaselineUsd),
    minTrades: c.minTrades == null ? '' : String(c.minTrades),
  }
}

// 表单里的门槛 → 请求体：空串 = null（跟随全局），否则转数字。
// A gate field → request body: empty means null (follow the global settings),
// otherwise a number.
function gateValue(raw: string): number | null {
  const v = raw.trim()
  return v === '' ? null : Number(v)
}

export default function CompetitionsPanel() {
  const { t } = useTranslation()
  const { toast, showToast } = useToast()
  // 待确认的破坏性动作（删除 / 终审），用站内 ConfirmModal 而不是 window.confirm。
  // Pending destructive action (delete / settle), confirmed via ConfirmModal.
  const [pendingAction, setPendingAction] = useState<{ kind: 'delete' | 'settle'; comp: CompetitionAdminRow } | null>(null)

  // ---- ① 比赛列表 / competition list ----
  const [comps, setComps] = useState<CompetitionAdminRow[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [advancingId, setAdvancingId] = useState<string | null>(null)
  const [settlingId, setSettlingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  // M-6：settle 按钮的 24h 宽限期是拿 Date.now() 跟 settleOpensAt 比出来的，
  // 只在渲染时算一次——管理员开着这个页签跨过 24h 那一刻，按钮不会自己解禁，
  // 得等下一次因为别的原因重渲染（如轮询列表）才会更新，容易让人以为卡住了。
  // 每分钟摆一次这个 tick 触发重渲染即可，真正的闸在后端 settle_competition，
  // 这里只是让前端的禁用状态别滞后太久。
  // M-6: the settle button's 24h grace period is Date.now() vs. settleOpensAt,
  // computed once per render — an admin who leaves this tab open across the
  // 24h mark won't see the button re-enable until something else triggers a
  // re-render (e.g. the list poll), which reads as stuck. Ticking this once a
  // minute just forces a re-render; the real gate stays on the backend
  // (settle_competition), this only keeps the frontend's disabled state from
  // lagging too far behind it.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const loadList = async () => {
    setListLoading(true)
    setListError(null)
    try {
      setComps(await adminApi.competitions())
    } catch (err) {
      setListError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
    } finally {
      setListLoading(false)
    }
  }

  useEffect(() => {
    loadList()
  }, [])

  // ---- ② 创建/编辑表单 / create-edit form ----
  const [mode, setMode] = useState<'create' | 'edit'>('create')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormDraft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const editingComp = editingId ? (comps.find((c) => c.id === editingId) ?? null) : null
  // draft 之外锁定 metric/enrollment/startsAt/endsAt——只读展示原值，不塞进
  // 表单控件里，呼应上面文件头「传但禁用」不成立的说明。
  // Locked outside draft: metric/enrollment/startsAt/endsAt render read-only
  // rather than as live form controls, matching the file-header note that
  // "send but disable" isn't the right model here.
  const fieldsLocked = mode === 'edit' && editingComp != null && editingComp.status !== 'draft'

  function startCreate() {
    setMode('create')
    setEditingId(null)
    setForm(EMPTY_DRAFT)
    setFormError(null)
  }

  function selectRow(comp: CompetitionAdminRow) {
    setSelectedId(comp.id)
    setEditingId(comp.id)
    setMode('edit')
    setForm(toFormDraft(comp))
    setFormError(null)
  }

  // 删除：不可撤销，参赛行/基线/快照一并清掉，所以先 confirm 一次（文案里写明
  // 会连带删掉多少人的参赛记录）。删掉的正好是当前编辑对象时，表单退回新建态。
  // Deleting is irreversible and also clears participants/baselines/snapshots, so it
  // confirms first (the copy names how many entries go with it). If the deleted row
  // is the one being edited, the form falls back to create mode.
  async function remove(c: CompetitionAdminRow) {
    setDeletingId(c.id)
    try {
      await adminApi.deleteCompetition(c.id)
      setComps((prev) => prev.filter((x) => x.id !== c.id))
      if (selectedId === c.id) setSelectedId(null)
      if (editingId === c.id) startCreate()
      showToast('ok', t('competition.admin.deleted'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('common.error'))
    } finally {
      setDeletingId(null)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setFormError(null)
    try {
      if (mode === 'create') {
        const startsIso = localInputToIso(form.startsAt)
        const endsIso = localInputToIso(form.endsAt)
        if (!startsIso || !endsIso) {
          setFormError(t('common.error'))
          return
        }
        const created = await adminApi.createCompetition({
          name: form.name.trim(),
          description: form.description.trim() || null,
          metric: form.metric,
          enrollment: form.enrollment,
          regOpensAt: form.enrollment === 'signup' ? localInputToIso(form.regOpensAt) : null,
          regClosesAt: form.enrollment === 'signup' ? localInputToIso(form.regClosesAt) : null,
          startsAt: startsIso,
          endsAt: endsIso,
          prizeNote: form.prizeNote.trim() || null,
          track: form.track,
          minBaselineUsd: gateValue(form.minBaselineUsd),
          minTrades: gateValue(form.minTrades),
        })
        setComps((prev) => [created, ...prev])
        showToast('ok', t('admin.saved'))
        startCreate()
      } else if (editingId && editingComp) {
        let patch: CompetitionPatch
        if (editingComp.status === 'draft') {
          const startsIso = localInputToIso(form.startsAt)
          const endsIso = localInputToIso(form.endsAt)
          if (!startsIso || !endsIso) {
            setFormError(t('common.error'))
            return
          }
          patch = {
            name: form.name.trim(),
            description: form.description.trim() || null,
            metric: form.metric,
            enrollment: form.enrollment,
            regOpensAt: form.enrollment === 'signup' ? localInputToIso(form.regOpensAt) : null,
            regClosesAt: form.enrollment === 'signup' ? localInputToIso(form.regClosesAt) : null,
            startsAt: startsIso,
            endsAt: endsIso,
            prizeNote: form.prizeNote.trim() || null,
            track: form.track,
            minBaselineUsd: gateValue(form.minBaselineUsd),
            minTrades: gateValue(form.minTrades),
          }
        } else {
          // 非 draft：patch 对象里绝不出现 metric/enrollment/startsAt/endsAt 的
          // 键，哪怕值没变——后端按键存在与否判 400，见文件头注释。
          // Non-draft: the patch object never carries the
          // metric/enrollment/startsAt/endsAt keys at all, even unchanged —
          // the backend 400s on key presence, see the file header.
          patch = {
            name: form.name.trim(),
            description: form.description.trim() || null,
            prizeNote: form.prizeNote.trim() || null,
            ...(editingComp.enrollment === 'signup'
              ? {
                  regOpensAt: localInputToIso(form.regOpensAt),
                  regClosesAt: localInputToIso(form.regClosesAt),
                }
              : {}),
          }
        }
        const updated = await adminApi.updateCompetition(editingId, patch)
        setComps((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
        setForm(toFormDraft(updated))
        showToast('ok', t('admin.saved'))
      }
    } catch (err) {
      setFormError(err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSaving(false)
    }
  }

  async function advance(comp: CompetitionAdminRow) {
    const next = NEXT_STATUS[comp.status]
    if (!next) return
    setAdvancingId(comp.id)
    try {
      const updated = await adminApi.updateCompetition(comp.id, { status: next })
      setComps((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      if (editingId === comp.id) setForm(toFormDraft(updated))
      showToast(
        'ok',
        updated.autoEnrolled != null
          ? t('competition.admin.autoEnrolled', { n: updated.autoEnrolled })
          : t('admin.saved')
      )
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setAdvancingId(null)
    }
  }

  // 立即重算这场比赛的榜单：进行中的比赛本来最多 20 秒陈旧（读接口会按需刷新），
  // 这个按钮是给"改完参赛资格想马上看结果"的场合，跳过节流立刻算一遍。
  // Recompute this competition's board now: a running competition is already at most
  // ~20s stale (the read path refreshes on demand); this button is for "I just changed
  // an entry and want to see it immediately" and skips the throttle.
  async function refreshBoard(comp: CompetitionAdminRow) {
    setRefreshingId(comp.id)
    try {
      const res = await adminApi.refreshCompetitionBoard(comp.id)
      showToast('ok', res.refreshed ? t('competition.admin.refreshed') : t('competition.admin.refreshSkipped'))
      if (selectedId === comp.id) loadBoard(comp.id)
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('common.error'))
    } finally {
      setRefreshingId(null)
    }
  }

  async function settle(comp: CompetitionAdminRow) {
    // 只有一种终审：ended 且过了 24 小时宽限期。内测期的"强制终审"（跳过状态与
    // 宽限期）已随后端一起移除——早于实际结束终审会漏掉尚未平仓和迟到的单，而名次
    // 一旦定格就是永久的。
    // One kind of settlement only: ended and past the 24h grace period. The beta-era
    // "force settle" went away with the backend bypass — settling early drops
    // still-open and late closes, and ranks are permanent once locked.
    setSettlingId(comp.id)
    try {
      const result = await adminApi.settleCompetition(comp.id)
      setComps((prev) => prev.map((c) => (c.id === comp.id ? { ...c, status: 'settled' } : c)))
      showToast('ok', t('competition.admin.settleResult', { n: result.ranked }))
      if (selectedId === comp.id) {
        loadParticipants(comp.id)
        loadBoard(comp.id)
      }
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSettlingId(null)
    }
  }

  // ---- ③ 选中比赛：参赛者表 + 实时榜预览 / selected: participants + board ----
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedComp = selectedId ? (comps.find((c) => c.id === selectedId) ?? null) : null

  const [participants, setParticipants] = useState<ParticipantAdminRow[]>([])
  const [participantsLoading, setParticipantsLoading] = useState(false)
  const [participantsError, setParticipantsError] = useState<string | null>(null)
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({})
  const [savingParticipantId, setSavingParticipantId] = useState<string | null>(null)

  const [board, setBoard] = useState<LeaderboardPayload | null>(null)
  const [boardLoading, setBoardLoading] = useState(false)
  const [boardError, setBoardError] = useState<string | null>(null)

  const loadParticipants = async (id: string) => {
    setParticipantsLoading(true)
    setParticipantsError(null)
    try {
      setParticipants(await adminApi.competitionParticipants(id))
    } catch (err) {
      setParticipantsError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
    } finally {
      setParticipantsLoading(false)
    }
  }

  const loadBoard = async (id: string) => {
    setBoardLoading(true)
    setBoardError(null)
    try {
      setBoard(await adminApi.competitionBoard(id))
    } catch (err) {
      setBoardError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
      setBoard(null)
    } finally {
      setBoardLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedId) {
      setParticipants([])
      setBoard(null)
      return
    }
    loadParticipants(selectedId)
    loadBoard(selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  async function disqualify(p: ParticipantAdminRow) {
    if (!selectedId) return
    setSavingParticipantId(p.id)
    try {
      const reason = (reasonDrafts[p.id] ?? '').trim() || null
      const updated = await adminApi.updateParticipant(selectedId, p.id, {
        disqualified: true,
        disqualifyReason: reason,
      })
      setParticipants((prev) => prev.map((x) => (x.id === p.id ? updated : x)))
      setReasonDrafts((prev) => ({ ...prev, [p.id]: '' }))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingParticipantId(null)
    }
  }

  async function restore(p: ParticipantAdminRow) {
    if (!selectedId) return
    setSavingParticipantId(p.id)
    try {
      const updated = await adminApi.updateParticipant(selectedId, p.id, { disqualified: false })
      setParticipants((prev) => prev.map((x) => (x.id === p.id ? updated : x)))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingParticipantId(null)
    }
  }

  return (
    <div className="space-y-5">
      {toast && (
        <div
          className={`rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* ① 比赛列表 / competition list */}
      <div className="glass p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold text-neutral-100">{t('competition.admin.list')}</h3>
          <button type="button" className="btn-primary px-4 py-1.5 text-xs" onClick={startCreate}>
            {t('competition.admin.create')}
          </button>
        </div>
        {listError && <p className="mt-2 text-sm text-down">{listError}</p>}
        {listLoading ? (
          <div className="mt-3 space-y-2">
            <SkeletonLine width="100%" />
            <SkeletonLine width="100%" />
            <SkeletonLine width="100%" />
          </div>
        ) : comps.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-400">{t('competition.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-neutral-500">
                  <th className="py-1.5 pr-4 font-medium">{t('competition.admin.colName')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('competition.admin.colStatus')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('competition.admin.colMetric')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('competition.admin.colTrack')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('competition.admin.colWindow')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('competition.admin.colParticipants')}</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {comps.map((c) => {
                  const next = NEXT_STATUS[c.status]
                  return (
                    <tr
                      key={c.id}
                      onClick={() => selectRow(c)}
                      className={`cursor-pointer border-t border-white/5 transition hover:bg-white/[0.03] ${
                        selectedId === c.id ? 'bg-prism-600/[0.06]' : ''
                      }`}
                    >
                      <td className="py-1.5 pr-4 text-neutral-200">{c.name}</td>
                      <td className="py-1.5 pr-4">
                        <span className={`tag text-[10px] ${STATUS_TAG_CLASS[c.status]}`}>
                          {t(`competition.status.${STATUS_LABEL_KEY[c.status]}`)}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 text-neutral-400">{t(`leaderboard.boards.${c.metric}`)}</td>
                      <td className="py-1.5 pr-4 text-neutral-400">{t(`competition.track.${c.track}`)}</td>
                      <td className="num py-1.5 pr-4 text-neutral-500">
                        {c.startsAt ? fmtDate(c.startsAt) : '—'} → {c.endsAt ? fmtDate(c.endsAt) : '—'}
                      </td>
                      <td className="num py-1.5 pr-4 text-neutral-300">{c.participantCount}</td>
                      <td className="py-1.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-2">
                          {next && (
                            <button
                              type="button"
                              className="btn-ghost whitespace-nowrap px-2.5 py-1 text-[11px] disabled:opacity-40"
                              disabled={advancingId === c.id}
                              onClick={() => advance(c)}
                            >
                              {advancingId === c.id
                                ? t('common.loading')
                                : t(`competition.admin.advance.${ADVANCE_LABEL_KEY[c.status]}`)}
                            </button>
                          )}
                          {c.status === 'running' && (
                            <button
                              type="button"
                              className="btn-ghost whitespace-nowrap px-2.5 py-1 text-[11px] disabled:opacity-40"
                              disabled={refreshingId === c.id}
                              onClick={() => refreshBoard(c)}
                            >
                              {refreshingId === c.id ? t('common.loading') : t('competition.admin.refresh')}
                            </button>
                          )}
                          {c.status === 'ended' && (() => {
                            // §5.3 宽限期：结束（endsAt）后 24 小时内按钮禁用——真正的闸在
                            // 后端 settle_competition，这里只是不让管理员点了白等一个必然
                            // 400。settleOpensAt 算不出来（endsAt 缺失，理论上不会发生）时
                            // 不拦，交给后端兜底。
                            // §5.3 grace period: the button is disabled for 24h after endsAt —
                            // the real gate is settle_competition on the backend, this just
                            // avoids a click that's guaranteed to 400. If settleOpensAt can't
                            // be computed, don't block; the backend still enforces it.
                            const settleOpensAt = c.endsAt
                              ? new Date(c.endsAt).getTime() + 24 * 60 * 60 * 1000
                              : null
                            const waiting = settleOpensAt != null && now < settleOpensAt
                            return (
                              <span className="inline-flex items-center gap-1.5">
                                {waiting && (
                                  <span className="text-[10px] text-neutral-500">
                                    {t('competition.admin.settleWait')}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className="btn-primary whitespace-nowrap px-2.5 py-1 text-[11px] disabled:opacity-40"
                                  disabled={settlingId === c.id || waiting}
                                  title={waiting ? t('competition.admin.settleWait') : undefined}
                                  onClick={() => setPendingAction({ kind: 'settle', comp: c })}
                                >
                                  {settlingId === c.id ? t('common.loading') : t('competition.admin.settle')}
                                </button>
                              </span>
                            )
                          })()}
                          {/* 删除：只有草稿 / 未开始可删。开赛之后后端一律 400，按钮干脆
                              不画——running/ended 删掉等于抹掉正在争的名次；settled 删掉
                              勋章收不回且会改变卫冕王判定。
                              Delete: draft / upcoming only. Once started the backend refuses,
                              so the button isn't rendered — deleting running/ended wipes
                              ranks being competed for; deleting settled can't revoke badges
                              and shifts the back-to-back judgement. */}
                          {(c.status === 'draft' || c.status === 'upcoming') && (
                            <button
                              type="button"
                              className="btn-ghost whitespace-nowrap px-2.5 py-1 text-[11px] text-down disabled:opacity-40"
                              disabled={deletingId === c.id}
                              onClick={() => setPendingAction({ kind: 'delete', comp: c })}
                            >
                              {deletingId === c.id ? t('common.loading') : t('competition.admin.delete')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ② 创建/编辑表单 / create-edit form */}
      <div className="glass p-5">
        <h3 className="font-display text-lg font-semibold text-neutral-100">
          {mode === 'create' ? t('competition.admin.create') : t('competition.admin.edit')}
        </h3>
        {fieldsLocked && <p className="mt-1 text-xs text-neutral-500">{t('competition.admin.lockedHint')}</p>}
        <form onSubmit={handleSubmit} className="mt-3 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="label">{t('competition.admin.fields.name')}</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={200}
                required
              />
            </div>
            <div>
              <label className="label">{t('competition.admin.fields.prizeNote')}</label>
              <input
                className="input"
                value={form.prizeNote}
                onChange={(e) => setForm({ ...form, prizeNote: e.target.value })}
                maxLength={500}
              />
            </div>
          </div>

          <div>
            <label className="label">{t('competition.admin.fields.description')}</label>
            <textarea
              className="input min-h-[70px] w-full resize-y"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={2000}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="label">{t('competition.admin.fields.metric')}</label>
              {fieldsLocked ? (
                <p className="input flex items-center text-neutral-400">{t(`leaderboard.boards.${form.metric}`)}</p>
              ) : (
                <Select
                  value={form.metric}
                  onChange={(v) => setForm({ ...form, metric: v as CompetitionMetric })}
                  options={METRICS.map((m) => ({ value: m, label: t(`leaderboard.boards.${m}`) }))}
                />
              )}
            </div>
            <div>
              <label className="label">{t('competition.admin.fields.enrollment')}</label>
              {fieldsLocked ? (
                <p className="input flex items-center text-neutral-400">
                  {t(`competition.enrollment.${form.enrollment}`)}
                </p>
              ) : (
                <Select
                  value={form.enrollment}
                  onChange={(v) => setForm({ ...form, enrollment: v as CompetitionEnrollment })}
                  options={ENROLLMENTS.map((en) => ({ value: en, label: t(`competition.enrollment.${en}`) }))}
                />
              )}
            </div>
          </div>

          {/* 赛道与本场门槛：与 metric/enrollment 同属"开赛后不可改"的一组，
              锁定时同样只读展示原值，不塞进 patch（见文件头注释）。
              Track and this competition's gates belong to the same "frozen after
              draft" group as metric/enrollment: when locked they render read-only
              and never enter the patch (see the file header). */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="label">{t('competition.admin.fields.track')}</label>
              {fieldsLocked ? (
                <p className="input flex items-center text-neutral-400">
                  {t(`competition.track.${form.track}`)}
                </p>
              ) : (
                <Select
                  value={form.track}
                  onChange={(v) => setForm({ ...form, track: v as CompetitionTrack })}
                  options={TRACKS.map((tr) => ({ value: tr, label: t(`competition.track.${tr}`) }))}
                />
              )}
            </div>
            <div>
              <label className="label">{t('competition.admin.fields.minBaselineUsd')}</label>
              <input
                type="number"
                min="0"
                step="any"
                className="input disabled:opacity-50"
                placeholder={t('competition.admin.fields.gateFollowGlobal')}
                value={form.minBaselineUsd}
                onChange={(e) => setForm({ ...form, minBaselineUsd: e.target.value })}
                disabled={fieldsLocked}
              />
            </div>
            <div>
              <label className="label">{t('competition.admin.fields.minTrades')}</label>
              <input
                type="number"
                min="1"
                step="1"
                className="input disabled:opacity-50"
                placeholder={t('competition.admin.fields.gateFollowGlobal')}
                value={form.minTrades}
                onChange={(e) => setForm({ ...form, minTrades: e.target.value })}
                disabled={fieldsLocked}
              />
            </div>
            <p className="text-xs text-neutral-500 md:col-span-3">
              {t('competition.admin.fields.gateHint')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="label">{t('competition.admin.fields.startsAt')}</label>
              <input
                type="datetime-local"
                className="input disabled:opacity-50"
                value={form.startsAt}
                onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                disabled={fieldsLocked}
                required={!fieldsLocked}
              />
            </div>
            <div>
              <label className="label">{t('competition.admin.fields.endsAt')}</label>
              <input
                type="datetime-local"
                className="input disabled:opacity-50"
                value={form.endsAt}
                onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                disabled={fieldsLocked}
                required={!fieldsLocked}
              />
            </div>
          </div>

          {form.enrollment === 'signup' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="label">{t('competition.admin.fields.regOpensAt')}</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={form.regOpensAt}
                  onChange={(e) => setForm({ ...form, regOpensAt: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">{t('competition.admin.fields.regClosesAt')}</label>
                <input
                  type="datetime-local"
                  className="input"
                  value={form.regClosesAt}
                  onChange={(e) => setForm({ ...form, regClosesAt: e.target.value })}
                  required
                />
              </div>
            </div>
          )}

          {formError && <p className="text-sm text-down">{formError}</p>}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
              disabled={saving || !form.name.trim()}
            >
              {saving ? t('common.loading') : t('common.save')}
            </button>
            {mode === 'edit' && (
              <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={startCreate}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </form>
      </div>

      {/* ③ 选中比赛：参赛者表 + 实时榜预览 / selected: participants + board preview */}
      {selectedId && selectedComp && (
        <div className="glass p-5">
          <h3 className="font-display text-lg font-semibold text-neutral-100">
            {t('competition.admin.participants.title')}
          </h3>
          {participantsError && <p className="mt-2 text-sm text-down">{participantsError}</p>}
          {participantsLoading ? (
            <div className="mt-3 space-y-2">
              <SkeletonLine width="100%" />
              <SkeletonLine width="100%" />
            </div>
          ) : participants.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-400">{t('competition.admin.participants.empty')}</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-neutral-500">
                    <th className="py-1.5 pr-4 font-medium">{t('competition.admin.participants.colEmail')}</th>
                    <th className="py-1.5 pr-4 font-medium">{t('competition.admin.participants.colLogin')}</th>
                    <th className="py-1.5 pr-4 font-medium">
                      {t('competition.admin.participants.colRegisteredAt')}
                    </th>
                    <th className="py-1.5 pr-4 font-medium">{t('competition.admin.participants.colScoringFrom')}</th>
                    <th className="py-1.5 pr-4 font-medium">{t('competition.admin.participants.colFinalScore')}</th>
                    <th className="py-1.5 pr-4 font-medium">{t('competition.admin.participants.colFinalRank')}</th>
                    <th className="py-1.5 pr-4 font-medium">
                      {t('competition.admin.participants.colDisqualified')}
                    </th>
                    <th className="py-1.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p) => (
                    <tr key={p.id} className="border-t border-white/5">
                      <td className="max-w-[180px] truncate py-1.5 pr-4 font-mono text-neutral-300">
                        {p.email ?? '—'}
                      </td>
                      <td className="num py-1.5 pr-4 text-neutral-300">{p.login}</td>
                      <td className="num py-1.5 pr-4 text-neutral-400">
                        {p.registeredAt ? fmtDate(p.registeredAt) : '—'}
                      </td>
                      <td className="num py-1.5 pr-4 text-neutral-400">
                        {p.scoringFrom ? fmtDate(p.scoringFrom) : '—'}
                      </td>
                      <td className="num py-1.5 pr-4 text-neutral-400">
                        {p.finalScore != null ? fmtScorePct(p.finalScore) : '—'}
                      </td>
                      <td className="num py-1.5 pr-4 text-neutral-400">{p.finalRank ?? '—'}</td>
                      <td className="py-1.5 pr-4">
                        {p.disqualified ? (
                          <span
                            className="tag bg-down/15 text-[10px] text-down"
                            title={p.disqualifyReason ?? undefined}
                          >
                            {t('competition.disqualified')}
                          </span>
                        ) : (
                          <span className="tag bg-white/5 text-[10px] text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="py-1.5">
                        {p.disqualified ? (
                          <button
                            type="button"
                            className="btn-ghost whitespace-nowrap px-2.5 py-1 text-[11px] disabled:opacity-40"
                            disabled={savingParticipantId === p.id}
                            onClick={() => restore(p)}
                          >
                            {savingParticipantId === p.id ? t('common.loading') : t('competition.admin.restore')}
                          </button>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <input
                              className="input w-32 py-1 text-[11px]"
                              placeholder={t('competition.admin.disqualifyReason')}
                              value={reasonDrafts[p.id] ?? ''}
                              onChange={(e) =>
                                setReasonDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                              }
                            />
                            <button
                              type="button"
                              className="btn-ghost whitespace-nowrap px-2.5 py-1 text-[11px] disabled:opacity-40"
                              disabled={savingParticipantId === p.id}
                              onClick={() => disqualify(p)}
                            >
                              {savingParticipantId === p.id
                                ? t('common.loading')
                                : t('competition.admin.disqualify')}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="mt-6 font-display text-lg font-semibold text-neutral-100">{t('competition.liveBoard')}</h3>
          {boardError && <p className="mt-2 text-sm text-down">{boardError}</p>}
          {boardLoading ? (
            <div className="mt-3 space-y-2">
              <SkeletonLine width="100%" />
              <SkeletonLine width="100%" />
            </div>
          ) : board && board.rows.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-neutral-500">
                    <th className="py-1.5 pr-4 font-medium">{t('leaderboard.colRank')}</th>
                    <th className="py-1.5 pr-4 font-medium">{t('leaderboard.colTrader')}</th>
                    <th className="py-1.5 pr-4 font-medium">{t('leaderboard.colAccount')}</th>
                    <th className="py-1.5 pr-4 font-medium">{t(`leaderboard.colScore.${selectedComp.metric}`)}</th>
                    <th className="py-1.5 font-medium">{t('leaderboard.colSample')}</th>
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map((row) => (
                    <tr key={row.rank} className="border-t border-white/5">
                      <td className="num py-1.5 pr-4 text-neutral-300">{row.rank}</td>
                      <td className="py-1.5 pr-4 text-neutral-200">{row.displayName}</td>
                      <td className="num py-1.5 pr-4 text-neutral-400">{row.login}</td>
                      <td className="num py-1.5 pr-4 text-neutral-100">{fmtScorePct(row.score)}</td>
                      <td className="num py-1.5 text-neutral-500">{row.sample}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !boardError && <p className="mt-3 text-sm text-neutral-400">{t('leaderboard.empty')}</p>
          )}
        </div>
      )}

      {pendingAction && (
        <ConfirmModal
          center
          title={pendingAction.kind === 'delete' ? t('competition.admin.delete') : t('competition.admin.settle')}
          message={
            pendingAction.kind === 'delete'
              ? t('competition.admin.deleteConfirm', { name: pendingAction.comp.name, n: pendingAction.comp.participantCount })
              : t('competition.admin.settleConfirm')
          }
          danger={pendingAction.kind === 'delete'}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction
            setPendingAction(null)
            if (action.kind === 'delete') void remove(action.comp)
            else void settle(action.comp)
          }}
        />
      )}
    </div>
  )
}
