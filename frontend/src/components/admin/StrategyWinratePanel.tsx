// 管理后台「策略胜率」子页：每个策略在亚洲盘/欧洲盘/纽约盘的近 N 天胜率矩阵。
// Admin "Strategy Win Rate" sub-tab: a matrix of each strategy's win rate in the
// Asian / European / New York sessions over the last N days.
//
// 时段窗口（小时区间 + IANA 时区）随接口一起下发，前端**不**复制一份：夏令时
// 的正确性只在后端保证一次，这里只负责把它翻译成看的人所在时区的钟点。
// The session windows (hour range + IANA zone) ship with the payload and are
// deliberately NOT duplicated here — DST correctness is settled once in the
// backend; this file only restates the window in the viewer's own clock.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { fmtTime } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate } from '../../api/types'
import { MIN_SAMPLES } from './winrate/shared'
import MatrixTable from './winrate/MatrixTable'

const DAY_OPTIONS = [7, 14, 30]

export default function StrategyWinratePanel() {
  const { t } = useTranslation()
  const [days, setDays] = useState(7)
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    adminApi
      .strategyWinrate(days)
      .then((res) => {
        // 慢请求返回时天数可能已经被改过——晚到的旧响应不能盖掉新的。
        // A slow response can land after the range changed; a stale reply must
        // not overwrite the current one.
        if (!cancelled) {
          setData(res)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Load failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [days])

  return (
    <div className="glass p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.winrate.title')}</h3>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.winrate.daysLabel')}>
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              aria-pressed={days === opt}
              onClick={() => setDays(opt)}
              className={`rounded-full px-3 py-1 text-xs transition ${
                days === opt
                  ? 'bg-white/10 text-neutral-100 ring-1 ring-white/20'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {t('admin.winrate.daysOption', { days: opt })}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-4 text-xs leading-5 text-neutral-500">{t('admin.winrate.hint')}</p>

      {error && <p className="py-3 text-sm text-down">{error}</p>}

      {loading && !data ? (
        <div className="space-y-2">
          <SkeletonLine width="100%" />
          <SkeletonLine width="85%" />
          <SkeletonLine width="65%" />
        </div>
      ) : data && data.overall.total.samples === 0 ? (
        <p className="py-3 text-sm text-neutral-500">{t('admin.winrate.empty')}</p>
      ) : data ? (
        <>
          {/* 判定链路健康条。窗口内有信号却一条都没判定，几乎一定是链路断了而不是
              "行情还没走到"——判定只在 POST /webhook/trend 带 high/low 时触发，
              正常运行下一周里不可能一条都判不出来。所以这种情况直接报警并给出
              该查什么，而不是让人对着满屏 0 笔猜。
              Resolution-pipeline health bar. Signals in the window with none
              resolved is almost always a broken pipeline rather than "price
              hasn't got there yet": resolution fires on POST /webhook/trend with
              high/low, and a whole week resolving nothing doesn't happen when
              it's working. So say so and name what to check, instead of leaving
              someone to guess at a screen of zeros. */}
          {data.overall.total.samples > 0 && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 text-[11px] leading-5 ${
                data.overall.total.resolved === 0
                  ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
                  : 'border-white/10 bg-white/[0.03] text-neutral-400'
              }`}
            >
              <span className="tabular-nums">
                {t('admin.winrate.health', {
                  samples: data.overall.total.samples,
                  resolved: data.overall.total.resolved,
                  pending: data.overall.total.pending,
                  stale: data.overall.total.stale,
                })}
              </span>
              <span className="ml-2 tabular-nums">
                {t('admin.winrate.lastResolved', {
                  when: data.lastResolvedAt ? fmtTime(data.lastResolvedAt) : t('admin.winrate.never'),
                })}
              </span>
              {data.overall.total.resolved === 0 && (
                <div className="mt-1 text-amber-200/80">{t('admin.winrate.stalledHint')}</div>
              )}
            </div>
          )}

          {/* Task 11 接真值前的占位：空 activeKeys 关掉高亮，空函数吞掉点击——
              矩阵先能编译能看，联动留给面板组装那一步。
              Placeholder ahead of Task 11 wiring real values: an empty activeKeys
              disables the highlight, a no-op swallows clicks — the matrix compiles
              and renders now, the interactivity lands with the panel assembly. */}
          <MatrixTable data={data} activeKeys={[]} onSelectStrategy={() => {}} />
          <p className="mt-3 text-[11px] leading-5 text-neutral-600">
            {t('admin.winrate.footnote', { min: MIN_SAMPLES })}
          </p>
        </>
      ) : null}
    </div>
  )
}
