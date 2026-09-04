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
  CompetitionMetric,
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

const LIST_GROUPS: Array<keyof CompetitionListGrouped> = ['upcoming', 'running', 'finished']

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

// 倒计时指向哪个时刻：未开赛看开赛，进行中看结束，已结束不再倒计时。
// Which instant the countdown targets: start before it begins, end while running,
// nothing once it's over.
function countdownOf(c: CompetitionSummary, nowMs: number, t: TFunction):
    { label: string; value: string } | null {
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

// 赛事牌：左缘一道状态色带（进行中紫并呼吸、已终审金、其余中性），名称压在
// 顶部，下面一行是计分口径 / 赛道 / 参赛方式三枚芯片，底部是时间窗口与倒计时。
// 整张卡是按钮，按下轻微下沉。
// Competition plate: a status stripe down the left edge (violet and breathing
// while running, gold once settled, neutral otherwise), the name up top, a row of
// metric / track / enrollment chips under it, and the time window plus countdown
// along the bottom. The whole plate is a button that dips slightly on press.
function CompetitionCard({
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
  const tagKey = statusTagKey(c, nowMs)
  const cd = countdownOf(c, nowMs, t)
  const tone = tagKey === 'settled' || tagKey === 'finished' ? 'done'
    : tagKey === 'running' || tagKey === 'regOpen' ? 'live' : 'soon'
  return (
    <button type="button" onClick={onClick} className={`cmp-card cmp-${tone}`}>
      <i className="cmp-stripe" aria-hidden />
      <div className="cmp-card-head">
        <h4 className="cmp-card-name">{c.name}</h4>
        <span className={`tag shrink-0 text-[11px] ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
          {tone === 'live' && <i className="cmp-live-dot" aria-hidden />}
          {t(`competition.status.${tagKey}`)}
        </span>
      </div>
      <div className="cmp-chips">
        <span className="chip">{t(`leaderboard.boards.${c.metric}`)}</span>
        <span className="chip">{t(`competition.track.${c.track}`)}</span>
        <span className="chip">{t(`competition.enrollment.${c.enrollment}`)}</span>
      </div>
      <div className="cmp-card-foot">
        <span className="num">
          {c.startsAt ? fmtDate(c.startsAt) : '—'} → {c.endsAt ? fmtDate(c.endsAt) : '—'}
        </span>
        {cd && (
          <span className="cmp-cd-inline">
            {cd.label} <b className="num">{cd.value}</b>
          </span>
        )}
      </div>
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
  return (
    <div className="space-y-9">
      {LIST_GROUPS.map(
        (g) =>
          data[g].length > 0 && (
            <section key={g}>
              {/* 分组眉头：标题 + 一道贯穿的发丝线 + 场次数，比单独一行小标题更像
                  赛程表的分节。
                  Group header: title, a hairline running across, and the count —
                  reads like a schedule's section break rather than a lone caption. */}
              <div className="cmp-group-h">
                <h3>{t(`competition.status.${g}`)}</h3>
                <i aria-hidden />
                <span className="num">{data[g].length}</span>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {data[g].map((c) => (
                  <CompetitionCard key={c.id} c={c} nowMs={nowMs} t={t} onClick={() => onOpen(c.id)} />
                ))}
              </div>
            </section>
          )
      )}
    </div>
  )
}

// 榜单 = 领奖台（前三，名次铸币 + 中间抬高）+ 其余名次的密排行。数据仍是
// LeaderboardPayload（后端与常设榜共用 build_board_rows_payload），只是这里
// 换一套更"颁奖"的呈现：比赛的意义在名次本身，表格把冠军和第八名画得一样重。
// The board = a podium (top three, rank coins, centre raised) plus dense rows for
// the rest. The data is still a LeaderboardPayload (the backend shares
// build_board_rows_payload with the standing boards); only the presentation
// changes to something ceremonial — in a competition the rank *is* the point, and
// a table draws the champion and the eighth place with equal weight.
function BoardBlock({
  board,
  metric,
  t,
}: {
  board: LeaderboardPayload
  metric: CompetitionMetric
  t: TFunction
}) {
  if (board.rows.length === 0) {
    return (
      <div className="cmp-empty">
        <p>{t('leaderboard.empty')}</p>
      </div>
    )
  }
  const podium = board.rows.slice(0, 3)
  const rest = board.rows.slice(3)
  // 2 | 1 | 3：冠军居中，与排行榜领奖台同一套视觉顺序。
  // 2 | 1 | 3: champion centred, the same visual order as the standing board's podium.
  const order = [2, 1, 3].filter((r) => podium.some((x) => x.rank === r))
  const byRank = new Map(podium.map((r) => [r.rank, r]))
  return (
    <div className="space-y-4">
      <div className={`cmp-podium cmp-podium-${order.length}`}>
        {order.map((rank) => {
          const row = byRank.get(rank)
          if (!row) return null
          return (
            <article key={rank} className={`cmp-plinth ${rank === 1 ? 'is-first' : ''} ${row.isSelf ? 'is-self' : ''}`}>
              {rank === 1 && <i className="cmp-spot" aria-hidden />}
              <RankCoin rank={rank} size={rank === 1 ? 56 : 44} />
              <div className="cmp-plinth-name">
                {row.equippedBadge && (
                  <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={18} />
                )}
                <span>{row.displayName}</span>
              </div>
              <b className={`cmp-plinth-score num ${row.score < 0 ? 'text-down' : 'text-up'}`}>{fmtScorePct(row.score)}</b>
              <span className="cmp-plinth-login num">{row.login}</span>
            </article>
          )
        })}
      </div>

      {rest.length > 0 && (
        <ul className="cmp-rows">
          {rest.map((row) => (
            <li key={row.rank} className={row.isSelf ? 'is-self' : ''}>
              <span className="num cmp-rank">{String(row.rank).padStart(2, '0')}</span>
              <div className="cmp-row-who">
                {row.equippedBadge && (
                  <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={18} />
                )}
                <span className="truncate">{row.displayName}</span>
                {row.isSelf && <span className="tag shrink-0 bg-prism-600/25 text-[10px] text-prism-300">{t('leaderboard.youTag')}</span>}
              </div>
              <span className="num cmp-row-login">{row.login}</span>
              <b className={`num cmp-row-score ${row.score < 0 ? 'text-down' : ''}`}>{fmtScorePct(row.score)}</b>
            </li>
          ))}
        </ul>
      )}
      <p className="cmp-metric-note">{t(`leaderboard.colScore.${metric}`)}</p>
    </div>
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
  const countdown = countdownOf(detail, now, t)
  // 榜上属于我的那一行（后端已经标了 isSelf）——「我的战况」用它取实时名次。
  // My row on the board (the backend already flags isSelf) — the standing block
  // reads the live rank off it.
  const myBoardRow = detail.board.rows.find((r) => r.isSelf) ?? null
  const boardHeading = detail.status === 'settled' ? t('competition.finalBoard') : t('competition.liveBoard')

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-neutral-400 transition-colors hover:text-neutral-200"
      >
        ← {t('competition.backToList')}
      </button>

      {/* ── 赛事横幅 ──────────────────────────────────────────
          纯黑舞台：极光缓漂 + 顶部一道聚光。左边是赛名与状态，右边是倒计时和
          奖品牌（奖品是"荣耀"的落点，值得单独一块金色）。下面一条等宽数据带
          放开赛 / 结束 / 报名窗口。
          Competition banner: a near-black stage with a drifting aurora and a
          spotlight along the top. Name and status on the left, countdown and the
          prize plaque on the right (the prize is where the glory lands and earns
          its own gold block). A mono strip underneath carries start / end /
          registration window. */}
      <section className="cmp-banner">
        <i className="cmp-banner-glow" aria-hidden />
        <div className="cmp-banner-main">
          <div className="min-w-0">
            <div className="cmp-eyebrow">{t('competition.title')}</div>
            <h2 className="cmp-title">{detail.name}</h2>
            <div className="cmp-chips mt-3">
              <span className={`tag text-[11px] ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
                {(tagKey === 'running' || tagKey === 'regOpen') && <i className="cmp-live-dot" aria-hidden />}
                {t(`competition.status.${tagKey}`)}
              </span>
              <span className="chip">{t(`leaderboard.boards.${detail.metric}`)}</span>
              <span className="chip">{t(`competition.track.${detail.track}`)}</span>
              <span className="chip">{t(`competition.enrollment.${detail.enrollment}`)}</span>
            </div>
            {detail.description && <p className="cmp-desc">{detail.description}</p>}
          </div>

          <div className="cmp-banner-side">
            {countdown && (
              <div className="cmp-cd">
                <span>{countdown.label}</span>
                <b className="num">{countdown.value}</b>
              </div>
            )}
            {detail.prizeNote && (
              <div className="cmp-prize">
                <span>{t('competition.prizeNote')}</span>
                <b>{detail.prizeNote}</b>
              </div>
            )}
          </div>
        </div>

        <dl className="cmp-facts">
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
                {detail.regOpensAt ? fmtDate(detail.regOpensAt) : '—'} – {detail.regClosesAt ? fmtDate(detail.regClosesAt) : '—'}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {/* ── 我的战况 ──────────────────────────────────────────
          已报名才出现。有名次就把名次铸币和成绩摆出来（这是用户最想看的一行），
          还没算出名次就说明在等成绩；被取消资格单独标红。
          My standing: only once entered. With a rank it leads with the rank coin and
          score (the one line the user actually came for); without one it says the
          score is still being computed. Disqualified entries are called out in red. */}
      {detail.myEntries.length > 0 && (
        <section className="cmp-mine">
          <div className="cmp-mine-h">
            <h3>{t('competition.myEntries')}</h3>
            {/* 收益率可能为负——按正负上色，不能一律绿（曾经是）。胜率榜恒为正，
                同一套写法两边都对。
                A return can be negative, so colour by sign rather than always green (it
                used to be). A win rate is never negative, so one rule covers both. */}
            {myBoardRow && (
              <span className={`cmp-mine-score num ${myBoardRow.score < 0 ? 'text-down' : 'text-up'}`}>
                {fmtScorePct(myBoardRow.score)}
              </span>
            )}
          </div>
          <ul className="cmp-mine-list">
            {detail.myEntries.map((entry) => {
              const rank = entry.finalRank ?? (myBoardRow?.login === entry.login ? myBoardRow.rank : null)
              return (
                <li key={entry.login} className={entry.disqualified ? 'is-dq' : ''}>
                  {rank != null && rank <= 3 ? (
                    <RankCoin rank={rank} size={34} />
                  ) : (
                    <span className="cmp-mine-rank num">{rank != null ? `#${rank}` : '—'}</span>
                  )}
                  <div className="min-w-0">
                    <b className="num">{entry.login}</b>
                    <span>
                      {entry.disqualified
                        ? t('competition.disqualified')
                        : entry.finalRank != null
                          ? `${t('competition.finalRank')} #${entry.finalRank}`
                          : rank != null
                            ? t('competition.myLiveRank', { n: rank })
                            : t('competition.myPending')}
                    </span>
                  </div>
                  {entry.scoringFrom && (
                    <span className="cmp-mine-from num">
                      {t('competition.scoringFrom')} {fmtDate(entry.scoringFrom)}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* 报名区：仅 signup 赛显示——auto 参赛没有用户可操作的动作，整块连提示
          都不出现。窗口内（rState==='open'）细分三态，靠 availableAccounts（已
          先过滤成"实盘且未报过"）是否为空、以及"是不是因为已经报完"来互斥：
            1) availableAccounts 非空 → 给按钮；
            2) availableAccounts 为空且 enteredLogins 非空 → 能报的实盘账户都报
               了，显示"已报名"标记；
            3) availableAccounts 为空且 enteredLogins 也空 → 这个用户要么压根
               没连接任何账户，要么连了但没有一个是实盘——两种情况下"已报名"
               都是假话（这曾经和 2）混判，对零账户用户显示"已报名"）。用
               accounts.length 是否为零区分这两种子情况，分别指向不同文案：
               零账户复用 noAccounts，有账户但非实盘用新的 noRealAccounts，
               两者都链到绑定页。
          Registration block: signup competitions only — auto-enrollment has no
          user action, so the whole block (including hints) is omitted. Inside
          the open window (rState==='open') there are three mutually exclusive
          states, keyed off whether availableAccounts (already filtered to
          "real and not yet entered") is empty and, if so, whether that's
          because everything eligible is already entered:
            1) availableAccounts non-empty → the register button;
            2) empty AND enteredLogins non-empty → every eligible real account
               is already entered, show the "registered" tag;
            3) empty AND enteredLogins also empty → this user either has no
               connected accounts at all, or has some but none real — in
               both cases "registered" would be a lie (this used to be folded
               into case 2, wrongly showing "registered" to a zero-account
               user). accounts.length === 0 distinguishes the two sub-cases:
               zero accounts reuses noAccounts, accounts-but-none-real uses
               the new noRealAccounts — both link to the bind page. */}
      {canShowRegisterAction && (
        <div className="cmp-register">
          {rState === 'notOpen' && <p className="text-sm text-neutral-400">{t('competition.regNotOpen')}</p>}
          {rState === 'closed' && <p className="text-sm text-neutral-400">{t('competition.regClosed')}</p>}
          {rState === 'open' &&
            (availableAccounts.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setPickerOpen(true)
                  setRegisterError(null)
                }}
                className="btn-primary px-4 py-2 text-sm"
              >
                {t('competition.register')}
              </button>
            ) : enteredLogins.size > 0 ? (
              <span className="tag bg-prism-600/20 text-[11px] text-prism-300">{t('competition.registered')}</span>
            ) : (
              <div>
                <p className="text-sm text-neutral-400">
                  {/* 三选一：零账户 -> noAccounts；有账户、没一个实盘、但有账户
                      tradeMode 还是 null（backfill 尚未跑到/桥接没给分组信息）
                      -> pendingAccountType（"尚未判定"，不能说"没有实盘"，那是
                      在没查清楚之前就下结论）；有账户、都判定过、确实没一个实盘
                      -> noRealAccounts（M-5）。
                      Three-way: zero accounts -> noAccounts; accounts exist,
                      none real, but at least one still has tradeMode null
                      (backfill hasn't reached it yet / bridge gave no group
                      info) -> pendingAccountType ("not yet determined" — must
                      not claim "no real accounts" before it's actually known);
                      accounts exist, all determined, genuinely none real ->
                      noRealAccounts (M-5). */}
                  {accounts.length === 0
                    ? t('competition.noAccounts')
                    : accounts.some((a) => a.tradeMode == null)
                      ? t('competition.pendingAccountType')
                      : t('competition.noRealAccounts')}
                </p>
                <Link
                  to="/bind"
                  className="mt-2 inline-block text-xs text-prism-300 transition hover:text-prism-200"
                >
                  {t('nav.bind')}
                </Link>
              </div>
            ))}
          {registerMsg && <p className="mt-2 text-sm text-up">{registerMsg}</p>}
          {registerError && <p className="mt-2 text-sm text-down">{registerError}</p>}
        </div>
      )}

      <div className="cmp-group-h">
        <h3>{boardHeading}</h3>
        <i aria-hidden />
        {/* ended 且未终审：实时榜仍然显示，但顶一条提示——名次还没定格，别当
            最终结果看。settled 之后不会再出现这个分支（pendingSettle 恒 false）。
            ended and not yet settled: the live board still renders, with a
            hint on top — ranks aren't locked in yet, don't read them as
            final. This branch never fires once settled (pendingSettle is
            always false by then). */}
        {detail.pendingSettle && (
          <span className="tag bg-amber-400/15 text-[11px] text-amber-300">{t('competition.pendingSettle')}</span>
        )}
      </div>
      <BoardBlock board={detail.board} metric={detail.metric} t={t} />

      {/* 规则挪到最底：进详情是来看名次的，规则是查证用的，不该挡在前面。
          Rules moved to the bottom: people open a competition to see standings; the
          rules are there to check against, not to wade through first. */}
      <ul className="cmp-rules">
        <li>{t('competition.rules.scoringFrom')}</li>
        <li>{t('competition.rules.minSamples')}</li>
        <li>{t('competition.rules.final')}</li>
      </ul>

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
