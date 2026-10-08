// 比赛页（Phase 3）：列表（三组分区：即将开始/进行中/已结束）+ 详情。
// 列表 ↔ 详情仍在同一条路由上，但打开哪一场记在查询参数 ?c=<id> 里而不是组件
// state——这样它进浏览器历史，安卓 App / PWA 的系统返回键才会回到列表而不是
// 直接离开比赛页（详见下面 useSearchParams 处的说明）。
// 入口本身按 competitionsVisible 门控（见 Layout/UserMenu），这里只处理直接打
// URL 绕过入口的情况——理论上只有内测期的普通用户会撞上 403，兜底成一句提示
// 而不是把接口错误糊在脸上（照 AchievementsPage/LeaderboardPage 的先例）。
//
// Competitions page (Phase 3): a list (three sections: upcoming/running/
// finished) + a detail view. Both stay on one route, but which competition is
// open lives in the ?c=<id> query parameter rather than component state, so it
// enters browser history and the Android app / PWA back button returns to the
// list instead of leaving the page (see the useSearchParams note below). The
// entry point itself is gated on competitionsVisible (see Layout/UserMenu);
// this only handles someone hitting the URL directly — in practice only a
// regular user during the beta window, degraded to one line of copy instead
// of a raw API error (same precedent as AchievementsPage/LeaderboardPage).
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ProfileLink from '../components/ProfileLink'
import type { TFunction } from 'i18next'
import { competitionApi } from '../api/client'
import { fmtDate, fmtDay, localizeApiError } from '../api/utils'
import { regState, useNowTicker } from '../utils/competitionTime'
import { useLive } from '../store/live'
import { useAuth } from '../store/auth'
import Switch from '../components/Switch'
import PrepChecklist from '../components/competition/PrepChecklist'
import { safeHttpUrl } from '../utils/safeUrl'
import { clearCompIntent, readCompIntent } from '../utils/compIntent'
import {
  bindHint, classifyDetailError, gatesOfDetail, prepState, registerErrorKey, shouldClearIntent,
  type DetailLoadError,
} from '../utils/compPrep'
import { SkeletonPage } from '../components/Skeleton'
import RankCoin from '../components/badges/RankCoin'
import CashflowRules from '../components/CashflowRules'
import ShareSheet, { type ShareSpec } from '../components/share/ShareSheet'
import { compCard } from '../components/share/cardData'
import { bugReadout, clockOf, countdownOf, fmtRange, statusTagKey } from '../components/competition/compClock'
import StatusLine, { STATUS_TAG_CLASS } from '../components/competition/StatusLine'
import { ScoreText, badgeOf } from '../components/competition/ScoreText'
import Ladder, { type LadderRowView } from '../components/competition/Ladder'
import CompClock from '../components/competition/CompClockView'
import CompFacts from '../components/competition/CompFacts'
import CompetitionDesc from '../components/competition/CompetitionDesc'
import type {
  CompetitionDetail,
  CompetitionTrack,
  CompetitionListGrouped,
  CompetitionSummary,
  LeaderboardPayload,
  MT5Account,
} from '../api/types'

const LIST_GROUPS: Array<keyof CompetitionListGrouped> = ['running', 'upcoming', 'finished']

// ── 列表：头版（进行中）──
// 把比赛当成一场正在直播的赛事：赛名 76px 压住整个头版，右上角是转播里的角标
// 倒计时，底下一条跑马灯滚着前三名。整块可点。
// The list's front page (running): treat the competition as a live broadcast. The
// name at 76px owns the page, a broadcast bug with the countdown sits top-right,
// and a ticker runs the top three underneath. The whole block is a button.
function LiveHero({
  c,
  nowMs,
  onClick,
  t,
}: {
  c: CompetitionSummary
  nowMs: number
  onClick: () => void
  t: TFunction
}) {
  const clock = clockOf(c, nowMs, t)
  const top = c.top ?? []
  // 跑马灯内容复制两份首尾相接，动画走满一份的宽度就无缝回到起点。
  // The ticker content is duplicated end to end; the animation travels one copy's
  // width and loops seamlessly.
  const ticker = (
    <>
      {top.length > 0
        ? top.map((r, i) => (
            <span key={i}>
              {String(i + 1).padStart(2, '0')} <b><ProfileLink profileId={r.profileId}>{r.displayName}</ProfileLink></b> <ScoreText score={r.score} />
            </span>
          ))
        : <span>{t('competition.ticker.empty')}</span>}
      <span>{t('competition.ticker.participants', { n: c.participants ?? 0 })}</span>
      <span>{t('competition.ticker.live')}</span>
    </>
  )
  return (
    <button type="button" onClick={onClick} className="cmp-hero">
      <span className="cmp-ghost" aria-hidden>LIVE</span>
      {clock && (
        <span className="cmp-bug">
          <span>{clock.label}</span>
          <b className="num">{clock.parts ? bugReadout(clock.parts) : t('competition.cd.soon')}</b>
        </span>
      )}
      <StatusLine c={c} tagKey={statusTagKey(c, nowMs)} t={t} />
      <h3 className="cmp-hero-name">{c.name}</h3>
      <div className="cmp-hero-sub">
        {c.prizeNote && (
          <span className="cmp-hero-prize">
            <small>{t('competition.prizeLabel')}</small>
            {c.prizeNote}
          </span>
        )}
        <span className="cmp-hero-when num">{fmtRange(c)}</span>
        <span className="cmp-hero-cta">{t('competition.enterArena')}</span>
      </div>
      <div className="cmp-ticker" aria-hidden>
        <div>{ticker}{ticker}</div>
      </div>
    </button>
  )
}

