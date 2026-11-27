// 交易报告 + 交易人格（2026-11-22）：「交易」页（OrdersPage）的第五个页签，/persona 转到那里。
// 自上而下：人格舞台（插画 + 称号 + 四个字母 + 点评，下面连着四个主轴）→ 月份切换 → 本月成绩
// （大号净盈亏 + 累计曲线 + 评分表盘 + 一排数字）→ 盈亏日历 + 分类报表 → 每笔单的标签 → 徽章 +
// AI 点评（只在存档月份）→ 「交易人格是怎么算的」（默认收起，里面是 16 种人格）。
// 没下过实盘单：只给「开通实盘」的钩子；下过但不够数：给解锁进度。
// mode="client"（/persona/client）是推荐官看直属客户：邮箱在路由 state 里，没有分享按钮。
// 2026-11-27 补的几块：四个主轴下面的「本月走向」（如果今天结算会是什么人格）、当月还没计入的
// 浮亏、各项数字「比上月」的升降和近几个月的评分走势、标签单 / 最好最差单点了跳到图表上看那一单
// （只在看自己的报告时能点）。这些字段旧存档可能没有，没有就不显示那一块。
// 2026-11-22 视觉重做：动效只有进场一次（滚到才出现、数字滚动、曲线展开），没有常驻动画；
// prefers-reduced-motion 下全部直接显示。
//
// Trading report + persona: the fifth tab of the Orders page (/persona redirects there). Top to
// bottom: persona stage (art, title, four letters, roast, with the four axes attached below), month
// picker, month headline (big net P&L, cumulative curve, score gauge, stat rail), P&L calendar +
// breakdowns, per-trade tags, badges + AI comment (archived months only) and a collapsed "how it
// works" section holding the 16 types. No real orders → a hook to go live; not enough yet → unlock
// progress. mode="client" is an ambassador viewing a direct customer (e-mail in router state, no
// share). Motion is entrance-only (reveal on scroll, count-up, curve wipe); nothing loops, and
// everything shows at once under prefers-reduced-motion.
// Added 2026-11-27: the outlook under the axes (the persona if the month closed today), the floating
// loss not yet counted, month-over-month arrows plus a score trend, and trades (tagged, best, worst)
// that open the chart on that trade — own report only. Older archives may lack these fields; a block
// without its data is simply not rendered.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { personaApi } from '../api/client'
import type { Persona, PersonaBucket, PersonaOutlook, PersonaOverview, PersonaPrevious, PersonaProgress, PersonaReport, PersonaTag, PersonaTradeRef } from '../api/personaTypes'
import { localizeApiError } from '../api/utils'
import { LOCALE_TAG, currentLang } from '../i18n'
import PageHead from '../components/PageHead'
import ShareSheet, { type ShareSpec } from '../components/share/ShareSheet'
import { SkeletonLine } from '../components/Skeleton'
import { AXES, FAMILY_COLOR, PERSONA_CODES, artUrl, familyOf, readArtStyle, writeArtStyle, type ArtStyle } from '../components/persona/personaMeta'
import { focusFromRef } from '../components/charts/trade/focusTrade'
import { onRovingKeyDown } from '../utils/rovingTabs'
import { EMPTY } from '../utils/format'
import '../components/persona/persona.css'

