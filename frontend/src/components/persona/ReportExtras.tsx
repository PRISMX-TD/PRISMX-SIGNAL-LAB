// 交易报告 2026-11-28 新增的几块（rev 58）：
// - WeekDigest：本周 / 上周小结（只在当月报告里）
// - Streaks：纪律连续记录（连续带止损的笔数、连续多少天没有扛单 / 报复加仓 / 反向挪止损）
// - GoalPanel：本月目标 + 目标人格（开关 persona_goals；看自己的当月报告时能改）
// - PeersPanel：和同人格的人比（不足 20 人时后端不给，这一块就不出）
// - LossAlertCard：自设的每日亏损提醒（只提醒，不拦单）
// - DemoPreview：没解锁的人用模拟盘的单预览人格（开关 persona_demo_preview）
// 数据没有就不渲染那一块；文案全在 i18n 的 persona.* 下。
//
// The panels added to the trading report on 2026-11-28: weekly digest, discipline streaks, monthly
// goals with a target persona, same-persona comparison, the self-set daily loss alert and the demo
// persona preview. A panel without its data is not rendered.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { personaApi } from '../../api/client'
import type {
  Persona, PersonaAlert, PersonaFeatures, PersonaGoal, PersonaGoalKey, PersonaGoalRow, PersonaPeers, PersonaPreview,
  PersonaProgress, PersonaStreak, PersonaTag, PersonaWeek,
} from '../../api/personaTypes'
import { localizeApiError } from '../../api/utils'
import { onRovingKeyDown } from '../../utils/rovingTabs'
import { EMPTY } from '../../utils/format'
import { fmtMinutes, money, num, pct, shortDate, tone, type T } from './fmt'
import { AXES, PERSONA_CODES, artUrl, familyOf, type ArtStyle } from './personaMeta'

const TAG_ORDER: PersonaTag[] = ['unprotected', 'heldLoser', 'revenge', 'movedStop', 'earlyExit', 'stoppedOut']

