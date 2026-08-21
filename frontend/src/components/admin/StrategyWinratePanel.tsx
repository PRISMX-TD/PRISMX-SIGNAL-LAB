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
import { SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate, SessionWindow, StrategyWinRate, WinRateBucket } from '../../api/types'

const DAY_OPTIONS = [7, 14, 30]

// 已判定样本少于这个数的格子按"样本不足"处理：只显示样本数、不显示百分比。
// 7 天再切成三个时段之后，一个格子里常常只有两三笔——"66.7% 胜率(3 笔里赢 2)"
// 是个会被当真的数字，而它和抛硬币没有区别。宁可显示"样本不足"也不给一个
// 看起来很确定的百分比。
// Cells with fewer resolved samples than this show the count instead of a
// percentage. Seven days split three ways often leaves two or three trades per
// cell, and "66.7% (2 of 3)" is a figure people act on despite being
// indistinguishable from a coin flip. Better to say "too few" than to print a
// confident-looking percentage.
const MIN_SAMPLES = 5

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

/** 某个 IANA 时区在给定时刻的 UTC 偏移（分钟）。夏令时体现在这里：同一个时区
 *  一月和七月返回的值不同。
 *  A zone's UTC offset in minutes at a given instant; DST shows up here, with
 *  January and July returning different values for the same zone. */
function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at)
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0'
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

function fmtClock(totalMinutes: number): string {
  // 取模到一天内：时段换算到本地时区后可能跨零点（东京盘对欧洲用户就是凌晨）。
  // Wrap into a day: converted to the viewer's zone a session can cross midnight
  // (the Tokyo session is the small hours for a European admin).
  const m = ((totalMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 把时段窗口翻译成看的人本地时区的钟点，例如「16:00–01:00」。
 *  按"此刻"的偏移换算，所以夏令时切换后这行字自己就变了。
 *  Restate the window in the viewer's local clock, e.g. "16:00–01:00", using the
 *  offsets in effect right now — so it shifts by itself across a DST changeover. */
function localWindow(session: SessionWindow, now: Date): { start: string; end: string } {
  const viewerOffset = -now.getTimezoneOffset()
  const delta = viewerOffset - zoneOffsetMinutes(session.tz, now)
  return {
    start: fmtClock(session.startHour * 60 + delta),
    end: fmtClock(session.endHour * 60 + delta),
  }
}

function Cell({ bucket }: { bucket: WinRateBucket }) {
  const { t } = useTranslation()
  if (bucket.samples === 0) {
    return <span className="text-neutral-600">—</span>
  }
  if (bucket.winRate === null || bucket.resolved < MIN_SAMPLES) {
    return (
      <span
        className="text-neutral-500"
        title={t('admin.winrate.thinSampleHint', { resolved: bucket.resolved, samples: bucket.samples })}
      >
        {/* count 而不是 resolved：i18next 靠这个参数名选单复数形式（英文 1 笔 / N 笔）。
            count, not resolved: i18next keys plural selection off this exact name. */}
        {t('admin.winrate.thinSample', { count: bucket.resolved })}
      </span>
    )
  }
  return (
    <span title={t('admin.winrate.cellHint', { tp: bucket.hitTp, sl: bucket.hitSl, pending: bucket.pending, stale: bucket.stale })}>
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