type ClientState = { email?: string; name?: string } | null
type BreakKey = 'symbol' | 'session' | 'weekday' | 'hold' | 'source'
type T = (k: string, o?: Record<string, unknown>) => string
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
const tone = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'is-up' : v < 0 ? 'is-down' : '')
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// ---------------------------------------------------------------- 进场动效 / entrance motion
// 滚到视口里才算「看见」，只触发一次。没有 IntersectionObserver 的环境直接算看见。
// "Seen" once the element scrolls into view; environments without IntersectionObserver count as seen.
function useSeen<E extends Element>(): [React.RefObject<E>, boolean] {
  const ref = useRef<E>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect() }
    }, { rootMargin: '0px 0px -6% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

function Rv({ i = 0, className = '', children }: { i?: number; className?: string; children: React.ReactNode }) {
  const [ref, seen] = useSeen<HTMLDivElement>()
  return (
    <div ref={ref} className={`pr-rv ${seen ? 'is-in' : ''} ${className}`} style={{ '--i': i } as React.CSSProperties}>
      {children}
    </div>
  )
}

// 金额从 0 滚到目标值（约 1 秒，先快后慢）。读屏器直接读最终值。
// Counts a money value up from zero (~1 s, ease-out); screen readers get the final value.
function CountMoney({ value, className = '' }: { value: number; className?: string }) {
  const [ref, seen] = useSeen<HTMLElement>()
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (!seen) return
    if (!Number.isFinite(value) || reducedMotion()) { setShown(value); return }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 1100)
      setShown(p >= 1 ? value : value * (1 - Math.pow(1 - p, 4)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [seen, value])
  return (
    <b ref={ref} className={className} aria-label={money(value)}>
      <span aria-hidden="true">{money(seen ? shown : 0)}</span>
    </b>
  )
}

// 鼠标在舞台上移动时，把位置（-1…1）写进 --tx / --ty，插画和背后的大字母跟着轻微错位。
// 只在有鼠标的设备上开；不走 React 状态。/ Pointer position (-1…1) goes into --tx / --ty so
// the art and the ghost letters shift slightly; mouse devices only, no React state.
function useTilt<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion() || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return
    let raf = 0
    let x = 0
    let y = 0
    const apply = () => {
      raf = 0
      el.style.setProperty('--tx', x.toFixed(3))
      el.style.setProperty('--ty', y.toFixed(3))
    }
    const queue = () => { if (!raf) raf = requestAnimationFrame(apply) }
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      x = ((e.clientX - r.left) / r.width - 0.5) * 2
      y = ((e.clientY - r.top) / r.height - 0.5) * 2
      queue()
    }
    const leave = () => { x = 0; y = 0; queue() }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', leave)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  return ref
}

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
        <div className="pr-slab">
          <div className="pr-stage is-skel"><div className="pr-art-col"><div className="pr-art" /></div><div className="pr-stage-body"><SkeletonLine width="40%" /><SkeletonLine width="70%" /><SkeletonLine width="90%" /></div></div>
        </div>
      </div>
    )
  }

  // 家族色铺到整页：舞台、主轴、评分表盘、徽章都用它。/ The family colour tints the whole page.
  const fam = persona ? FAMILY_COLOR[familyOf(persona.code)] : null
  const famStyle = fam ? ({ '--fam': fam.main, '--fam-deep': fam.deep } as React.CSSProperties) : undefined

  return (
    <div className="pr" style={famStyle}>
      {head}
      {overview.status === 'unlocked' && persona ? (
        <>
          <div className="pr-slab">
            <PersonaStage persona={persona} style={style} onStyle={pickStyle} change={report?.change ?? null}
              onShare={mode === 'self' ? openShare : undefined} sharing={sharing} />
            <Spectrum persona={persona} />
            {overview.report?.outlook && <Outlook persona={persona} outlook={overview.report.outlook} />}
          </div>
          <section className="pr-sec" aria-labelledby="pr-month-h">
            <div className="pr-st-head">
              <div>
                <p className="pr-kicker">{t('persona.report.title')}</p>
                <h2 id="pr-month-h" className="pr-st-month">{period ? monthLabel(period, i18n.language, 'long') : t('persona.report.title')}</h2>
              </div>
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
              <div className="pr-slab pr-month-skel"><SkeletonLine width="30%" /><SkeletonLine width="60%" /><SkeletonLine width="80%" /></div>
            ) : report ? <MonthReport key={report.period} report={report} canOpen={mode === 'self'} /> : null}
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

function intlTag(lang: string) {
  const tag = LOCALE_TAG[currentLang()] ?? lang
  return tag.startsWith('th') ? `${tag}-u-ca-gregory` : tag
}

function monthLabel(period: string, lang: string, month: 'short' | 'long' = 'short') {
  const [y, m] = period.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(intlTag(lang), { year: 'numeric', month, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
  } catch {
    return period
  }
}

function dayLabel(period: string, day: number, lang: string) {
  const [y, m] = period.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(intlTag(lang), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, day)))
  } catch {
    return `${m}-${day}`
  }
}

// ---------------------------------------------------------------- 人格舞台 / persona stage
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

function PersonaStage({ persona, style, onStyle, change, onShare, sharing }: {
  persona: Persona; style: ArtStyle; onStyle: (s: ArtStyle) => void; change: { from: string; to: string } | null
  onShare?: () => void; sharing: boolean
}) {
  const { t } = useTranslation()
  const fam = familyOf(persona.code)
  const tilt = useTilt<HTMLElement>()
  return (
    <section ref={tilt} className={`pr-stage is-${style}`}>
      <span className="pr-ghost" aria-hidden="true">{persona.code}</span>
      <div className="pr-art-col">
        <div className="pr-art">
          <img src={artUrl(persona.code, style)} alt={t(`persona.types.${persona.code}.title`)} width={300} height={345} />
          <span className="pr-glare" aria-hidden="true" />
        </div>
        <ArtSwitch style={style} onStyle={onStyle} />
      </div>
      <div className="pr-stage-body">
        <p className="pr-eyebrow"><span className="pr-dot" aria-hidden="true" />{t(`persona.family.${fam}`)}</p>
        <h2 className="pr-title">{t(`persona.types.${persona.code}.title`)}</h2>
        <ul className="pr-dna" aria-label={persona.code}>
          {AXES.map((a) => {
            const letter = persona.axes[a.key]?.letter ?? a.poles[0]
            return <li key={a.key}><b aria-hidden="true">{letter}</b><span>{t(`persona.pole.${letter}`)}</span></li>
          })}
        </ul>
        <blockquote className="pr-say">{t(`persona.types.${persona.code}.say`)}</blockquote>
        <div className="pr-meta">
          <span className={`pr-pill ${persona.provisional ? 'is-soft' : ''}`}>
            {persona.provisional ? t('persona.provisional', { n: persona.positions, need: 50 }) : t('persona.formal', { n: persona.positions })}
          </span>
          {change && (
            <span className="pr-pill is-soft">{t('persona.changed', { from: t(`persona.types.${change.from}.title`) })}</span>
          )}
        </div>
        <div className="pr-actions">
          {onShare && (
            <button type="button" className="btn-primary pr-btn" onClick={onShare} disabled={sharing}>
              {sharing ? t('share.generating') : t('persona.share.button')}
            </button>
          )}
          <p className="pr-small">{t('persona.window')}</p>
        </div>
      </div>
    </section>
  )
}

