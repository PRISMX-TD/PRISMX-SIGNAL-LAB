// 管理后台「游戏化」页签：用户端可见性开关 + 用户检查器。
//
// 可见性开关走「只升不降、发出不收回」的铁律（见 client.ts 的
// setGamificationVisibility 注释）——后端接口本身仍接受 false，真正的闸门
// 只有一处：翻到「开」之前必须 window.confirm 一次。翻回「关」不设二次确认，
// 与任务书口径一致（这不是后端强制的单向锁，是前端刻意做的最后一道人工关卡）。
//
// 用户检查器复用成就页（AchievementsPage）的数据形状（GamificationMe），
// 但渲染成管理员要的"紧凑排查视图"：称号/等级一行、五组条件缩成勾/状态标签、
// 勋章墙缩成 40px 缩略图、胜率表不带折叠。没有抽取 AchievementsPage 的
// TaskRow/CheckIcon 复用——两边字号、有无进度条的诉求都不同，抽出来的公共
// 组件反而要塞一堆 variant props，不如各自维护一份简单的。
//
// The admin "gamification" tab: user-facing visibility switch + user inspector.
//
// The visibility switch follows the "up only, never revoked" rule (see the
// comment on setGamificationVisibility in client.ts) — the backend endpoint
// itself still accepts false; the one real gate is the confirm() before
// flipping to true. Flipping back to false needs no second confirmation, per
// the task brief (this is a deliberate front-end-only last check, not a
// backend-enforced one-way lock).
//
// The user inspector reuses AchievementsPage's data shape (GamificationMe) but
// renders it as the compact view an admin wants: title/level on one line, the
// five condition groups collapsed to check/state tags, the badge wall shrunk
// to 40px thumbnails, and the win-rate table always expanded (no toggle).
// AchievementsPage's TaskRow/CheckIcon aren't extracted for reuse — the two
// views want different sizing and progress-bar needs, and a shared component
// would just grow a pile of variant props instead of two small local ones.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import { fmtPct } from '../winrate/shared'
import { SkeletonLine } from '../Skeleton'
import BadgeIcon from '../badges/BadgeIcon'
import type { AdminUser, GamificationMe, GamificationTask } from '../../api/types'

type SelectedUser = GamificationMe & { email: string }

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--up)" strokeWidth="2.4"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

// 进度数字格式化，同 AchievementsPage 的口径（整数不带小数点，小数最多两位）。
// Progress number formatting, matching AchievementsPage's rule (no decimals
// when whole, at most 2dp otherwise).
function fmtProgressNum(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function taskStateTagClass(state: 'locked' | 'pending' | 'done'): string {
  if (state === 'pending') return 'bg-white/[0.06] text-neutral-300'
  return 'bg-white/[0.03] text-neutral-500'
}

// 一行紧凑条件：名字 + 完成勾 / 状态标签 / 进度数字，三选一。
// One compact condition row: name plus a done check, a state tag, or a
// progress fraction — whichever applies.
function CompactTask({ task, t }: { task: GamificationTask; t: TFunction }) {
  const isWinrate = task.state !== undefined
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className={task.done ? 'text-neutral-300' : 'text-neutral-500'}>
        {t(`gamification.tasks.${task.id}`)}
      </span>
      {task.done ? (
        <CheckIcon />
      ) : isWinrate && task.state ? (
        <span className={`tag shrink-0 text-[10px] ${taskStateTagClass(task.state)}`}>
          {t(`gamification.taskState.${task.state}`)}
        </span>
      ) : task.progressTarget != null ? (
        <span className="num shrink-0 text-[10px] text-neutral-500">
          {fmtProgressNum(task.progressNow ?? 0)}/{fmtProgressNum(task.progressTarget)}
        </span>
      ) : (
        <span className="tag shrink-0 bg-white/[0.03] text-[10px] text-neutral-500">—</span>
      )}
    </li>
  )
}

