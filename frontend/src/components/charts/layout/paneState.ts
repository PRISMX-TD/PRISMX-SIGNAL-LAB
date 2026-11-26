// 阶段 6 共享契约：一张图（多图布局里的一格）需要持久化的状态。布局保存、对比品种、回放三块都按这个结构对接。
// Phase 6 shared contract: the persisted state of one chart (one cell of a multi-chart layout). Layout saving,
// compare symbols and replay all plug into this shape.

// 对比品种的显示方式：percent = 同一价格轴改百分比；scale = 新开一条价格轴；pane = 新窗格
// How a compare symbol is shown: percent = same price axis switched to %; scale = its own new price axis; pane = new pane
export type CompareMode = 'percent' | 'scale' | 'pane'

export interface CompareEntry {
  symbol: string
  mode: CompareMode
  color: string
  // 隐藏但保留 / hidden but kept
  hidden?: boolean
}

export interface PaneState {
  symbol: string
  interval: string
  // 图表类型（不填 = 跟全局设置）/ chart type (absent = follow the global setting)
  chartType?: string
  // 指标布局（不填 = 用全局 chartv2/ind；第 1 格永远用全局）/ indicator layout (absent = global chartv2/ind; pane 0 always global)
  ind?: unknown
  compare?: CompareEntry[]
}
