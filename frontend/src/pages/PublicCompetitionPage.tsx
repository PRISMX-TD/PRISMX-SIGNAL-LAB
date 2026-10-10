// 公开比赛页（设计 2026-10-08 §3.1/§4）：/c（主推比赛）与 /c/:compId，Protected 之外。
// · 已登录访客 → 直接去站内比赛页（/competitions?c=<id>）；/c 先取主推 id。
// · 未登录：轻量公开页头（logo、5 语切换、登录/注册）、「模拟账户比赛·虚拟资金」标、
//   倒计时/状态、奖品、参赛人数、规则（只算经 Signal Lab 下的单、资金门槛、报名前别交易）、
//   匿名化榜单、风险提示、法务页脚，以及按报名状态变化的 CTA。
// · 数据只走 api/publicCompetition（裸 fetch，不带 token）；名字是纯文本，不链到 /u/:id；
//   不 import useLive / Layout / ProfileLink——那些要登录态，也会把站内依赖拖进本 chunk。
// · 进行中且页面可见时每 60 秒刷新；404 → 不存在或未公开；429/5xx/断网 → 保留旧数据并提示稍后刷新。
// · 语言：?lang= → 浏览器语言 → en，用 syncLanguage（不写偏好）；切换只改 URL 的 ?lang=。
// Public competition page (spec §3.1/§4): /c (featured) and /c/:compId, outside Protected.
// Signed-in visitors go straight to /competitions?c=<id>. Logged out: light header (logo,
// 5-language switch, sign in/up), a "demo account · virtual funds" badge, clock/status,
// prize, participants, rules, an anonymised board, risk copy, legal footer and a CTA that
// follows the registration state. Data only via api/publicCompetition (bare fetch, no
// token); names are plain text; no useLive / Layout / ProfileLink. Polls every 60s while
// running and visible; 404 → not found; 429/5xx/network → keep data, "refresh later".
// Language: ?lang= → browser → en via syncLanguage (never persisted); switching edits ?lang=.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAuth } from '../store/auth'
import { syncLanguage, type AppLang } from '../i18n'
import { localePath } from '../seo/meta'
import { API_BASE, readRef, readRefs } from '../api/client'
import { publicCompetitionApi } from '../api/publicCompetition'
import type { PublicCompetition } from '../api/types'
import { fmtDate, fmtUsd } from '../api/utils'
import { useNowTicker } from '../utils/competitionTime'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import { storeCompIntent } from '../utils/compIntent'
import { competitionOpenAccountUrl, publicOpenAccountHref } from '../utils/openAccountLink'
import { isInAppBrowser } from '../utils/inAppBrowser'
import { browserLangs, legalLang, pickPublicLang } from '../utils/publicLang'
import { classifyPublicError, publicCta, publicLadderRows, shouldSendView, type PublicLoadError } from '../utils/publicCompetition'
import { fundsRule } from '../utils/compPrep'
import Logo from '../components/Logo'
import LanguageMenu from '../components/LanguageMenu'
import { SkeletonPage } from '../components/Skeleton'
import Ladder from '../components/competition/Ladder'
import StatusLine from '../components/competition/StatusLine'
import CompClock from '../components/competition/CompClockView'
import CompFacts from '../components/competition/CompFacts'
import CompetitionDesc from '../components/competition/CompetitionDesc'
import { statusTagKey } from '../components/competition/compClock'

const POLL_MS = 60_000
const refOrUndef = () => readRef() ?? undefined

// 语言跟着 URL 的 ?lang= 走（没有就按浏览器）；切换 = 改 ?lang=（replace，不进历史）。
// 只调 syncLanguage，绝不 setLanguage/setPref：访客的偏好由注册成功那一刻（Part D）决定。
// Language follows ?lang= (else the browser); switching rewrites ?lang= (replace). Only
// syncLanguage — never setLanguage / setPref; Part D persists it at signup.
function usePublicCompLang(enabled: boolean): [AppLang, (l: AppLang) => void] {
  const [params, setParams] = useSearchParams()
  const lang = pickPublicLang(params.toString(), browserLangs())
  useEffect(() => {
    if (enabled) void syncLanguage(lang)
  }, [enabled, lang])
  const choose = useCallback(
    (next: AppLang) => {
      setParams(
        (prev) => {
          const q = new URLSearchParams(prev)
          q.set('lang', next)
          return q
        },
        { replace: true },
      )
    },
    [setParams],
  )
  return [lang, choose]
}

