// 成就页：称号/等级头部 + 五个闯关条件组 + 勋章墙。
// 入口本身按 gamificationVisible 门控（见 Layout/UserMenu），这里只处理直接
// 打 URL 绕过入口的情况——理论上只有内测期的普通用户会撞上 403，兜底成一句
// 提示而不是把接口错误糊在脸上。
// Achievements page: title/level header + the five condition groups + the
// badge wall. The entry point itself is gated on gamificationVisible (see
// Layout/UserMenu); this only handles someone hitting the URL directly —
// in practice only a regular user during the beta window, degraded to one
// line of copy instead of a raw API error.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { gamificationApi, userApi } from '../api/client'
import { localizeApiError, fmtDate } from '../api/utils'
import { fmtPct } from '../components/winrate/shared'
import { SkeletonPage } from '../components/Skeleton'
import BadgeIcon from '../components/badges/BadgeIcon'
import MedalTilt from '../components/badges/MedalTilt'
import BadgeDetailModal from '../components/badges/BadgeDetailModal'
import type { GamificationBadge, GamificationBadgeRarity, GamificationMe, GamificationTask } from '../api/types'

const RARITY_ORDER: GamificationBadgeRarity[] = ['common', 'rare', 'epic', 'legendary', 'limited']

// 铸造瞬间只在用户第一次看到这枚新勋章时播——已看过的记进 localStorage（try/
// catch 包住每次读写：隐私模式/存储已满都不该炸页面，退化成"每次都当作已看
// 过"，最多是少放一次动画，不是报错）。
// The mint moment plays only the first time a user sees a given new badge —
// seen ids live in localStorage (every read/write wrapped in try/catch:
// private browsing or a full quota shouldn't crash the page, it just
// degrades to "treat as already seen", i.e. one skipped animation, not an
// error).
const SEEN_BADGES_KEY = 'prismx_badges_seen'
// 首次铸造动画错峰上限：一次性拿到 17 枚也只放最近获得的 3 枚，其余静默标记
// 已看过——不然新用户一进成就页要盯着 17 遍"毛坯→压印→闪光→流光"。
// Cap on staggered first-time mint animations: even a first load with all 17
// badges earned only plays the 3 most recently awarded; the rest are marked
// seen silently — otherwise a new user would sit through 17 rounds of
// blank -> strike -> flash -> sweep.
const MINT_STAGGER_CAP = 3
const MINT_DURATION_MS = 2200

function readSeenBadges(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_BADGES_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function writeSeenBadges(ids: Set<string>): void {
  try {
    localStorage.setItem(SEEN_BADGES_KEY, JSON.stringify([...ids]))
  } catch {
    // 存储不可用（隐私模式/已满）：静默放弃，下次加载顶多重放一次铸造动画。
    // Storage unavailable (private mode / full quota): give up silently —
    // worst case the mint animation replays once on the next load.
  }
}

function markBadgeSeen(id: string): void {
  const seen = readSeenBadges()
  seen.add(id)
  writeSeenBadges(seen)
}

// 进度数字：lots 类条件可能带小数（stats 按 4 位小数四舍五入），交易数/交易日
// 都是整数——这里统一"整数不带小数点，小数最多两位"，不针对条件类型特判。
// Progress numbers: lot-based conditions can carry a fraction (stats round to
// 4dp); trade/day counts are integers. Uniformly "no decimals when whole,
// at most 2dp otherwise" rather than special-casing by condition type.
function fmtProgressNum(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--up)" strokeWidth="2.2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

// 胜率毕业考条件的 tag 配色：done 走 CheckIcon 不会到这里；pending 用中性面
// （还没到，不该给它已完成的绿），locked 更淡一档。
// Colouring for the win-rate graduation tag: "done" never reaches here (it
// renders CheckIcon instead); "pending" stays neutral (not yet met, so no
// green), "locked" one shade fainter.
function taskStateClass(state: 'locked' | 'pending' | 'done'): string {
  if (state === 'pending') return 'bg-white/[0.06] text-neutral-300'
  return 'bg-white/[0.03] text-neutral-500'
}

function TaskRow({ task, t }: { task: GamificationTask; t: TFunction }) {
  const isWinrate = task.state !== undefined
  const target = task.progressTarget
  const pct = target ? Math.min(100, ((task.progressNow ?? 0) / target) * 100) : 0

  return (
    <li>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className={task.done ? 'text-neutral-200' : 'text-neutral-400'}>
          {t(`gamification.tasks.${task.id}`)}
        </span>
        {task.done ? (
          <CheckIcon />
        ) : isWinrate && task.state ? (
          <span className={`tag shrink-0 text-[11px] ${taskStateClass(task.state)}`}>
            {t(`gamification.taskState.${task.state}`)}
          </span>
        ) : null}
      </div>

      {/* 胜率条件用 state 表达进度，不叠加进度条——两套语义摆一起会互相矛盾。
          Win-rate conditions express progress via `state`; no progress bar on
          top of it, or the two would say conflicting things. */}
      {!task.done && isWinrate && task.state === 'pending' && (
        <p className="mt-1 text-xs text-neutral-500">
          {task.currentWinRate != null ? fmtPct(task.currentWinRate) : '—'}
          {' / '}
          {target != null ? fmtPct(target) : '—'}
        </p>
      )}

      {!task.done && !isWinrate && target != null && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-prism-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="num shrink-0 text-[11px] text-neutral-500">
            {fmtProgressNum(task.progressNow ?? 0)}/{fmtProgressNum(target)}
          </span>
        </div>
      )}
    </li>
  )
}

