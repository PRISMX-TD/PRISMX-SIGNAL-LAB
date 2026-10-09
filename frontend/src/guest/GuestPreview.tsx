// 游客预览：未登录访客打开首页时，直接看到登录后的仪表盘（PRO 视角），而不是落地页。
//
// 卡片全部复用真实仪表盘的组件，数据来自公开预览快照（StaticLiveProvider 喂进去）。
// 活跃信号的价位在服务端就被抹掉，前端只画一层磨砂锁；任何操作性点击都被 gate.ts 拦成
// 注册弹窗。由后台开关控制：关掉后首页回到原来的落地页（见 App.tsx 的 Home）。
//
// Guest preview: a logged-out visitor opening the home page sees the signed-in dashboard (PRO
// view) instead of the landing page. Every card is the real dashboard component, fed by the
// public preview snapshot through StaticLiveProvider. Active-signal prices are stripped
// server-side and only a frosted lock is drawn; every action click is caught by gate.ts and
// becomes the sign-up modal. An admin switch controls it — off, the home page goes back to
// the landing page (see Home in App.tsx).
import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { StaticLiveProvider } from '../store/live'
import type { CompetitionSummary, Signal } from '../api/types'
import { displaySymbol, parseTime } from '../api/utils'
import Logo from '../components/Logo'
import AuroraBackground from '../components/AuroraBackground'
import PublicLanguageToggle from '../components/PublicLanguageToggle'
import CompetitionMarquee from '../components/CompetitionMarquee'
import CompetitionNavBadge from '../components/CompetitionNavBadge'
import SignalHero from '../components/signals/SignalHero'
import SignalExec from '../components/signals/SignalExec'
import SignalOthers from '../components/signals/SignalOthers'
import QuotesTable from '../components/signals/QuotesTable'
import SessionWinrateCard from '../components/winrate/SessionWinrateCard'
import { ClockTtlRing } from '../components/signals/TtlRing'
import { useBucketedNow, useFocusEntries } from '../components/signals/hooks'
import { trendStance, type FocusState, type TrendStance } from '../components/signals/SignalView'
import RecentResultsCard from './RecentResultsCard'
import GateModal from './GateModal'
import { useExitIntent, useGateCapture, type GateReason } from './gate'
import { markHomeView, releaseHomeHold, trackHome } from './homeMode'
import {
  useGuestAnalysis, useGuestCompetition, useGuestOffer, useGuestPreviewData, type GuestPreviewPayload,
} from './previewData'
import '../styles/guest.css'

const noop = () => {}
const NUDGE_AFTER_MS = 45_000