export default function PublicCompetitionPage() {
  // 手改的链接可能是大写 UUID：统一小写再取数 / 打点 / 记意图（库里与缓存键都是小写）。
  // Hand-edited links may carry an uppercase UUID: lowercase before fetching / events / intent.
  const compId = useParams<{ compId?: string }>().compId?.toLowerCase()
  const { isAuthed } = useAuth()
  const [lang, chooseLang] = usePublicCompLang(!isAuthed)
  if (isAuthed) {
    return compId
      ? <Navigate to={`/competitions?c=${encodeURIComponent(compId)}`} replace />
      : <FeaturedRedirect authed />
  }
  return (
    <PublicFrame lang={lang} onLang={chooseLang} compId={compId ?? null}>
      {compId ? <CompetitionView key={compId} compId={compId} /> : <FeaturedRedirect authed={false} />}
    </PublicFrame>
  )
}

function Notice({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
      <p className="card glass max-w-md p-6 text-sm text-neutral-400">{text}</p>
      {children}
    </div>
  )
}

// /c：取主推比赛 id，跳到 /c/<id>（保留 ?ref= 与 ?lang=，CompIntentCapture 在那里记录意图）；
// 已登录则直接进站内比赛页。
// /c: fetch the featured id and go to /c/<id> (keeping ?ref= and ?lang=; CompIntentCapture
// records the intent there); signed-in visitors go straight to the in-app page.
function FeaturedRedirect({ authed }: { authed: boolean }) {
  const { t } = useTranslation()
  const { search } = useLocation()
  const [state, setState] = useState<{ id: string | null } | 'loading' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setState('loading')
    publicCompetitionApi.featured().then(
      (r) => {
        if (alive) setState({ id: typeof r?.id === 'string' && r.id ? r.id : null })
      },
      () => {
        if (alive) setState('error')
      },
    )
    return () => {
      alive = false
    }
  }, [attempt])

  if (state === 'loading') return authed ? null : <SkeletonPage cards={2} />
  if (authed) {
    const to = state !== 'error' && state.id ? `/competitions?c=${encodeURIComponent(state.id)}` : '/competitions'
    return <Navigate to={to} replace />
  }
  if (state === 'error') {
    return (
      <Notice text={t('competition.pub.loadError')}>
        <button type="button" className="cmp-btn-ghost" onClick={() => setAttempt((n) => n + 1)}>{t('competition.pub.retry')}</button>
      </Notice>
    )
  }
  if (!state.id) {
    return (
      <Notice text={t('competition.pub.noFeatured')}>
        <Link to="/" className="cmp-btn-ghost">{t('competition.pub.notFoundHome')}</Link>
      </Notice>
    )
  }
  // Part D 约定：/c 的意图由本页在拿到 id 后自己记（未登录才会走到这里）。
  // Part D contract: for /c the page stores the intent itself once the id is known (logged out here).
  storeCompIntent(state.id)
  return <Navigate to={`/c/${encodeURIComponent(state.id)}${search}`} replace />
}

function PublicFrame({ lang, onLang, compId, children }: {
  lang: AppLang
  onLang: (l: AppLang) => void
  compId: string | null
  children: ReactNode
}) {
  const { t } = useTranslation()
  const inApp = isInAppBrowser()
  const legal = legalLang(lang)
  const onRegister = () => {
    if (compId) storeCompIntent(compId)
  }
  return (
    <div className="min-h-screen bg-ink-950 text-neutral-200">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.07] bg-ink-950/85 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1100px] items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-2.5">
            <Logo size={28} />
            <span className="hidden font-display text-[15px] font-bold tracking-tight text-white sm:inline">Signal Lab</span>
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <LanguageMenu value={lang} onChoose={onLang} />
            <Link to="/login" className="px-1.5 text-[13px] text-neutral-400 transition-colors hover:text-white">
              {t('landing.signIn')}
            </Link>
            <Link to="/login?mode=register" onClick={onRegister} className="btn btn-primary h-9 px-3.5 text-[13px]">
              {t('competition.pub.signUp')}
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1100px] px-4 pb-14 pt-[calc(5.5rem+env(safe-area-inset-top))] sm:px-6">
        {inApp && <p className="pcp-inapp" role="note">{t('competition.pub.inAppHint')}</p>}
        {children}
      </main>
      <footer className="border-t border-white/[0.07]">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-3 px-4 py-8 text-[12px] text-neutral-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <nav className="flex flex-wrap gap-x-5 gap-y-2">
            {(['terms', 'privacy', 'risk'] as const).map((d) => (
              <Link key={d} to={localePath(legal, `/${d}`)} className="transition-colors hover:text-white">
                {t(`legal.${d}.title`)}
              </Link>
            ))}
          </nav>
          <p>© {new Date().getFullYear()} PRISMX · {t('landing.footerRights')}</p>
        </div>
      </footer>
    </div>
  )
}

