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
import { BADGE_RARITY } from '../components/badges/badgeRarity'
import type {
  CompetitionDetail,
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

const LIST_GROUPS: Array<keyof CompetitionListGrouped> = ['upcoming', 'running', 'finished']

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

function CompetitionCard({
  c,
  onClick,
  t,
}: {
  c: CompetitionSummary
  onClick: () => void
  t: TFunction
}) {
  const tagKey = statusTagKey(c, Date.now())
  return (
    <button
      type="button"
      onClick={onClick}
      className="card glass w-full p-4 text-left transition hover:border-prism-400/40"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-semibold text-neutral-100">{c.name}</h4>
        <span className={`tag shrink-0 text-[11px] ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
          {t(`competition.status.${tagKey}`)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="tag bg-white/5 text-[11px] text-neutral-300">
          {t(`leaderboard.boards.${c.metric}`)}
        </span>
        <span className="tag bg-white/5 text-[11px] text-neutral-400">
          {t(`competition.enrollment.${c.enrollment}`)}
        </span>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        {c.startsAt ? fmtDate(c.startsAt) : '—'} → {c.endsAt ? fmtDate(c.endsAt) : '—'}
      </p>
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
  const empty = LIST_GROUPS.every((g) => data[g].length === 0)
  if (empty) {
    return (
      <div className="flex min-h-[30vh] items-center justify-center">
        <p className="card glass p-6 text-center text-sm text-neutral-400">{t('competition.empty')}</p>
      </div>
    )
  }
  return (
    <div className="space-y-8">
      {LIST_GROUPS.map(
        (g) =>
          data[g].length > 0 && (
            <section key={g}>
              <h3 className="sec-h-title mb-3">{t(`competition.status.${g}`)}</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {data[g].map((c) => (
                  <CompetitionCard key={c.id} c={c} t={t} onClick={() => onOpen(c.id)} />
                ))}
              </div>
            </section>
          )
      )}
    </div>
  )
}

// 实时/最终榜表格：逐字复用 LeaderboardPage 的行渲染模式（打码名+佩戴勋章、
// 账户号、score%、笔数、isSelf 高亮），列头把"分数"列换成该比赛计分指标对应的
// leaderboard.colScore.<metric> ——CompetitionDetail.board 本就是同一套
// LeaderboardPayload 形状（后端 build_board_rows_payload 共用）。
// Live/final board table: reuses LeaderboardPage's row-rendering pattern
// verbatim (masked name + equipped badge, account login, score%, sample
// count, isSelf highlight). The score column header swaps in this
// competition's metric via leaderboard.colScore.<metric> — CompetitionDetail
// .board is already the same LeaderboardPayload shape (shared server-side via
// build_board_rows_payload).
function BoardTable({
  board,
  metric,
  t,
}: {
  board: LeaderboardPayload
  metric: CompetitionMetric
  t: TFunction
}) {
  if (board.rows.length === 0) {
    return <p className="p-6 text-center text-sm text-neutral-400">{t('leaderboard.empty')}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-neutral-500">
            <th className="py-2.5 pl-4 pr-2 font-medium">{t('leaderboard.colRank')}</th>
            <th className="py-2.5 pr-2 font-medium">{t('leaderboard.colTrader')}</th>
            <th className="py-2.5 pr-2 font-medium">{t('leaderboard.colAccount')}</th>
            <th className="py-2.5 pr-2 font-medium">{t(`leaderboard.colScore.${metric}`)}</th>
            <th className="py-2.5 pr-4 font-medium">{t('leaderboard.colSample')}</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((row) => (
            <tr key={row.rank} className={`border-t border-white/5 ${row.isSelf ? 'bg-prism-600/10' : ''}`}>
              <td className="num py-2.5 pl-4 pr-2 text-neutral-300">{row.rank}</td>
              <td className="py-2.5 pr-2">
                <div className="flex items-center gap-2">
                  {row.equippedBadge && (
                    <BadgeIcon
                      id={row.equippedBadge}
                      rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'}
                      earned
                      size={20}
                    />
                  )}
                  <span className={row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-200'}>
                    {row.displayName}
                  </span>
                  {row.isSelf && (
                    <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">
                      {t('leaderboard.youTag')}
                    </span>
                  )}
                </div>
              </td>
              <td className="num py-2.5 pr-2 text-neutral-400">{row.login}</td>
              <td className="num py-2.5 pr-2 font-semibold text-neutral-100">{fmtScorePct(row.score)}</td>
              <td className="num py-2.5 pr-4 text-neutral-500">{row.sample}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

  const now = Date.now()
  const tagKey = statusTagKey(detail, now)
  const rState = regState(detail, now)
  const enteredLogins = new Set(detail.myEntries.map((e) => e.login))
  // 只列本人已连接、是实盘、且这场比赛还没报过的账户——报过的再选一遍，后端会
  // 幂等返回原条目而不是报错，但前端不必让用户白走一趟；非实盘账户报名注定
  // 被后端拒绝，同样不必列出来。
  // Only accounts that are connected, real-money, and not yet entered in this
  // competition: re-picking an entered one would just get the same row back
  // idempotently from the backend, and a non-real account would be rejected
  // by the backend anyway — neither is worth listing.
  const availableAccounts = accounts.filter((a) => isRealAccount(a) && !enteredLogins.has(a.login))
  const canShowRegisterAction = detail.enrollment === 'signup'
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

      <div className="card glass p-5">
        <h2 className="font-display text-xl font-bold text-neutral-100">{detail.name}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`tag text-[11px] ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
            {t(`competition.status.${tagKey}`)}
          </span>
          <span className="tag bg-white/5 text-[11px] text-neutral-300">
            {t(`leaderboard.boards.${detail.metric}`)}
          </span>
          <span className="tag bg-white/5 text-[11px] text-neutral-400">
            {t(`competition.enrollment.${detail.enrollment}`)}
          </span>
        </div>

        {detail.description && (
          <p className="mt-4 text-sm leading-relaxed text-neutral-300">{detail.description}</p>
        )}

        <div className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div>
            <span className="text-neutral-500">{t('competition.starts')}</span>
            <p className="num mt-0.5 text-neutral-200">{detail.startsAt ? fmtDate(detail.startsAt) : '—'}</p>
          </div>
          <div>
            <span className="text-neutral-500">{t('competition.ends')}</span>
            <p className="num mt-0.5 text-neutral-200">{detail.endsAt ? fmtDate(detail.endsAt) : '—'}</p>
          </div>
          {detail.enrollment === 'signup' && (
            <div className="sm:col-span-2">
              <span className="text-neutral-500">{t('competition.regWindow')}</span>
              <p className="num mt-0.5 text-neutral-200">
                {detail.regOpensAt ? fmtDate(detail.regOpensAt) : '—'} –{' '}
                {detail.regClosesAt ? fmtDate(detail.regClosesAt) : '—'}
              </p>
            </div>
          )}
          {detail.prizeNote && (
            <div className="sm:col-span-2">
              <span className="text-neutral-500">{t('competition.prizeNote')}</span>
              <p className="mt-0.5 text-neutral-200">{detail.prizeNote}</p>
            </div>
          )}
        </div>

        <ul className="mt-4 space-y-1 text-xs leading-relaxed text-neutral-500">
          <li>{t('competition.rules.scoringFrom')}</li>
          <li>{t('competition.rules.minSamples')}</li>
          <li>{t('competition.rules.final')}</li>
        </ul>
      </div>

      {detail.myEntries.length > 0 && (
        <div className="card glass p-5">
          <h3 className="sec-h-title">{t('competition.myEntries')}</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {detail.myEntries.map((entry) => (
              <span
                key={entry.login}
                className={`tag text-[11px] ${
                  entry.disqualified ? 'bg-down/15 text-down' : 'bg-white/5 text-neutral-300'
                }`}
              >
                {entry.login}
                {entry.scoringFrom && (
                  <>
                    {' · '}
                    {t('competition.scoringFrom')} {fmtDate(entry.scoringFrom)}
                  </>
                )}
                {entry.finalRank != null && (
                  <>
                    {' · '}
                    {t('competition.finalRank')} #{entry.finalRank}
                  </>
                )}
                {entry.disqualified && (
                  <>
                    {' · '}
                    {t('competition.disqualified')}
                  </>
                )}
              </span>
            ))}
          </div>
        </div>
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
        <div className="card glass p-5">
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
                  {accounts.length === 0 ? t('competition.noAccounts') : t('competition.noRealAccounts')}
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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="sec-h-title">{boardHeading}</h3>
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
      <section className="card glass overflow-hidden p-0">
        <BoardTable board={detail.board} metric={detail.metric} t={t} />
      </section>

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
