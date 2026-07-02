// 多周期趋势小组件：英雄卡右上角，五格「周期 + 彩色箭头」。
// 无趋势数据时灰色 →，等 webhook 推送后自动亮起。
// Multi-timeframe trend widget: five "timeframe + colored arrow" cells in the hero card corner.
import type { Trend, TrendDir } from '../../api/types'
import { TREND_TFS } from './signalView'

// 每种趋势方向的视觉：箭头 + 颜色 / arrow + color for each trend direction
const TREND_VIS: Record<TrendDir, { arrow: string; color: string }> = {
  UP: { arrow: '↑', color: '#2ee07e' },
  DOWN: { arrow: '↓', color: '#ff4d67' },
  FLAT: { arrow: '→', color: '#64748b' },
}

export default function MultiTfTrend({ trend }: { trend?: Trend }) {
  return (
    <div className="flex items-center gap-1.5">
      {TREND_TFS.map((tf) => {
        const dir: TrendDir = trend?.timeframes?.[tf] ?? 'FLAT'
        const vis = TREND_VIS[dir]
        return (
          <div key={tf} className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] font-medium uppercase leading-none tracking-wider text-slate-500">{tf}</span>
            <span className="font-display text-sm font-bold leading-none" style={{ color: vis.color }}>
              {vis.arrow}
            </span>
          </div>
        )
      })}
    </div>
  )
}
