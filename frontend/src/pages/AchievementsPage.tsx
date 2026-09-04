// 成就页 = 一座陈列台：聚光灯下的佩戴勋章 + 当前关卡 + 按材质分层的勋章库。
// 入口本身按 gamificationVisible 门控（见 Layout/UserMenu），这里只处理直接
// 打 URL 绕过入口的情况——理论上只有内测期的普通用户会撞上 403，兜底成一句
// 提示而不是把接口错误糊在脸上。
// Achievements page as a showcase: the equipped badges under a spotlight, the
// current stage, and the badge vault shelved by material.
// The entry point itself is gated on gamificationVisible (see Layout/UserMenu);
// this only handles someone hitting the URL directly — in practice only a
// regular user during the beta window, degraded to one line of copy instead of
// a raw API error.
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { gamificationApi, userApi } from '../api/client'
import { localizeApiError, fmtDate } from '../api/utils'
import { fmtPct } from '../components/winrate/shared'
import { SkeletonBlock, SkeletonLine } from '../components/Skeleton'
import BadgeIcon from '../components/badges/BadgeIcon'
import MedalTilt from '../components/badges/MedalTilt'
import BadgeDetailModal from '../components/badges/BadgeDetailModal'
import PedestalStage from '../components/badges/PedestalStage'
import type { GamificationBadge, GamificationBadgeRarity, GamificationMe, GamificationTask } from '../api/types'

// 勋章库按稀有度从高到低分层，最珍贵的一层在最上面——进门先看到镇馆之宝。
// The vault is shelved rarest-first, most precious on top — the centrepiece is the
// first thing you see.
const RARITY_ORDER: GamificationBadgeRarity[] = ['common', 'rare', 'epic', 'legendary', 'limited']
const VAULT_ORDER: GamificationBadgeRarity[] = [...RARITY_ORDER].reverse()
// 与后端 LEVEL_TITLES 同序 / same order as the backend's LEVEL_TITLES
const LEVEL_KEYS = ['novice', 'junior', 'elite', 'senior', 'chief', 'legend'] as const

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
// 可同时佩戴的枚数，与后端 EQUIP_SLOTS 对齐。第一枚是默认——榜单行与比赛条目
// 只画那一枚，其余两枚只在这一页露面。
// How many badges can be worn at once, mirroring the backend's EQUIP_SLOTS.
// The first is the default: leaderboard rows and competition entries draw only
// that one, the other two appear on this page alone.
const EQUIP_SLOTS = 3
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

