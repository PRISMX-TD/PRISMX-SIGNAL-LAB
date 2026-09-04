// 比赛页（Phase 3）：列表（三组分区：即将开始/进行中/已结束）+ 详情（同页状态
// 切换，不开子路由——列表和详情共用一次数据加载，切回列表也不必重新拉取）。
// 入口本身按 competitionsVisible 门控（见 Layout/UserMenu），这里只处理直接打
// URL 绕过入口的情况——理论上只有内测期的普通用户会撞上 403，兜底成一句提示
// 而不是把接口错误糊在脸上（照 AchievementsPage/LeaderboardPage 的先例）。
//
// Competitions page (Phase 3): a list (three sections: upcoming/running/
// finished) + a detail view (same-page state switch, no sub-route — list and
// detail load independently, so going back to the list needs no refetch). The
// entry point itself is gated on competitionsVisible (see Layout/UserMenu);
// this only handles someone hitting the URL directly — in practice only a
// regular user during the beta window, degraded to one line of copy instead
// of a raw API error (same precedent as AchievementsPage/LeaderboardPage).
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { competitionApi } from '../api/client'
import { fmtDate, localizeApiError, parseTime } from '../api/utils'
import { useLive } from '../store/live'
import { SkeletonPage } from '../components/Skeleton'
import BadgeIcon from '../components/badges/BadgeIcon'
import RankCoin from '../components/badges/RankCoin'
import { BADGE_RARITY } from '../components/badges/badgeRarity'
import type {
  CompetitionDetail,
  CompetitionTrack,
  CompetitionListGrouped,
  CompetitionSummary,
  LeaderboardPayload,
  MT5Account,
} from '../api/types'

// score 是分数（0.124 = 12.4%），与 LeaderboardPage 同一套显示规则——两榜口径
// 不同但显示格式一致，各自本地定义一份，不为一行代码搭一个共享模块。
// score is a fraction (0.124 = 12.4%); same display rule as LeaderboardPage.
// Both pages define this locally rather than sharing a module for one line.
const fmtScorePct = (v: number): string => `${(v * 100).toFixed(1)}%`

// tradeMode: 0=模拟, 1=竞赛, 2=实盘, null/undefined=尚未判定（见后端
// services/account_type.py）。报名只认实盘，未判定的一律当"非实盘"处理，
// 不能默认放行。
// tradeMode: 0=demo, 1=contest, 2=real, null/undefined=not yet determined
// (see backend services/account_type.py). Registration only accepts real
// accounts; an undetermined value is treated as "not real", never
// default-allowed.
const isRealAccount = (a: MT5Account): boolean => a.tradeMode === 2
// 账户是否符合这场比赛的赛道：实盘赛只收 tradeMode===2，模拟赛只收 0/1
//（模拟与赛区）。未判定（null/undefined）两个赛道都不收——后端同样拒绝。
// Whether an account matches this competition's track: a live competition takes
// tradeMode===2 only, a demo one takes 0/1 (demo and contest). Unclassified
// (null/undefined) matches neither, and the backend refuses it too.
const matchesTrack = (a: MT5Account, track: CompetitionTrack): boolean =>
  track === 'demo' ? a.tradeMode === 0 || a.tradeMode === 1 : isRealAccount(a)

const LIST_GROUPS: Array<keyof CompetitionListGrouped> = ['running', 'upcoming', 'finished']

