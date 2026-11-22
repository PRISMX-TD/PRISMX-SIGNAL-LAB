// 交易报告 + 交易人格（2026-11-22）：「交易」页（OrdersPage）的第五个页签，/persona 转到那里。
// 自上而下：人格卡（插画 + 称号 + 点评 + 四个主轴）→ 月份切换 → 本月成绩 → 盈亏日历 → 徽章 →
// 分类报表 → 每笔单的标签 → AI 点评（只在存档月份）→ 「交易人格是怎么算的」（默认收起，里面是 16 种人格）。
// 没下过实盘单：只给「开通实盘」的钩子；下过但不够数：给解锁进度。
// mode="client"（/persona/client）是推荐官看直属客户：邮箱在路由 state 里，没有分享按钮。
//
// Trading report + persona: the fifth tab of the Orders page (/persona redirects there). Top to
// bottom: persona card, month picker, month stats, P&L calendar, badges, breakdowns, per-trade tags,
// AI comment (archived months only) and a collapsed "how it works" section holding the 16 types. No real orders → a hook to go live; not enough yet → unlock progress.
// mode="client" is an ambassador viewing a direct customer (e-mail in router state, no share).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { personaApi } from '../api/client'
import type { Persona, PersonaBucket, PersonaOverview, PersonaProgress, PersonaReport, PersonaTag } from '../api/personaTypes'
import { localizeApiError } from '../api/utils'
import { LOCALE_TAG, currentLang } from '../i18n'
import PageHead from '../components/PageHead'
import ShareSheet, { type ShareSpec } from '../components/share/ShareSheet'
import { SkeletonLine } from '../components/Skeleton'
import { AXES, FAMILY_COLOR, PERSONA_CODES, artUrl, familyOf, readArtStyle, writeArtStyle, type ArtStyle } from '../components/persona/personaMeta'
import { onRovingKeyDown } from '../utils/rovingTabs'
import { EMPTY } from '../utils/format'
import '../components/persona/persona.css'

type ClientState = { email?: string; name?: string } | null
type BreakKey = 'symbol' | 'session' | 'weekday' | 'hold' | 'source'
const BREAKS: BreakKey[] = ['symbol', 'session', 'hold', 'weekday', 'source']
const TAGS: PersonaTag[] = ['unprotected', 'heldLoser', 'earlyExit', 'movedStop', 'revenge', 'stoppedOut']
const TAGGED_SHOWN = 8

