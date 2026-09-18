// 转化漏斗：注册 → 绑定 MT5 → 下过单，外加两组缩进子行（潜在转化客户、真仓 / 模拟仓）
// 和最近 8 周分批表。各步独立统计、允许跳步，所以后一根柱子不一定比前一根短；
// 柱宽一律按「占注册人数比例」画，缩进行的百分比另算分母（见 PCT_BASE）。
//
// 「潜在转化客户」那一行可以展开名单：后台要的是「现在该联系谁」，只给一个人数没法行动。
// 名单按需拉取，不跟着看板一起加载——大多数时候只看数字。
//
// Conversion funnel with two groups of indented sub-rows, plus the last 8 signup
// weeks. Steps are counted independently (skipping allowed); bar width is always
// the share of registered users while percentages use their own denominators.
// The warm-leads row expands into the actual list, lazily fetched: a count alone
// isn't actionable, but most visits only read the number.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { AdminFunnelSteps, AdminFunnelWeek, AdminPotentialCustomers } from '../../../api/types'
import { fmtTime, localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'

type Step = keyof AdminFunnelSteps
const STEPS: Step[] = ['registered', 'potential', 'bound', 'boundReal', 'boundDemo', 'traded']
// 缩进的子行：它们是上一主行的拆分或子集，不是新的漏斗阶段。
// Indented rows: a split or subset of the row above, not a new funnel stage.
const SUB_STEPS = new Set<Step>(['potential', 'boundReal', 'boundDemo'])
// 每一步百分比的分母。潜在客户相对注册数，真仓 / 模拟仓相对绑定数，主步骤相对上一主步骤。
// Denominator per step: leads vs registered, real/demo vs bound, main steps vs the previous one.
const PCT_BASE: Partial<Record<Step, Step>> = {
  potential: 'registered',
  bound: 'registered',
  boundReal: 'bound',
  boundDemo: 'bound',
  traded: 'bound',
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

// 分批表里的百分比分母：真仓 / 模拟仓相对该周绑定数，其余相对该周注册数。
// Weekly-table denominator: real/demo vs that week's linked, everything else vs its signups.
function weekBase(step: Step, week: AdminFunnelWeek): number {
  return step === 'boundReal' || step === 'boundDemo' ? week.bound : week.registered
}

export default function FunnelCard({ funnel }: { funnel: { overall: AdminFunnelSteps; byWeek: AdminFunnelWeek[] } }) {
  const { t } = useTranslation()
  const { overall, byWeek } = funnel
  const base = overall.registered

  const [listOpen, setListOpen] = useState(false)
  const [list, setList] = useState<AdminPotentialCustomers | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  // 第一次展开才拉，之后复用；收起不清空，来回点不会反复打接口。
  // Fetched on first expand and kept afterwards, so toggling doesn't refetch.
  const toggleList = async () => {
    const next = !listOpen
    setListOpen(next)
    if (!next || list || listLoading) return
    setListLoading(true)
    setListError(null)
    try {
      setList(await adminApi.potentialCustomers())
    } catch (err) {
      setListError(err instanceof Error ? localizeApiError(err.message) : '')
    } finally {
      setListLoading(false)
    }
  }

  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.funnel.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.overview.funnel.hint')}</p>

      <ol className="space-y-2">
        {STEPS.map((step) => {
          const n = overall[step]
          const baseKey = PCT_BASE[step]
          const prev = baseKey ? overall[baseKey] : null
          const sub = SUB_STEPS.has(step)
          const width = base > 0 && n > 0 ? Math.max(2, (n / base) * 100) : 0
          return (
            <li key={step} className="grid grid-cols-[9rem_1fr_5rem] items-center gap-3 text-xs">
              <span className={sub ? 'pl-4 text-neutral-500' : 'text-neutral-300'}>
                {t(`admin.overview.funnel.step.${step}`)}
                {step === 'potential' && (
                  <button
                    type="button"
                    onClick={toggleList}
                    aria-expanded={listOpen}
                    className="ml-2 text-[10px] text-prism-300 underline-offset-2 hover:underline"
                  >
                    {listOpen ? t('admin.overview.funnel.listHide') : t('admin.overview.funnel.listToggle')}
                  </button>
                )}
              </span>
              <div className={sub ? 'h-3 rounded bg-white/5' : 'h-5 rounded bg-white/5'}>
                <div
                  className={sub ? 'h-3 rounded bg-prism-500/30' : 'h-5 rounded bg-prism-500/50'}
                  style={{ width: `${width}%` }}
                />
              </div>
              <span className="text-right tabular-nums text-neutral-100">
                {n}
                {prev !== null && <span className="ml-1 text-[10px] text-neutral-500">{pct(n, prev)}</span>}
              </span>
            </li>
          )
        })}
      </ol>

      {listOpen && (
        <div className="mt-4 rounded-lg bg-white/5 p-3">
          {listLoading && <SkeletonLine height={72} />}
          {listError !== null && !listLoading && (
            <p className="text-xs text-down">
              {t('admin.overview.funnel.listFailed')}
              {listError ? `：${listError}` : ''}
            </p>
          )}
          {list && (
            <>
              <p className="mb-2 text-[11px] leading-5 text-neutral-500">
                {t('admin.overview.funnel.listNote', {
                  days: list.windowDays,
                  min: list.minActiveDays,
                  from: list.windowFrom,
                })}
              </p>
              {list.users.length === 0 ? (
                // 周一、周二本周天数还不够门槛，名单必然为空——说清楚是"还没到时候"而不是
                // "确实没人"，否则看板每周头两天都像坏了。
                // On Mon/Tue the week is shorter than the threshold, so the list cannot
                // have anyone yet; say that rather than letting it read as "nobody".
                <p className="text-xs text-neutral-500">
                  {list.windowDays < list.minActiveDays
                    ? t('admin.overview.funnel.listTooEarly', { days: list.windowDays, min: list.minActiveDays })
                    : t('admin.overview.funnel.listEmpty')}
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-xs">
                      <thead>
                        <tr className="text-left text-neutral-500">
                          <th className="pb-2 font-medium">{t('admin.overview.funnel.colUser')}</th>
                          <th className="pb-2 font-medium">{t('admin.overview.funnel.colPhone')}</th>
                          <th className="pb-2 font-medium">{t('admin.overview.funnel.colSignup')}</th>
                          <th className="pb-2 text-right font-medium">{t('admin.overview.funnel.colActiveDays')}</th>
                          <th className="pb-2 text-right font-medium">{t('admin.overview.funnel.colLastSeen')}</th>
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
                            <td className="py-1.5 tabular-nums text-neutral-400">{fmtTime(u.createdAt)}</td>
                            <td className="py-1.5 text-right tabular-nums text-neutral-100">{u.activeDays}</td>
                            <td className="py-1.5 text-right tabular-nums text-neutral-400">{u.lastActiveDay || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {list.total > list.users.length && (
                    <p className="mt-2 text-[11px] text-neutral-500">
                      {t('admin.overview.funnel.listTruncated', { total: list.total, shown: list.users.length })}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      <h3 className="mb-2 mt-5 text-xs font-medium text-neutral-400">{t('admin.overview.funnel.byWeek')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-xs">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-2 font-medium">{t('admin.overview.funnel.weekOf')}</th>
              {STEPS.map((s) => <th key={s} className="pb-2 text-right font-medium">{t(`admin.overview.funnel.step.${s}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {byWeek.map((w) => (
              <tr key={w.weekStart} className="border-t border-white/5">
                <td className="py-1.5 tabular-nums text-neutral-300">{w.weekStart}</td>
                {STEPS.map((s) => (
                  <td key={s} className="py-1.5 text-right tabular-nums text-neutral-200">
                    {w[s]}
                    {s !== 'registered' && (
                      <span className="ml-1 text-[10px] text-neutral-500">{pct(w[s], weekBase(s, w))}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
