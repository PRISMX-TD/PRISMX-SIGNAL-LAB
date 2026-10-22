// 期的弹框：新建 / 编辑一期（名称、开始、结束、模式）与删除一期（输入期名确认）。
// 编辑只发改过的字段；开始时间只有未开始的期能改；结束改到过去 = 立即结束（作废未用券），先二次确认。
// 模式在「奖品设置」里改（有抽奖记录后锁住），这里编辑时只显示。
// Round dialogs: create / edit a round (name, start, end, mode) and delete one (type the name to
// confirm). Editing sends only changed fields; the start moves only while upcoming; moving the end into
// the past ends the round (voiding unused tickets) after a confirm. The mode is changed under prize
// settings (locked once there are draws), so editing only shows it.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyMode, LuckyRoundAdmin } from '../../../api/luckyTypes'
import { localizeApiError } from '../../../api/utils'
import AdminSheet from '../AdminSheet'
import {
  NAME_MAX, deleteNameMatches, endsInPast, fromLocalInput, roundFormProblem, roundPatch, shown, toLocalInput, type RoundForm,
} from './luckyRounds'

const HOUR = 3600_000

// 新建时的默认时间：下一个整点开始，7 天后结束 / defaults for a new round: next full hour, for 7 days
function defaults(): RoundForm {
  const start = Math.ceil(Date.now() / HOUR) * HOUR
  return { name: '', start: toLocalInput(new Date(start).toISOString()), end: toLocalInput(new Date(start + 7 * 24 * HOUR).toISOString()), mode: 'prob' }
}

