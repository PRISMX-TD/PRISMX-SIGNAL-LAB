// 后台「增长 → 幸运轮盘」（v2 多期）。顶部是期列表：期名、时间（UTC+8）、状态、模式、「用户端显示」开关、
// 统计（已发券 / 已用 / 待发奖），每期可编辑、结束、删除；右上「新建一期」。选中一期后下方是它的
// 「奖品设置」「发券」「抽奖记录」；「待发奖」是跨期的全局队列。
// 管理员不受显示开关限制：没打开显示的期管理员在用户端也能看到、能抽（内部测试用）。
// Admin "Growth -> Lucky wheel" (v2, several rounds). The top lists rounds: name, window (UTC+8),
// phase, mode, the "show to users" switch and stats, with edit / end / delete per round and "New round"
// at the top right. Selecting a round shows its prize settings / issue / draws tabs below; "Pending" is
// the global cross-round queue. Admins bypass the visible switch (they can test hidden rounds).
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyRoundAdmin } from '../../../api/luckyTypes'
import { fmtTime, localizeApiError } from '../../../api/utils'
import Switch from '../../Switch'
import LuckyDrawsTab from './LuckyDrawsTab'
import LuckyIssueTab from './LuckyIssueTab'
import { DeleteRoundSheet, RoundFormSheet } from './LuckyRoundSheets'
import LuckySettingsTab from './LuckySettingsTab'
import { keepSelection, replaceRound, splitRounds } from './luckyRounds'

type Tab = 'prizes' | 'issue' | 'draws' | 'pending'
type Sheet = { kind: 'create' } | { kind: 'edit'; round: LuckyRoundAdmin } | { kind: 'delete'; round: LuckyRoundAdmin } | null

const PHASE_TONE: Record<LuckyRoundAdmin['phase'], string> = {
  upcoming: 'bg-sky-500/15 text-sky-300',
  active: 'bg-up/15 text-up',
  ended: 'bg-white/10 text-neutral-400',
}