function CompetitionView({ compId }: { compId: string }) {
  const { t } = useTranslation()
  const nowMs = useNowTicker()
  const [data, setData] = useState<PublicCompetition | null>(null)
  const [error, setError] = useState<PublicLoadError | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    publicCompetitionApi
      .detail(compId)
      .then(
        (d) => {
          if (!alive) return
          setData(d)
          setError(null)
        },
        (e) => {
          if (alive) setError(classifyPublicError(e))
        },
      )
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [compId, attempt])

  // 只在进行中、页面可见时轮询（usePollWhileVisible：后台暂停、回前台立即补一次）。
  // Poll only while running and visible (usePollWhileVisible pauses in the background and catches up on return).
  usePollWhileVisible(
    (isCurrent) => {
      publicCompetitionApi.detail(compId).then(
        (d) => {
          if (!isCurrent()) return
          setData(d)
          setError(null)
        },
        (e) => {
          if (isCurrent()) setError(classifyPublicError(e))
        },
      )
    },
    POLL_MS,
    [compId],
    { enabled: data?.status === 'running', immediate: false },
  )

  const viewed = useRef(false)
  useEffect(() => {
    if (!data || viewed.current) return
    viewed.current = true
    if (shouldSendView(compId)) void publicCompetitionApi.event({ compId, step: 'view', ref: refOrUndef() })
  }, [data, compId])

  useDocumentTitle(data ? t('competition.pub.docTitle', { name: data.name }) : 'Signal Lab', {
    // 卸载时还原（→ /login 等自己不设标题的页面不再挂着比赛名）。
    // Restore on unmount so /login etc. don't keep the competition name.
    restoreOnUnmount: true,
  })

  if (error === 'notFound') {
    return (
      <Notice text={t('competition.pub.notFound')}>
        <Link to="/" className="cmp-btn-ghost">{t('competition.pub.notFoundHome')}</Link>
        {/* 未公开的比赛站内仍可看：给登录入口（登录后报名意图会送回这场）。
            A non-public competition is still visible in-app: offer login. */}
        <Link to="/login" className="cmp-btn-ghost">{t('competition.pub.ctaHaveAccount')}</Link>
      </Notice>
    )
  }
  if (!data) {
    return loading ? (
      <SkeletonPage cards={2} />
    ) : (
      <Notice text={t('competition.pub.loadError')}>
        <button type="button" className="cmp-btn-ghost" onClick={() => setAttempt((n) => n + 1)}>{t('competition.pub.retry')}</button>
      </Notice>
    )
  }

  const rows = publicLadderRows(data.rows, t('competition.pub.anon'), (n) => t('competition.pub.sample', { n }))
  const heading = data.status === 'settled' ? t('competition.finalBoard') : t('competition.liveBoard')

  return (
    <div className="cmp-detail">
      <div className="cmp-split">
        <aside className="cmp-side">
          <span className="pcp-badge">{t('competition.pub.badge')}</span>
          <StatusLine c={data} tagKey={statusTagKey(data, nowMs)} t={t} />
          <h1 className="cmp-hero-name is-detail">{data.name}</h1>
          {data.description && <CompetitionDesc title={data.name} text={data.description} t={t} />}
          <CompClock c={data} nowMs={nowMs} t={t} />
          <p className="pcp-meta num">{t('competition.pub.participants', { n: data.participants })}</p>
          <CompFacts c={data} t={t} />
          <PublicCta c={data} nowMs={nowMs} t={t} />
          {error === 'retry' && <p className="pcp-stale" role="status">{t('competition.pub.stale')}</p>}
        </aside>
        <section className="min-w-0">
          <div className="cmp-ladder-h">
            <h3>{heading}</h3>
            <span className="num">{rows.length}</span>
          </div>
          <Ladder rows={rows} emptyText={t('leaderboard.empty')} />
          {data.snapshotAt && <p className="pcp-snap">{t('competition.pub.snapshotAt', { time: fmtDate(data.snapshotAt) })}</p>}
          <PublicRules c={data} t={t} />
          <p className="pcp-risk">{t('competition.pub.risk')}</p>
        </section>
      </div>
    </div>
  )
}