export default function AchievementsPage() {
  const { t } = useTranslation()
  const [me, setMe] = useState<GamificationMe | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [equipping, setEquipping] = useState<string | null>(null)
  const [equipMsg, setEquipMsg] = useState<string | null>(null)
  const [mintIds, setMintIds] = useState<Set<string>>(new Set())
  const [detailBadge, setDetailBadge] = useState<GamificationBadge | null>(null)
  // 只在数据第一次到达时判定一次「哪些勋章要放铸造动画」——之后佩戴/取消
  // 佩戴触发的 setMe 会换新的 badges 数组引用，但不该重新判定一遍（不然乐观
  // 更新一次佩戴态就重放一次铸造动画）。
  // Which badges get the mint animation is decided exactly once, on the
  // data's first arrival — later equip/unequip calls replace the badges
  // array reference via setMe, but must not re-trigger this judging (or an
  // optimistic equip toggle would replay the mint animation).
  const mintCheckedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    gamificationApi
      .me()
      .then((res) => {
        if (!cancelled) setMe(res)
      })
      .catch(() => {
        // 唯一预期的失败就是入口理论上已隐藏、用户直接打 URL 撞上 403——
        // 不细分错误类型，统一退化成内测提示。
        // The one expected failure is someone hitting a URL whose entry is
        // already hidden and getting a 403 — not worth distinguishing error
        // kinds; everything degrades to the same beta hint.
        if (!cancelled) setForbidden(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!me || mintCheckedRef.current) return
    mintCheckedRef.current = true

    const seen = readSeenBadges()
    const earned = me.badges.filter((b) => b.earned)
    const unseen = earned.filter((b) => !seen.has(b.id))
    if (unseen.length === 0) return

    // 最近获得优先——awardedAt 是 ISO 字符串，字典序降序等价于时间降序。
    // Most-recently-awarded first — awardedAt is an ISO string, so
    // descending lexical order is descending chronological order.
    const sorted = [...unseen].sort((a, b) => (b.awardedAt ?? '').localeCompare(a.awardedAt ?? ''))
    const toMint = sorted.slice(0, MINT_STAGGER_CAP)
    const toSkip = sorted.slice(MINT_STAGGER_CAP)

    if (toSkip.length > 0) {
      const next = new Set(seen)
      toSkip.forEach((b) => next.add(b.id))
      writeSeenBadges(next)
    }
    if (toMint.length === 0) return

    setMintIds(new Set(toMint.map((b) => b.id)))
    const timers = toMint.map((b) => setTimeout(() => markBadgeSeen(b.id), MINT_DURATION_MS))
    return () => {
      timers.forEach(clearTimeout)
    }
  }, [me])

  async function toggleEquip(badgeId: string, equipped: boolean) {
    if (!me || equipping) return
    const next = equipped ? null : badgeId
    const prev = me
    setEquipping(badgeId)
    setEquipMsg(null)
    // 乐观更新：佩戴态立即翻转，失败再回滚——同一枚勋章的按钮不必等一次
    // 往返才有反馈。
    // Optimistic: flip the equipped state immediately, roll back on failure —
    // the button for this badge doesn't have to wait a round trip for feedback.
    setMe({
      ...me,
      equippedBadge: next,
      badges: me.badges.map((b) => ({ ...b, equipped: b.id === next })),
    })
    try {
      await userApi.updateProfile({ equippedBadge: next })
    } catch (err) {
      setMe(prev)
      setEquipMsg(err instanceof Error ? localizeApiError(err.message) : t('account.notifError'))
    } finally {
      setEquipping(null)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[1100px]">
        <SkeletonPage cards={3} />
      </div>
    )
  }

  if (forbidden || !me) {
    return (
      <div className="mx-auto flex min-h-[40vh] max-w-[1100px] items-center justify-center">
        <p className="card glass p-6 text-center text-sm text-neutral-400">
          {t('gamification.admin.visibleOff')}
        </p>
      </div>
    )
  }

  const nextGroup = me.groups.find((g) => g.tasks.some((task) => !task.done))
  const remaining = nextGroup ? nextGroup.tasks.filter((task) => !task.done).length : 0
  const badgesByRarity = RARITY_ORDER.map((rarity) => ({
    rarity,
    badges: me.badges.filter((b) => b.rarity === rarity),
  })).filter((g) => g.badges.length > 0)
  const equippedBadge = me.equippedBadge ? me.badges.find((b) => b.id === me.equippedBadge) ?? null : null

  return (
    <div className="mx-auto max-w-[1100px] space-y-6">
      <h2 className="font-display text-2xl font-bold text-neutral-100">
        <span className="neon-text">{t('gamification.title')}</span>
      </h2>

      {/* 头部：称号 + 等级 + 距下一级 + 综合胜率 */}
      <section className="card glass p-[18px]">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tag bg-prism-600/20 text-sm text-prism-300">
            {t('gamification.levelLabel')} L{me.level}
          </span>
          <h3 className="font-display text-xl font-bold text-white">
            {t(`gamification.titles.${me.title}`)}
          </h3>
        </div>
        <p className="mt-2 text-sm text-neutral-400">
          {nextGroup ? t('gamification.remainingToNext', { count: remaining }) : t('gamification.maxLevel')}
        </p>

        {/* 佩戴中的勋章：96 像素，倾斜 + 缓慢自转（16s 一圈，比列表行的静态展示
            郑重一档，但不到详情层放大图那么夸张）。 */}
        {/* Currently-equipped badge: 96px, tilt + a slow 16s spin — a notch more
            ceremonial than the static row-sized display, short of the detail
            layer's full-size render. */}
        {equippedBadge && (
          <div className="mt-4 flex items-center gap-3 border-t border-white/10 pt-4">
            <MedalTilt
              ariaLabel={t(`gamification.badges.${equippedBadge.id}.name`)}
              onClick={() => setDetailBadge(equippedBadge)}
            >
              <BadgeIcon id={equippedBadge.id} rarity={equippedBadge.rarity} earned size={96} spin />
            </MedalTilt>
            <div>
              <span className="text-xs text-neutral-500">{t('gamification.equip')}</span>
              <div className="text-sm font-semibold text-white">
                {t(`gamification.badges.${equippedBadge.id}.name`)}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-xs text-neutral-500">{t('gamification.winRateCard.combined')}</span>
              <div className="num text-2xl font-bold text-up">
                {me.winRate.value != null ? fmtPct(me.winRate.value) : '—'}
              </div>
              {me.winRate.value != null && (
                <p className="text-[11px] text-neutral-500">
                  {t('winrate.windowHint', { days: me.winRate.windowDays })}
                </p>
              )}
            </div>
            {me.winRate.perLogin.length > 0 && (
              <button
                type="button"
                className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
                onClick={() => setShowBreakdown((v) => !v)}
              >
                {t('gamification.winRateCard.breakdown')}
              </button>
            )}
          </div>

          {showBreakdown && me.winRate.perLogin.length > 0 && (
            <div className="mt-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {t('gamification.winRateCard.account')}
              </span>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-neutral-500">
                      <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colLogin')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colTrades')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colWins')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colWinRate')}</th>
                      <th className="py-1.5 font-medium">{t('gamification.winRateCard.colExcluded')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {me.winRate.perLogin.map((row) => (
                      <tr key={row.login} className="border-t border-white/5">
                        <td className="num py-1.5 pr-4 text-neutral-200">{row.login}</td>
                        <td className="num py-1.5 pr-4 text-neutral-300">{row.trades}</td>
                        <td className="num py-1.5 pr-4 text-neutral-300">{row.wins}</td>
                        <td className="num py-1.5 pr-4 text-neutral-300">
                          {row.winRate != null ? fmtPct(row.winRate) : '—'}
                        </td>
                        <td className="num py-1.5 text-neutral-500">{row.excluded}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 当前等级组：只显示正在闯的这一关，已过的和未解锁的都不列 */}
      {/* Current group only: the level being worked on — cleared and locked groups are not listed */}
      {nextGroup && (
        <section className="card glass p-[18px]">
          <h3 className="sec-h-title">{t(`gamification.groups.${nextGroup.group}`)}</h3>
          <ul className="mt-3 space-y-3">
            {nextGroup.tasks.map((task) => (
              <TaskRow key={task.id} task={task} t={t} />
            ))}
          </ul>
        </section>
      )}

      {/* 勋章墙 */}
      <section className="card glass p-[18px]">
        <h3 className="sec-h-title">{t('gamification.badgeWall')}</h3>
        <div className="mt-4 space-y-6">
          {badgesByRarity.map(({ rarity, badges }) => (
            <div key={rarity}>
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {t(`gamification.rarity.${rarity}`)}
              </span>
              <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {badges.map((b) => (
                  <div
                    key={b.id}
                    className="flex flex-col items-center gap-1.5 rounded-xl bg-white/[0.03] p-3 text-center"
                  >
                    <MedalTilt
                      ariaLabel={t(`gamification.badges.${b.id}.name`)}
                      onClick={() => setDetailBadge(b)}
                    >
                      <BadgeIcon id={b.id} rarity={b.rarity} earned={b.earned} size={72} mint={mintIds.has(b.id)} />
                    </MedalTilt>
                    <span className="text-xs font-semibold text-neutral-200">
                      {t(`gamification.badges.${b.id}.name`)}
                    </span>
                    {b.earned ? (
                      <>
                        {b.awardedAt && (
                          <span className="text-[10px] text-neutral-500">{fmtDate(b.awardedAt)}</span>
                        )}
                        <button
                          type="button"
                          disabled={equipping === b.id}
                          onClick={() => toggleEquip(b.id, b.equipped)}
                          className={`tag text-[11px] transition disabled:opacity-50 ${
                            b.equipped
                              ? 'bg-prism-600/25 text-prism-300'
                              : 'bg-white/5 text-neutral-400 hover:bg-white/10'
                          }`}
                        >
                          {b.equipped ? t('gamification.unequip') : t('gamification.equip')}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="tag bg-white/5 text-[11px] text-neutral-500">
                          {t('gamification.notEarned')}
                        </span>
                        <span className="text-[10px] leading-relaxed text-neutral-500">
                          {t(`gamification.badges.${b.id}.desc`)}
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {equipMsg && <p className="mt-3 text-sm text-down">{equipMsg}</p>}
      </section>

      {detailBadge && (
        <BadgeDetailModal badge={detailBadge} population={me.population} onClose={() => setDetailBadge(null)} />
      )}
    </div>
  )
}