// ── 列表：赛程行（即将开始）──
function UpcomingRow({
  c,
  nowMs,
  onClick,
  t,
}: {
  c: CompetitionSummary
  nowMs: number
  onClick: () => void
  t: TFunction
}) {
  const cd = countdownOf(c, nowMs, t)
  const tagKey = statusTagKey(c, nowMs)
  return (
    <button type="button" onClick={onClick} className="cmp-row">
      <div className="min-w-0">
        <b className="cmp-row-name">{c.name}</b>
        <div className="cmp-row-meta">
          {t(`leaderboard.boards.${c.metric}`)} · {t(`competition.track.${c.track}`)} · {t(`competition.enrollment.${c.enrollment}`)}
        </div>
      </div>
      <span className={`cmp-status-tag ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
        {tagKey === 'regOpen' && <i className="cmp-live-dot" aria-hidden />}
        {t(`competition.status.${tagKey}`)}
      </span>
      <div className="cmp-row-cd">
        {cd ? (<><small>{cd.label}</small><b>{cd.value}</b></>) : <b className="num">{c.startsAt ? fmtDay(c.startsAt) : '—'}</b>}
      </div>
    </button>
  )
}

// ── 列表：荣誉墙行（已结束）──
// 冠军铸币 + 冠军名在中间，夺冠成绩在右；未终审的中间写"待终审"。
// Champion coin and name in the middle, the winning score on the right; unsettled
// ones say "pending" in the middle instead.
function HonorRow({ c, onClick, t }: { c: CompetitionSummary; onClick: () => void; t: TFunction }) {
  const champ = c.status === 'settled' ? c.champion ?? null : null
  return (
    <button type="button" onClick={onClick} className="cmp-row cmp-row-honor">
      <div className="min-w-0">
        <b className="cmp-row-name">{c.name}</b>
        <div className="cmp-row-meta num">{fmtRange(c)}</div>
      </div>
      <div className="cmp-champ">
        {champ ? (
          <>
            <RankCoin rank={1} size={40} />
            <div className="min-w-0">
              <b>{badgeOf(champ.equippedBadge, champ.equippedBadgeTier)}<ProfileLink profileId={champ.profileId} className="truncate">{champ.displayName}</ProfileLink></b>
              <small>{t('competition.champion')} · {t(`leaderboard.boards.${c.metric}`)}</small>
            </div>
          </>
        ) : (
          <span className="cmp-champ-none">{c.status === 'settled' ? t('competition.noChampion') : t('competition.settling')}</span>
        )}
      </div>
      <div className="cmp-row-cd">{champ && <ScoreText score={champ.score} className="cmp-row-score" />}</div>
    </button>
  )
}

function ListView({
  data,
  onOpen,
  t,
}: {
  data: CompetitionListGrouped
  onOpen: (id: string) => void
  t: TFunction
}) {
  const nowMs = useNowTicker()
  const empty = LIST_GROUPS.every((g) => data[g].length === 0)
  if (empty) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center">
        <p className="card glass p-6 text-center text-sm text-neutral-400">{t('competition.empty')}</p>
      </div>
    )
  }
  // 版式：进行中是头版（一场一块，通常只有一场），即将开始与荣誉墙是"栏目 + 行"
  // ——左边 220px 栏目名与一句说明，右边发丝线分行。
  // Layout: running is the front page (one block each, usually just one); upcoming
  // and the hall of champions are "column + rows": a 220px column title with one
  // line of copy on the left, hairline rows on the right.
  return (
    <div className="cmp-list">
      {data.running.map((c) => (
        <LiveHero key={c.id} c={c} nowMs={nowMs} t={t} onClick={() => onOpen(c.id)} />
      ))}
      {data.upcoming.length > 0 && (
        <section className="cmp-sec">
          <h4>{t('competition.status.upcoming')}<small>{t('competition.upcomingHint')}</small></h4>
          <div>
            {data.upcoming.map((c) => (
              <UpcomingRow key={c.id} c={c} nowMs={nowMs} t={t} onClick={() => onOpen(c.id)} />
            ))}
          </div>
        </section>
      )}
      {data.finished.length > 0 && (
        <section className="cmp-sec">
          <h4>{t('competition.hall')}<small>{t('competition.hallHint')}</small></h4>
          <div>
            {data.finished.map((c) => (
              <HonorRow key={c.id} c={c} t={t} onClick={() => onOpen(c.id)} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// 参赛账户选择弹窗：复用 SlideOrderModal/ConfirmModal 的 portal-to-body + 玻璃卡
// 居中弹窗模式（原因同 ConfirmModal 顶部注释——本页调用点本身就在 .glass 卡片
// 内部，不 portal 会被 backdrop-filter 截断）。列表来自 useLive().accounts（见
// DetailView 的说明），调用方（DetailView）已经按本场赛道（matchesTrack）过滤过：
// 实盘赛只收到实盘账户、模拟赛只收到模拟账户，副标题也按 track 说清楚是哪一种；
// 后端仍会独立复核一遍并在选错时用 400 拒绝，前端过滤只是少让用户走一趟弯路，
// 不是唯一防线。
// Entry-account picker: reuses the SlideOrderModal/ConfirmModal
// portal-to-body + centered glass-card modal pattern (same reason as
// ConfirmModal's top comment — this page's call site sits inside a .glass
// card, and skipping the portal would get clipped by its backdrop-filter).
// The list comes from useLive().accounts (see DetailView's comment); the
// caller (DetailView) has already filtered it by this competition's track
// (matchesTrack): real accounts for a live competition, demo accounts for a demo
// one, and the subtitle names which. The backend still validates
// independently and rejects an ineligible pick with a 400 — this client-side
// filter just saves the user a wasted round trip, it isn't the only guard.
function AccountPickerModal({
  accounts,
  track,
  busy,
  onCancel,
  onConfirm,
  publicNotice,
  t,
}: {
  accounts: MT5Account[]
  track: CompetitionTrack
  busy: boolean
  onCancel: () => void
  onConfirm: (login: string) => void
  publicNotice: boolean
  t: TFunction
}) {
  const [login, setLogin] = useState<string | null>(accounts[0]?.login ?? null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  /* 上面的注释说本弹窗「复用 SlideOrderModal/ConfirmModal 模式」，但此前实际只复用了
     portal 这一件事：没有 role="dialog"/aria-modal，Escape 关不掉，焦点不进弹窗也不
     被困住，背景照常滚动，唯一的关闭方式是拿鼠标点遮罩。而这是**报名的唯一入口**，
     键盘与读屏用户等于进得去出不来。同仓库的 BadgeDetailModal 就有正确实现。
     这里补齐四件事：Escape 关闭、打开时把焦点移进面板、Tab 在面板内循环、锁住背景
     滚动。语义标记（role/aria-modal/aria-labelledby）见下面的 JSX。

     The comment above says this reuses the SlideOrderModal/ConfirmModal pattern, but
     in practice only the portal was reused: no role="dialog"/aria-modal, no Escape,
     no focus move or trap, no scroll lock — the sole way out was clicking the scrim
     with a mouse. This is the only entry point for registering, so keyboard and
     screen-reader users could enter it and not get out. BadgeDetailModal in this
     same repo does it correctly. Added here: Escape to close, focus moved into the
     panel on open, Tab cycling inside it, and a background scroll lock. */
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()

    const FOCUSABLE =
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      // 焦点跑到面板外（或还停在面板容器本身）时，把它拉回两端。
      // Pull focus back to an end whenever it would leave the panel.
      if (e.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      prevFocus?.focus?.()
    }
  }, [onCancel])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="glass-card w-full max-w-sm p-6 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-lg font-bold text-white">{t('competition.pickAccount')}</h3>
        <p className="mt-2 text-xs text-neutral-500">{t(track === 'demo' ? 'competition.pickAccountHintDemo' : 'competition.pickAccountHint')}</p>
        {publicNotice && <p className="mt-2 text-xs leading-relaxed text-amber-300">{t('competition.publicNotice')}</p>}
        <div className="mt-4 max-h-64 space-y-2 overflow-y-auto">
          {accounts.map((a) => (
            <button
              key={a.login}
              type="button"
              onClick={() => setLogin(a.login)}
              className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                login === a.login
                  ? 'border-prism-500/60 bg-prism-600/15 text-prism-200'
                  : 'border-white/10 bg-white/5 text-neutral-300 hover:border-prism-400/40'
              }`}
            >
              {a.login}
              {a.accountName ? ` · ${a.accountName}` : ''}
            </button>
          ))}
        </div>
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={onCancel} disabled={busy} className="btn-ghost flex-1 py-2 text-sm">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => login && onConfirm(login)}
            disabled={busy || !login}
            className="btn-primary flex-1 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {t('competition.register')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// 站内榜单行 → 名次梯视图：名字可点进公开主页，灰字是后端打码的账户号（自己那行是全的）。