function PublicRules({ c, t }: { c: PublicCompetition; t: TFunction }) {
  const r = fundsRule(c.gates)
  const funds = r.kind === 'exact'
    ? t('competition.pub.ruleExact', { usd: fmtUsd(r.usd) })
    : r.kind === 'range'
      ? t('competition.pub.ruleRange', { min: fmtUsd(r.min), max: fmtUsd(r.max) })
      : t('competition.pub.ruleMin', { min: fmtUsd(r.min) })
  return (
    <div className="pcp-rules">
      <h3>{t('competition.pub.rulesTitle')}</h3>
      <ul className="cmp-rules">
        <li>{t('competition.pub.ruleViaApp')}</li>
        <li>{funds}</li>
        <li>{t('competition.pub.ruleNoPreTrade')}</li>
        <li>{t('competition.rules.scoringFrom')}</li>
        <li>{t('competition.pub.ruleMinTrades', { n: c.gates.minTrades })}</li>
        <li>{t('competition.rules.final')}</li>
      </ul>
    </div>
  )
}

// CTA 状态机（utils/publicCompetition.publicCta）：
// join / notOpen → 四步说明 + 「注册并参赛」+（有本场开户链接时）「开模拟账户」新窗口；
// closed → 截止/已结束 +「下一场」或「注册 Signal Lab」。
// 「开模拟账户」不直接指向 openAccountUrl，而是后端跳转口：服务端按访客最近的 ref（代理
// 优先）选代理自己的开户链接或本场默认的，并顺手记 open_account 漏斗（所以这里不再打点）。
// 是否显示按钮仍只看载荷里的 openAccountUrl。
// CTA state machine: join / notOpen → four steps + sign-up + (with a link) open-account in a
// new tab; closed → closed/ended + next competition or a plain sign-up. The open-account
// button points at the backend redirect, which picks the agent's or the competition's URL
// from the visitor's recent refs and records the funnel step itself (no client ping).
function PublicCta({ c, nowMs, t }: { c: PublicCompetition; nowMs: number; t: TFunction }) {
  const [params] = useSearchParams()
  const cta = publicCta(c, nowMs)
  // 载荷里的是比赛自己的开户链接（管理员填的，可信）：只挡非 http(s)。代理链接不经这里，
  // 由后端跳转口按 refs 挑选并按白名单校验。/ The payload carries the competition's own (admin-set)
  // URL: safeHttpUrl only. Agent links never pass here; the backend redirect picks and validates them.
  const openUrl = competitionOpenAccountUrl(c.openAccountUrl)
  const langQs = params.get('lang') ? `?lang=${encodeURIComponent(params.get('lang')!)}` : ''
  const ping = (step: 'cta') => void publicCompetitionApi.event({ compId: c.id, step, ref: refOrUndef() })
  const onJoin = () => {
    storeCompIntent(c.id)
    ping('cta')
  }
  const onOpenAccount = () => {
    storeCompIntent(c.id)
  }

  if (cta.kind === 'closed') {
    return (
      <div className="cmp-enroll">
        <p>{t(cta.reason === 'ended' ? 'competition.pub.ended' : 'competition.pub.closed')}</p>
        {cta.next ? (
          <Link to={`/c/${encodeURIComponent(cta.next)}${langQs}`} className="cmp-btn">{t('competition.pub.nextComp')}</Link>
        ) : (
          <Link to="/login?mode=register" className="cmp-btn" onClick={() => ping('cta')}>{t('competition.pub.joinPlatform')}</Link>
        )}
      </div>
    )
  }

  return (
    <div className="cmp-enroll pcp-cta">
      {cta.kind === 'notOpen' && <p>{t('competition.pub.notOpen', { time: cta.opensAt ? fmtDate(cta.opensAt) : '—' })}</p>}
      <p className="pcp-steps-h">{t('competition.pub.stepsTitle')}</p>
      <ol className="pcp-steps">
        <li>{t('competition.pub.step1')}</li>
        <li>{t('competition.pub.step2')}</li>
        <li>{t('competition.pub.step3')}</li>
        <li>{t('competition.pub.step4')}</li>
      </ol>
      <div className="pcp-cta-row">
        <Link to="/login?mode=register" className="cmp-btn" onClick={onJoin}>{t('competition.pub.ctaJoin')}</Link>
        {openUrl && (
          <a
            href={publicOpenAccountHref(API_BASE, c.id, readRefs())}
            target="_blank"
            rel="noopener noreferrer"
            className="cmp-btn-ghost"
            onClick={onOpenAccount}
          >
            {t('competition.pub.ctaOpenAccount')} ↗
          </a>
        )}
      </div>
      {openUrl && <p className="pcp-hint">{t('competition.pub.openAccountHint')}</p>}
      <Link to="/login" className="pcp-link" onClick={onJoin}>{t('competition.pub.ctaHaveAccount')}</Link>
    </div>
  )
}