// ---------------------------------------------------------------- 周小结 / weekly digest
export function WeekDigest({ weeks }: { weeks: PersonaWeek[] }) {
  const { t, i18n } = useTranslation()
  const [which, setWhich] = useState(0)
  const w = weeks[which] ?? weeks[0]
  if (!w) return null
  const other = weeks[which === 0 ? 1 : 0]
  const s = w.summary
  const issue = TAG_ORDER.map((k) => ({ k, n: w.tags[k] ?? 0 })).sort((a, b) => b.n - a.n)[0]
  // 只有「本周」才和上周比；看上周时不反过来比。/ Only this week is compared (against last week).
  const cmp = which === 0 && other && other.summary.trades > 0 && s.trades > 0 ? other.summary : null
  const arrow = (cur: number | null, was: number | null, fmt: (v: number) => string) => {
    if (!cmp || cur == null || was == null) return null
    const d = cur - was
    if (Math.abs(d) < 1e-9) return null
    return <small className={`pr-delta num ${d > 0 ? 'is-up' : 'is-down'}`}>{d > 0 ? '▲' : '▼'} {fmt(Math.abs(d))}</small>
  }
  return (
    <>
      <div className="pr-panel-head">
        <h3 className="pr-h3">{t('persona.week.title')}</h3>
        <div className="pr-seg" role="tablist" aria-label={t('persona.week.title')} onKeyDown={onRovingKeyDown}>
          {weeks.map((x, i) => (
            <button key={x.start} type="button" role="tab" aria-selected={i === which} tabIndex={i === which ? 0 : -1}
              className={i === which ? 'on' : ''} onClick={() => setWhich(i)}>
              {t(x.current ? 'persona.week.this' : 'persona.week.last')}
            </button>
          ))}
        </div>
      </div>
      <p className="pr-small">{t('persona.week.range', { from: shortDate(w.start, i18n.language), to: shortDate(w.end, i18n.language) })}</p>
      {s.trades === 0 ? (
        <p className="pr-wk-empty">{t('persona.week.empty')}</p>
      ) : (
        <>
          <dl className="pr-wk">
            <div><dt>{t('persona.week.profit')}</dt><dd className={`num ${tone(s.profit)}`}>{money(s.profit)}</dd></div>
            <div><dt>{t('persona.week.trades')}</dt><dd className="num">{s.trades}</dd></div>
            <div><dt>{t('persona.week.winRate')}</dt><dd className="num">{pct(s.winRate)}{arrow(s.winRate, cmp?.winRate ?? null, (v) => `${(v * 100).toFixed(0)}%`)}</dd></div>
            <div><dt>{t('persona.week.score')}</dt><dd className="num">{s.score ?? EMPTY}{arrow(s.score, cmp?.score ?? null, (v) => String(Math.round(v)))}</dd></div>
          </dl>
          <ul className="pr-wk-facts">
            <li>
              <span>{t('persona.week.issue')}</span>
              <b>{issue && issue.n > 0 ? t('persona.week.issueValue', { name: t(`persona.tags.${issue.k}.name`), n: issue.n }) : t('persona.week.issueNone')}</b>
            </li>
            {w.topSymbol && (
              <li><span>{t('persona.week.topSymbol')}</span><b>{String(w.topSymbol.key)} <i className={`num ${tone(w.topSymbol.profit)}`}>{money(w.topSymbol.profit)}</i></b></li>
            )}
            {w.bestDay && w.bestDay.profit > 0 && (
              <li><span>{t('persona.week.bestDay')}</span><b>{shortDate(w.bestDay.day, i18n.language)} <i className="num is-up">{money(w.bestDay.profit)}</i></b></li>
            )}
            {w.worstDay && w.worstDay.profit < 0 && (
              <li><span>{t('persona.week.worstDay')}</span><b>{shortDate(w.worstDay.day, i18n.language)} <i className="num is-down">{money(w.worstDay.profit)}</i></b></li>
            )}
          </ul>
          {cmp && <p className="pr-small">{t('persona.week.vsLast')}</p>}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- 纪律连续记录 / streaks
const streakUnit = (t: T, s: { unit: 'trades' | 'days' }, n: number) => t(`persona.streak.unit.${s.unit}`, { n })

export function Streaks({ streaks }: { streaks: PersonaStreak[] }) {
  const { t, i18n } = useTranslation()
  if (!streaks.length) return null
  return (
    <>
      <div className="pr-panel-head">
        <h3 className="pr-h3">{t('persona.streak.title')}</h3>
        <p className="pr-small">{t('persona.streak.lead')}</p>
      </div>
      <ul className="pr-streaks">
        {streaks.map((s) => (
          <li key={s.key} className={s.current > 0 && s.current >= s.best ? 'is-best' : ''}>
            <div className="pr-streak-top">
              <span>{t(`persona.streak.${s.key}`)}</span>
              <b className="num">{streakUnit(t, s, s.current)}</b>
            </div>
            <div className="pr-prog-track"><span style={{ width: `${s.best > 0 ? Math.min(100, (s.current / s.best) * 100) : 0}%` }} /></div>
            <p className="pr-small">
              {s.broken
                ? t('persona.streak.broken', { date: shortDate(s.broken.at, i18n.language), v: streakUnit(t, s, s.broken.length) })
                : t('persona.streak.best', { v: streakUnit(t, s, s.best) })}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}

// ---------------------------------------------------------------- 本月目标 / monthly goals
const GOAL_KEYS: PersonaGoalKey[] = ['unprotected', 'heldLoser', 'revenge', 'movedStop', 'winRate', 'payoff', 'score', 'maxDrawdown', 'trades']
const COUNT_GOALS = new Set<PersonaGoalKey>(['unprotected', 'heldLoser', 'revenge', 'movedStop', 'trades'])

// 四个标签类目标直接用标签自己的名字，和「每笔单的标签」那一块叫法一致。
// The four tag goals reuse the tag names, so they read the same as the tagged-trades panel.
const TAG_GOALS = new Set<PersonaGoalKey>(['unprotected', 'heldLoser', 'revenge', 'movedStop'])
const goalName = (t: T, key: PersonaGoalKey) => (TAG_GOALS.has(key) ? t(`persona.tags.${key}.name`) : t(`persona.goal.metric.${key}`))

function goalValue(t: T, key: PersonaGoalKey, v: number | null) {
  if (v == null) return EMPTY
  if (key === 'winRate') return pct(v)
  if (key === 'payoff') return num(v, 2)
  if (key === 'maxDrawdown') return money(v, false)
  if (key === 'score') return String(Math.round(v))
  return t('persona.goal.count', { n: Math.round(v) })
}
// 输入框里的数：胜率按百分数填。/ What the input holds: win rate is typed as a percentage.
const toInput = (key: PersonaGoalKey, v: number) => (key === 'winRate' ? String(Math.round(v * 100)) : String(v))
const fromInput = (key: PersonaGoalKey, raw: string) => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return key === 'winRate' ? n / 100 : n
}
const DEFAULT_TARGET: Record<PersonaGoalKey, number> = {
  unprotected: 0, heldLoser: 2, revenge: 0, movedStop: 0, winRate: 0.5, payoff: 1.5, score: 60, maxDrawdown: 200, trades: 60,
}

function GoalRow({ g, live }: { g: PersonaGoalRow; live: boolean }) {
  const { t } = useTranslation()
  // 进度条：ge 类看离目标还差多少；le 类看「额度」用了多少（用完就超了）。
  // The bar: ge goals fill toward the target; le goals show how much of the allowance is used.
  const ratio = g.value == null ? 0
    : g.dir === 'ge' ? (g.target > 0 ? g.value / g.target : 1)
      : g.target > 0 ? g.value / g.target : g.value > 0 ? 1 : 0
  const state = g.dir === 'le' && live ? (g.met ? 'onTrack' : 'over') : g.met ? 'met' : live ? 'pending' : 'unmet'
  return (
    <li className={`pr-goal is-${g.met ? 'met' : g.dir === 'le' || !live ? 'miss' : 'pending'}`}>
      <div className="pr-goal-top">
        <b>{goalName(t, g.key)}</b>
        <span className="pr-mini">{t(`persona.goal.state.${state}`)}</span>
      </div>
      <div className="pr-prog-track"><span style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} /></div>
      <p className="pr-small">
        {t(`persona.goal.rule.${g.dir}`, { v: goalValue(t, g.key, g.target) })} · {t('persona.goal.now', { v: goalValue(t, g.key, g.value) })}
      </p>
    </li>
  )
}

interface Draft { key: PersonaGoalKey; raw: string }

function GoalEditor({ goal, features, onDone, onCancel }: {
  goal: PersonaGoal | null; features: PersonaFeatures; onDone: () => void; onCancel: () => void
}) {
  const { t } = useTranslation()
  const menu = features.goalMenu
  const [rows, setRows] = useState<Draft[]>(() => (goal?.goals ?? []).map((g) => ({ key: g.key, raw: toInput(g.key, g.target) })))
  const [code, setCode] = useState<string>(goal?.target?.code ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!menu) return null
  const free = GOAL_KEYS.filter((k) => !rows.some((r) => r.key === k))
  const add = () => { if (free.length && rows.length < features.goalsMax) setRows((r) => [...r, { key: free[0], raw: toInput(free[0], DEFAULT_TARGET[free[0]]) }]) }
  const save = async () => {
    const goals: { key: string; target: number }[] = []
    for (const r of rows) {
      const v = fromInput(r.key, r.raw)
      const m = menu[r.key]
      if (v == null || !m || v < m.min || v > m.max) { setErr(t('persona.goal.invalid', { name: goalName(t, r.key) })); return }
      goals.push({ key: r.key, target: v })
    }
    setBusy(true)
    setErr(null)
    try {
      await personaApi.setGoal(goals, code || null)
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error'))
      setBusy(false)
    }
  }
  return (
    <div className="pr-goal-edit">
      {rows.map((r, i) => (
        <div key={r.key} className="pr-goal-line">
          <select className="input" value={r.key} aria-label={t('persona.goal.pick')}
            onChange={(e) => { const k = e.target.value as PersonaGoalKey; setRows((x) => x.map((y, j) => (j === i ? { key: k, raw: toInput(k, DEFAULT_TARGET[k]) } : y))) }}>
            {[r.key, ...free].map((k) => <option key={k} value={k}>{goalName(t, k)}</option>)}
          </select>
          <span className="pr-goal-dir">{t(`persona.goal.dir.${menu[r.key]?.dir ?? 'le'}`)}</span>
          <input className="input num" inputMode="decimal" value={r.raw} aria-label={goalName(t, r.key)}
            onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, raw: e.target.value.replace(/[^0-9.]/g, '') } : y)))} />
          <span className="pr-goal-unit">{r.key === 'winRate' ? '%' : r.key === 'maxDrawdown' ? '$' : COUNT_GOALS.has(r.key) ? t('persona.goal.unitCount') : ''}</span>
          <button type="button" className="pr-goal-x" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} aria-label={t('persona.goal.remove')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      ))}
      {rows.length < features.goalsMax && free.length > 0 && (
        <button type="button" className="pr-link" onClick={add}>{t('persona.goal.add', { n: features.goalsMax })}</button>
      )}
      <label className="pr-goal-target">
        <span>{t('persona.goal.target')}</span>
        <select className="input" value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">{t('persona.goal.targetNone')}</option>
          {PERSONA_CODES.map((c) => <option key={c} value={c}>{c} · {t(`persona.types.${c}.title`)}</option>)}
        </select>
      </label>
      {err && <p className="pr-err" role="alert">{err}</p>}
      <div className="pr-goal-actions">
        <button type="button" className="btn-primary pr-btn" onClick={() => void save()} disabled={busy}>{t('persona.goal.save')}</button>
        <button type="button" className="btn-ghost pr-btn" onClick={onCancel} disabled={busy}>{t('persona.goal.cancel')}</button>
      </div>
      <p className="pr-small">{t('persona.goal.editNote')}</p>
    </div>
  )
}

export function GoalPanel({ goal, features, live, canEdit, onSaved }: {
  goal: PersonaGoal | null | undefined; features: PersonaFeatures | undefined; live: boolean; canEdit: boolean; onSaved: () => void
}) {
  const { t, i18n } = useTranslation()
  const [editing, setEditing] = useState(false)
  const editable = canEdit && live && !!features?.goals && !!features.goalMenu
  if (!goal && !editable) return null
  return (
    <>
      <div className="pr-panel-head">
        <h3 className="pr-h3">{t(live ? 'persona.goal.title' : 'persona.goal.titleArchived')}</h3>
        {editable && !editing && (
          <button type="button" className="pr-link" onClick={() => setEditing(true)}>{t(goal ? 'persona.goal.edit' : 'persona.goal.set')}</button>
        )}
      </div>
      {editing && features ? (
        <GoalEditor goal={goal ?? null} features={features} onCancel={() => setEditing(false)} onDone={() => { setEditing(false); onSaved() }} />
      ) : !goal ? (
        <p className="pr-small">{t('persona.goal.empty')}</p>
      ) : (
        <>
          {goal.goals.length > 0 && <ul className="pr-goals">{goal.goals.map((g) => <GoalRow key={g.key} g={g} live={live} />)}</ul>}
          {goal.target && (
            <div className={`pr-goal-persona ${goal.target.reached ? 'is-met' : ''}`}>
              <div className="pr-goal-top">
                <b>{t('persona.goal.target')}：{t(`persona.types.${goal.target.code}.title`)} <i className="num">{goal.target.code}</i></b>
                <span className="pr-mini">{t(goal.target.reached ? 'persona.goal.state.met' : live ? 'persona.goal.state.pending' : 'persona.goal.state.unmet')}</span>
              </div>
              <ul className="pr-goal-axes">
                {goal.target.axes.map((a) => (
                  <li key={a.axis} className={a.met ? 'is-met' : ''}>
                    <span>{t(`persona.axes.${a.axis}.name`)}</span>
                    <b>{a.met ? t('persona.goal.axisMet', { pole: t(`persona.pole.${a.want}`) }) : t('persona.goal.axisNeed', { from: a.have ? t(`persona.pole.${a.have}`) : EMPTY, pole: t(`persona.pole.${a.want}`) })}</b>
                  </li>
                ))}
              </ul>
              {live && <p className="pr-small">{t('persona.goal.targetNote')}</p>}
            </div>
          )}
          {goal.setAt && <p className="pr-small">{t('persona.goal.setAt', { date: shortDate(goal.setAt, i18n.language) })}</p>}
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------- 同人格对比 / same-persona comparison
export function PeersPanel({ peers, persona }: { peers: PersonaPeers; persona: Persona }) {
  const { t } = useTranslation()
  const ax = persona.axes
  const rows: { k: keyof PersonaPeers['medians']; you: number | null | undefined; fmt: (v: number) => string }[] = [
    { k: 'medianHoldMin', you: ax.tempo?.medianHoldMin, fmt: (v) => fmtMinutes(t, v) },
    { k: 'perDay', you: ax.tempo?.perDay, fmt: (v) => num(v, 1) },
    { k: 'payoff', you: ax.risk?.payoff, fmt: (v) => num(v, 2) },
    { k: 'holdRatio', you: ax.risk?.holdRatio, fmt: (v) => `${num(v, 1)}×` },
    { k: 'signalShare', you: ax.judge?.share, fmt: (v) => pct(v) },
    { k: 'manageShare', you: ax.manage?.share, fmt: (v) => pct(v) },
  ]
  const shown = rows.filter((r) => r.you != null && peers.medians[r.k] != null)
  if (!shown.length) return null
  return (
    <>
      <div className="pr-panel-head"><h3 className="pr-h3">{t('persona.peers.title')}</h3></div>
      <p className="pr-small">
        {peers.scope === 'code'
          ? t('persona.peers.leadCode', { n: peers.count, name: t(`persona.types.${persona.code}.title`) })
          : t('persona.peers.leadFamily', { n: peers.count, family: t(`persona.family.${peers.family}`) })}
      </p>
      <div className="pr-peers" role="table">
        <div className="pr-peer is-head" role="row">
          <span role="columnheader" />
          <span role="columnheader">{t('persona.peers.you')}</span>
          <span role="columnheader">{t('persona.peers.them')}</span>
        </div>
        {shown.map((r) => (
          <div key={r.k} className="pr-peer" role="row">
            <span role="cell">{t(`persona.peers.row.${r.k}`)}</span>
            <b role="cell" className="num">{r.fmt(r.you as number)}</b>
            <span role="cell" className="num">{r.fmt(peers.medians[r.k] as number)}</span>
          </div>
        ))}
      </div>
      <p className="pr-small">{t('persona.peers.note')}</p>
    </>
  )
}

// ---------------------------------------------------------------- 每日亏损提醒 / daily loss alert
export function LossAlertCard({ alert }: { alert: PersonaAlert }) {
  const { t } = useTranslation()
  const [state, setState] = useState(alert)
  const [raw, setRaw] = useState(alert.limit != null ? String(alert.limit) : '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async (enabled: boolean) => {
    const limit = raw.trim() === '' ? null : Number(raw)
    if (enabled && (limit == null || !Number.isFinite(limit) || limit < 1 || limit > 1_000_000)) {
      setMsg({ ok: false, text: t('persona.alert.invalid') })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const next = await personaApi.setAlert(limit != null && Number.isFinite(limit) ? limit : null, enabled)
      setState(next)
      setMsg({ ok: true, text: t(next.enabled ? 'persona.alert.savedOn' : 'persona.alert.savedOff') })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? localizeApiError(e.message) : t('common.error') })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="pr-panel-head">
        <h3 className="pr-h3">{t('persona.alert.title')}</h3>
        <span className={`pr-mini ${state.enabled ? 'is-on' : ''}`}>{t(state.enabled ? 'persona.alert.on' : 'persona.alert.off')}</span>
      </div>
      <p className="pr-small">{t('persona.alert.lead')}</p>
      <div className="pr-alert-row">
        <label>
          <span>{t('persona.alert.limit')}</span>
          <span className="pr-alert-input">
            <i aria-hidden="true">$</i>
            <input className="input num" inputMode="decimal" value={raw} placeholder="100"
              onChange={(e) => setRaw(e.target.value.replace(/[^0-9.]/g, ''))} />
          </span>
        </label>
        <button type="button" className="btn-primary pr-btn" disabled={busy} onClick={() => void save(true)}>
          {t(state.enabled ? 'persona.alert.update' : 'persona.alert.enable')}
        </button>
        {state.enabled && (
          <button type="button" className="btn-ghost pr-btn" disabled={busy} onClick={() => void save(false)}>{t('persona.alert.disable')}</button>
        )}
      </div>
      {msg && <p className={msg.ok ? 'pr-small' : 'pr-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      {state.enabled && state.firedToday && <p className="pr-small">{t('persona.alert.fired')}</p>}
      <p className="pr-small">{t('persona.alert.note')}</p>
    </>
  )
}

// ---------------------------------------------------------------- 模拟盘预览 / demo preview
function PreviewProgress({ label, have, need }: { label: string; have: number; need: number }) {
  const v = Math.min(1, need ? have / need : 0)
  return (
    <div className="pr-prog">
      <div className="pr-prog-top"><span>{label}</span><b className="num">{Math.min(have, need)} / {need}</b></div>
      <div className="pr-prog-track"><span style={{ width: `${v * 100}%` }} /></div>
    </div>
  )
}

export function DemoPreview({ preview, style, onShare, sharing }: {
  preview: PersonaPreview; style: ArtStyle; onShare?: (p: Persona) => void; sharing?: boolean
}) {
  const { t } = useTranslation()
  if (!preview.unlocked) {
    const p: PersonaProgress = preview.progress
    return (
      <section className="pr-panel pr-preview">
        <div className="pr-panel-head">
          <h3 className="pr-h3">{t('persona.preview.progressTitle')}</h3>
          <span className="pr-mini is-demo">{t('persona.preview.pill')}</span>
        </div>
        <p className="pr-small">{t('persona.preview.progressLead')}</p>
        <PreviewProgress label={t('persona.locked.actions')} have={p.actions} need={p.actionsNeed} />
        <PreviewProgress label={t('persona.locked.days')} have={p.days} need={p.daysNeed} />
        {p.needMore && <p className="pr-small">{t('persona.locked.needMore')}</p>}
      </section>
    )
  }
  const persona = preview.persona
  const fam = familyOf(persona.code)
  return (
    <section className="pr-panel pr-preview is-ready">
      <div className="pr-preview-art"><img src={artUrl(persona.code, style)} alt="" width={150} height={172} /></div>
      <div className="pr-preview-body">
        <p className="pr-eyebrow"><span className="pr-mini is-demo">{t('persona.preview.pill')}</span>{t(`persona.family.${fam}`)}</p>
        <h3 className="pr-preview-title">{t('persona.preview.title', { name: t(`persona.types.${persona.code}.title`) })}</h3>
        <ul className="pr-dna" aria-label={persona.code}>
          {AXES.map((a) => {
            const letter = persona.axes[a.key]?.letter ?? a.poles[0]
            return <li key={a.key}><b aria-hidden="true">{letter}</b><span>{t(`persona.pole.${letter}`)}</span></li>
          })}
        </ul>
        <blockquote className="pr-say">{t(`persona.types.${persona.code}.say`)}</blockquote>
        <p className="pr-small">{t('persona.preview.lead')}</p>
        {onShare && (
          <button type="button" className="btn-ghost pr-btn" onClick={() => onShare(persona)} disabled={sharing}>
            {sharing ? t('share.generating') : t('persona.preview.share')}
          </button>
        )}
      </div>
    </section>
  )
}
