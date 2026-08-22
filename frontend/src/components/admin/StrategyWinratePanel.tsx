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
import type { AdminStrategyWinRate, StrategyWinRate, WinRateBucket } from '../../api/types'
import { MIN_SAMPLES, localWindow } from './winrate/shared'

const DAY_OPTIONS = [7, 14, 30]

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

// 胜率配色只有三档，且只在样本足够时才上色——给一个 3 笔样本的格子涂绿色，
// 等于用颜色替读者下了一个数据支撑不了的结论。
// Three colour steps, applied only when the sample is large enough: colouring a
// three-trade cell green would use colour to assert a conclusion the data can't
// support.
function winRateClass(rate: number): string {
  if (rate >= 0.6) return 'text-up'
  if (rate <= 0.4) return 'text-down'
  return 'text-neutral-100'
}

function Cell({ bucket }: { bucket: WinRateBucket }) {
  const { t } = useTranslation()
  // 完整的四态明细统一挂在 title 上：表格里放不下，但排查时第一个想看的就是它。
  // The full four-state breakdown always goes on the title: there's no room for
  // it in the table, yet it's the first thing anyone debugging wants to see.
  const hint = t('admin.winrate.cellHint', {
    tp: bucket.hitTp, sl: bucket.hitSl, pending: bucket.pending, stale: bucket.stale,
  })
  if (bucket.samples === 0) {
    return <span className="text-neutral-600">—</span>
  }
  // 一条都没判定出来：显示待判定/追踪中断的条数，而不是"0 笔"。
  // "0 笔" 是这个面板上线后第一个真实故障现场给出的读数，而它把两种完全不同的
  // 情况（这个格子没信号 / 有一批信号但判定链路根本没跑）显示成了同一个样子——
  // 判定只在 POST /webhook/trend 带 high/low 时触发，链路一断就是满屏 0 笔。
  // Nothing resolved: show how many are pending or stale instead of "0 trades".
  // "0" was the readout from this panel's first real incident, and it rendered
  // two entirely different situations identically (no signals in this cell vs. a
  // pile of signals the resolver never touched). Resolution only fires on POST
  // /webhook/trend with high/low, so a broken feed means a screen full of zeros.
  if (bucket.resolved === 0) {
    return (
      <span className="text-amber-400/80" title={hint}>
        {bucket.pending > 0
          ? t('admin.winrate.pendingOnly', { count: bucket.pending })
          : t('admin.winrate.staleOnly', { count: bucket.stale })}
      </span>
    )
  }
  if (bucket.winRate === null || bucket.resolved < MIN_SAMPLES) {
    return (
      <span className="text-neutral-500" title={hint}>
        {/* count 而不是 resolved：i18next 靠这个参数名选单复数形式（英文 1 笔 / N 笔）。
            count, not resolved: i18next keys plural selection off this exact name. */}
        {t('admin.winrate.thinSample', { count: bucket.resolved })}
      </span>
    )
  }
  return (
    <span title={hint}>
      <span className={`font-medium tabular-nums ${winRateClass(bucket.winRate)}`}>{fmtPct(bucket.winRate)}</span>
      <span className="ml-1.5 text-[10px] tabular-nums text-neutral-500">
        {bucket.hitTp}/{bucket.resolved}
      </span>
    </span>
  )
}

function Row({ row, sessionKeys, isSummary }: { row: StrategyWinRate; sessionKeys: string[]; isSummary?: boolean }) {
  const { t } = useTranslation()
  return (
    <tr className={isSummary ? 'border-t border-white/10 bg-white/[0.03]' : 'border-t border-white/5'}>
      <td className={`py-2 pr-3 ${isSummary ? 'font-medium text-neutral-100' : 'text-neutral-200'}`}>
        {isSummary ? t('admin.winrate.allStrategies') : row.strategy || t('admin.winrate.unnamed')}
      </td>
      <td className="py-2 pr-3 text-right">
        <Cell bucket={row.total} />
      </td>
      {sessionKeys.map((key) => (
        <td key={key} className="py-2 pr-3 text-right">
          <Cell bucket={row.sessions[key]} />
        </td>
      ))}
    </tr>
  )
}

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

  const now = new Date()
  // outside 桶固定排在三个时段之后：它不是一个"盘"，是三个盘之间的空档。
  // The outside bucket always sorts after the three real sessions — it isn't a
  // session, it's the gaps between them.
  const sessionKeys = [...(data?.sessions ?? []).map((s) => s.key), 'outside']

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

          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="text-left align-bottom text-neutral-500">
                  <th className="pb-2 pr-3 font-medium">{t('admin.winrate.colStrategy')}</th>
                  <th className="pb-2 pr-3 text-right font-medium">{t('admin.winrate.colTotal')}</th>
                  {(data.sessions ?? []).map((s) => {
                    const w = localWindow(s, now)
                    return (
                      <th key={s.key} className="pb-2 pr-3 text-right font-medium">
                        <div className="text-neutral-300">{t(`admin.winrate.session.${s.key}`)}</div>
                        {/* 两行：上面是该金融中心的本地时间（口径本身），下面是换算到
                            管理员本地时区的钟点（实际几点看盘）。只给其中一个都会让人
                            在夏令时前后怀疑数据错了。
                            Two lines: the centre's own local window (the definition) above,
                            the same window in the admin's clock below. Showing only one of
                            them invites "the data looks wrong" every changeover. */}
                        <div className="text-[10px] font-normal tabular-nums text-neutral-600">
                          {String(s.startHour).padStart(2, '0')}:00–{String(s.endHour).padStart(2, '0')}:00 {s.tz}
                        </div>
                        <div className="text-[10px] font-normal tabular-nums text-neutral-600">
                          {t('admin.winrate.yourTime', { start: w.start, end: w.end })}
                        </div>
                      </th>
                    )
                  })}
                  <th className="pb-2 pr-3 text-right font-medium">
                    <div className="text-neutral-300">{t('admin.winrate.session.outside')}</div>
                    <div className="text-[10px] font-normal text-neutral-600">{t('admin.winrate.outsideNote')}</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <Row row={data.overall} sessionKeys={sessionKeys} isSummary />
                {data.strategies.map((row) => (
                  <Row key={row.strategy} row={row} sessionKeys={sessionKeys} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-neutral-600">
            {t('admin.winrate.footnote', { min: MIN_SAMPLES })}
          </p>
        </>
      ) : null}
    </div>
  )
}