// 进度数字：手数类条件可能带小数（stats 保留 4 位），笔数/天数类是整数——统一
// "整数不带小数点，小数最多两位"，不针对条件类型特判。
// Progress numbers: lot-based conditions can carry a fraction (stats round to
// 4dp); trade/day counts are integers. Uniformly "no decimals when whole, at
// most 2dp otherwise" rather than special-casing by condition type.
function fmtProgressNum(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

// population 为 0（数据库为空的边界情况）时不做除零——直接报 0.0%，比 NaN% 更能看。
// population zero (an empty-database edge case) avoids a divide-by-zero — reports
// 0.0% outright rather than NaN%.
function fmtOwnerPct(owners: number, population: number): string {
  if (population <= 0) return '0.0%'
  return `${((owners / population) * 100).toFixed(1)}%`
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--up)" strokeWidth="2.2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

// 每条任务三种视觉态：done 绿 / active 紫（正在推进）/ locked 灰（胜率毕业考
// 未开考）。锁定态照样画条——画的是当前胜率在 0–100% 标尺上的位置，加一道阈值
// 刻度，用户能看到"离开考线还有多远"，只是不上色不计入。
// Three visual states per task: done (green) / active (violet, in progress) /
// locked (grey, win-rate exam not yet open). Locked rows still get a bar — the
// current win rate on a 0–100% scale with a threshold tick — so the distance
// to the pass line stays visible; it just isn't coloured or counted.
type TaskVisual = 'done' | 'active' | 'locked'

function taskVisual(task: GamificationTask): TaskVisual {
  if (task.done) return 'done'
  if (task.state === 'locked') return 'locked'
  return 'active'
}

// 进度比例：计数类 now/target；布尔 0/1；盈亏看正负；胜率按 0–100% 标尺画当前值。
// Fill ratio: counters now/target; boolean 0/1; P&L by sign; win rate on a 0–100% scale.
function taskPct(task: GamificationTask): number {
  if (task.done) return 1
  const now = task.progressNow ?? 0
  if (task.kind === 'profit') return now > 0 ? 1 : 0
  if (task.kind === 'winrate') return Math.min(1, Math.max(0, now))
  const target = task.progressTarget ?? 0
  return target > 0 ? Math.min(1, now / target) : 0
}

function fmtSignedUsd(n: number): string {
  const abs = Math.abs(n).toFixed(2)
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${abs} USD`
}

// 右侧数值：计数「2 / 5 笔」、盈亏「+128.40 USD · 盈亏为正」、胜率「41.7% / 35%」、
// 布尔只给一个词。done 时数字变绿，布尔 done 不显示（左侧勾已经说明）。
// Right-hand value: counters "2 / 5 trades", P&L "+128.40 USD · above zero",
// win rate "41.7% / 35%", boolean a single word. Numbers turn green when done;
// a done boolean shows nothing (the check on the left already says it).
function TaskValue({ task, t }: { task: GamificationTask; t: TFunction }) {
  const now = task.progressNow ?? 0
  const target = task.progressTarget ?? 0
  switch (task.kind) {
    case 'boolean':
      return task.done ? null : <span>{t('gamification.taskProgress.pending')}</span>
    case 'profit':
      return (
        <>
          <b className={now > 0 ? 'text-up' : now < 0 ? 'text-down' : ''}>{fmtSignedUsd(now)}</b>
          <span className="hidden sm:inline"> · {t('gamification.taskProgress.profitTarget')}</span>
        </>
      )
    case 'winrate':
      return (
        <>
          <b>{task.currentWinRate != null ? fmtPct(task.currentWinRate) : '—'}</b>
          <span> / {fmtPct(target)}</span>
        </>
      )
    default: {
      const unit = task.kind ? t(`gamification.taskUnits.${task.kind}`) : ''
      // 已完成的计数只报实际值（「6 笔」），不再拖着目标——「6 / 5」读起来像超卖。
      // A done counter reports the actual value only ("6 trades"); "6 / 5" reads oddly.
      if (task.done) {
        return (
          <>
            <b>{fmtProgressNum(now)}</b>
            {unit ? <span> {unit}</span> : null}
          </>
        )
      }
      return (
        <>
          <b>{fmtProgressNum(now)}</b>
          <span> / {fmtProgressNum(target)}{unit ? ` ${unit}` : ''}</span>
        </>
      )
    }
  }
}

// 任务名的文案是「短名——条件」（英文用 " — "），拆成两行：短名做标题、条件做说明。
// 拆不开就整句当标题。
// Task copy is "short name — condition" (" — " in English); split into a title
// line and a condition line. If it doesn't split, the whole string is the title.
function splitTaskName(label: string): { title: string; cond: string } {
  const m = label.match(/^(.*?)\s*(?:——|\s—\s|\s-\s)\s*(.+)$/)
  return m ? { title: m[1], cond: m[2] } : { title: label, cond: '' }
}

function TaskTile({ task, index, t }: { task: GamificationTask; index: number; t: TFunction }) {
  const visual = taskVisual(task)
  const pct = taskPct(task)
  const { title, cond } = splitTaskName(t(`gamification.tasks.${task.id}`))
  const style = { '--i': index, '--pct': pct } as CSSProperties
  return (
    <li className={`tk-tile tk-${visual}`} style={style}>
      <div className="tk-tile-top">
        <span className="tk-status" aria-hidden>
          {visual === 'done' ? <CheckIcon /> : visual === 'locked' ? <LockIcon /> : <i className="tk-dot" />}
        </span>
        <span className="tk-value num">
          <TaskValue task={task} t={t} />
        </span>
      </div>
      <div className="tk-title">{title}</div>
      {cond && <div className="tk-cond">{cond}</div>}
      {/* 已完成的瓦片不再画条——勾和绿色数值已经说完了；进度条只给还在推进和锁定的。
          Done tiles carry no bar: the check and green value already say it;
          bars are for in-progress and locked tasks only. */}
      {visual !== 'done' && (
        <div
          className="tk-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct * 100)}
          aria-label={title}
        >
          <i className="tk-fill" />
          {task.kind === 'winrate' && (
            <i className="tk-tick" style={{ left: `${(task.progressTarget ?? 0) * 100}%` }} />
          )}
        </div>
      )}
      {visual === 'locked' && <p className="tk-hint">{t('gamification.taskState.locked')}</p>}
    </li>
  )
}

// 关卡标题右侧的完成度环：r=18 → 周长 ≈ 113，按 done/total 走 dashoffset。
// Completion ring beside the stage title: r=18 → circumference ≈ 113, dashoffset by done/total.
function StageRing({ done, total }: { done: number; total: number }) {
  const C = 2 * Math.PI * 18
  const ratio = total > 0 ? done / total : 0
  return (
    <span className="tk-ring" aria-hidden>
      <svg width="48" height="48" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="18" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
        <circle
          cx="24" cy="24" r="18" fill="none" stroke="var(--up)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - ratio)}
          transform="rotate(-90 24 24)"
          className="tk-ring-arc"
        />
      </svg>
      <span className="tk-ring-num num">{done}<span>/{total}</span></span>
    </span>
  )
}

// 首屏骨架贴陈列台版式：左侧文字块 + 右侧一个大圆；下面两行占位。延迟 150ms 显形
// （.lb-skel 那条规则），本地/缓存命中时根本不露面。
// First-load skeleton shaped like the stage: text block left, one big disc right,
// two placeholder rows below. Appears after 150ms (.lb-skel), so a fast response
// never shows it at all.
function PageSkeleton() {
  return (
    <div className="ach mx-auto max-w-[1100px] space-y-8 lb-skel" aria-hidden>
      <div className="ach-stage" style={{ minHeight: 420 }}>
        <div className="flex flex-col gap-4 pt-2">
          <SkeletonLine width={90} height={11} />
          <SkeletonLine width={260} height={40} />
          <SkeletonLine width={180} height={14} />
          <SkeletonLine width="100%" height={14} className="mt-6" />
          <SkeletonLine width="100%" height={44} className="mt-4" />
        </div>
        <div className="flex items-end justify-center gap-6 pb-16">
          <SkeletonBlock width={92} height={92} radius={999} />
          <SkeletonBlock width={236} height={236} radius={999} />
          <SkeletonBlock width={92} height={92} radius={999} />
        </div>
      </div>
      <SkeletonBlock height={64} radius="var(--r-lg)" />
      <SkeletonBlock height={220} radius="var(--r-lg)" />
    </div>
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

  // 佩戴写的是一份有序列表：首枚 = 默认（上榜那枚）。三个动作共用一次 PATCH——
  // 戴上（追加到末尾）、取下（从列表移除）、设为默认（移到首位）。
  // Equipping writes one ordered list: first = default (the one that goes on the
  // board). Three actions share a single PATCH — equip (append), unequip
  // (remove), set-default (move to front).
  async function writeEquipped(next: string[], busyId: string) {
    if (!me || equipping) return
    const prev = me
    setEquipping(busyId)
    setEquipMsg(null)
    // 乐观更新：佩戴态立即翻转，失败再回滚——按钮不必等一次往返才有反馈。
    // Optimistic: flip immediately and roll back on failure, so the button
    // doesn't wait a round trip for feedback.
    const nextSet = new Set(next)
    setMe({
      ...me,
      equippedBadge: next[0] ?? null,
      equippedBadges: next,
      badges: me.badges.map((b) => ({ ...b, equipped: nextSet.has(b.id) })),
    })
    try {
      await userApi.updateProfile({ equippedBadges: next })
    } catch (err) {
      setMe(prev)
      setEquipMsg(err instanceof Error ? localizeApiError(err.message) : t('account.notifError'))
    } finally {
      setEquipping(null)
    }
  }

  function toggleEquip(badgeId: string, equipped: boolean) {
    if (!me) return
    const current = me.equippedBadges
    if (equipped) {
      void writeEquipped(current.filter((id) => id !== badgeId), badgeId)
      return
    }
    if (current.length >= EQUIP_SLOTS) {
      setEquipMsg(t('gamification.equipSlots.full', { max: EQUIP_SLOTS }))
      return
    }
    void writeEquipped([...current, badgeId], badgeId)
  }

  function makeDefault(badgeId: string) {
    if (!me) return
    void writeEquipped([badgeId, ...me.equippedBadges.filter((id) => id !== badgeId)], badgeId)
  }

  if (loading) return <PageSkeleton />

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
  // 关卡序号 = 组在 groups 里的下标 + 1；通往的称号 = 当前等级 + 1。
  // Stage number = the group's index + 1; the title it leads to = current level + 1.
  const stageIndex = nextGroup ? me.groups.indexOf(nextGroup) + 1 : me.groups.length
  const nextTitleKey = LEVEL_KEYS[Math.min(me.level, LEVEL_KEYS.length - 1)]
  const earnedCount = me.badges.filter((b) => b.earned).length
  const shelves = VAULT_ORDER.map((rarity) => ({
    rarity,
    badges: me.badges.filter((b) => b.rarity === rarity),
  })).filter((g) => g.badges.length > 0)
  // 按佩戴顺序取出勋章对象；首枚是默认，站陈列台正中。
  // Resolve badges in equipped order; the first is the default and takes centre stage.
  const equippedBadges = me.equippedBadges
    .map((id) => me.badges.find((b) => b.id === id))
    .filter((b): b is GamificationBadge => b != null)

  return (
    <div className="ach mx-auto max-w-[1100px] space-y-8">
      {/* ── 陈列台 / stage ────────────────────────────────────── */}
      <section className="ach-stage" aria-labelledby="ach-title">
        <div className="ach-stage-l">
          <div className="ach-eyebrow">{t('gamification.title')}</div>
          <h2 id="ach-title" className="ach-title">
            <span className="ach-lv num">L{me.level}</span>
            <span>{t(`gamification.titles.${me.title}`)}</span>
          </h2>
          <p className="ach-sub">
            {nextGroup
              ? `${t('gamification.remainingToNext', { count: remaining })} · ${t(`gamification.groups.${nextGroup.group}`)}`
              : t('gamification.maxLevel')}
          </p>
          <ol className="ach-rail" aria-label={t('gamification.levelLabel')}>
            {LEVEL_KEYS.map((key, i) => {
              const lv = i + 1
              const cls = lv < me.level ? 'on' : lv === me.level ? 'on cur' : ''
              return (
                <li key={key} className={cls} aria-current={lv === me.level ? 'step' : undefined}>
                  <i aria-hidden />
                  <b>{t(`gamification.levelShort.${key}`)}</b>
                </li>
              )
            })}
          </ol>
          <div className="ach-stats">
            <div>
              {/* 手机上「综合胜率（考核口径）」会折成两行把三栏挤歪，短标签只在 <640 用。
                  The full label wraps to two lines on phones and skews the three columns;
                  the short one is for <640 only. */}
              <small>
                <span className="hidden sm:inline">{t('gamification.winRateCard.combined')}</span>
                <span className="sm:hidden">{t('gamification.winRateCard.combinedShort')}</span>
              </small>
              <strong className="num text-up">{me.winRate.value != null ? fmtPct(me.winRate.value) : '—'}</strong>
              {me.winRate.perLogin.length > 0 && (
                <button type="button" className="ach-link" onClick={() => setShowBreakdown((v) => !v)}>
                  {t('gamification.winRateCard.breakdown')}
                </button>
              )}
            </div>
            <div>
              <small>{t('gamification.stage.collected')}</small>
              <strong className="num">{earnedCount} <span>/ {me.badges.length}</span></strong>
            </div>
            <div>
              <small>{t('gamification.equip')}</small>
              <strong className="num">{equippedBadges.length} <span>/ {EQUIP_SLOTS}</span></strong>
            </div>
          </div>
        </div>

        <PedestalStage
          badges={equippedBadges}
          defaultId={me.equippedBadge}
          busy={equipping != null}
          onOpen={setDetailBadge}
          onMakeDefault={makeDefault}
        />
      </section>

      {/* 综合胜率构成：从陈列台的「构成」按钮展开，独立一块，不挤进舞台。
          Win-rate breakdown: toggled from the stage's button, its own block so the
          table never crowds the stage. */}
      {showBreakdown && me.winRate.perLogin.length > 0 && (
        <section className="glass p-[18px] content-fade">
          <div className="ach-sec-h">
            <h3><b>{t('gamification.winRateCard.account')}</b>{t('winrate.windowHint', { days: me.winRate.windowDays })}</h3>
          </div>
          <div className="mt-3 overflow-x-auto">
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
        </section>
      )}

      {/* ── 当前关卡 / current stage ───────────────────────────── */}
      {nextGroup && (
        <section aria-labelledby="ach-stage-title">
          <div className="ach-sec-h">
            <h3 id="ach-stage-title">
              <b>{t(`gamification.groups.${nextGroup.group}`)}</b>
              {t('gamification.stage.nth', { n: stageIndex })} · {t('gamification.stage.toward', { title: t(`gamification.titles.${nextTitleKey}`) })}
            </h3>
            <StageRing done={nextGroup.tasks.length - remaining} total={nextGroup.tasks.length} />
          </div>
          <ul className="tk-grid">
            {nextGroup.tasks.map((task, i) => (
              <TaskTile key={task.id} task={task} index={i} t={t} />
            ))}
          </ul>
        </section>
      )}

      {/* ── 勋章库 / vault ────────────────────────────────────── */}
      <section className="ach-vault" aria-labelledby="ach-vault-title">
        <div className="ach-sec-h">
          <h3 id="ach-vault-title"><b>{t('gamification.stage.vault')}</b>{t('gamification.stage.vaultHint')}</h3>
          <div className="r"><b className="num">{me.badges.length}</b></div>
        </div>
        {equipMsg && <p className="text-sm text-down">{equipMsg}</p>}

        {shelves.map(({ rarity, badges }) => {
          const got = badges.filter((b) => b.earned).length
          return (
            <div key={rarity} className={`ach-shelf ach-s-${rarity}`}>
              <div className="ach-shelf-h">
                <h4>
                  {t(`gamification.rarity.${rarity}`)}
                  <span>{t(`gamification.material.${rarity}`)}</span>
                </h4>
                <div className="r"><b className="num">{got} / {badges.length}</b></div>
              </div>
              <ul className="ach-row">
                {badges.map((b) => {
                  const isDefault = b.id === me.equippedBadge
                  return (
                    <li key={b.id} className={`ach-item ${b.earned ? '' : 'ghost'}`}>
                      <i className="ach-glow" aria-hidden />
                      {!b.earned && <i className="ach-ring" aria-hidden />}
                      <MedalTilt ariaLabel={t(`gamification.badges.${b.id}.name`)} onClick={() => setDetailBadge(b)}>
                        <BadgeIcon id={b.id} rarity={b.rarity} earned={b.earned} size={92} mint={mintIds.has(b.id)} />
                      </MedalTilt>
                      <b className="ach-name">{t(`gamification.badges.${b.id}.name`)}</b>
                      <small className="ach-meta">
                        {b.earned
                          ? (b.awardedAt ? t('gamification.stage.awardedOn', { date: fmtDate(b.awardedAt) }) : '')
                          : t(`gamification.badges.${b.id}.desc`)}
                      </small>
                      <small className="ach-own">
                        {t('gamification.detail.owners', { n: b.owners, pct: fmtOwnerPct(b.owners, me.population) })}
                      </small>
                      {b.earned && (
                        <div className="ach-eq">
                          {isDefault && <span className="on static">{t('gamification.equipSlots.isDefault')}</span>}
                          {b.equipped && !isDefault && (
                            <button type="button" disabled={equipping === b.id} onClick={() => makeDefault(b.id)}>
                              {t('gamification.equipSlots.setDefault')}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={equipping === b.id}
                            onClick={() => toggleEquip(b.id, b.equipped)}
                            className={b.equipped ? 'on' : ''}
                          >
                            {b.equipped ? t('gamification.unequip') : t('gamification.equip')}
                          </button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </section>

      {detailBadge && (
        <BadgeDetailModal badge={detailBadge} population={me.population} onClose={() => setDetailBadge(null)} />
      )}
    </div>
  )
}
