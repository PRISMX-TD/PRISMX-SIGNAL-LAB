// 策略分析的第一层：选一路（策略 × 品种），看它**一天里胜率最高的三个时段**和
// **胜率最低的三个时段**。时段 = 一天中的一个小时，按浏览者本地钟点显示。
//
// 2026-10-11 产品要求重做：原来这一层以「现在是哪个盘（亚 / 欧 / 美）、还剩多久、
// 这个盘里最好的几个钟点」为锚，右侧还有一条三大盘的时间轴。现在去掉盘的概念，
// 直接回答两件事：一天里什么时候最该做、什么时候最该躲。
//
// 钟点数据来自 `symbolRow.total.hourly`（后端按 UTC 分 24 格，只含已判定信号），
// 排名规则见 shared.bestWorstHours：**不设样本门槛**（产品决定），所以每项都带笔数。
//
// 选择与仪表盘「当前时段胜率」卡**共用同一份偏好**（`useWinratePick`，云端按用户
// 落库、跨设备）——那张卡的「查看详情 ›」就链到这一页，两处选中值不一致会让人以为
// 点错了地方。**没有「全部」这一项**：所有策略所有品种合起来的钟点胜率不指向任何
// 一个能下手的动作。
//
// The analysis page's first layer: pick a line (strategy x symbol) and see its
// **three best hours** and **three worst hours** of the day, in the viewer's local
// clock. Reworked 2026-10-11 at the product owner's request: the old layer was
// anchored on the open session (Asia / Europe / New York) with a session timeline
// beside it; sessions are gone, and the layer now answers "when to trade, when to
// stay out". Hours come from `symbolRow.total.hourly`, ranked by
// shared.bestWorstHours with **no sample floor** (product call), so each entry
// shows its trade count. The pick is shared with the dashboard card
// (`useWinratePick`), and there is deliberately no "all" option.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate } from '../../api/types'
import RateChip from './RateChip'
import Select from '../Select'
import { bestWorstHours, fmtHourRange, type HourStat } from './shared'
import { useWinratePick } from './useWinratePick'

function HourList({ label, hint, hours, empty, tone }: {
  label: string
  hint: string
  hours: HourStat[]
  empty: string
  tone: 'best' | 'worst'
}) {
  return (
    <div>
      <p className="wr-cap">
        <i className={`wr-tone ${tone}`} aria-hidden="true" />
        {label}
        <span className="hint">{hint}</span>
      </p>
      {hours.length > 0 ? (
        <div className="wr-chips">
          {hours.map((h) => (
            <RateChip key={h.localMinutes} kind={h.kind} name={fmtHourRange(h.localMinutes)} rate={h.rate} count={h.n} />
          ))}
        </div>
      ) : (
        <p className="wr-none">{empty}</p>
      )}
    </div>
  )
}

export default function WatchNow({ data, now }: { data: AdminStrategyWinRate; now: Date }) {
  const { t } = useTranslation()
  const { pick, row, symbolRow, chooseStrategy, chooseSymbol } = useWinratePick(data)
  const { best, worst } = bestWorstHours(symbolRow?.total.hourly ?? null, now)
  const hint = String(t('signals.analysis.hours.hint', { days: data.days }))

  return (
    <section className="card glass animate-fade-in-up wr-now">
      <h2 className="wr-cap">{t('signals.analysis.hours.title')}</h2>

      {pick && row && (
        <div className="wr-pickers">
          <Select
            className="min-w-0"
            ariaLabel={t('dashboard.sessionWinrate.pickStrategy')}
            value={pick.strategy}
            options={data.strategies.map((s) => ({
              value: s.strategy,
              label: s.strategy || t('admin.winrate.strategies.unnamed'),
            }))}
            onChange={chooseStrategy}
          />
          <Select
            className="min-w-0 tabular-nums"
            ariaLabel={t('dashboard.sessionWinrate.pickSymbol')}
            value={pick.symbol}
            options={row.symbols.map((s) => ({ value: s.symbol, label: s.symbol }))}
            onChange={chooseSymbol}
          />
        </div>
      )}

      <div className="wr-groups">
        <HourList
          tone="best"
          label={t('signals.analysis.hours.best')}
          hint={hint}
          hours={best}
          empty={t('signals.analysis.hours.none', { days: data.days })}
        />
        <HourList
          tone="worst"
          label={t('signals.analysis.hours.worst')}
          hint={hint}
          hours={worst}
          empty={t('signals.analysis.hours.none', { days: data.days })}
        />
      </div>
    </section>
  )
}