export default function GamificationPanel() {
  const { t } = useTranslation()

  // ---- 用户端可见性 / user-facing visibility ----
  const [userVisible, setUserVisible] = useState<boolean | null>(null)
  const [visLoading, setVisLoading] = useState(true)
  const [visSaving, setVisSaving] = useState(false)
  const [visError, setVisError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    adminApi
      .gamificationVisibility()
      .then((res) => {
        if (!cancelled) setUserVisible(res.userVisible)
      })
      .catch((err) => {
        if (!cancelled) setVisError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
      })
      .finally(() => {
        if (!cancelled) setVisLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleVisibility = async (next: boolean) => {
    // 翻到「开」之前必须过 confirm 这一关；翻回「关」不设置二次确认——见文件头注释。
    // Flipping to "open" must pass this confirm; flipping back needs none — see the file header.
    if (next && !window.confirm(t('gamification.admin.confirmOpen'))) return
    setVisSaving(true)
    setVisError(null)
    try {
      const res = await adminApi.setGamificationVisibility(next)
      setUserVisible(res.userVisible)
    } catch (err) {
      setVisError(err instanceof Error ? localizeApiError(err.message) : 'Save failed')
    } finally {
      setVisSaving(false)
    }
  }

  // ---- 用户检查器 / user inspector ----
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdminUser[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<SelectedUser | null>(null)
  const [selectedLoading, setSelectedLoading] = useState(false)
  const [selectedError, setSelectedError] = useState<string | null>(null)

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await adminApi.listUsers({ q: query.trim(), limit: 20 })
      setResults(res.users)
    } catch (err) {
      setSearchError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
    } finally {
      setSearching(false)
    }
  }

  const selectUser = async (id: string) => {
    setSelectedId(id)
    setSelected(null)
    setSelectedError(null)
    setSelectedLoading(true)
    try {
      setSelected(await adminApi.gamificationUser(id))
    } catch (err) {
      setSelectedError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
    } finally {
      setSelectedLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* 用户端可见性 / user-facing visibility */}
      <div className="glass p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-lg font-semibold text-neutral-100">
            {t('gamification.admin.visibility')}
          </h3>
          {visLoading ? (
            <SkeletonLine width="120px" />
          ) : (
            <label className="flex cursor-pointer items-center gap-3">
              <span className={`text-sm ${userVisible ? 'text-up' : 'text-neutral-500'}`}>
                {userVisible ? t('gamification.admin.visibleOn') : t('gamification.admin.visibleOff')}
              </span>
              <span className="relative inline-flex items-center">
                <input
                  type="checkbox"
                  checked={!!userVisible}
                  disabled={visSaving}
                  onChange={(e) => toggleVisibility(e.target.checked)}
                  className="peer sr-only"
                />
                <span className="h-6 w-11 rounded-full bg-white/10 transition peer-checked:bg-prism-500 peer-disabled:opacity-60" />
                <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
              </span>
            </label>
          )}
        </div>
        {visError && <p className="mt-2 text-sm text-down">{visError}</p>}
      </div>

      {/* 用户检查器 / user inspector */}
      <div className="glass p-5">
        <h3 className="font-display text-lg font-semibold text-neutral-100">{t('gamification.admin.inspect')}</h3>
        <form onSubmit={handleSearch} className="mt-3 flex flex-wrap items-center gap-3">
          <input
            className="input flex-1 sm:max-w-xs"
            placeholder={t('gamification.admin.searchUser')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={searching}>
            {searching ? t('common.loading') : t('admin.search')}
          </button>
        </form>
        {searchError && <p className="mt-2 text-sm text-down">{searchError}</p>}

        {results.length > 0 && (
          <ul className="mt-3 max-h-64 divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/5">
            {results.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => selectUser(u.id)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-white/[0.03] ${
                    selectedId === u.id ? 'bg-prism-600/[0.08] text-prism-200' : 'text-neutral-300'
                  }`}
                >
                  <span className="truncate font-mono text-xs">{u.email}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tag bg-white/5 text-[11px] text-neutral-400">{u.role}</span>
                    <span className="tag bg-white/5 text-[11px] text-neutral-400">{u.plan}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedLoading && (
          <div className="mt-4 space-y-3" aria-busy="true">
            <SkeletonLine width="60%" /><SkeletonLine width="90%" /><SkeletonLine width="80%" />
          </div>
        )}
        {selectedError && <p className="mt-3 text-sm text-down">{selectedError}</p>}

        {selected && !selectedLoading && (
          <div className="mt-4 space-y-4 border-t border-white/5 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="truncate font-mono text-xs text-neutral-400">{selected.email}</span>
              <span className="tag bg-prism-600/20 text-xs text-prism-300">
                {t('gamification.levelLabel')} L{selected.level}
              </span>
              <span className="text-sm font-semibold text-neutral-100">
                {t(`gamification.titles.${selected.title}`)}
              </span>
            </div>

            {/* 五组条件完成态 / the five condition groups */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {selected.groups.map((group) => (
                <div key={group.group} className="rounded-lg bg-white/[0.02] p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    {t(`gamification.groups.${group.group}`)}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {group.tasks.map((task) => (
                      <CompactTask key={task.id} task={task} t={t} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* 勋章墙缩略 / badge wall thumbnails */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {t('gamification.badgeWall')}
              </p>
              <div className="mt-2 grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10">
                {selected.badges.map((b) => (
                  <div key={b.id} className="flex flex-col items-center gap-1" title={t(`gamification.badges.${b.id}.name`)}>
                    <BadgeIcon id={b.id} rarity={b.rarity} earned={b.earned} size={40} />
                  </div>
                ))}
              </div>
            </div>

            {/* 综合胜率 + perLogin 构成表 / combined win rate + per-login table */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-500">{t('gamification.winRateCard.combined')}</span>
                <span className="num text-lg font-bold text-up">
                  {selected.winRate.value != null ? fmtPct(selected.winRate.value) : '—'}
                </span>
              </div>
              {selected.winRate.perLogin.length > 0 && (
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
                      {selected.winRate.perLogin.map((row) => (
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
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