// 每 30 秒走一次的时钟：倒计时与"进行中/已结束"的判定都读它。30 秒够用——
// 倒计时最小单位是分钟，秒级刷新只是白白重渲染整页。
// A 30s clock driving both the countdown and the running/ended checks. 30s is
// enough: the countdown's smallest unit is a minute, and a per-second tick would
// re-render the whole page for nothing.
function useNowTicker(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

// 倒计时文案：只取最大的两个单位（3 天 5 小时 / 5 小时 12 分 / 12 分），
// 不足一分钟给"即将"。比赛跨度以天计，精确到秒既没用也让人焦虑。
// Countdown copy: the two largest units only (3d 5h / 5h 12m / 12m), with
// "any moment" under a minute. Competitions span days; second-level precision
// would be useless and needlessly anxious.
function fmtCountdown(ms: number, t: TFunction): string {
  if (ms <= 0) return ''
  const mins = Math.floor(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return t('competition.cd.dh', { d, h })
  if (h > 0) return t('competition.cd.hm', { h, m })
  if (m > 0) return t('competition.cd.m', { m })
  return t('competition.cd.soon')
}

// 详情页的钟表：把倒计时拆成 天 / 小时 / 分 三格大数字（不足一天只给两格），
// 到点返回 parts=null 让页面写"即将"。与列表卡的一句话倒计时同一套时刻判定。
// The detail page clock: the countdown split into day / hour / minute cells of
// large numerals (two cells under a day); parts=null at zero so the page can say
// "any moment". Same target-instant rule as the one-line countdown on list cards.
type ClockUnit = 'd' | 'h' | 'm'
function clockOf(c: CompetitionSummary, nowMs: number, t: TFunction):
    { label: string; parts: Array<{ unit: ClockUnit; value: number }> | null } | null {
  // 已结束 / 已终审（可能是提前强制终审）没有什么可倒数的，哪怕 endsAt 还在未来。
  // Ended / settled (possibly force-settled early) has nothing left to count down,
  // even when endsAt is still in the future.
  if (c.status === 'ended' || c.status === 'settled') return null
  const starts = parseTime(c.startsAt)?.getTime() ?? null
  const ends = parseTime(c.endsAt)?.getTime() ?? null
  const target = starts != null && nowMs < starts
    ? { label: t('competition.cd.toStart'), at: starts }
    : ends != null && nowMs < ends
      ? { label: t('competition.cd.toEnd'), at: ends }
      : null
  if (!target) return null
  const mins = Math.floor((target.at - nowMs) / 60_000)
  if (mins <= 0) return { label: target.label, parts: null }
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const parts: Array<{ unit: ClockUnit; value: number }> = d > 0
    ? [{ unit: 'd', value: d }, { unit: 'h', value: h }, { unit: 'm', value: m }]
    : [{ unit: 'h', value: h }, { unit: 'm', value: m }]
  return { label: target.label, parts }
}

// 倒计时指向哪个时刻：未开赛看开赛，进行中看结束，已结束不再倒计时。
// Which instant the countdown targets: start before it begins, end while running,
// nothing once it's over.
function countdownOf(c: CompetitionSummary, nowMs: number, t: TFunction):
    { label: string; value: string } | null {
  if (c.status === 'ended' || c.status === 'settled') return null
  // parseTime 返回 Date，倒计时要的是毫秒差，先取时间戳。
  // parseTime returns a Date; the countdown needs a millisecond delta, so take the stamp.
  const starts = parseTime(c.startsAt)?.getTime() ?? null
  const ends = parseTime(c.endsAt)?.getTime() ?? null
  if (starts != null && nowMs < starts) {
    return { label: t('competition.cd.toStart'), value: fmtCountdown(starts - nowMs, t) }
  }
  if (ends != null && nowMs < ends) {
    return { label: t('competition.cd.toEnd'), value: fmtCountdown(ends - nowMs, t) }
  }
  return null
}

// 状态 tag 的取值集合与 i18n competition.status 的键一一对应：upcoming/running/
// settled 直接照抄 comp.status；仅两处不直接照抄——comp.status=="ended" 对应
// i18n 键是 "finished"（用户端措辞，不是内部状态名）；comp.status=="upcoming"
// 且报名制、当前恰好在报名窗口内时，细分成 "regOpen"，比笼统的"即将开始"更
// 有信息量（该干嘛写在 tag 上，用户不用点进详情才知道能不能报名）。
//
// The status-tag value set maps 1:1 onto the i18n competition.status keys:
// upcoming/running/settled are copied straight from comp.status. Two are not:
// comp.status=="ended" maps to the i18n key "finished" (user-facing wording,
// not the internal state name); and comp.status=="upcoming" with signup
// enrollment currently inside its registration window is narrowed to
// "regOpen" — more informative than a blanket "upcoming" tag, since it tells
// the user whether they can register without opening the detail view.
function statusTagKey(c: CompetitionSummary, nowMs: number): string {
  if (c.status === 'upcoming' && regState(c, nowMs) === 'open') return 'regOpen'
  if (c.status === 'ended') return 'finished'
  return c.status
}

const STATUS_TAG_CLASS: Record<string, string> = {
  upcoming: 'bg-neutral-500/15 text-neutral-400',
  regOpen: 'bg-prism-600/20 text-prism-300',
  running: 'bg-up/15 text-up',
  finished: 'bg-neutral-500/15 text-neutral-400',
  settled: 'bg-blue-400/15 text-blue-300',
}

// 报名窗口状态：仅 enrollment=="signup" 且报名窗口两端都有值时才有意义——auto
// 参赛没有报名这回事，signup 赛的报名窗口后端建库时已强制两端必填（见
// routers/competitions.py 的 _validate_reg_window），这里仍防御性地处理 null。
// Registration-window state: only meaningful for enrollment=="signup" with
// both window ends set — auto-enrollment has no such window, and a signup
// competition's window is enforced non-null at creation server-side (see
// routers/competitions.py's _validate_reg_window); null is still handled
// defensively here.
function regState(c: CompetitionSummary, nowMs: number): 'notOpen' | 'open' | 'closed' | null {
  if (c.enrollment !== 'signup') return null
  const opens = c.regOpensAt ? parseTime(c.regOpensAt)?.getTime() : null
  const closes = c.regClosesAt ? parseTime(c.regClosesAt)?.getTime() : null
  if (opens == null || closes == null) return null
  if (nowMs < opens) return 'notOpen'
  if (nowMs >= closes) return 'closed'
  return 'open'
}

// 状态行：状态芯片 + 计分口径 / 赛道 / 参赛方式，发丝线隔开。列表与详情共用。
// The status line: status pill plus metric / track / enrollment, hairline-separated.
// Shared by the list and the detail.
function StatusLine({ c, tagKey, t }: { c: CompetitionSummary; tagKey: string; t: TFunction }) {
  const live = tagKey === 'running' || tagKey === 'regOpen'
  return (
    <div className="cmp-kicker">
      <span className={`cmp-status-tag ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
        {live && <i className="cmp-live-dot" aria-hidden />}
        {t(`competition.status.${tagKey}`)}
      </span>
      <span>{t(`leaderboard.boards.${c.metric}`)}</span>
      <span>{t(`competition.track.${c.track}`)}</span>
      <span>{t(`competition.enrollment.${c.enrollment}`)}</span>
    </div>
  )
}

// 列表上的时间窗口只到日：两端各带时分和时区的一串在手机上要折两行，而列表
// 只需要知道"哪几天"，精确到分钟的时刻详情页才需要。
// Time windows on the list stop at the day: two full timestamps with zone wrap onto
// two lines on a phone, and the list only needs "which days"; minute precision
// belongs to the detail page.
const fmtDay = (iso: string): string =>
  (parseTime(iso) ?? new Date(NaN)).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  })
const fmtRange = (c: CompetitionSummary) =>
  `${c.startsAt ? fmtDay(c.startsAt) : '—'} → ${c.endsAt ? fmtDay(c.endsAt) : '—'}`

// 转播角标的读数：固定 DD:HH:MM，不足一天也补 00，读数的位置和宽度永远不变。
// The broadcast bug's readout: always DD:HH:MM, zero-padded under a day, so the
// readout never changes place or width.
function bugReadout(parts: Array<{ unit: ClockUnit; value: number }>): string {
  const v: Record<ClockUnit, number> = { d: 0, h: 0, m: 0 }
  for (const p of parts) v[p.unit] = p.value
  return [v.d, v.h, v.m].map((n) => String(n).padStart(2, '0')).join(':')
}

// 分数按正负上色：收益率会为负，胜率恒为正，同一条规则两边都对。
// Score coloured by sign: a return can be negative, a win rate never is, and one
// rule covers both.
function ScoreText({ score, className = '' }: { score: number; className?: string }) {
  return (
    <b className={`num ${score < 0 ? 'text-down' : 'text-up'} ${className}`}>{fmtScorePct(score)}</b>
  )
}

const badgeOf = (id: string | null | undefined) =>
  id ? <BadgeIcon id={id} rarity={BADGE_RARITY[id] ?? 'common'} earned size={18} /> : null

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
              {String(i + 1).padStart(2, '0')} <b>{r.displayName}</b> <ScoreText score={r.score} />
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
              <b>{badgeOf(champ.equippedBadge)}<span className="truncate">{champ.displayName}</span></b>
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

// ── 详情：名次梯 ──
// 名次是 54px 的描边巨型数字，只有第一名填成金色；每行一根按分数比例的细线
// （负数红色），分数 24px 在最右。表格把冠军和第八名画得一样重，这个不会。
// The ladder: ranks as 54px outlined giants, only #1 filled gold; a thin bar per row
// proportional to the score (red when negative), the score at 24px on the right. A
// table draws the champion and the eighth place with equal weight; this doesn't.
function Ladder({ board, t }: { board: LeaderboardPayload; t: TFunction }) {
  if (board.rows.length === 0) {
    return (
      <div className="cmp-empty">
        <p>{t('leaderboard.empty')}</p>
      </div>
    )
  }
  const maxAbs = Math.max(...board.rows.map((r) => Math.abs(r.score)), 1e-9)
  return (
    <ol className="cmp-ladder">
      {board.rows.map((row) => (
        <li key={`${row.rank}-${row.login}`} className={row.isSelf ? 'is-self' : ''}>
          <span className="cmp-ladder-rank">{String(row.rank).padStart(2, '0')}</span>
          <div className="cmp-ladder-who">
            <b>
              {badgeOf(row.equippedBadge)}
              <span className="truncate">{row.displayName}</span>
              {row.isSelf && <span className="cmp-you">{t('leaderboard.youTag')}</span>}
            </b>
            <span className="num">{row.login}</span>
          </div>
          <i
            className={`cmp-ladder-bar ${row.score < 0 ? 'is-neg' : ''}`}
            style={{ width: `${Math.max(2, (Math.abs(row.score) / maxAbs) * 100)}%` }}
            aria-hidden
          />
          <ScoreText score={row.score} className="cmp-ladder-score" />
        </li>
      ))}
    </ol>
  )
}

// 参赛账户选择弹窗：复用 SlideOrderModal/ConfirmModal 的 portal-to-body + 玻璃卡
// 居中弹窗模式（原因同 ConfirmModal 顶部注释——本页调用点本身就在 .glass 卡片
// 内部，不 portal 会被 backdrop-filter 截断）。列表来自 useLive().accounts（见
// DetailView 的说明），调用方（DetailView）已经用 isRealAccount 过滤过，这里
// 收到的都是实盘账户；后端仍会独立复核一遍并在选错时用 400 拒绝，前端过滤只是
// 少让用户走一趟弯路，不是唯一防线。
// Entry-account picker: reuses the SlideOrderModal/ConfirmModal
// portal-to-body + centered glass-card modal pattern (same reason as
// ConfirmModal's top comment — this page's call site sits inside a .glass
// card, and skipping the portal would get clipped by its backdrop-filter).
// The list comes from useLive().accounts (see DetailView's comment); the
// caller (DetailView) has already filtered it with isRealAccount, so
// everything here is a real account. The backend still validates
// independently and rejects an ineligible pick with a 400 — this client-side
// filter just saves the user a wasted round trip, it isn't the only guard.
function AccountPickerModal({
  accounts,
  busy,
  onCancel,
  onConfirm,
  t,
}: {
  accounts: MT5Account[]
  busy: boolean
  onCancel: () => void
  onConfirm: (login: string) => void
  t: TFunction
}) {
  const [login, setLogin] = useState<string | null>(accounts[0]?.login ?? null)
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="glass-card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-white">{t('competition.pickAccount')}</h3>
        <p className="mt-2 text-xs text-neutral-500">{t('competition.pickAccountHint')}</p>
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

function DetailView({ id, onBack, t }: { id: string; onBack: () => void; t: TFunction }) {
  // 账户来源用 useLive().accounts 而不是另发一次 accountApi.list()：这份状态
  // 已经在 LiveProvider（Layout 挂的）里全站共享、随桥接心跳保持新鲜，
  // SlideOrderModal 的账户选择器就是这么拿的——同一个先例，这里不重新造。
  // GET /bridge/accounts 的响应（MT5AccountOut）现在带 tradeMode 字段，下面
  // 用 isRealAccount 在本地把非实盘账户过滤掉；后端仍然独立复核（见
  // AccountPickerModal 的说明），前端过滤只是不再把模拟/竞赛账户列出来让用户
  // 白选一次。
  // Accounts come from useLive().accounts rather than a second
  // accountApi.list() call: that state is already shared app-wide via
  // LiveProvider (mounted by Layout) and kept fresh by the bridge heartbeat —
  // SlideOrderModal's own account switcher sources it the same way, so this
  // follows the same precedent rather than reinventing it. GET
  // /bridge/accounts's response (MT5AccountOut) now carries a tradeMode
  // field, filtered locally below via isRealAccount. The backend still
  // validates independently (see AccountPickerModal's comment) — the
  // client-side filter just keeps demo/contest accounts from being listed as
  // pickable in the first place.
  const { accounts } = useLive()
  const nowMs = useNowTicker()
  const [detail, setDetail] = useState<CompetitionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registerError, setRegisterError] = useState<string | null>(null)
  const [registerMsg, setRegisterMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setForbidden(false)
    competitionApi
      .detail(id)
      .then((res) => {
        if (!cancelled) setDetail(res)
      })
      .catch(() => {
        if (!cancelled) setForbidden(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

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
      setRegisterMsg(t('competition.registerSuccess'))
      await refreshDetail()
    } catch (err) {
      setRegisterError(err instanceof Error ? localizeApiError(err.message) : t('common.error'))
    } finally {
      setRegistering(false)
    }
  }

  if (loading) {
    return <SkeletonPage cards={2} />
  }

  if (forbidden || !detail) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="card glass p-6 text-center text-sm text-neutral-400">
          {t('gamification.admin.visibleOff')}
        </p>
      </div>
    )
  }

  const now = nowMs
  const tagKey = statusTagKey(detail, now)
  const rState = regState(detail, now)
  const enteredLogins = new Set(detail.myEntries.map((e) => e.login))
  // 只列本人已连接、符合本场赛道、且这场比赛还没报过的账户——报过的再选一遍，
  // 后端会幂等返回原条目而不是报错，但前端不必让用户白走一趟；赛道不符的账户
  // 报名注定被后端拒绝，同样不必列出来。
  // Only accounts that are connected, match this competition's track, and aren't
  // entered yet: re-picking an entered one would just get the same row back
  // idempotently from the backend, and an off-track account would be rejected by
  // the backend anyway — neither is worth listing.
  const availableAccounts = accounts.filter(
    (a) => matchesTrack(a, detail.track) && !enteredLogins.has(a.login))
  const canShowRegisterAction = detail.enrollment === 'signup'
  const clock = clockOf(detail, now, t)
  // 榜上属于我的行按账户号索引（后端已标 isSelf；一人可带多个账户参赛，各占
  // 一行）——「你的名次」逐账户取实时名次与分数。
  // My rows on the board keyed by login (the backend flags isSelf; one person can
  // enter several accounts, one row each). "Your rank" reads live rank and score
  // per account off this.
  const myRows = new Map(detail.board.rows.filter((r) => r.isSelf).map((r) => [r.login, r]))
  const boardHeading = detail.status === 'settled' ? t('competition.finalBoard') : t('competition.liveBoard')

  return (
    <div className="cmp-detail">
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
          {detail.description && <p className="cmp-desc">{detail.description}</p>}

          <div className="cmp-clock">
            {clock?.parts ? (
              ['d', 'h', 'm'].map((u) => {
                const part = clock.parts!.find((x) => x.unit === u)
                return (
                  <div key={u}>
                    <b className="num">{String(part?.value ?? 0).padStart(2, '0')}</b>
                    <span>{t(`competition.cd.units.${u}`)}</span>
                  </div>
                )
              })
            ) : (
              <div className="is-wide">
                <b className="num is-text">{clock ? t('competition.cd.soon') : detail.endsAt ? fmtDate(detail.endsAt) : '—'}</b>
                <span>{clock ? clock.label : t('competition.ends')}</span>
              </div>
            )}
          </div>

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
                  </div>
                )
              })}
            </div>
          )}

          <dl className="cmp-facts">
            {detail.prizeNote && (
              <div>
                <dt>{t('competition.prizeLabel')}</dt>
                <dd className="is-prize">{detail.prizeNote}</dd>
              </div>
            )}
            <div>
              <dt>{t('competition.starts')}</dt>
              <dd className="num">{detail.startsAt ? fmtDate(detail.startsAt) : '—'}</dd>
            </div>
            <div>
              <dt>{t('competition.ends')}</dt>
              <dd className="num">{detail.endsAt ? fmtDate(detail.endsAt) : '—'}</dd>
            </div>
            {detail.enrollment === 'signup' && (
              <div>
                <dt>{t('competition.regWindow')}</dt>
                <dd className="num">
                  {detail.regOpensAt ? fmtDay(detail.regOpensAt) : '—'} – {detail.regClosesAt ? fmtDay(detail.regClosesAt) : '—'}
                </dd>
              </div>
            )}
          </dl>

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
              {rState === 'open' &&
                (availableAccounts.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPickerOpen(true)
                      setRegisterError(null)
                    }}
                    className={enteredLogins.size > 0 ? 'cmp-btn-ghost' : 'cmp-btn'}
                  >
                    {t(enteredLogins.size > 0 ? 'competition.registerMore' : 'competition.register')}
                  </button>
                ) : enteredLogins.size > 0 ? null : (
                  <div>
                    <p>
                      {accounts.length === 0
                        ? t('competition.noAccounts')
                        : accounts.some((a) => a.tradeMode == null)
                          ? t('competition.pendingAccountType')
                          : t('competition.noRealAccounts')}
                    </p>
                    <Link to="/bind" className="mt-1 inline-block text-xs text-prism-300 transition hover:text-prism-200">
                      {t('nav.bind')}
                    </Link>
                  </div>
                ))}
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
          <Ladder board={detail.board} t={t} />
          <ul className="cmp-rules">
            <li>{t('competition.rules.scoringFrom')}</li>
            <li>{t('competition.rules.minSamples')}</li>
            <li>{t('competition.rules.final')}</li>
          </ul>
        </main>
      </div>

      {pickerOpen && (
        <AccountPickerModal
          accounts={availableAccounts}
          busy={registering}
          onCancel={() => setPickerOpen(false)}
          onConfirm={handleRegister}
          t={t}
        />
      )}
    </div>
  )
}

export default function CompetitionsPage() {
  const { t } = useTranslation()
  // 同页状态切换，不开子路由（先例同 SupportPage 的 View = 'list' | 'form' |
  // {ticket}）：列表和详情是两次独立请求，没有必要为一个"看一场比赛详情"的
  // 动作单独挂一条 /competitions/:id 路由再处理浏览器历史。
  // Same-page state switch, no sub-route (same precedent as SupportPage's
  // View = 'list' | 'form' | {ticket}): list and detail are two independent
  // requests, and viewing one competition's detail doesn't warrant its own
  // /competitions/:id route plus browser-history handling.
  const [view, setView] = useState<'list' | { id: string }>('list')
  const [listData, setListData] = useState<CompetitionListGrouped | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listForbidden, setListForbidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    competitionApi
      .list()
      .then((res) => {
        if (!cancelled) setListData(res)
      })
      .catch(() => {
        if (!cancelled) setListForbidden(true)
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (typeof view === 'object') {
    return (
      <div className="mx-auto max-w-[1100px] pb-10">
        <DetailView id={view.id} onBack={() => setView('list')} t={t} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 pb-10">
      <h2 className="font-display text-2xl font-bold text-neutral-100">
        <span className="neon-text">{t('competition.title')}</span>
      </h2>

      {listLoading ? (
        <SkeletonPage cards={3} />
      ) : listForbidden || !listData ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <p className="card glass p-6 text-center text-sm text-neutral-400">
            {t('gamification.admin.visibleOff')}
          </p>
        </div>
      ) : (
        <ListView data={listData} onOpen={(id) => setView({ id })} t={t} />
      )}
    </div>
  )
}
