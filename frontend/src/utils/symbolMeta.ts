// 已知品种的展示元数据（字母 + 配色），全站需要按品种上色/取首字母的地方
// （报价表、交易表现的品种分布图……）统一从这里取，同一个品种在任何地方
// 颜色都一致。活跃列表里出现未在此列出的新品种时，用品种名首字母 + 统一
// 灰色兜底，不需要为了新品种改这份表才能显示。品种名本身走 i18n
// （signals.symbolNames），这里只管颜色/首字母。
//
// Known display metadata (letter + color) for a handful of symbols. Anywhere
// in the app that colors things by symbol (quotes table, the trading-
// performance symbol breakdown, …) pulls from this single source, so the
// same symbol always gets the same color everywhere. A symbol appearing in
// an active list but not listed here falls back to its own first letter + a
// neutral color, so a brand-new symbol shows up without needing a code
// change here. Symbol names themselves come from i18n (signals.symbolNames);
// this only owns color/letter.
export const SYMBOL_META: Record<string, { letter: string; color: string }> = {
  XAUUSD: { letter: 'X', color: '#f6c453' },
  XAGUSD: { letter: 'X', color: '#94a3b8' },
  WTI: { letter: 'W', color: '#d97757' },
  EURUSD: { letter: 'E', color: '#6366f1' },
  GBPUSD: { letter: 'G', color: '#a855f7' },
  USDJPY: { letter: 'U', color: '#7c3aed' },
  BTCUSD: { letter: 'B', color: '#f59e0b' },
}
export const DEFAULT_SYMBOL_META = { color: '#64748b' }

export function symbolMeta(sym: string): { letter: string; color: string } {
  return SYMBOL_META[sym] ?? { letter: sym.charAt(0).toUpperCase() || '?', color: DEFAULT_SYMBOL_META.color }
}
