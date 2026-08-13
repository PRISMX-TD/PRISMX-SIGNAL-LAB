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
// ── 标识：三字母，不是首字母 ──
// 首字母不是唯一标识：XAUUSD 与 XAGUSD 都是「X」，黄金和白银只靠颜色区分，
// 而其中一个还是低饱和灰——色觉障碍用户直接分不出。三字母不依赖颜色，
// 也正是交易员实际的读法。
//
// ── 颜色：用饱和度把两套色分开 ──
// 原来七个品种色里有三个就是品牌紫：USDJPY #7C3AED 距 --purple 只有 6°，
// EURUSD 14°，GBPUSD 15°。身份芯片出现在信号卡、持仓卡、订单表、报价表，
// 等于把「看起来像品牌色」的圆点撒了一地。实测那三个还都不过 AA
// （3.05 / 3.76 / 4.21）。
//
// 新规则两条：
//   甲、身份色 S ≤ 60%，语义/状态色 S ≥ 70%。用**饱和度**分开两套色比把色相
//       摊在色轮上稳得多——语义色（涨/跌/待处理）本来就都是高饱和。这也顺带
//       解决了 XAU(H48) 与状态金(H40) 只差 8° 的问题：色相近，但 S42 vs S73
//       一眼分得开。
//   乙、外汇对不给颜色。黄金、白银、原油、比特币有文化上固定的色，外汇对没有，
//       硬给三个色只是噪音。它们统一走中性芯片，靠三字母区分。
//
// Three-letter codes, not initials (XAUUSD and XAGUSD both started with "X" and
// were told apart by colour alone). Identity hues are separated from semantic
// ones by *saturation* (identity ≤60%, semantic ≥70%) rather than by hue, and FX
// pairs get no colour at all — they have no culturally fixed one.
//
// 每个品种有两个色：`color` 是芯片**底色**的来源（会被调用点降到 20% 不透明度
// 压在卡面上），`ink` 是压在那层底上的**文字色**。
// 分成两个而不是一个的原因很实际：底色要低饱和、暗，才不跟语义色打架；而同
// 一个值当文字色压在自己的 20% 底上只有 4.1–4.3，过不了 AA。所以文字取同色相
// 的提亮版——色相不变，识别性不变，对比度回到 5 以上。
// Two values per symbol: `color` seeds the chip fill (used at 20% opacity) and
// `ink` is the text on top. One value can't do both — the fill needs to be dark
// and low-chroma, but that same value as text on its own 20% tint scores ~4.2,
// under AA. The ink is the same hue, lifted.
export const SYMBOL_META: Record<string, { letter: string; color: string; ink: string }> = {
  XAUUSD: { letter: 'XAU', color: '#b8a351', ink: '#d6be6e' }, // 金  H48  S42
  XAGUSD: { letter: 'XAG', color: '#91a0ac', ink: '#afbcc8' }, // 银  H205 S14
  WTI: { letter: 'WTI', color: '#b36c56', ink: '#d08a72' },    // 油  H14  S38
  BTCUSD: { letter: 'BTC', color: '#ce8546', ink: '#e5a163' }, // 币  H28  S58
  EURUSD: { letter: 'EUR', color: '#a5a5b0', ink: '#c2c2cc' }, // 外汇对：中性
  GBPUSD: { letter: 'GBP', color: '#a5a5b0', ink: '#c2c2cc' },
  USDJPY: { letter: 'JPY', color: '#a5a5b0', ink: '#c2c2cc' },
}
export const DEFAULT_SYMBOL_META = { color: '#a5a5b0', ink: '#c2c2cc' }

export function symbolMeta(sym: string): { letter: string; color: string; ink: string } {
  // 兜底同样给三个字符：未知品种取代码前三位，与已知品种同构。
  // Unknown symbols also get three characters, matching the known ones.
  return SYMBOL_META[sym] ?? { letter: (sym.slice(0, 3) || '?').toUpperCase(), ...DEFAULT_SYMBOL_META }
}