// 四个主轴：每格一个大百分比（朝你那个字母偏了多少）+ 一条两端对拉的细条。
// The four axes: a big percentage toward your letter plus a thin tug-of-war bar per cell.
function Spectrum({ persona }: { persona: Persona }) {
  const { t } = useTranslation()
  return (
    <Rv className="pr-spectrum-wrap">
      <h2 className="pr-sr">{t('persona.axes.title')}</h2>
      <div className="pr-spectrum">
        {AXES.map((a, i) => {
          const ax = persona.axes[a.key]
          const v = Math.max(0, Math.min(100, ax?.value ?? 50))
          const right = v >= 50
          const letter = ax?.letter ?? (right ? a.poles[1] : a.poles[0])
          const toward = Math.round(letter === a.poles[1] ? v : 100 - v)
          return (
            <div key={a.key} className="pr-ax" style={{ '--i': i } as React.CSSProperties}>
              <span className="pr-ax-name">{t(`persona.axes.${a.key}.name`)}</span>
              <div className="pr-ax-val">
                <b className="pr-ax-pct">{toward}<small>%</small></b>
                <span className="pr-ax-word">{t(`persona.pole.${letter}`)}</span>
              </div>
              <div className="pr-track" role="img" aria-label={`${t(`persona.pole.${a.poles[0]}`)} ${100 - Math.round(v)} / ${t(`persona.pole.${a.poles[1]}`)} ${Math.round(v)}`}>
                <span className="pr-mid" aria-hidden="true" />
                <span className={`pr-fill ${right ? 'is-right' : 'is-left'}`} style={{ left: `${right ? 50 : v}%`, width: `${Math.max(Math.abs(v - 50), 1.5)}%` }} />
                <span className="pr-knob" style={{ left: `${v}%` }} />
              </div>
              <div className="pr-poles" aria-hidden="true">
                <span className={!right ? 'on' : ''}>{t(`persona.pole.${a.poles[0]}`)}</span>
                <span className={right ? 'on' : ''}>{t(`persona.pole.${a.poles[1]}`)}</span>
              </div>
              <p className="pr-ax-fact">{axisFact(t, a.key, ax)}</p>
              <p className="pr-ax-help">{t(`persona.axes.${a.key}.help`)}</p>
            </div>
          )
        })}
      </div>
    </Rv>
  )
}

function axisFact(t: T, key: string, ax: Persona['axes'][keyof Persona['axes']] | undefined) {
  if (!ax) return ''
  if (key === 'judge') return t('persona.axes.judge.fact', { p: pct(ax.share) })
  if (key === 'risk') return t('persona.axes.risk.fact', { r: num(ax.holdRatio, 1), p: num(ax.payoff, 2) })
  if (key === 'tempo') return t('persona.axes.tempo.fact', { m: num(ax.medianHoldMin, 1), n: num(ax.perDay, 1) })
  return t('persona.axes.manage.fact', { p: pct(ax.share) })
}