// ── 顶栏：和登录后同一套壳，右侧换成登录 / 免费注册 ──
// Header: the signed-in shell, with log-in / sign-up on the right.
const GuestHeader: FC<{ competition: CompetitionSummary | null; onRegister: () => void; onLogin: () => void }> = ({
  competition, onRegister, onLogin,
}) => {
  const { t } = useTranslation()
  const nav: Array<[string, string]> = [
    ['nav:signals', t('nav.signals')],
    ['nav:charts', t('nav.charts')],
    ['nav:orders', t('nav.orders')],
    ['nav:growth', t('nav.growth')],
  ]
  const badge = competition
    ? { running: competition.status === 'running' ? [competition] : [], upcoming: competition.status === 'running' ? [] : [competition] }
    : null
  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-ink-950/90 pt-[env(safe-area-inset-top)] backdrop-blur-lg">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-4 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo size={40} />
          <div className="hdr-wordmark leading-tight">
            <div className="font-display text-[17px] font-bold tracking-[-0.015em] text-white">Signal Lab</div>
            <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-neutral-500">by PRISMX</div>
          </div>
        </div>
        <nav className="hidden flex-1 items-center justify-center gap-1 lg:flex lg:gap-2">
          <span className="relative whitespace-nowrap px-3 py-2 text-sm font-medium text-white">
            {t('nav.dashboard')}
            <span className="rule-spectral absolute -bottom-px left-3 right-3"><i /></span>
          </span>
          {nav.map(([gate, label]) => (
            <button key={gate} type="button" data-gate={gate}
              className="gst-nav-item relative whitespace-nowrap px-3 py-2 text-sm font-medium text-neutral-400 transition-colors hover:text-neutral-100">
              {label}
              <svg className="gst-nav-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
          {badge && <CompetitionNavBadge preset={badge} />}
          <div className="hidden lg:block" data-guest-allow><PublicLanguageToggle /></div>
          <button type="button" data-guest-allow onClick={onLogin}
            className="hidden px-2 py-2 text-sm font-medium text-neutral-300 transition-colors hover:text-white sm:inline-flex">
            {t('guest.header.login')}
          </button>
          <button type="button" data-guest-allow onClick={onRegister} className="btn btn-primary gst-hdr-cta">
            {t('guest.header.register')}
          </button>
        </div>
      </div>
    </header>
  )
}

// ── 仪表盘主体：与 DashboardPage 同一套栅格与卡片 ──
// Dashboard body: the same grid and cards as DashboardPage.
const GuestDashboard: FC<{ data: GuestPreviewPayload; competition: CompetitionSummary | null }> = ({ data, competition }) => {
  const { t } = useTranslation()
  const analysis = useGuestAnalysis()
  const now = useBucketedNow(10_000)
  const focusEntries = useFocusEntries(data.active, now, data.symbols)
  const [focusIdx, setFocusIdx] = useState(0)
  const idx = Math.min(focusIdx, Math.max(0, focusEntries.length - 1))
  const cur = focusEntries[idx]
  const stance: TrendStance = cur ? trendStance(data.trends[cur.symbol]) : 'NEUTRAL'
  const total = focusEntries.length
  const goPrev = useCallback(() => setFocusIdx((i) => (i - 1 + total) % total), [total])
  const goNext = useCallback(() => setFocusIdx((i) => (i + 1) % total), [total])
  const otherEntries = useMemo(
    () =>
      focusEntries
        .map((e, i) => ({ ...e, i }))
        .filter((e) => e.i !== idx && e.state !== 'WATCH' && e.signal != null)
        .map(({ symbol, state, signal, i }) => ({ symbol, state: state as FocusState, signal: signal!, idx: i })),
    [focusEntries, idx],
  )
  const marquee = useMemo(() => (competition ? [competition] : []), [competition])

  return (
    <div className="max-w-[1520px] mx-auto">
      {marquee.length > 0 && <CompetitionMarquee items={marquee} />}
      <div className="dash-grid content-fade">
        <div className="dash-col-1">
          {cur && (
            <SignalHero symbol={cur.symbol} cnName={t(`signals.symbolNames.${cur.symbol}`, { defaultValue: '' })}
              focusIdx={idx} focusTotal={total} stance={stance} trend={data.trends[cur.symbol]}
              sentiment={data.sentiment[cur.symbol] ?? null} onPrev={goPrev} onNext={goNext} onSelectIdx={setFocusIdx} />
          )}
          <QuotesTable symbols={data.symbols} mt5Online focusSymbol={cur?.symbol} />
        </div>
        <div className="dash-col-2">
          <SignalExec signal={cur?.signal ?? null} onTrade={noop} />
          <SessionWinrateCard preset={analysis} presetLoading={analysis == null} />
          <RecentResultsCard signals={data.recent} stats={data.recentStats} />
        </div>
        <SignalOthers entries={otherEntries} onTrade={noop} onFocus={setFocusIdx} onViewAll={noop} />
      </div>
    </div>
  )
}

// onUnavailable：预览接口 404（开关其实已关，本地缓存还记着「预览」）→ 上层换回落地页。
// onUnavailable: the preview endpoint 404s (switch off, stale local cache) → back to landing.
export default function GuestPreview({ onUnavailable }: { onUnavailable?: () => void }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const data = useGuestPreviewData(onUnavailable ?? noop)
  const competition = useGuestCompetition(t('competition.pub.anon'))
  const offer = useGuestOffer()
  const [gate, setGate] = useState<GateReason | null>(null)
  const [gateSignal, setGateSignal] = useState<Signal | null>(null)
  const [nudge, setNudge] = useState(false)
  const [newSig, setNewSig] = useState<Signal | null>(null)
  const engaged = gate != null

  useEffect(() => {
    markHomeView('preview')
    releaseHomeHold()
  }, [])

  const active = useMemo(() => data?.active ?? [], [data])
  const nextExpiry = useMemo(() => {
    const ts = active.map((s) => s.expireAt).filter((x): x is string => !!x).sort()
    return ts.find((x) => (parseTime(x)?.getTime() ?? 0) > Date.now()) ?? null
  }, [active])

  const openGate = useCallback((r: GateReason) => {
    // 弹窗里那张小票在打开的那一刻定格：信号在弹窗开着时过期也不会突然变空。
    // The modal's ticket is frozen at open time, so a signal expiring meanwhile doesn't blank it.
    if (r.kind === 'trade') setGateSignal(active.find((s) => s.id === r.signalId) ?? null)
    setGate(r)
    setNudge(false)
    setNewSig(null)
    trackHome('preview', 'gate')
  }, [active])
  useGateCapture(openGate)
  useExitIntent(() => { if (!gate) openGate({ kind: 'exit' }) }, !!data)

  // 逛了一会儿还没点过任何东西：轻提示一次（不挡页面、可关）。
  // Browsed a while without clicking anything: one light, dismissible nudge.
  useEffect(() => {
    if (engaged) return
    const timer = window.setTimeout(() => setNudge(true), NUDGE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [engaged])

  // 访问期间真的发出了新信号：右上角提示一下（真实事件，不是编的）。
  // A real new signal during the visit gets a corner toast.
  const [seen] = useState(() => new Set<string>())
  const [primed, setPrimed] = useState(false)
  useEffect(() => {
    if (!data) return
    const fresh = data.active.filter((s) => !seen.has(s.id))
    fresh.forEach((s) => seen.add(s.id))
    if (!primed) { setPrimed(true); return }
    if (fresh.length) setNewSig(fresh[0])
  }, [data, seen, primed])
  useEffect(() => {
    if (!newSig) return
    const timer = window.setTimeout(() => setNewSig(null), 8000)
    return () => window.clearTimeout(timer)
  }, [newSig])

  const intro = i18n.language === 'en' ? '/en/intro' : '/intro'
  const goRegister = useCallback(() => { trackHome('preview', 'cta'); navigate('/login?mode=register') }, [navigate])
  const goLogin = useCallback(() => navigate('/login'), [navigate])

  const quotes = data?.quotes ?? EMPTY_QUOTES
  const trends = data?.trends ?? EMPTY_TRENDS
  const symbols = data?.symbols ?? EMPTY_SYMBOLS

  return (
    <StaticLiveProvider signals={active} trends={trends} activeSymbols={symbols} quotes={quotes}>
      <div className="relative flex min-h-screen supports-[min-height:100dvh]:min-h-[100dvh] flex-col">
        <AuroraBackground />
        <GuestHeader competition={competition} onRegister={goRegister} onLogin={goLogin} />

        {/* 预览条：告诉访客「这是真的面板、只是价位藏起来了」，免得以为页面坏了。
            The preview strip says "this is the real board, prices hidden", so nobody
            thinks the page is broken. */}
        <div className="gst-banner" data-guest-allow>
          <span className="gst-banner-tag"><i className="animate-breathe" />{t('guest.banner.tag')}</span>
          <span className="hidden sm:inline">{t('guest.banner.text')}</span>
          <span className="sm:hidden">{t('guest.banner.textShort')}</span>
          {data && <span className="gst-banner-stat hidden md:inline">{t('guest.banner.issued24h', { n: data.recentStats.issued })}</span>}
          <button type="button" className="gst-banner-cta" onClick={() => goRegister()}>
            {t('guest.banner.cta')} →
          </button>
        </div>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pt-6 sm:px-6 gst-main">
          {data ? (
            <GuestDashboard data={data} competition={competition} />
          ) : (
            <div className="flex min-h-[40vh] items-center justify-center">
              <div className="h-px w-40 overflow-hidden bg-white/10"><div className="h-full w-1/3 animate-shimmer bg-prism-400" /></div>
            </div>
          )}
        </main>

        <footer className="mx-auto w-full max-w-7xl px-4 pb-28 sm:px-6 lg:pb-6" data-guest-allow>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-white/[0.06] pt-5 text-[12px] text-neutral-500">
            <span>© {new Date().getFullYear()} PRISMX</span>
            {(['terms', 'privacy', 'risk'] as const).map((d) => (
              <a key={d} href={`/${d}`} className="transition-colors hover:text-neutral-300">{t(`legal.${d}.title`)}</a>
            ))}
            <a href={intro} className="transition-colors hover:text-neutral-300">{t('guest.gate.learnMore')}</a>
          </div>
        </footer>

        {/* 手机吸底条：取代底部 Tab 栏，永远看得到「还有几条信号在跑」和注册按钮。
            Mobile sticky bar in place of the tab bar: live count + sign-up always in view. */}
        {data && (
          <div className="gst-sticky lg:hidden" data-guest-allow>
            <div className="gst-sticky-info">
              <b><i className="animate-breathe" />{t('guest.sticky.live', { n: active.length })}</b>
              {nextExpiry && (
                <span className="gst-sticky-next"><ClockTtlRing expireAt={nextExpiry} label={t('guest.sticky.next')} /></span>
              )}
            </div>
            <button type="button" className="btn btn-primary" onClick={() => goRegister()}>{t('guest.sticky.cta')}</button>
          </div>
        )}

        {newSig && !gate && (
          <button type="button" className="gst-toast" data-signal-id={newSig.id} onClick={() => setNewSig(null)}>
            <span className="gst-toast-bolt" aria-hidden>⚡</span>
            <span>
              <b>{t('guest.newSignal.title', { symbol: displaySymbol(newSig.symbol), side: newSig.side === 'BUY' ? t('common.buy') : t('common.sell') })}</b>
              <small>{t('guest.newSignal.sub')}</small>
            </span>
          </button>
        )}

        {nudge && !gate && (
          <div className="gst-nudge" data-guest-allow role="status">
            <button type="button" className="gst-nudge-x" onClick={() => setNudge(false)} aria-label={t('guest.gate.close')}>×</button>
            <b>{t('guest.nudge.title')}</b>
            <p>{t('guest.nudge.text')}</p>
            <button type="button" className="btn btn-primary" onClick={() => goRegister()}>{t('guest.nudge.cta')}</button>
          </div>
        )}

        {gate && (
          <GateModal
            reason={gate}
            signal={gateSignal}
            nextExpiry={nextExpiry}
            activeCount={active.length}
            competition={competition}
            offer={offer}
            onClose={() => setGate(null)}
            onRegister={goRegister}
            onLogin={goLogin}
            onLearnMore={() => navigate(intro)}
            onCompetition={() => competition && navigate(`/c/${encodeURIComponent(competition.id)}`)}
          />
        )}
      </div>
    </StaticLiveProvider>
  )
}

const EMPTY_QUOTES = {}
const EMPTY_TRENDS = {}
const EMPTY_SYMBOLS: string[] = []
