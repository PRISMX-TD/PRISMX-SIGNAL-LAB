// 后台「增长 → 幸运轮盘」（v2 多期）。最上面四格 KPI：进行中的期、已发券、已使用、待发奖（跨期合计，点它直接
// 去「待发奖」）。下面是期列表卡：每期一块，期名、状态、模式、时间（UTC+8）、已用 / 已发的细条，底栏是
// 「用户端显示」开关和编辑 / 结束 / 删除；已结束的期默认收起。选中一期后显示期名和页签：「奖品设置」「发券」
// 「抽奖记录」，「待发奖」是跨期的全局队列。
// 管理员不受显示开关限制：没打开显示的期管理员在用户端也能看到、能抽（内部测试用）。
// Admin "Growth -> Lucky wheel" (v2, several rounds). On top, four KPIs: active rounds, tickets issued,
// tickets used and pending prizes (cross-round; clicking it opens the Pending tab). Below, the round list:
// one tile per round with name, phase, mode, window (UTC+8) and a used / issued meter, and a footer with
// the "show to users" switch and edit / end / delete; ended rounds start collapsed. Selecting a round shows
// its name and tabs: prize settings / issue / draws; "Pending" is the global cross-round queue. Admins
// bypass the visible switch (they can test hidden rounds).
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
import { keepSelection, replaceRound, roundKpis, splitRounds, usedRatio } from './luckyRounds'
import './luckyAdmin.css'

type Tab = 'prizes' | 'issue' | 'draws' | 'pending'
type Sheet = { kind: 'create' } | { kind: 'edit'; round: LuckyRoundAdmin } | { kind: 'delete'; round: LuckyRoundAdmin } | null