// 本月走向：正式人格每月 1 号才换，这里按「此刻的最近 90 天」先算一遍（后端和月底存档同一个算法），
// 告诉用户照这样下去下个月会是什么，以及每条轴比现在的人格挪了多少。
// Outlook: the official persona only changes on the 1st; this previews it over the last 90 days as of
// now (same maths as the month-end archive) and shows how far each axis has moved since.
function Outlook({ persona, outlook }: { persona: Persona; outlook: PersonaOutlook }) {
  const { t } = useTranslation()
  return (
    <Rv className="pr-outlook">
      <div className="pr-outlook-head">
        <p className="pr-kicker">{t('persona.outlook.title')}</p>
        <p className={`pr-outlook-say ${outlook.changed ? 'is-changed' : ''}`}>
          {outlook.changed
            ? t('persona.outlook.changed', { from: t(`persona.types.${outlook.from}.title`), to: t(`persona.types.${outlook.code}.title`) })
            : t('persona.outlook.same', { name: t(`persona.types.${outlook.code}.title`) })}
        </p>
      </div>
      <ul className="pr-outlook-axes">
        {AXES.map((a) => {
          const now = outlook.axes[a.key]
          const was = persona.axes[a.key]
          if (!now) return null
          const flipped = !!was && was.letter !== now.letter
          const d = was ? Math.round(now.value - was.value) : 0
          return (
            <li key={a.key} className={flipped ? 'is-flip' : ''}>
              <span className="pr-outlook-name">{t(`persona.axes.${a.key}.name`)}</span>
              <b>
                {flipped
                  ? t('persona.outlook.flip', { from: t(`persona.pole.${was.letter}`), to: t(`persona.pole.${now.letter}`) })
                  : d === 0
                    ? t('persona.outlook.still')
                    : t('persona.outlook.drift', { pole: t(`persona.pole.${d > 0 ? a.poles[1] : a.poles[0]}`), n: Math.abs(d) })}
              </b>
            </li>
          )
        })}
      </ul>
      <p className="pr-small">{t('persona.outlook.note')}</p>
    </Rv>
  )
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
    <section className="pr-slab pr-hook">
      <span className="pr-ghost" aria-hidden="true">????</span>
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
    <section className="pr-slab pr-hook">
      <span className="pr-ghost" aria-hidden="true">????</span>
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
// 「比上月」的升降。good：这项变大是好事（胜率、盈亏比、评分）、坏事（回撤），还是无所谓（持仓时间、笔数）。
// 进行中的月份不比净盈亏和笔数——拿半个月和一整月比没有意义。
// Month-over-month delta. `good` says whether a rise is good (win rate, payoff, score), bad (drawdown)
// or neutral (holding time, trade count). A live month skips net P&L and trade count: half a month
// against a whole one says nothing.
type DeltaKind = 'winRate' | 'payoff' | 'score' | 'drawdown' | 'hold' | 'profit' | 'trades'
function deltaOf(kind: DeltaKind, report: PersonaReport, t: T): { text: string; cls: string } | null {
  const prev: PersonaPrevious | null | undefined = report.previous
  if (!prev) return null
  if (report.live && (kind === 'profit' || kind === 'trades')) return null
  const s = report.summary
  const pair: Record<DeltaKind, [number | null, number | null, 1 | -1 | 0]> = {
    winRate: [s.winRate, prev.winRate, 1],
    payoff: [s.payoff, prev.payoff, 1],
    score: [s.score, prev.score, 1],
    drawdown: [s.maxDrawdown, prev.maxDrawdown, -1],
    hold: [s.medianHoldMin, prev.medianHoldMin, 0],
    profit: [s.profit, prev.profit, 1],
    trades: [s.trades, prev.trades, 0],
  }
  const [cur, was, good] = pair[kind]
  if (cur == null || was == null || !Number.isFinite(cur) || !Number.isFinite(was)) return null
  const d = cur - was
  const abs = Math.abs(d)
  const text = kind === 'winRate' ? `${(abs * 100).toFixed(0)}%`
    : kind === 'payoff' ? abs.toFixed(2)
      : kind === 'score' || kind === 'trades' ? String(Math.round(abs))
        : kind === 'hold' ? fmtMinutes(t, abs)
          : money(abs, false)
  const flat = kind === 'winRate' ? abs < 0.005 : kind === 'payoff' ? abs < 0.005 : kind === 'hold' ? abs < 0.5 : abs < 0.5
  if (flat) return { text: '—', cls: 'is-flat' }
  const cls = good === 0 ? 'is-flat' : (d > 0) === (good > 0) ? 'is-up' : 'is-down'
  return { text: `${d > 0 ? '▲' : '▼'} ${text}`, cls }
}

function Delta({ kind, report, label = false }: { kind: DeltaKind; report: PersonaReport; label?: boolean }) {
  const { t, i18n } = useTranslation()
  const d = deltaOf(kind, report, t)
  if (!d || !report.previous) return null
  const vs = t('persona.compare.vs', { month: monthLabel(report.previous.period, i18n.language) })
  return (
    <small className={`pr-delta num ${d.cls} ${label ? 'has-label' : ''}`} title={vs}>
      {label && <span>{t('persona.compare.short')}</span>}{d.text}
    </small>
  )
}

// 近几个月的综合评分：一条折线，每个月一个点，两头标月份。少于两个月不画。
// Score across recent months: one line, a dot per month, the first and last month labelled.
function ScoreTrend({ report }: { report: PersonaReport }) {
  const { t, i18n } = useTranslation()
  const trend = report.trend ?? []
  if (trend.length < 2) return null
  const X = (i: number) => 4 + (i / (trend.length - 1)) * 92
  const Y = (v: number) => 26 - (Math.max(0, Math.min(100, v)) / 100) * 22
  const line = trend.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.score).toFixed(1)}`).join(' ')
  const label = trend.map((p) => `${monthLabel(p.period, i18n.language)} ${p.score}`).join(', ')
  return (
    <figure className="pr-trend" role="img" aria-label={`${t('persona.compare.trend')}: ${label}`}>
      <figcaption><span>{t('persona.compare.trend')}</span><Delta kind="score" report={report} /></figcaption>
      <div className="pr-trend-plot">
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
          <path d={line} />
        </svg>
        {trend.map((p, i) => (
          <span key={p.period} className={`pr-trend-dot ${i === trend.length - 1 ? 'is-now' : ''}`}
            style={{ left: `${X(i)}%`, top: `${(Y(p.score) / 30) * 100}%` }} title={`${monthLabel(p.period, i18n.language)} · ${p.score}`} />
        ))}
      </div>
      <div className="pr-trend-x" aria-hidden="true">
        <span>{monthLabel(trend[0].period, i18n.language)} · {trend[0].score}</span>
        <span>{monthLabel(trend[trend.length - 1].period, i18n.language)} · {trend[trend.length - 1].score}</span>
      </div>
    </figure>
  )
}

// 一笔单 → 「在图表上看」的链接（路由 state 带过去，不进网址）。读不出开仓时间就不给链接。
// A trade → the "view on chart" link (carried in router state, not the URL); none without an open time.
function TradeLink({ trade, className, children }: { trade: PersonaTradeRef | null | undefined; className?: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (!trade) return <>{children}</>
  const open = () => {
    const focusTrade = focusFromRef(trade)
    if (focusTrade) navigate('/charts', { state: { focusTrade } })
  }
  return (
    <button type="button" className={`pr-tradelink ${className ?? ''}`} onClick={open} title={t('persona.tags.onChart')} aria-label={`${trade.symbol} ${money(trade.profit)} · ${t('persona.tags.onChart')}`}>
      {children}
    </button>
  )
}

function MonthReport({ report, canOpen }: { report: PersonaReport; canOpen: boolean }) {
  const { t, i18n } = useTranslation()
  const s = report.summary
  const lang = (i18n.language || 'zh').slice(0, 2) as 'zh' | 'en' | 'ja' | 'th' | 'vi'
  const comment = report.comment ? (report.comment[lang] || report.comment.en || report.comment.zh) : null
  if (!s.trades) {
    return <div className="pr-slab pr-empty">{t('persona.report.empty')}</div>
  }
  const facts: { k: string; v: string; cls?: string; delta?: DeltaKind }[] = [
    { k: 'avgWin', v: money(s.avgWin), cls: tone(s.avgWin) },
    { k: 'avgLoss', v: money(s.avgLoss == null ? null : -Math.abs(s.avgLoss)), cls: s.avgLoss ? 'is-down' : '' },
    { k: 'drawdown', v: money(-s.maxDrawdown, false), cls: s.maxDrawdown > 0 ? 'is-down' : '', delta: 'drawdown' },
  ]
  const rail: { k: string; v: string; cls?: string; delta?: DeltaKind; trade?: PersonaTradeRef | null }[] = [
    { k: 'trades', v: String(s.trades), delta: 'trades' },
    { k: 'payoff', v: num(s.payoff, 2), delta: 'payoff' },
    { k: 'days', v: t('persona.report.daysValue', { g: s.greenDays, n: s.tradingDays }) },
    { k: 'hold', v: s.medianHoldMin == null ? EMPTY : fmtMinutes(t, s.medianHoldMin), delta: 'hold' },
    { k: 'best', v: money(s.best), cls: tone(s.best), trade: canOpen ? report.bestTrade : null },
    { k: 'worst', v: money(s.worst), cls: tone(s.worst), trade: canOpen ? report.worstTrade : null },
  ]
  const prevMonth = report.previous ? monthLabel(report.previous.period, i18n.language) : null
  const winShare = s.wins + s.losses ? s.wins / (s.wins + s.losses) : 0
  return (
    <div className="pr-month">
      {report.live && <p className="pr-live"><span className="pr-live-dot" aria-hidden="true" />{t('persona.report.live')}</p>}

      <Rv className={`pr-slab pr-headline ${s.profit > 0 ? 'tone-up' : s.profit < 0 ? 'tone-down' : ''}`}>
        <div className="pr-pnl">
          <span className="pr-k">{t('persona.report.stat.profit')}</span>
          <CountMoney value={s.profit} className={`pr-pnl-num ${tone(s.profit)}`} />
          <Delta kind="profit" report={report} label />
          <dl className="pr-facts">
            {facts.map((x) => (
              <div key={x.k}><dt>{t(`persona.report.stat.${x.k}`)}</dt><dd className={`num ${x.cls ?? ''}`}>{x.v}{x.delta && <Delta kind={x.delta} report={report} />}</dd></div>
            ))}
          </dl>
          <Curve report={report} />
        </div>
        <div className="pr-score">
          <ScoreRing score={s.score} label={t('persona.report.stat.score')} />
          <div className="pr-wl">
            <div className="pr-wl-top">
              <span>{t('persona.report.stat.winRate')}</span>
              <b className="num">{pct(s.winRate)}<Delta kind="winRate" report={report} /></b>
            </div>
            <div className="pr-wl-bar" aria-hidden="true">
              <i className="is-win" style={{ flexGrow: Math.max(winShare, 0.02) }} />
              <i className="is-loss" style={{ flexGrow: Math.max(1 - winShare, 0.02) }} />
            </div>
            <p className="pr-wl-sub">{t('persona.report.wl', { w: s.wins, l: s.losses })}</p>
            <ScoreTrend report={report} />
          </div>
        </div>
        <dl className="pr-rail">
          {rail.map((x) => (
            <div key={x.k}>
              <dt>{t(`persona.report.stat.${x.k}`)}</dt>
              <dd className={`num ${x.cls ?? ''}`}>
                <TradeLink trade={x.trade}>{x.v}</TradeLink>
                {x.delta && <Delta kind={x.delta} report={report} />}
              </dd>
            </div>
          ))}
        </dl>
      </Rv>
      {prevMonth && <p className="pr-small">{t(report.live ? 'persona.compare.noteLive' : 'persona.compare.note', { month: prevMonth })}</p>}
      {report.floating && report.floating.count > 0 && (
        <p className="pr-floating" role="status">
          <span className="pr-floating-dot" aria-hidden="true" />
          {t('persona.report.floating', { loss: money(report.floating.loss), n: report.floating.count })}
        </p>
      )}
      {report.openLosers > 0 && <p className="pr-small">{t('persona.report.openLosers', { n: report.openLosers })}</p>}

      <div className="pr-grid2">
        <Rv className="pr-panel"><Calendar report={report} /></Rv>
        <Rv className="pr-panel" i={1}><Breakdowns report={report} /></Rv>
      </div>

      <Rv className="pr-panel"><TagsPanel report={report} canOpen={canOpen} /></Rv>

      <div className={report.badges.length > 0 ? 'pr-grid2' : 'pr-grid1'}>
        {report.badges.length > 0 && (
          <Rv className="pr-panel">
            <h3 className="pr-h3">{t('persona.badges.title')}</h3>
            <ul className="pr-badges">
              {report.badges.map((b) => (
                <li key={b}><b>{t(`persona.badges.${b}.name`)}</b><span>{t(`persona.badges.${b}.desc`)}</span></li>
              ))}
            </ul>
          </Rv>
        )}
        <Rv className="pr-panel pr-comment" i={1}>
          <h3 className="pr-h3">{t('persona.comment.title')}</h3>
          {comment ? <blockquote>{comment}</blockquote> : <p className="pr-small">{t(report.live ? 'persona.comment.pending' : 'persona.comment.none')}</p>}
        </Rv>
      </div>
    </div>
  )
}

function fmtMinutes(t: T, m: number) {
  if (m < 1) return t('persona.unit.sec', { n: Math.max(1, Math.round(m * 60)) })
  if (m < 90) return t('persona.unit.min', { n: Math.round(m) })
  return t('persona.unit.hour', { n: (m / 60).toFixed(1) })
}

// 当月累计盈亏曲线：按 UTC 日把每天的已平仓盈亏累加，进行中的月份只画到今天。
// Cumulative P&L of the month by UTC day (closed trades); a live month stops at today.
function Curve({ report }: { report: PersonaReport }) {
  const { t } = useTranslation()
  const gid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const model = useMemo(() => {
    const [y, m] = report.period.split('-').map(Number)
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const asOf = new Date(report.asOf)
    const sameMonth = report.live && asOf.getUTCFullYear() === y && asOf.getUTCMonth() === m - 1
    const last = sameMonth ? Math.max(1, asOf.getUTCDate()) : days
    const byDay = new Map(report.calendar.map((d) => [Number(d.day.slice(8, 10)), d.profit]))
    const pts: [number, number][] = [[0, 0]]
    let cum = 0
    for (let d = 1; d <= last; d++) {
      cum += byDay.get(d) ?? 0
      pts.push([d / days, cum])
    }
    const lo = Math.min(...pts.map((p) => p[1]))
    const hi = Math.max(...pts.map((p) => p[1]))
    const span = hi - lo || 1
    const Y = (v: number) => 5 + (1 - (v - lo) / span) * 30
    const line = pts.map(([f, v], i) => `${i ? 'L' : 'M'}${(f * 100).toFixed(2)} ${Y(v).toFixed(2)}`).join(' ')
    const endX = pts[pts.length - 1][0] * 100
    const y0 = Y(0)
    return { line, area: `${line} L${endX.toFixed(2)} ${y0.toFixed(2)} L0 ${y0.toFixed(2)} Z`, y0, yTop: Y(hi), yBottom: Y(lo), endX, endY: Y(cum), up: cum >= 0, days }
  }, [report])
  const stroke = model.up ? 'rgb(var(--up-rgb))' : 'rgb(var(--down-rgb))'
  return (
    <figure className="pr-curve" role="img" aria-label={t('persona.report.curve')}>
      <figcaption>{t('persona.report.curve')}</figcaption>
      <div className="pr-curve-plot">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={model.up ? model.yTop : model.y0} y2={model.up ? model.y0 : model.yBottom}>
              <stop offset="0" stopColor={stroke} stopOpacity={model.up ? 0.34 : 0} />
              <stop offset="1" stopColor={stroke} stopOpacity={model.up ? 0 : 0.34} />
            </linearGradient>
          </defs>
          <line className="pr-curve-zero" x1="0" x2="100" y1={model.y0} y2={model.y0} />
          <path d={model.area} fill={`url(#${gid})`} />
          <path className="pr-curve-line" d={model.line} stroke={stroke} />
        </svg>
        <span className="pr-curve-dot" style={{ left: `${model.endX}%`, top: `${(model.endY / 40) * 100}%`, background: stroke }} />
      </div>
      <div className="pr-curve-x" aria-hidden="true"><span>1</span><span>{Math.round(model.days / 2)}</span><span>{model.days}</span></div>
    </figure>
  )
}

