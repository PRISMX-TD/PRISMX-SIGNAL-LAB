// 数据覆盖度提示：在回测执行之前就把「你选了 365 天，库里实际只有 47 天」说清楚。
//
// 只显示可用天数、日期区间与根数。断档数与累计缺失时长曾经也在这里显示，后来撤掉了：
// 那两个数字绝大部分由周末与节假日休市构成（后端的 coverage_for() 无从区分正常休市
// 与喂价中断，数据上两者完全一样），于是稳定显示着「179 处断档、缺失 2038 小时」这种
// 看着像故障、实际全属正常的数字，反而盖住了真正要传达的「可用范围有多长」。
//
// Only the available span, date range and bar count are shown. Gap count and
// total missing hours used to appear here and were removed: they consist almost
// entirely of weekend and holiday closures (the backend's coverage_for() can't
// tell a normal closure from a feed outage — they look identical in the data), so
// they persistently displayed alarming-looking figures like "179 gaps, 2038h
// missing" that were entirely normal, drowning out the point of this notice.
//
// 存在的理由是 spec 里那条已核实的现状缺陷：K 线唯一写入路径是 EA 推送，每次只
// 回补最新 500 根，历史深度靠 EA 长期在线累积，断线期间形成永久空洞。此前用户
// 完全看不出实际范围，回测数字看着精确，实际建立在一段自己都不知道多长的历史上。
//
// Data-coverage notice, shown *before* a backtest runs: "you asked for 365 days,
// the store holds 47". Why it exists: the only write path for candles is the EA
// push, which backfills just the latest 500 bars, so depth accrues only while
// the EA stays online and disconnections leave permanent holes. Users previously
// had no way to see the real range — precise-looking numbers over a history of
// unknown length.
import { useTranslation } from 'react-i18next'
import { displaySymbol, fmtDate } from '../../api/utils'
import { intervalLabel } from './conditionTypes'
import type { StrategyCoverage } from '../../api/types'

export interface CoverageNoticeProps {
  coverage: StrategyCoverage | null
  // 用户在回测参数里选的天数。与 coverage.spanDays 对比得出那句提示。
  // The day count the user picked in the backtest params, compared against
  // coverage.spanDays to produce the headline sentence.
  requestedDays: number
  // 覆盖度还在拉取。加载中显示占位，不显示"0 天可用"——那会被读成"没有数据"。
  // Coverage still loading: show a placeholder rather than "0 days available",
  // which reads as "there is no data".
  loading?: boolean
}

export default function CoverageNotice({ coverage, requestedDays, loading }: CoverageNoticeProps) {
  const { t } = useTranslation()

  if (loading) {
    return <p className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-500">{t('strategy.coverageLoading')}</p>
  }
  if (!coverage) return null

  const available = Math.floor(coverage.spanDays)
  // 实际可用不足所选的 80% 才算"明显短于预期"。留 20% 余量是因为周末休市本身
  // 就会让 spanDays 低于自然日天数，卡死等号会让每次回测都亮警告，警告随即失效。
  // Flag "materially shorter than requested" only below 80% of the request. The
  // 20% slack exists because weekend closures alone push spanDays under the
  // calendar-day count; an exact comparison would warn on every backtest and the
  // warning would stop meaning anything.
  const short = available < requestedDays * 0.8
  const bad = coverage.bars === 0 || !coverage.feedActive
  const toneClass = bad
    ? 'border-down/30 bg-down/5 text-down'
    : short
      ? 'border-amber-400/20 bg-amber-400/5 text-amber-200'
      : 'border-white/10 bg-white/[0.02] text-slate-400'

  return (
    // 严重程度不只靠颜色：坏消息用 role="alert" 让读屏主动播报，其余用 status。
    // Severity isn't conveyed by color alone: bad news uses role="alert" so screen
    // readers announce it, everything else uses status.
    <div
      className={`rounded-lg border p-3 text-xs leading-relaxed ${toneClass}`}
      role={bad || short ? 'alert' : 'status'}
    >
      <div className="font-medium">
        {t('strategy.coverageHeadline', {
          symbol: displaySymbol(coverage.symbol),
          interval: intervalLabel(coverage.interval),
          requested: requestedDays,
          available,
        })}
      </div>
      {coverage.earliestT != null && coverage.latestT != null && (
        <div className="mt-1.5 font-mono text-[11px] opacity-90">
          {t('strategy.coverageRange', {
            from: fmtDate(new Date(coverage.earliestT * 1000).toISOString()),
            to: fmtDate(new Date(coverage.latestT * 1000).toISOString()),
            n: coverage.bars,
          })}
        </div>
      )}
      {!coverage.feedActive && <div className="mt-1.5">{t('strategy.coverageFeedInactive')}</div>}
    </div>
  )
}