export default function LuckyWheelPanel() {
  const { t } = useTranslation()
  const [rounds, setRounds] = useState<LuckyRoundAdmin[] | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('prizes')
  const [pending, setPending] = useState(0)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [showEnded, setShowEnded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const errText = useCallback((e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error')), [t])

  const reload = useCallback(() => {
    adminApi.luckyRounds().then((r) => {
      setRounds(r.rounds)
      setSelId((cur) => keepSelection(r.rounds, cur))
    }).catch((e) => setErr(errText(e)))
    adminApi.luckyDraws({ status: 'open', limit: 1, offset: 0 }).then((r) => setPending(r.total)).catch((e) => setErr(errText(e)))
  }, [errText])
  useEffect(reload, [reload])

  // 奖品设置有未保存的改动时，切页签 / 换期前确认（卸载设置页改动就丢了）。
  // Unsaved prize edits are lost when the settings tab unmounts, so confirm before switching tab or round.
  const guard = (fn: () => void) => {
    if (tab === 'prizes' && dirty && !window.confirm(t('admin.lucky.confirmLeave'))) return
    fn()
  }
  const update = (r: LuckyRoundAdmin & { voided?: number }) => setRounds((xs) => replaceRound(xs ?? [], r))
  const selected = rounds?.find((r) => r.id === selId) ?? null

  const setVisible = async (r: LuckyRoundAdmin, v: boolean) => {
    setBusyId(r.id); setErr(''); setMsg('')
    try { update(await adminApi.luckySetRoundVisible(r.id, v)) } catch (e) { setErr(errText(e)) } finally { setBusyId(null) }
  }
  const endRound = async (r: LuckyRoundAdmin) => {
    if (!window.confirm(t('admin.lucky.confirmEndRound', { name: r.name }))) return
    setBusyId(r.id); setErr(''); setMsg('')
    try {
      const next = await adminApi.luckyEndRound(r.id)
      update(next)
      setMsg(t('admin.lucky.voided', { n: next.voided }))
    } catch (e) { setErr(errText(e)) } finally { setBusyId(null) }
  }

  if (!rounds) return <div className="card p-6 text-sm text-neutral-500">{err || t('common.loading')}</div>
  const { open, ended } = splitRounds(rounds)
  const roundTabs: Tab[] = selected ? ['prizes', 'issue', 'draws', 'pending'] : ['pending']
  const activeTab: Tab = selected ? tab : 'pending'

  const card = (r: LuckyRoundAdmin) => {
    const on = r.id === selId
    const isEnded = r.phase === 'ended'
    return (
      <li key={r.id} className={`min-w-0 rounded-lg border p-3 ${on ? 'border-prism-500/60 bg-prism-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
        <div className="flex items-start gap-3">
          <button type="button" className="min-w-0 flex-1 text-left" aria-pressed={on}
            onClick={() => { if (!on) guard(() => setSelId(r.id)) }}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="break-all font-semibold text-neutral-100">{r.name}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] ${PHASE_TONE[r.phase]}`}>{t(`admin.lucky.phase.${r.phase}`)}</span>
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-neutral-300">{t(`admin.lucky.mode.${r.mode}`)}</span>
            </div>
            <div className="mt-1 break-words text-xs text-neutral-400">{fmtTime(r.startsAt)} ～ {fmtTime(r.endsAt)}</div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {t('admin.lucky.round.stats', { issued: r.stats.issued, used: r.stats.used, pending: r.stats.pendingClaims })}
            </div>
          </button>
          {!isEnded && (
            <label className="flex shrink-0 flex-col items-end gap-1 text-[11px] text-neutral-400">
              <Switch checked={r.visible} busy={busyId === r.id} onChange={(v) => void setVisible(r, v)}
                aria-label={t('admin.lucky.round.visibleFor', { name: r.name })} />
              {t(r.visible ? 'admin.lucky.round.shown' : 'admin.lucky.round.hidden')}
            </label>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!isEnded && (
            <>
              <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setSheet({ kind: 'edit', round: r })}>
                {t('admin.lucky.round.edit')}</button>
              <button type="button" className="btn-ghost px-2.5 py-1 text-xs text-amber-300 disabled:opacity-40" disabled={busyId === r.id}
                onClick={() => void endRound(r)}>{t('admin.lucky.endNow')}</button>
            </>
          )}
          <button type="button" className="rounded px-2.5 py-1 text-xs text-down hover:bg-white/10"
            onClick={() => setSheet({ kind: 'delete', round: r })}>{t('admin.lucky.round.delete')}</button>
        </div>
      </li>
    )
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-sm font-semibold text-neutral-100">{t('admin.lucky.round.list')}</h3>
          <span className="text-xs text-neutral-500">{t('admin.lucky.round.adminSees')}</span>
          <button type="button" className="btn-primary ml-auto px-3 py-1.5 text-sm" onClick={() => setSheet({ kind: 'create' })}>
            {t('admin.lucky.round.new')}</button>
        </div>
        {rounds.length === 0 && <p className="py-4 text-center text-sm text-neutral-500">{t('admin.lucky.round.empty')}</p>}
        {open.length > 0 && <ul className="grid gap-3 md:grid-cols-2">{open.map(card)}</ul>}
        {ended.length > 0 && (
          <div className="space-y-2">
            <button type="button" className="text-xs text-neutral-400 hover:text-neutral-200" aria-expanded={showEnded}
              onClick={() => setShowEnded((v) => !v)}>
              {t(showEnded ? 'admin.lucky.round.hideEnded' : 'admin.lucky.round.showEnded', { n: ended.length })}</button>
            {(showEnded || selected?.phase === 'ended') && (
              <ul className="grid gap-3 md:grid-cols-2">{(showEnded ? ended : ended.filter((r) => r.id === selId)).map(card)}</ul>
            )}
          </div>
        )}
        {err && <p className="text-xs text-down" role="alert">{err}</p>}
        {msg && <p className="text-xs text-neutral-300" role="status">{msg}</p>}
      </section>

      {selected && <p className="break-words text-sm text-neutral-300">{t('admin.lucky.round.current', { name: selected.name })}</p>}
      <div className="seg-tabs w-full sm:w-fit" role="tablist">
        {roundTabs.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={activeTab === k} className={activeTab === k ? 'on' : ''}
            onClick={() => { if (k !== activeTab) guard(() => setTab(k)) }}>
            {t(`admin.lucky.tab.${k}`)}{k === 'pending' && pending > 0 ? ` · ${pending}` : ''}</button>
        ))}
      </div>
      {selected && activeTab === 'prizes' && (
        <LuckySettingsTab key={selected.id} round={selected} onDirty={setDirty} onSaved={update} />
      )}
      {selected && activeTab === 'issue' && <LuckyIssueTab key={selected.id} round={selected} onIssued={reload} />}
      {selected && activeTab === 'draws' && <LuckyDrawsTab key={selected.id} mode="all" roundId={selected.id} onChange={reload} />}
      {activeTab === 'pending' && <LuckyDrawsTab mode="pending" onChange={reload} />}

      {sheet?.kind === 'create' && (
        <RoundFormSheet onClose={() => setSheet(null)} onDone={(r) => {
          setSheet(null); update(r)
          guard(() => { setSelId(r.id); setTab('prizes') })
          setMsg(t('admin.lucky.round.created', { name: r.name }))
        }} />
      )}
      {sheet?.kind === 'edit' && (
        <RoundFormSheet round={sheet.round} onClose={() => setSheet(null)} onDone={(r) => {
          setSheet(null); update(r)
          setMsg(r.voided ? t('admin.lucky.voided', { n: r.voided }) : t('admin.lucky.saved'))
        }} />
      )}
      {sheet?.kind === 'delete' && (
        <DeleteRoundSheet round={sheet.round} onClose={() => setSheet(null)} onDeleted={(d) => {
          const id = sheet.round.id
          setSheet(null)
          if (id === selId) setDirty(false)
          const next = rounds.filter((r) => r.id !== id)
          setRounds(next)
          setSelId(keepSelection(next, selId === id ? null : selId))
          setMsg(t('admin.lucky.del.done', d))
          reload()
        }} />
      )}
    </div>
  )
}