// 综合评分表盘：四分之三圈，进场时从 0 转到分数。/ Three-quarter gauge that sweeps to the score.
function ScoreRing({ score, label }: { score: number | null; label: string }) {
  const R = 52
  const C = 2 * Math.PI * R
  const ARC = 0.75 * C
  const len = score == null ? 0 : (ARC * Math.max(0, Math.min(100, score))) / 100
  return (
    <div className="pr-ring" role="img" aria-label={`${label} ${score ?? EMPTY} / 100`}
      style={{ '--c': C.toFixed(1), '--len': len.toFixed(1) } as React.CSSProperties}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle className="pr-ring-track" cx="60" cy="60" r={R} strokeDasharray={`${ARC.toFixed(1)} ${C.toFixed(1)}`} />
        <circle className="pr-ring-arc" cx="60" cy="60" r={R} />
      </svg>
      <div className="pr-ring-num" aria-hidden="true">
        <b>{score ?? EMPTY}</b>
        <span>/ 100</span>
      </div>
      <span className="pr-ring-label" aria-hidden="true">{label}</span>
    </div>
  )
}

function Calendar({ report }: { report: PersonaReport }) {
  const { t, i18n } = useTranslation()
  const [y, m] = report.period.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7 // 周一开头 / Monday first
  const byDay = new Map(report.calendar.map((d) => [Number(d.day.slice(8, 10)), d]))
  const maxAbs = Math.max(1, ...report.calendar.map((d) => Math.abs(d.profit)))
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  while (cells.length % 7) cells.push(null)
  const sorted = [...report.calendar].sort((a, b) => b.profit - a.profit)
  const bestDay = sorted.length && sorted[0].profit > 0 ? sorted[0] : null
  const worstDay = sorted.length && sorted[sorted.length - 1].profit < 0 ? sorted[sorted.length - 1] : null
  return (
    <>
      <h3 className="pr-h3">{t('persona.calendar.title')}</h3>
      <div className="pr-cal" role="grid" aria-label={t('persona.calendar.title')}>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => <span key={`h${i}`} className="pr-cal-h" role="columnheader">{t(`persona.weekday.${i}`)}</span>)}
        {cells.map((d, i) => {
          if (d == null) return <span key={i} className="pr-cal-c is-blank" role="gridcell" />
          const row = byDay.get(d)
          const a = row ? Math.min(1, Math.abs(row.profit) / maxAbs) : 0
          const rgb = row ? (row.profit >= 0 ? 'var(--up-rgb)' : 'var(--down-rgb)') : ''
          return (
            <span key={i} className={`pr-cal-c ${row ? 'has' : ''}`} role="gridcell"
              style={row ? ({ background: `rgb(${rgb} / ${(0.14 + a * 0.5).toFixed(3)})`, '--cell': rgb } as React.CSSProperties) : undefined}
              title={row ? `${report.period}-${String(d).padStart(2, '0')} · ${money(row.profit)} · ${t('persona.calendar.trades', { n: row.trades })}` : undefined}>
              <i>{d}</i>
              {row && <b className="num">{shortMoney(row.profit)}</b>}
            </span>
          )
        })}
      </div>
      {(bestDay || worstDay) && (
        <dl className="pr-cal-peaks">
          {bestDay && (
            <div><dt>{t('persona.calendar.bestDay')}</dt><dd><b className="num is-up">{money(bestDay.profit)}</b><span>{dayLabel(report.period, Number(bestDay.day.slice(8, 10)), i18n.language)}</span></dd></div>
          )}
          {worstDay && (
            <div><dt>{t('persona.calendar.worstDay')}</dt><dd><b className="num is-down">{money(worstDay.profit)}</b><span>{dayLabel(report.period, Number(worstDay.day.slice(8, 10)), i18n.language)}</span></dd></div>
          )}
        </dl>
      )}
      <p className="pr-small">{t('persona.calendar.utc')}</p>
    </>
  )
}