export function RoundFormSheet({ round, onClose, onDone }: {
  // 不传 = 新建 / omitted = create
  round?: LuckyRoundAdmin
  onClose: () => void
  onDone: (r: LuckyRoundAdmin & { voided?: number }) => void
}) {
  const { t } = useTranslation()
  const [f, setF] = useState<RoundForm>(() => round
    ? { name: round.name, start: toLocalInput(round.startsAt), end: toLocalInput(round.endsAt), mode: round.mode }
    : defaults())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const editing = !!round
  const problem = roundFormProblem(f, Date.now(), editing)
  const set = (p: Partial<RoundForm>) => setF((x) => ({ ...x, ...p }))

  const submit = async () => {
    if (busy || problem) return
    setBusy(true); setErr('')
    try {
      if (!round) {
        onDone(await adminApi.luckyCreateRound({ name: f.name.trim(), startsAt: fromLocalInput(f.start), endsAt: fromLocalInput(f.end), mode: f.mode }))
        return
      }
      const patch = roundPatch(round, f)
      if (!patch) { onClose(); return }
      if (patch.endsAt && endsInPast(f.end, Date.now()) && !window.confirm(t('admin.lucky.confirmEnd'))) return
      onDone(await adminApi.luckyUpdateRound(round.id, patch))
    } catch (e) {
      setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error'))
    } finally { setBusy(false) }
  }

  return (
    <AdminSheet title={t(editing ? 'admin.lucky.round.editTitle' : 'admin.lucky.round.createTitle')} onClose={onClose}>
      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.round.name')}</span>
          <input className="input w-full py-1.5 text-sm" maxLength={NAME_MAX} placeholder={t('admin.lucky.round.namePh')}
            value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.startsAt')}</span>
            <input type="datetime-local" className="input w-full py-1.5 text-sm" value={f.start}
              disabled={editing && round?.phase !== 'upcoming'} onChange={(e) => set({ start: e.target.value })} />
            {shown(f.start) && <span className="mt-1 block text-[11px] text-neutral-500">{t('admin.lucky.userSees', { time: shown(f.start) })}</span>}
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.endsAt')}</span>
            <input type="datetime-local" className="input w-full py-1.5 text-sm" value={f.end} onChange={(e) => set({ end: e.target.value })} />
            {shown(f.end) && <span className="mt-1 block text-[11px] text-neutral-500">{t('admin.lucky.userSees', { time: shown(f.end) })}</span>}
          </label>
        </div>
        {editing && round?.phase !== 'upcoming' && <p className="text-[11px] text-neutral-500">{t('admin.lucky.round.startLocked')}</p>}
        {editing && endsInPast(f.end, Date.now()) && <p className="text-xs text-amber-300">{t('admin.lucky.round.endNowWarn')}</p>}
        <div>
          <span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.mode.label')}</span>
          {editing ? (
            <p className="text-sm text-neutral-200">{t(`admin.lucky.mode.${f.mode}`)}
              <span className="ml-2 text-xs text-neutral-500">{t('admin.lucky.round.modeWhere')}</span></p>
          ) : (
            <div className="space-y-2" role="radiogroup" aria-label={t('admin.lucky.mode.label')}>
              {(['qty', 'prob'] as LuckyMode[]).map((m) => (
                <label key={m} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm ${
                  f.mode === m ? 'border-prism-500/60 bg-prism-500/10' : 'border-white/10'}`}>
                  <input type="radio" name="lucky-mode" className="mt-0.5" checked={f.mode === m} onChange={() => set({ mode: m })} />
                  <span className="min-w-0">
                    <span className="block text-neutral-100">{t(`admin.lucky.mode.${m}`)}</span>
                    <span className="block text-xs text-neutral-500">{t(`admin.lucky.mode.${m}Hint`)}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        {problem && problem !== 'name' && <p className="text-xs text-amber-300">{t(`admin.lucky.round.err.${problem}`)}</p>}
        {err && <p className="text-xs text-down" role="alert">{err}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-ghost flex-1 py-2 text-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary flex-1 py-2 text-sm disabled:opacity-40" disabled={busy || !!problem} onClick={submit}>
            {t(editing ? 'admin.lucky.round.save' : 'admin.lucky.round.create')}</button>
        </div>
      </div>
    </AdminSheet>
  )
}

export function DeleteRoundSheet({ round, onClose, onDeleted }: {
  round: LuckyRoundAdmin
  onClose: () => void
  onDeleted: (d: { draws: number; tickets: number; batches: number; prizes: number }) => void
}) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ok = deleteNameMatches(typed, round.name)
  return (
    <AdminSheet title={t('admin.lucky.del.title')} onClose={onClose}>
      <div className="mt-4 space-y-3 text-sm">
        <p className="break-words text-neutral-200">{t('admin.lucky.del.lead', { name: round.name })}</p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-300">
          <li>{t('admin.lucky.del.draws', { n: round.stats.draws })}</li>
          <li>{t('admin.lucky.del.tickets', { n: round.stats.issued })}</li>
          <li>{t('admin.lucky.del.batchesPrizes')}</li>
        </ul>
        <p className="text-xs text-neutral-500">{t('admin.lucky.del.keeps')}</p>
        {round.stats.pendingClaims > 0 && (
          <p className="text-xs text-amber-300">{t('admin.lucky.del.pendingWarn', { n: round.stats.pendingClaims })}</p>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.del.typeName')}</span>
          <input className="input w-full py-1.5 text-sm" value={typed} placeholder={round.name} autoComplete="off"
            onChange={(e) => setTyped(e.target.value)} />
        </label>
        {err && <p className="text-xs text-down" role="alert">{err}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-ghost flex-1 py-2 text-sm" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" disabled={!ok || busy}
            className="flex-1 rounded-lg bg-down/80 py-2 text-sm font-medium text-white transition hover:bg-down disabled:opacity-40"
            onClick={async () => {
              if (!ok || busy) return
              setBusy(true); setErr('')
              try { onDeleted((await adminApi.luckyDeleteRound(round.id)).deleted) } catch (e) {
                setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error'))
              } finally { setBusy(false) }
            }}>
            {t('admin.lucky.del.confirm')}</button>
        </div>
      </div>
    </AdminSheet>
  )
}
