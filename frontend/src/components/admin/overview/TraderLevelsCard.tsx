// 交易员等级（六级闯关）：每一级现在有多少人、本期有多少人升上来，点开能看到具体是谁、
// 什么时候升的（精确到秒）。
//
// 两个数字口径不同，卡片上要分得清清楚楚：「现有」是当前处于该等级的人数，不跟上面的
// 时间范围走；「本期 +N」是所选时间段内升到该等级的人数，跟范围走。后者不是前者的子集——
// 本期升到 3 级的人现在可能已经是 4 级，所以名单里每行都带「现在几级」。
//
// Trader levels: the stock per level and the flow into it during the range, with the
// exact moment (to the second) behind each row. Stock ignores the range picker; flow
// follows it, and the flow is not a subset of the stock — someone who reached level 3
// this month may already be level 4, so every row carries the user's current level.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { AdminTraderLevelUsers, AdminTraderLevels } from '../../../api/types'
import { fmtTime, localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'
import { rangeKey, toQuery, type RangeState } from './rangeUtils'

type Scope = 'all' | 'range'
const SCOPES: Scope[] = ['all', 'range']

export default function TraderLevelsCard({ range }: { range: RangeState }) {
  const { t } = useTranslation()
  const key = rangeKey(range)

  const [summary, setSummary] = useState<AdminTraderLevels | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [openLevel, setOpenLevel] = useState<number | null>(null)
  const [scope, setScope] = useState<Scope>('all')
  const [list, setList] = useState<AdminTraderLevelUsers | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSummaryError(null)
    adminApi.traderLevels(toQuery(range)).then(
      (data) => { if (!cancelled) setSummary(data) },
      (err: unknown) => { if (!cancelled) setSummaryError(err instanceof Error ? localizeApiError(err.message) : '') },
    )
    // 换了时间范围，已展开的名单就过期了——收起来，别让旧名单配新数字。
    // A range change invalidates any open list; collapse rather than show stale rows.
    setOpenLevel(null)
    setList(null)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const loadList = useCallback(async (level: number, nextScope: Scope) => {
    setListLoading(true)
    setListError(null)
    try {
      setList(await adminApi.traderLevelUsers(level, toQuery(range), nextScope))
    } catch (err) {
      setList(null)
      setListError(err instanceof Error ? localizeApiError(err.message) : '')
    } finally {
      setListLoading(false)
    }
  }, [range])

  const toggle = (level: number) => {
    if (openLevel === level) {
      setOpenLevel(null)
      return
    }
    setOpenLevel(level)
    setScope('all')
    setList(null)
    void loadList(level, 'all')
  }

  const switchScope = (next: Scope) => {
    if (next === scope || openLevel === null) return
    setScope(next)
    setList(null)
    void loadList(openLevel, next)
  }

  const levelName = (levelKey: string) => t(`gamification.titles.${levelKey}`, { defaultValue: levelKey })

  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.levels.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.overview.levels.hint')}</p>

      {summaryError !== null && !summary && (
        <p className="text-xs text-down">
          {t('admin.overview.levels.failed')}
          {summaryError ? `：${summaryError}` : ''}
        </p>
      )}
      {!summary && summaryError === null && <SkeletonLine height={120} />}

      {summary && (
        <ol className="space-y-2">
          {summary.levels.map((row) => {
            const width = summary.totalUsers > 0 && row.total > 0
              ? Math.max(2, (row.total / summary.totalUsers) * 100)
              : 0
            const open = openLevel === row.level
            return (
              <li key={row.level}>
                <div className="grid grid-cols-[8rem_1fr_7rem] items-center gap-3 text-xs">
                  <span className="text-neutral-300">
                    {levelName(row.key)}
                    <button
                      type="button"
                      onClick={() => toggle(row.level)}
                      aria-expanded={open}
                      className="ml-2 text-[10px] text-prism-300 underline-offset-2 hover:underline"
                    >
                      {open ? t('admin.overview.levels.listHide') : t('admin.overview.levels.listToggle')}
                    </button>
                  </span>
                  <div className="h-5 rounded bg-white/5">
                    <div className="h-5 rounded bg-prism-500/50" style={{ width: `${width}%` }} />
                  </div>
                  <span className="text-right tabular-nums text-neutral-100">
                    {row.total}
                    {row.reachedInRange > 0 && (
                      <span className="ml-1 text-[10px] text-up">+{row.reachedInRange}</span>
                    )}
                  </span>
                </div>

                {open && (
                  <div className="mt-2 rounded-lg bg-white/5 p-3">
                    <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label={t('admin.overview.levels.scopeLabel')}>
                      {SCOPES.map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={scope === s}
                          onClick={() => switchScope(s)}
                          className={`rounded-full px-3 py-1 text-[11px] transition ${
                            scope === s
                              ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40'
                              : 'text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          {t(`admin.overview.levels.scope.${s}`)}
                        </button>
                      ))}
                    </div>

                    {listLoading && <SkeletonLine height={72} />}
                    {listError !== null && !listLoading && (
                      <p className="text-xs text-down">
                        {t('admin.overview.levels.failed')}
                        {listError ? `：${listError}` : ''}
                      </p>
                    )}
                    {list && !listLoading && (
                      <>
                        <p className="mb-2 text-[11px] leading-5 text-neutral-500">
                          {scope === 'all'
                            ? t('admin.overview.levels.noteAll', { level: levelName(list.key) })
                            : t('admin.overview.levels.noteRange', {
                                level: levelName(list.key),
                                from: list.rangeStart,
                                to: list.rangeEnd,
                              })}
                        </p>
                        {list.users.length === 0 ? (
                          <p className="text-xs text-neutral-500">{t('admin.overview.levels.empty')}</p>
                        ) : (
                          <>
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[560px] text-xs">
                                <thead>
                                  <tr className="text-left text-neutral-500">
                                    <th className="pb-2 font-medium">{t('admin.overview.levels.colUser')}</th>
                                    <th className="pb-2 font-medium">{t('admin.overview.levels.colPhone')}</th>
                                    <th className="pb-2 font-medium">{t('admin.overview.levels.colReachedAt')}</th>
                                    <th className="pb-2 text-right font-medium">{t('admin.overview.levels.colCurrent')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {list.users.map((u) => (
                                    <tr key={u.id} className="border-t border-white/5">
                                      <td className="py-1.5">
                                        <span className="text-neutral-200">{u.email}</span>
                                        {u.nickname && <span className="ml-2 text-[10px] text-neutral-500">{u.nickname}</span>}
                                      </td>
                                      <td className="py-1.5 text-neutral-400">{u.phone || '—'}</td>
                                      <td className="py-1.5 tabular-nums text-neutral-200">{fmtTime(u.reachedAt)}</td>
                                      <td className="py-1.5 text-right text-neutral-400">
                                        {u.currentLevel === list.level
                                          ? '—'
                                          : levelName(summary.levels[u.currentLevel - 1]?.key ?? '')}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {list.total > list.users.length && (
                              <p className="mt-2 text-[11px] text-neutral-500">
                                {t('admin.overview.levels.truncated', { total: list.total, shown: list.users.length })}
                              </p>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