const shortMoney = (v: number) => {
  const a = Math.abs(v)
  const s = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a.toFixed(1)
  return `${v < 0 ? '−' : '+'}${s}`
}

function bucketLabel(t: T, key: BreakKey, b: PersonaBucket) {
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
    <>
      <h3 className="pr-h3">{t('persona.break.title')}</h3>
      <div className="pr-tabs" role="tablist" aria-label={t('persona.break.title')} onKeyDown={onRovingKeyDown}>
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
          <div key={`${tab}-${String(r.key)}`} className="pr-row" role="row">
            <span role="cell" className="pr-row-k">{bucketLabel(t, tab, r)}</span>
            <span role="cell" className="num">{r.trades}</span>
            <span role="cell" className="num">{pct(r.trades ? r.wins / r.trades : null)}</span>
            <span role="cell" className="pr-row-p">
              {/* 以中线为零：盈利往右、亏损往左。/ Zero in the middle: profit grows right, loss left. */}
              <span className="pr-div" aria-hidden="true">
                <i className={r.profit >= 0 ? 'is-up' : 'is-down'} style={{ width: `${(Math.abs(r.profit) / maxAbs) * 50}%` }} />
              </span>
              <b className={`num ${tone(r.profit)}`}>{money(r.profit)}</b>
            </span>
          </div>
        ))}
      </div>
      {tab === 'session' && <p className="pr-small">{t('persona.break.session.note')}</p>}
    </>
  )
}