const money = (v: number | null | undefined, sign = true) => {
  if (v == null || !Number.isFinite(v)) return EMPTY
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : ''}$${s}`
}
const pct = (v: number | null | undefined, digits = 0) => (v == null || !Number.isFinite(v) ? EMPTY : `${(v * 100).toFixed(digits)}%`)
const num = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? EMPTY : v.toFixed(digits))
const tone = (v: number) => (v > 0 ? 'is-up' : v < 0 ? 'is-down' : '')

export default function PersonaPage({ mode = 'self' }: { mode?: 'self' | 'client' }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const client = mode === 'client' ? ((location.state as ClientState) ?? null) : null
  const clientEmail = client?.email ?? ''
  const [overview, setOverview] = useState<PersonaOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [period, setPeriod] = useState<string | null>(null)
  const [reports, setReports] = useState<Record<string, PersonaReport>>({})
  const [loadingMonth, setLoadingMonth] = useState(false)
  const [style, setStyle] = useState<ArtStyle>(readArtStyle)
  const [share, setShare] = useState<ShareSpec | null>(null)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    if (mode === 'client' && !clientEmail) {
      navigate('/agent', { replace: true })
      return
    }
    let alive = true
    const p = mode === 'client' ? personaApi.client(clientEmail) : personaApi.me()
    p.then((o) => {
      if (!alive) return
      setOverview(o)
      if (o.status === 'unlocked' && o.report) {
        setPeriod(o.report.period)
        setReports({ [o.report.period]: o.report })
      }
    }).catch((e: unknown) => {
      if (!alive) return
      const msg = e instanceof Error ? e.message : ''
      if (/403|beta|内测|权限/i.test(msg)) setForbidden(true)
      else setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error'))
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, clientEmail])

  const pickMonth = useCallback((p: string) => {
    setPeriod(p)
    if (reports[p]) return
    setLoadingMonth(true)
    const req = mode === 'client' ? personaApi.clientReport(clientEmail, p).then((r) => r.report) : personaApi.report(p)
    req.then((r) => setReports((m) => ({ ...m, [p]: r })))
      .catch((e: unknown) => setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error')))
      .finally(() => setLoadingMonth(false))
  }, [reports, mode, clientEmail, t])

  const pickStyle = (s: ArtStyle) => {
    setStyle(s)
    writeArtStyle(s)
  }

  const persona = overview?.status === 'unlocked' ? overview.persona : null
  const report = period ? reports[period] : null

  const openShare = async () => {
    if (!persona || sharing) return
    setSharing(true)
    try {
      const { buildPersonaCard } = await import('../components/persona/personaCard')
      const build = await buildPersonaCard(t, persona, style)
      setShare({ type: 'D', variants: [{ key: 'p', label: '', input: {} }], custom: { title: t('persona.share.title'), fileStem: 'persona', build } })
    } catch (e) {
      console.error('persona share card failed', e)
      setErr(t('share.failed'))
    } finally {
      setSharing(false)
    }
  }

  const head = mode === 'client' ? (
    <PageHead
      title={t('persona.client.title', { name: client?.name || clientEmail })}
      subtitle={t('persona.client.sub')}
      back={{ to: '/agent', label: t('persona.client.back') }}
    />
  ) : null

  if (forbidden) {
    return <>{head}<div className="card glass p-6 text-center text-sm text-neutral-400">{t(mode === 'client' ? 'persona.client.forbidden' : 'persona.closed')}</div></>
  }
  if (err && !overview) {
    return <>{head}<p className="pr-err" role="alert">{err}</p></>
  }
  if (!overview) {
    return (
      <div className="pr" aria-busy="true">
        {head}
        <div className="pr-hero is-skel"><div className="pr-art-box" /><div className="pr-hero-body"><SkeletonLine width="40%" /><SkeletonLine width="70%" /><SkeletonLine width="90%" /></div></div>
      </div>
    )
  }

  return (
    <div className="pr">
      {head}
      {overview.status === 'unlocked' && persona ? (
        <>
          <PersonaHero persona={persona} style={style} onStyle={pickStyle} change={report?.change ?? null}
            onShare={mode === 'self' ? openShare : undefined} sharing={sharing} />
          <AxesPanel persona={persona} />
          <section className="pr-sec" aria-labelledby="pr-month-h">
            <div className="pr-sec-head">
              <h2 id="pr-month-h">{t('persona.report.title')}</h2>
              <div className="pr-months" role="tablist" aria-label={t('persona.report.title')} onKeyDown={onRovingKeyDown}>
                {overview.months.map((m) => (
                  <button key={m} type="button" role="tab" aria-selected={m === period} tabIndex={m === period ? 0 : -1}
                    className={`pr-chip ${m === period ? 'on' : ''}`} onClick={() => pickMonth(m)}>
                    {monthLabel(m, i18n.language)}
                  </button>
                ))}
              </div>
            </div>
            {err && <p className="pr-err" role="alert">{err}</p>}
            {loadingMonth && !report ? (
              <div className="pr-card"><SkeletonLine width="60%" /><SkeletonLine width="80%" /></div>
            ) : report ? <MonthReport report={report} /> : null}
          </section>
        </>
      ) : overview.status === 'locked' ? (
        <LockedHero progress={overview.progress} client={mode === 'client'} />
      ) : (
        <DemoHero client={mode === 'client'} />
      )}
      <Intro current={persona?.code ?? null} style={style} />
      <p className="pr-note">{t('persona.note')}</p>
      <ShareSheet spec={share} onClose={() => setShare(null)} />
    </div>
  )
}

function monthLabel(period: string, lang: string) {
  const [y, m] = period.split('-').map(Number)
  const tag = LOCALE_TAG[currentLang()] ?? lang
  try {
    return new Intl.DateTimeFormat(tag.startsWith('th') ? `${tag}-u-ca-gregory` : tag, { year: 'numeric', month: 'short', timeZone: 'UTC' })
      .format(new Date(Date.UTC(y, m - 1, 1)))
  } catch {
    return period
  }
}

// ---------------------------------------------------------------- 人格卡 / persona hero
function ArtSwitch({ style, onStyle }: { style: ArtStyle; onStyle: (s: ArtStyle) => void }) {
  const { t } = useTranslation()
  return (
    <div className="pr-seg" role="group" aria-label={t('persona.art.label')}>
      {(['voxel', 'poster'] as ArtStyle[]).map((s) => (
        <button key={s} type="button" aria-pressed={s === style} className={s === style ? 'on' : ''} onClick={() => onStyle(s)}>
          {t(`persona.art.${s}`)}
        </button>
      ))}
    </div>
  )
}

function PersonaHero({ persona, style, onStyle, change, onShare, sharing }: {
  persona: Persona; style: ArtStyle; onStyle: (s: ArtStyle) => void; change: { from: string; to: string } | null
  onShare?: () => void; sharing: boolean
}) {
  const { t } = useTranslation()
  const fam = familyOf(persona.code)
  const c = FAMILY_COLOR[fam]
  return (
    <section className="pr-hero" style={{ '--fam': c.main, '--fam-deep': c.deep } as React.CSSProperties}>
      <div className="pr-art-col">
        <div className="pr-art-box">
          <img src={artUrl(persona.code, style)} alt={t(`persona.types.${persona.code}.title`)} width={300} height={345} />
        </div>
        <ArtSwitch style={style} onStyle={onStyle} />
      </div>
      <div className="pr-hero-body">
        <p className="pr-eyebrow"><span className="pr-dot" aria-hidden="true" />{t(`persona.family.${fam}`)}<span className="pr-code">{persona.code}</span></p>
        <h2 className="pr-title">{t(`persona.types.${persona.code}.title`)}</h2>
        <p className="pr-traits">{AXES.map((a) => t(`persona.pole.${persona.axes[a.key]?.letter ?? a.poles[0]}`)).join(' · ')}</p>
        <blockquote className="pr-say">{t(`persona.types.${persona.code}.say`)}</blockquote>
        <div className="pr-meta">
          <span className={`pr-pill ${persona.provisional ? 'is-soft' : ''}`}>
            {persona.provisional ? t('persona.provisional', { n: persona.positions, need: 50 }) : t('persona.formal', { n: persona.positions })}
          </span>
          {change && (
            <span className="pr-pill is-soft">{t('persona.changed', { from: t(`persona.types.${change.from}.title`) })}</span>
          )}
        </div>
        <p className="pr-small">{t('persona.window')}</p>
        {onShare && (
          <div className="pr-actions">
            <button type="button" className="btn-primary pr-btn" onClick={onShare} disabled={sharing}>
              {sharing ? t('share.generating') : t('persona.share.button')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function AxesPanel({ persona }: { persona: Persona }) {
  const { t } = useTranslation()
  const c = FAMILY_COLOR[familyOf(persona.code)]
  return (
    <section className="pr-sec" aria-labelledby="pr-axes-h">
      <div className="pr-sec-head"><h2 id="pr-axes-h">{t('persona.axes.title')}</h2></div>
      <div className="pr-card pr-axes">
        {AXES.map((a) => {
          const ax = persona.axes[a.key]
          const v = Math.max(0, Math.min(100, ax?.value ?? 50))
          const right = v >= 50
          return (
            <div key={a.key} className="pr-axis">
              <div className="pr-axis-top">
                <span className="pr-axis-name">{t(`persona.axes.${a.key}.name`)}</span>
                <span className="pr-axis-fact">{axisFact(t, a.key, ax)}</span>
              </div>
              <div className="pr-axis-bar">
                <span className={`pr-pole ${!right ? 'on' : ''}`}>{t(`persona.pole.${a.poles[0]}`)}</span>
                <div className="pr-track" role="img" aria-label={`${t(`persona.pole.${a.poles[0]}`)} ${100 - Math.round(v)} / ${t(`persona.pole.${a.poles[1]}`)} ${Math.round(v)}`}>
                  <span className="pr-mid" aria-hidden="true" />
                  <span className="pr-fill" style={{ left: `${right ? 50 : v}%`, width: `${Math.max(Math.abs(v - 50), 1.5)}%`, background: c.main }} />
                  <span className="pr-knob" style={{ left: `${v}%`, borderColor: c.main }} />
                </div>
                <span className={`pr-pole ${right ? 'on' : ''}`}>{t(`persona.pole.${a.poles[1]}`)}</span>
              </div>
              <p className="pr-axis-help">{t(`persona.axes.${a.key}.help`)}</p>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function axisFact(t: (k: string, o?: Record<string, unknown>) => string, key: string, ax: Persona['axes'][keyof Persona['axes']] | undefined) {
  if (!ax) return ''
  if (key === 'judge') return t('persona.axes.judge.fact', { p: pct(ax.share) })
  if (key === 'risk') return t('persona.axes.risk.fact', { r: num(ax.holdRatio, 1), p: num(ax.payoff, 2) })
  if (key === 'tempo') return t('persona.axes.tempo.fact', { m: num(ax.medianHoldMin, 1), n: num(ax.perDay, 1) })
  return t('persona.axes.manage.fact', { p: pct(ax.share) })
}

// ---------------------------------------------------------------- 未解锁 / locked + demo
function ProgressRow({ label, have, need }: { label: string; have: number; need: number }) {
  const v = Math.min(1, need ? have / need : 0)
  return (
    <div className="pr-prog">
      <div className="pr-prog-top"><span>{label}</span><b className="num">{Math.min(have, need)} / {need}</b></div>
      <div className="pr-prog-track"><span style={{ width: `${v * 100}%` }} /></div>
    </div>
  )
}

function TeaserArt() {
  return (
    <div className="pr-teaser" aria-hidden="true">
      {['AGLZ', 'AXQM', 'RGQZ', 'RXQM'].map((code) => <img key={code} src={artUrl(code, 'voxel')} alt="" width={120} height={138} loading="lazy" />)}
    </div>
  )
}

function LockedHero({ progress, client }: { progress: PersonaProgress; client: boolean }) {
  const { t } = useTranslation()
  return (
    <section className="pr-hook">
      <TeaserArt />
      <div className="pr-hook-body">
        <h2 className="pr-title">{t(client ? 'persona.client.locked' : 'persona.locked.title')}</h2>
        <p className="pr-lead">{t('persona.locked.lead')}</p>
        <ProgressRow label={t('persona.locked.actions')} have={progress.actions} need={progress.actionsNeed} />
        <ProgressRow label={t('persona.locked.days')} have={progress.days} need={progress.daysNeed} />
        {progress.needMore && <p className="pr-small">{t('persona.locked.needMore')}</p>}
        <p className="pr-small">{t('persona.locked.actionHelp')}</p>
      </div>
    </section>
  )
}

function DemoHero({ client }: { client: boolean }) {
  const { t } = useTranslation()
  return (
    <section className="pr-hook">
      <TeaserArt />
      <div className="pr-hook-body">
        <h2 className="pr-title">{t(client ? 'persona.client.demo' : 'persona.demo.title')}</h2>
        <p className="pr-lead">{t('persona.demo.lead')}</p>
        {!client && <Link to="/bind" className="btn-primary pr-btn">{t('persona.demo.cta')}</Link>}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- 月报 / monthly report
function MonthReport({ report }: { report: PersonaReport }) {
  const { t, i18n } = useTranslation()
  const s = report.summary
  const lang = (i18n.language || 'zh').slice(0, 2) as 'zh' | 'en' | 'ja' | 'th' | 'vi'
  const comment = report.comment ? (report.comment[lang] || report.comment.en || report.comment.zh) : null
  if (!s.trades) {
    return <div className="pr-card pr-empty">{t('persona.report.empty')}</div>
  }
  const tiles: { k: string; v: string; cls?: string }[] = [
    { k: 'profit', v: money(s.profit), cls: tone(s.profit) },
    { k: 'trades', v: String(s.trades) },
    { k: 'winRate', v: pct(s.winRate) },
    { k: 'payoff', v: num(s.payoff, 2) },
    { k: 'score', v: s.score == null ? EMPTY : String(s.score) },
    { k: 'days', v: t('persona.report.daysValue', { g: s.greenDays, n: s.tradingDays }) },
    { k: 'hold', v: s.medianHoldMin == null ? EMPTY : fmtMinutes(t, s.medianHoldMin) },
    { k: 'drawdown', v: money(-s.maxDrawdown, false), cls: s.maxDrawdown > 0 ? 'is-down' : '' },
  ]
  return (
    <div className="pr-month">
      {report.live && <p className="pr-small">{t('persona.report.live')}</p>}
      <div className="pr-tiles">
        {tiles.map((x) => (
          <div key={x.k} className="pr-tile">
            <span>{t(`persona.report.stat.${x.k}`)}</span>
            <b className={`num ${x.cls ?? ''}`}>{x.v}</b>
          </div>
        ))}
      </div>
      {report.openLosers > 0 && <p className="pr-small">{t('persona.report.openLosers', { n: report.openLosers })}</p>}

      <Calendar report={report} />

      {report.badges.length > 0 && (
        <div className="pr-card">
          <h3 className="pr-h3">{t('persona.badges.title')}</h3>
          <ul className="pr-badges">
            {report.badges.map((b) => (
              <li key={b}><b>{t(`persona.badges.${b}.name`)}</b><span>{t(`persona.badges.${b}.desc`)}</span></li>
            ))}
          </ul>
        </div>
      )}

      <Breakdowns report={report} />
      <TagsPanel report={report} />

      <div className="pr-card pr-comment">
        <h3 className="pr-h3">{t('persona.comment.title')}</h3>
        {comment ? <p>{comment}</p> : <p className="pr-small">{t(report.live ? 'persona.comment.pending' : 'persona.comment.none')}</p>}
      </div>
    </div>
  )
}

function fmtMinutes(t: (k: string, o?: Record<string, unknown>) => string, m: number) {
  if (m < 1) return t('persona.unit.sec', { n: Math.max(1, Math.round(m * 60)) })
  if (m < 90) return t('persona.unit.min', { n: Math.round(m) })
  return t('persona.unit.hour', { n: (m / 60).toFixed(1) })
}

function Calendar({ report }: { report: PersonaReport }) {
  const { t } = useTranslation()
  const [y, m] = report.period.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7 // 周一开头 / Monday first
  const byDay = new Map(report.calendar.map((d) => [Number(d.day.slice(8, 10)), d]))
  const maxAbs = Math.max(1, ...report.calendar.map((d) => Math.abs(d.profit)))
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  while (cells.length % 7) cells.push(null)
  return (
    <div className="pr-card">
      <h3 className="pr-h3">{t('persona.calendar.title')}</h3>
      <div className="pr-cal" role="grid" aria-label={t('persona.calendar.title')}>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={`h${i}`} className="pr-cal-h" role="columnheader">{t(`persona.weekday.${i}`)}</span>)}
        {cells.map((d, i) => {
          if (d == null) return <span key={i} className="pr-cal-c is-blank" role="gridcell" />
          const row = byDay.get(d)
          const a = row ? Math.min(1, Math.abs(row.profit) / maxAbs) : 0
          const bg = row ? (row.profit >= 0 ? `rgb(var(--up-rgb) / ${0.12 + a * 0.45})` : `rgb(var(--down-rgb) / ${0.12 + a * 0.45})`) : undefined
          return (
            <span key={i} className={`pr-cal-c ${row ? 'has' : ''}`} role="gridcell" style={bg ? { background: bg } : undefined}
              title={row ? `${report.period}-${String(d).padStart(2, '0')} · ${money(row.profit)} · ${t('persona.calendar.trades', { n: row.trades })}` : undefined}>
              <i>{d}</i>
              {row && <b className="num">{shortMoney(row.profit)}</b>}
            </span>
          )
        })}
      </div>
      <p className="pr-small">{t('persona.calendar.utc')}</p>
    </div>
  )
}

const shortMoney = (v: number) => {
  const a = Math.abs(v)
  const s = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(1)
  return `${v < 0 ? '−' : '+'}${s}`
}

function bucketLabel(t: (k: string, o?: Record<string, unknown>) => string, key: BreakKey, b: PersonaBucket) {
  if (key === 'symbol') return String(b.key)
  if (key === 'weekday') return t(`persona.weekday.${b.key}`)
  return t(`persona.break.${key}.${b.key}`)
}

function Breakdowns({ report }: { report: PersonaReport }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<BreakKey>('symbol')
  const rows = report.breakdowns[tab] ?? []
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.profit)))
  return (
    <div className="pr-card">
      <h3 className="pr-h3">{t('persona.break.title')}</h3>
      <div className="pr-seg is-wide" role="tablist" aria-label={t('persona.break.title')} onKeyDown={onRovingKeyDown}>
        {BREAKS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={k === tab} tabIndex={k === tab ? 0 : -1} className={k === tab ? 'on' : ''} onClick={() => setTab(k)}>
            {t(`persona.break.${k}.tab`)}
          </button>
        ))}
      </div>
      <div className="pr-rows" role="table">
        <div className="pr-row is-head" role="row">
          <span role="columnheader">{t(`persona.break.${tab}.tab`)}</span>
          <span role="columnheader">{t('persona.break.trades')}</span>
          <span role="columnheader">{t('persona.break.winRate')}</span>
          <span role="columnheader">{t('persona.break.profit')}</span>
        </div>
        {rows.length === 0 ? <p className="pr-small">{t('persona.report.empty')}</p> : rows.map((r) => (
          <div key={String(r.key)} className="pr-row" role="row">
            <span role="cell" className="pr-row-k">{bucketLabel(t, tab, r)}</span>
            <span role="cell" className="num">{r.trades}</span>
            <span role="cell" className="num">{pct(r.trades ? r.wins / r.trades : null)}</span>
            <span role="cell" className="pr-row-p">
              <i className={r.profit >= 0 ? 'is-up' : 'is-down'} style={{ width: `${(Math.abs(r.profit) / maxAbs) * 100}%` }} aria-hidden="true" />
              <b className={`num ${tone(r.profit)}`}>{money(r.profit)}</b>
            </span>
          </div>
        ))}
      </div>
      {tab === 'session' && <p className="pr-small">{t('persona.break.session.note')}</p>}
    </div>
  )
}

function TagsPanel({ report }: { report: PersonaReport }) {
  const { t } = useTranslation()
  const [more, setMore] = useState(false)
  const list = more ? report.taggedTrades : report.taggedTrades.slice(0, TAGGED_SHOWN)
  const fmt = useMemo(() => new Intl.DateTimeFormat(LOCALE_TAG[currentLang()], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }), [])
  const listRef = useRef<HTMLUListElement>(null)
  return (
    <div className="pr-card">
      <h3 className="pr-h3">{t('persona.tags.title')}</h3>
      <p className="pr-small">{t('persona.tags.lead')}</p>
      <div className="pr-tags">
        {TAGS.map((k) => {
          const x = report.tags[k] ?? { count: 0, profit: 0 }
          return (
            <div key={k} className={`pr-tag ${x.count ? '' : 'is-zero'}`}>
              <div className="pr-tag-top"><b>{t(`persona.tags.${k}.name`)}</b><span className="num">{x.count}</span></div>
              <p>{t(`persona.tags.${k}.desc`)}</p>
              {x.count > 0 && <span className={`num pr-tag-p ${tone(x.profit)}`}>{money(x.profit)}</span>}
            </div>
          )
        })}
      </div>
      {report.taggedTrades.length > 0 && (
        <>
          <h4 className="pr-h4">{t('persona.tags.trades')}</h4>
          <ul className="pr-trades" ref={listRef}>
            {list.map((x, i) => (
              <li key={`${x.closeAt}-${i}`}>
                <div className="pr-trade-top">
                  <b>{x.symbol}</b>
                  <span className={`pr-side ${x.side === 'BUY' ? 'is-up' : 'is-down'}`}>{x.side === 'BUY' ? t('persona.side.buy') : t('persona.side.sell')}</span>
                  <span className="num pr-dim">{Number(x.volume.toFixed(2))}</span>
                  <span className="num pr-dim">{fmt.format(new Date(x.openAt))}</span>
                  <b className={`num pr-trade-p ${tone(x.profit)}`}>{money(x.profit)}</b>
                </div>
                <div className="pr-trade-tags">
                  {x.unrealized && <span className="pr-mini is-warn">{t('persona.tags.open')}</span>}
                  {x.tags.map((g) => <span key={g} className="pr-mini">{t(`persona.tags.${g}.name`)}</span>)}
                </div>
              </li>
            ))}
          </ul>
          {report.taggedTrades.length > TAGGED_SHOWN && (
            <button type="button" className="pr-link" onClick={() => setMore((v) => !v)}>
              {more ? t('persona.tags.less') : t('persona.tags.more', { n: report.taggedTrades.length - TAGGED_SHOWN })}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 介绍 + 图鉴 / intro + gallery
// 默认收起：怎么算、四个字母的意思、16 种人格都在里面。/ Collapsed by default: how it works,
// what the four letters mean and all 16 personas.
function Intro({ current, style }: { current: string | null; style: ArtStyle }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <section className="pr-sec pr-intro">
      <button type="button" className="pr-intro-toggle" aria-expanded={open} aria-controls="pr-intro-body" onClick={() => setOpen((v) => !v)}>
        <span>{t('persona.intro.title')}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div id="pr-intro-body" className="pr-intro-body">
          <p className="pr-lead">{t('persona.intro.how')}</p>
          <ul className="pr-legend">
            {AXES.map((a) => (
              <li key={a.key}>
                <b>{t(`persona.axes.${a.key}.name`)}</b>
                <span><i>{a.poles[0]}</i> {t(`persona.pole.${a.poles[0]}`)}</span>
                <span><i>{a.poles[1]}</i> {t(`persona.pole.${a.poles[1]}`)}</span>
              </li>
            ))}
          </ul>
          <Gallery current={current} style={style} />
        </div>
      )}
    </section>
  )
}

function Gallery({ current, style }: { current: string | null; style: ArtStyle }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="pr-sec">
      <h3 className="pr-h3">{t('persona.gallery.title')}</h3>
      <p className="pr-small">{t('persona.gallery.lead')}</p>
      <ul className="pr-gal">
        {PERSONA_CODES.map((code) => {
          const fam = familyOf(code)
          const isOpen = open === code
          return (
            <li key={code} className={`pr-gal-i ${code === current ? 'is-me' : ''}`} style={{ '--fam': FAMILY_COLOR[fam].main, '--fam-deep': FAMILY_COLOR[fam].deep } as React.CSSProperties}>
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : code)}>
                <img src={artUrl(code, style)} alt="" width={150} height={172} loading="lazy" />
                <span className="pr-gal-code">{code}</span>
                <b>{t(`persona.types.${code}.title`)}</b>
                {code === current && <span className="pr-gal-me">{t('persona.gallery.me')}</span>}
              </button>
              {isOpen && <p className="pr-gal-say">{t(`persona.types.${code}.say`)}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