const PHASE_PILL: Record<LuckyRoundAdmin['phase'], string> = {
  upcoming: 'is-info',
  active: 'is-up',
  ended: '',
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

  if (!rounds) return <div className="adm-card text-sm text-neutral-500">{err || t('common.loading')}</div>
  const { open, ended } = splitRounds(rounds)
  const kpi = roundKpis(rounds)
  const roundTabs: Tab[] = selected ? ['prizes', 'issue', 'draws', 'pending'] : ['pending']
  const activeTab: Tab = selected ? tab : 'pending'
  const goTab = (k: Tab) => { if (k !== activeTab) guard(() => setTab(k)) }

  const tile = (r: LuckyRoundAdmin) => {
    const on = r.id === selId
    const isEnded = r.phase === 'ended'
    return (
      <li key={r.id} className={`lka-round ${on ? 'is-on' : ''} ${isEnded && !on ? 'is-ended' : ''}`}>
        <button type="button" className="lka-round-main" aria-pressed={on}
          onClick={() => { if (!on) guard(() => setSelId(r.id)) }}>
          <span className="lka-round-name">{r.name}</span>
          <span className="lka-round-pills">
            <span className={`adm-pill ${PHASE_PILL[r.phase]}`}>{t(`admin.lucky.phase.${r.phase}`)}</span>
            <span className="adm-pill">{t(`admin.lucky.mode.${r.mode}`)}</span>
            {r.stats.pendingClaims > 0 && (
              <span className="adm-pill is-warn num">{t('admin.lucky.round.pending', { n: r.stats.pendingClaims })}</span>
            )}
          </span>
          <span className="lka-round-time num block">{fmtTime(r.startsAt)} ～ {fmtTime(r.endsAt)}</span>
          <span className="lka-meter" aria-hidden><i style={{ width: `${usedRatio(r.stats) * 100}%` }} /></span>
          <span className="lka-round-stats num block">{t('admin.lucky.round.meterLabel', { used: r.stats.used, issued: r.stats.issued })}</span>
        </button>
        <div className="lka-round-foot">
          {!isEnded && (
            <label className="lka-vis">
              <Switch checked={r.visible} busy={busyId === r.id} onChange={(v) => void setVisible(r, v)}
                aria-label={t('admin.lucky.round.visibleFor', { name: r.name })} />
              {t(r.visible ? 'admin.lucky.round.shown' : 'admin.lucky.round.hidden')}
            </label>
          )}
          <div className="lka-round-actions">
            {!isEnded && (
              <>
                <button type="button" className="lka-act" onClick={() => setSheet({ kind: 'edit', round: r })}>
                  {t('admin.lucky.round.edit')}</button>
                <button type="button" className="lka-act is-warn" disabled={busyId === r.id}
                  onClick={() => void endRound(r)}>{t('admin.lucky.endNow')}</button>
              </>
            )}
            <button type="button" className="lka-act is-down" onClick={() => setSheet({ kind: 'delete', round: r })}>
              {t('admin.lucky.round.delete')}</button>
          </div>
        </div>
      </li>
    )
  }

  return (
    <div className="lka space-y-5">
      <div className="adm-kpis is-quad">
        <div className="adm-kpi">
          <span className="adm-kpi-label">{t('admin.lucky.kpi.active')}</span>
          <span className="adm-kpi-value num">{kpi.active}</span>
          <span className="adm-kpi-foot lka-note">{t('admin.lucky.kpi.upcomingFoot', { n: kpi.upcoming })}</span>
        </div>
        <div className="adm-kpi">
          <span className="adm-kpi-label">{t('admin.lucky.kpi.issued')}</span>
          <span className="adm-kpi-value num">{kpi.issued}</span>
        </div>
        <div className="adm-kpi">
          <span className="adm-kpi-label">{t('admin.lucky.kpi.used')}</span>
          <span className="adm-kpi-value num">{kpi.used}</span>
          <span className="adm-kpi-foot lka-note">{t('admin.lucky.kpi.usedFoot', { pct: Math.round(usedRatio(kpi) * 100) })}</span>
        </div>
        <button type="button" className={`adm-kpi adm-kpi-btn ${activeTab === 'pending' ? 'is-on' : ''}`}
          aria-pressed={activeTab === 'pending'} onClick={() => goTab('pending')}>
          <span className="adm-kpi-label">
            {pending > 0 && <i className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />}
            {t('admin.lucky.kpi.pending')}
          </span>
          <span className={`adm-kpi-value num ${pending > 0 ? 'is-warn' : ''}`}>{pending}</span>
          <span className="adm-kpi-foot lka-note">{t('admin.lucky.kpi.pendingFoot')}</span>
        </button>
      </div>

      <section className="adm-card">
        <div className="lka-card-head">
          <div className="min-w-0">
            <h3 className="lka-h">{t('admin.lucky.round.list')}</h3>
            <p className="lka-sub">{t('admin.lucky.round.adminSees')}</p>
          </div>
          <button type="button" className="adm-btn is-primary" onClick={() => setSheet({ kind: 'create' })}>
            {t('admin.lucky.round.new')}</button>
        </div>
        {rounds.length === 0 && (
          <div className="adm-empty"><p className="adm-empty-title">{t('admin.lucky.round.empty')}</p></div>
        )}
        {open.length > 0 && <ul className="lka-rounds">{open.map(tile)}</ul>}
        {ended.length > 0 && (
          <div className={open.length > 0 ? 'mt-4' : ''}>
            <button type="button" className="adm-link-btn" aria-expanded={showEnded} onClick={() => setShowEnded((v) => !v)}>
              {t(showEnded ? 'admin.lucky.round.hideEnded' : 'admin.lucky.round.showEnded', { n: ended.length })}</button>
            {(showEnded || selected?.phase === 'ended') && (
              <ul className="lka-rounds mt-3">{(showEnded ? ended : ended.filter((r) => r.id === selId)).map(tile)}</ul>
            )}
          </div>
        )}
        {err && <p className="lka-note is-down mt-3" role="alert">{err}</p>}
        {msg && <p className="lka-note mt-3" role="status">{msg}</p>}
      </section>

      <div>
        {selected && <h3 className="lka-sel-name">{selected.name}</h3>}
        <div className="adm-tabs lka-tabs no-scrollbar" role="tablist">
          {roundTabs.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={activeTab === k} className={`adm-tab ${activeTab === k ? 'is-active' : ''}`}
              onClick={() => goTab(k)}>
              {t(`admin.lucky.tab.${k}`)}
              {k === 'pending' && pending > 0 && <span className="adm-pill is-warn num">{pending}</span>}
            </button>
          ))}
        </div>
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