// In-app board rows → ladder view: names link to the public profile; the grey line is the
// server-masked login (full on your own row).
function boardLadderRows(board: LeaderboardPayload): LadderRowView[] {
  return board.rows.map((row) => ({
    key: `${row.rank}-${row.login}`,
    rank: row.rank,
    name: <ProfileLink profileId={row.profileId} className="truncate">{row.displayName}</ProfileLink>,
    sub: row.login,
    score: row.score,
    isSelf: row.isSelf,
    badgeId: row.equippedBadge,
    badgeTier: row.equippedBadgeTier,
  }))
}

function DetailView({ id, onBack, t }: { id: string; onBack: () => void; t: TFunction }) {
  // 账户来源用 useLive().accounts 而不是另发一次 accountApi.list()：这份状态
  // 已经在 LiveProvider（Layout 挂的）里全站共享、随桥接心跳保持新鲜，
  // SlideOrderModal 的账户选择器就是这么拿的——同一个先例，这里不重新造。
  // GET /bridge/accounts 的响应（MT5AccountOut）现在带 tradeMode 字段，下面
  // 用 matchesTrack 按本场赛道在本地过滤（实盘赛只列实盘、模拟赛只列模拟/竞赛
  // 账户）；后端仍然独立复核（见 AccountPickerModal 的说明），前端过滤只是不把
  // 赛道不符的账户列出来让用户白选一次。
  // Accounts come from useLive().accounts rather than a second
  // accountApi.list() call: that state is already shared app-wide via
  // LiveProvider (mounted by Layout) and kept fresh by the bridge heartbeat —
  // SlideOrderModal's own account switcher sources it the same way, so this
  // follows the same precedent rather than reinventing it. GET
  // /bridge/accounts's response (MT5AccountOut) now carries a tradeMode
  // field, filtered locally below via matchesTrack by this competition's track
  // (real accounts for a live competition, demo/contest ones for a demo one). The
  // backend still validates independently (see AccountPickerModal's comment) —
  // the client-side filter just keeps off-track accounts from being listed as
  // pickable in the first place.
  const { accounts } = useLive()
  const nowMs = useNowTicker()
  const [detail, setDetail] = useState<CompetitionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const { user } = useAuth()
  const [loadError, setLoadError] = useState<DetailLoadError | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [nameBusy, setNameBusy] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [registerMsg, setRegisterMsg] = useState<string | null>(null)
  const [share, setShare] = useState<ShareSpec | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    competitionApi
      .detail(id)
      .then((res) => {
        if (!cancelled) setDetail(res)
      })
      .catch((err) => {
        if (cancelled) return
        const kind = classifyDetailError(err)
        setLoadError(kind)
        // 不存在 / 已下线的比赛：作废指向它的报名意图（Part D 约定）。
        // Gone competition: drop a sign-up intent pointing at it (Part D contract).
        if (kind === 'notFound' && readCompIntent() === id.toLowerCase()) clearCompIntent()
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  // 已报名 / 报名已截止 / 比赛已结束时作废指向本场的报名意图，免得之后每次登录都被带回来。
  // Drop the intent for this competition once entered / closed / over, so later sign-ins
  // don't keep landing here.
  useEffect(() => {
    if (!detail || readCompIntent() !== detail.id.toLowerCase()) return
    if (shouldClearIntent(detail, Date.now())) clearCompIntent()
  }, [detail])

  /* 「实时榜」要真的会动。
     详情页的榜单标题在比赛进行中写的是 competition.liveBoard（实时榜），但此前
     数据**只在挂载时拉一次**，之后永不刷新：useNowTicker 推的只是倒计时。于是开着
     页面看半小时，倒计时一直在跳而榜单一行不变——倒计时的「活」反而强化了「数据是
     活的」这个错觉，比干脆写成静态快照更误导人。

     这里补两条最省的刷新路径，不引入轮询以外的任何机制：
     · 比赛进行中（running）时每 60 秒重拉一次。榜单本身按成交结算，分钟级足够，
       60 秒既不会让人觉得卡住，也不会给后端压出多余负载。
     · 标签页从后台切回前台时立刻重拉一次。移动端最常见的用法就是切走一会儿再切
       回来，这时屏幕上那份数据可能已经过期很久，而定时器在后台本来就被节流。
     未开赛/已结束/已终审不刷新：那些状态下榜单要么还不存在，要么已经封存不会再变。

     Make the "live board" actually live. The heading reads
     competition.liveBoard while a competition is running, but the payload was
     fetched once at mount and never again — useNowTicker only advances the
     countdown. Leaving the page open for half an hour showed a ticking clock above
     a frozen board, and that ticking actively reinforced the impression the data
     was live, which is worse than presenting an honest static snapshot.
     Two cheap refresh paths, no mechanism beyond an interval: re-fetch every 60s
     while running (the board settles per trade, so minute granularity is ample and
     60s adds no meaningful backend load), and re-fetch immediately when the tab
     returns to the foreground (the common mobile pattern is to switch away and
     back, by which point the on-screen data can be badly stale and background
     timers are throttled anyway).
     Upcoming / ended / settled do not poll: the board either does not exist yet or
     is sealed and will not change again. */
  useEffect(() => {
    if (detail?.status !== 'running') return
    let cancelled = false
    const pull = () => {
      competitionApi
        .detail(id)
        .then((res) => {
          if (!cancelled) setDetail(res)
        })
        .catch(() => {
          /* 静默：屏幕上已有可用数据，网络抖动不该把整页降级。
             Silent: usable data is already on screen; a blip must not degrade it. */
        })
    }
    const timer = setInterval(pull, 60_000)
    const onVisibility = () => {
      if (!document.hidden) pull()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [id, detail?.status])

  async function refreshDetail() {
    try {
      const res = await competitionApi.detail(id)
      setDetail(res)
    } catch {
      // 详情已经在屏幕上，刷新失败（如报名成功那一刻网络抖了一下）不必把整页
      // 降级成内测提示——静默忽略，用户下次进详情自然会拿到最新数据。
      // The detail is already on screen; a refresh failure (e.g. a network
      // blip right after a successful register) shouldn't degrade the whole
      // page into the beta hint — silently ignored, the next visit picks up
      // fresh data.
    }
  }

  async function handleRegister(login: string) {
    setRegistering(true)
    setRegisterError(null)
    try {
      await competitionApi.register(id, login)
      setPickerOpen(false)
      clearCompIntent()
      setRegisterMsg(t('competition.registerSuccess'))
      await refreshDetail()
    } catch (err) {
      const key = registerErrorKey(err)
      setRegisterError(key ? t(key) : err instanceof Error ? localizeApiError(err.message) : t('common.error'))
    } finally {
      setRegistering(false)
    }
  }

  // 乐观切换，失败回滚并提示。/ Optimistic toggle; roll back with a message on failure.
  async function togglePublicName(login: string, show: boolean) {
    const prev = detail?.myEntries.find((e) => e.login === login)?.publicName ?? null
    const patch = (value: boolean | null) =>
      setDetail((d) => d && { ...d, myEntries: d.myEntries.map((e) => (e.login === login ? { ...e, publicName: value } : e)) })
    setNameBusy(login)
    setNameError(null)
    patch(show)
    try {
      await competitionApi.setPublicName(id, login, show)
    } catch {
      patch(prev)
      setNameError(t('competition.publicNameFailed'))
    } finally {
      setNameBusy(null)
    }
  }

  if (loading) {
    return <SkeletonPage cards={2} />
  }

  if (loadError || !detail) {
    const kind = loadError ?? 'retry'
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
        <p className="card glass p-6 text-center text-sm text-neutral-400">
          {kind === 'forbidden'
            ? t('gamification.admin.visibleOff')
            : kind === 'notFound'
              ? t('competition.err.notFound')
              : t('competition.err.retry')}
        </p>
        {kind === 'notFound' && (
          <button type="button" onClick={onBack} className="cmp-back">← {t('competition.backToList')}</button>
        )}
        {kind === 'retry' && (
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="cmp-btn-ghost">
            {t('competition.err.retryBtn')}
          </button>
        )}
      </div>
    )
  }

  const now = nowMs
  const tagKey = statusTagKey(detail, now)
  const rState = regState(detail, now)
  const enteredLogins = new Set(detail.myEntries.map((e) => e.login))
  const gates = gatesOfDetail(detail)
  const openAccountUrl = safeHttpUrl(detail.openAccountUrl)
  // 可报名账户：本人、直连、赛道相符、未撤销、本场还没报过（设计 §1.11；后端仍独立复核）。
  // Eligible: own, direct-connected, on-track, not revoked, not yet entered (spec §1.11; backend re-checks).
  const prep = prepState({
    emailVerified: user?.emailVerified !== false,
    accounts,
    track: detail.track,
    gates,
    enteredLogins,
    hasOpenAccountUrl: openAccountUrl !== '',
  })
  const availableAccounts = prep.eligible
  const isOver = detail.status === 'ended' || detail.status === 'settled'
  const canShowRegisterAction = detail.enrollment === 'signup'
  const showPrep = canShowRegisterAction && enteredLogins.size === 0 && rState !== 'closed' && !isOver
  const openPicker = () => {
    setPickerOpen(true)
    setRegisterError(null)
  }
  // 榜上属于我的行按账户号索引（后端已标 isSelf；一人可带多个账户参赛，各占
  // 一行）——「你的名次」逐账户取实时名次与分数。
  // My rows on the board keyed by login (the backend flags isSelf; one person can
  // enter several accounts, one row each). "Your rank" reads live rank and score
  // per account off this.
  const myRows = new Map(detail.board.rows.filter((r) => r.isSelf).map((r) => [r.login, r]))
  const boardHeading = detail.status === 'settled' ? t('competition.finalBoard') : t('competition.liveBoard')

  return (
    <div className="cmp-detail">
      <ShareSheet spec={share} onClose={() => setShare(null)} />
      <button type="button" onClick={onBack} className="cmp-back">
        ← {t('competition.backToList')}
      </button>

      {/* ── 转播台式详情：左 380px 侧栏（赛名、大钟、你的名次、事实、报名动作），
          右侧名次梯。侧栏是"字幕条"，名次梯是"画面"。
          Broadcast-style detail: a 380px side rail (name, big clock, your rank, facts,
          enrol action) on the left, the ladder on the right. The rail is the caption
          strip; the ladder is the picture. */}
      <div className="cmp-split">
        <aside className="cmp-side">
          <StatusLine c={detail} tagKey={tagKey} t={t} />
          <h2 className="cmp-hero-name is-detail">{detail.name}</h2>
          {detail.description && <CompetitionDesc title={detail.name} text={detail.description} t={t} />}

          <CompClock c={detail} nowMs={now} t={t} />

          {detail.myEntries.length > 0 && (
            <div className="cmp-mine">
              <small>{t('competition.myRank')}</small>
              {detail.myEntries.map((entry) => {
                const row = myRows.get(entry.login) ?? null
                const rank = entry.finalRank ?? row?.rank ?? null
                return (
                  <div key={entry.login} className={`cmp-mine-row ${entry.disqualified ? 'is-dq' : ''}`}>
                    <b className="num">{rank != null ? `#${rank}` : '—'}</b>
                    <span>
                      <span className="num">{entry.login}</span>
                      <small>
                        {entry.disqualified
                          ? t('competition.disqualified')
                          : entry.finalRank != null
                            ? t('competition.finalRank')
                            : rank == null
                              ? t('competition.myPending')
                              : entry.scoringFrom
                                ? `${t('competition.scoringFrom')} ${fmtDate(entry.scoringFrom)}`
                                : ''}
                      </small>
                    </span>
                    {row && <ScoreText score={row.score} className="cmp-mine-score" />}
                    {/* 结算后的收益赛名次可以分享成卡片 / settled return-competition ranks can be shared as a card */}
                    {entry.finalRank != null && !entry.disqualified && detail.metric === 'return_pct' && (
                      <button type="button"
                        onClick={() => setShare({ type: 'D', variants: [{ key: entry.login, label: '', input: { comp: compCard(
                          detail.name, entry.finalRank!, (entry.finalScore ?? row?.score ?? 0) * 100,
                          detail.participants ?? detail.board.rows.length) } }] })}
                        className="ml-2 shrink-0 rounded-full bg-prism-600/20 px-2.5 py-1 text-xs font-semibold text-prism-300 transition hover:bg-prism-600/30">
                        {t('share.button')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* 报名后的下一步（设计 §1.15）：进行中给「去下第一单」，未开赛提醒开赛后再下单；
              每个参赛账户显示「已平仓 x / N 笔」（N = 本场笔数门槛）。
              After entering (spec §1.15): running → "place your first order"; before the start →
              trade after the start; each entry shows "closed x / N" (N = this competition's gate). */}
          {detail.myEntries.length > 0 && !isOver && (
            <div className="cmp-next">
              {detail.myEntries.filter((e) => !e.disqualified).map((e) => (
                <span key={e.login} className="num">
                  {e.login} · {t('competition.closedCount', { x: e.sample ?? 0, n: gates.minTrades })}
                </span>
              ))}
              {detail.status === 'running' ? (
                detail.myEntries.every((e) => !e.sample) && (
                  <Link to="/app" className="cmp-prep-act">{t('competition.firstOrder')} →</Link>
                )
              ) : (
                <span>{t('competition.firstOrderWait')}</span>
              )}
            </div>
          )}

          {/* 公开页昵称开关（设计 §1.8）：仅当本场公开时出现。/ Public-page nickname toggle, only when public. */}
          {detail.publicView === true && detail.myEntries.length > 0 && (
            <div className="cmp-next">
              {detail.myEntries.map((e) => (
                <label key={e.login} className="cmp-pubname">
                  <span className="min-w-0">
                    {t('competition.publicName')}
                    {detail.myEntries.length > 1 && <span className="num"> · {e.login}</span>}
                    <small className="cmp-prep-sub">{t('competition.publicNameHint')}</small>
                  </span>
                  <Switch
                    checked={e.publicName === true}
                    busy={nameBusy === e.login}
                    onChange={(v) => void togglePublicName(e.login, v)}
                    aria-label={t('competition.publicName')}
                  />
                </label>
              ))}
              {nameError && <span className="text-down">{nameError}</span>}
            </div>
          )}

          <CompFacts c={detail} t={t} />

          {/* 报名动作：仅 signup 赛。窗口内三态互斥（有可报账户 → 按钮，已报完 →
              什么都不显示，"你的名次"已经说明了；一个账户都没有 → 指向绑定页）。
              已经在场的人不再看到"报名已截止"。
              Enrol action: signup competitions only. Inside the window three mutually
              exclusive states (eligible accounts → button; all entered → nothing, "your
              rank" already says so; no accounts → the bind page). Someone already in
              never sees "registration closed". */}
          {canShowRegisterAction && (
            <div className="cmp-enroll">
              {rState === 'notOpen' && <p>{t('competition.regNotOpen')}</p>}
              {rState === 'closed' && enteredLogins.size === 0 && <p>{t('competition.regClosed')}</p>}
              {showPrep && (
                <PrepChecklist
                  prep={prep}
                  gates={gates}
                  openAccountUrl={openAccountUrl}
                  hint={availableAccounts.length > 0 ? null : bindHint(accounts, detail.track)}
                  canRegister={rState === 'open' && availableAccounts.length > 0}
                  onRegister={openPicker}
                  t={t}
                />
              )}
              {rState === 'open' && enteredLogins.size > 0 && availableAccounts.length > 0 && (
                <button type="button" onClick={openPicker} className="cmp-btn-ghost">
                  {t('competition.registerMore')}
                </button>
              )}
              {registerMsg && <p className="text-up">{registerMsg}</p>}
              {registerError && <p className="text-down">{registerError}</p>}
            </div>
          )}
        </aside>

        <main className="min-w-0">
          <div className="cmp-ladder-h">
            <h3>{boardHeading}</h3>
            {detail.pendingSettle && <span className="text-amber-300">{t('competition.pendingSettle')}</span>}
            <span className="num">{detail.board.rows.length}</span>
          </div>
          <Ladder rows={boardLadderRows(detail.board)} emptyText={t('leaderboard.empty')} youTag={t('leaderboard.youTag')} />
          <ul className="cmp-rules">
            <li>{t('competition.rules.scoringFrom')}</li>
            <li>{t('competition.rules.minSamples')}</li>
            <li>{t('competition.rules.final')}</li>
          </ul>
          {/* 出入金计分说明（默认收起，与排行榜同一个组件）：本金门槛取本场榜负载里的
              gates，不是全局设置——单场比赛可以覆盖它。
              Same collapsed explainer as the leaderboard; the capital floor comes from
              this competition's own board gates, since a competition may override the
              global setting. */}
          <CashflowRules minBaselineUsd={detail.board.gates.minBaselineUsd} maxBaselineUsd={detail.board.gates.maxBaselineUsd} variant="competition" />
        </main>
      </div>

      {pickerOpen && (
        <AccountPickerModal
          accounts={availableAccounts}
          track={detail.track}
          busy={registering}
          onCancel={() => setPickerOpen(false)}
          onConfirm={handleRegister}
          publicNotice={detail.publicView === true}
          t={t}
        />
      )}
    </div>
  )
}

// 宽度由 GrowthHub 外壳统一约束（mx-auto max-w-[1100px]），本页不再自己套一层。
// 三条路由都是 <GrowthHub><Page/></GrowthHub>（见 App.tsx），外壳一定在。两个来源时
// 改壳会漏改这里，且没有任何视觉差别可以提醒人。
// Width belongs to the GrowthHub shell; all three routes are
// <GrowthHub><Page/></GrowthHub> (see App.tsx) so the shell is always present. With
// two sources, changing the shell silently misses this one and nothing looks wrong.
export default function CompetitionsPage() {
  const { t } = useTranslation()
  /* 列表 ↔ 详情放在查询参数里，而不是纯组件 state。
     原来是 `useState<'list' | {id}>`，切换不进浏览器历史。本站有安卓 App（WebView）
     和 PWA standalone，系统返回键/返回手势走的就是 history——在 App 里点开一场比赛
     详情后按返回，会**直接离开比赛页**（退到上一个页面甚至退出 App），而不是回到
     比赛列表。这是移动端最容易被当成 bug 的一类行为。

     用 ?c=<id> 而不是新开一条 /competitions/:id 子路由：路由表在 App.tsx 里，而
     查询参数留在同一条路由上，既拿到了历史记录条目（返回键回列表），又不必改动
     路由表，也不会与 react-router 的 history 打架——参数的读写全部经由 react-router
     自己的 useSearchParams。
     顺带还有一个好处：详情页现在可以被分享和刷新了，以前 URL 永远只是 /competitions。

     List <-> detail lives in a query parameter rather than plain component state.
     It used to be `useState<'list' | {id}>`, which never entered browser history.
     This site ships an Android WebView app and a standalone PWA, where the system
     back button and back gesture drive history — so opening a competition and
     pressing back left the competitions page entirely instead of returning to the
     list, which is the classic mobile "that's a bug" behaviour.
     ?c=<id> rather than a new /competitions/:id child route: the route table lives
     in App.tsx, while a query parameter stays on the same route, still produces a
     history entry, and is read and written through react-router's own
     useSearchParams so nothing fights its history. It also makes a detail view
     shareable and reload-safe, which it never was. */
  const [params, setParams] = useSearchParams()
  const openId = params.get('c')
  const view: 'list' | { id: string } = openId ? { id: openId } : 'list'
  const openDetail = (id: string) => setParams({ c: id })
  const backToList = () => setParams({})
  const [listData, setListData] = useState<CompetitionListGrouped | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<DetailLoadError | null>(null)
  const [listAttempt, setListAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setListLoading(true)
    setListError(null)
    competitionApi
      .list()
      .then((res) => {
        if (!cancelled) setListData(res)
      })
      .catch((err) => {
        if (!cancelled) setListError(classifyDetailError(err))
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [listAttempt])

  if (typeof view === 'object') {
    return (
      <div className="pb-10">
        <DetailView id={view.id} onBack={backToList} t={t} />
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-10">
      {listLoading ? (
        <SkeletonPage cards={3} />
      ) : listError || !listData ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
          <p className="card glass p-6 text-center text-sm text-neutral-400">
            {listError === 'forbidden' ? t('gamification.admin.visibleOff') : t('competition.err.retry')}
          </p>
          {listError !== 'forbidden' && (
            <button type="button" onClick={() => setListAttempt((n) => n + 1)} className="cmp-btn-ghost">
              {t('competition.err.retryBtn')}
            </button>
          )}
        </div>
      ) : (
        <ListView data={listData} onOpen={openDetail} t={t} />
      )}
    </div>
  )
}