function TagsPanel({ report, canOpen }: { report: PersonaReport; canOpen: boolean }) {
  const { t } = useTranslation()
  const [more, setMore] = useState(false)
  const list = more ? report.taggedTrades : report.taggedTrades.slice(0, TAGGED_SHOWN)
  const fmt = useMemo(() => new Intl.DateTimeFormat(LOCALE_TAG[currentLang()], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }), [])
  return (
    <>
      <div className="pr-panel-head">
        <h3 className="pr-h3">{t('persona.tags.title')}</h3>
        <p className="pr-small">{t('persona.tags.lead')}{canOpen && report.taggedTrades.length > 0 ? ` ${t('persona.tags.tapHint')}` : ''}</p>
      </div>
      <div className="pr-tags">
        {TAGS.map((k) => {
          const x = report.tags[k] ?? { count: 0, profit: 0 }
          return (
            <div key={k} className={`pr-tag ${x.count ? '' : 'is-zero'}`}>
              <span className="pr-tag-n">{x.count}</span>
              <div className="pr-tag-body">
                <b>{t(`persona.tags.${k}.name`)}</b>
                <p>{t(`persona.tags.${k}.desc`)}</p>
                {x.count > 0 && <span className={`num pr-tag-p ${tone(x.profit)}`}>{money(x.profit)}</span>}
              </div>
            </div>
          )
        })}
      </div>
      {report.taggedTrades.length > 0 && (
        <>
          <h4 className="pr-h4">{t('persona.tags.trades')}</h4>
          <ul className="pr-trades">
            {list.map((x, i) => (
              <li key={`${x.closeAt}-${i}`}>
                <div className="pr-trade-top">
                  <b>{x.symbol}</b>
                  <span className={`pr-side ${x.side === 'BUY' ? 'is-up' : 'is-down'}`}>{x.side === 'BUY' ? t('persona.side.buy') : t('persona.side.sell')}</span>
                  <span className="num pr-dim">{Number(x.volume.toFixed(2))}</span>
                  <span className="num pr-dim">{fmt.format(new Date(x.openAt))}</span>
                  <b className={`num pr-trade-p ${tone(x.profit)}`}>{money(x.profit)}</b>
                  {canOpen && (
                    <TradeLink trade={x} className="pr-trade-go">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                    </TradeLink>
                  )}
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
    </>
  )
}

// ---------------------------------------------------------------- 介绍 + 图鉴 / intro + gallery
// 默认收起：怎么算、四个字母的意思、16 种人格都在里面。/ Collapsed by default: how it works,
// what the four letters mean and all 16 personas.
function Intro({ current, style }: { current: string | null; style: ArtStyle }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <section className="pr-intro">
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
