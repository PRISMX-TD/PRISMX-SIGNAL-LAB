// 品种分类（外汇 / 商品 / 指数 / 加密货币），报价表和图表页自选栏的分类标签共用。
// EA 推什么品种前端就显示什么，所以这里不是一份白名单，而是按代码规则推断：
// 先认加密货币和商品的常见代码前缀，再认指数，最后「两个三字母货币代码拼起来」
// 的才算外汇。都不像的归 other——只在「全部」里出现，不会被硬塞进某个分类。
// 经纪商常给代码加后缀（XAUUSD.m、EURUSDc、US500.cash），先去掉再判断。
//
// Symbol categories (forex / commodity / index / crypto), shared by the quotes
// table and the charts watchlist tabs. The symbol list follows whatever the EA
// pushes, so this infers from the code instead of keeping a whitelist: crypto and
// commodity prefixes first, then indices, and forex only when the code is two
// ISO currency codes back to back. Anything else is 'other' — listed under
// "All" only, never forced into a category. Broker suffixes (XAUUSD.m, EURUSDc,
// US500.cash) are stripped before matching.

export type SymbolCategory = 'forex' | 'commodity' | 'index' | 'crypto' | 'other'

/** 标签栏里分类的固定顺序 / fixed order of the category tabs */
export const SYMBOL_CATEGORIES: Exclude<SymbolCategory, 'other'>[] = ['forex', 'commodity', 'index', 'crypto']

const CRYPTO = [
  'BTC', 'ETH', 'XRP', 'SOL', 'LTC', 'BCH', 'DOGE', 'ADA', 'BNB', 'DOT', 'LINK', 'AVAX',
  'TRX', 'XLM', 'UNI', 'MATIC', 'POL', 'SHIB', 'TON', 'ATOM', 'ETC', 'XMR', 'NEAR', 'APT',
  'ARB', 'OP', 'PEPE', 'SUI', 'FIL', 'AAVE', 'HBAR', 'ALGO', 'EOS', 'XTZ', 'DASH', 'ZEC',
]
// 贵金属 / 能源 / 农产品与工业金属 / precious metals, energy, softs & base metals
const COMMODITY = [
  'XAU', 'XAG', 'XPT', 'XPD', 'GOLD', 'SILVER', 'PLAT', 'PALL',
  'WTI', 'BRENT', 'BRN', 'UKOIL', 'USOIL', 'OIL', 'CL', 'XTI', 'XBR', 'XNG', 'NGAS', 'NATGAS', 'GAS',
  'COPPER', 'XCU', 'HG', 'ALU', 'ZINC', 'NICKEL',
  'COFFEE', 'COCOA', 'SUGAR', 'COTTON', 'CORN', 'WHEAT', 'SOYBEAN', 'SOY',
]
// 指数还决定手数步长（0.1，见 api/utils.ts lotStep）；后端 symbol_aliases.py 的
// _INDEX_PREFIXES 是这张表的副本，增删要两边一起改。
// Indices also get a 0.1 lot step (api/utils.ts lotStep); the backend's _INDEX_PREFIXES
// in symbol_aliases.py is a copy of this list — change both together.
const INDEX = [
  'US500', 'US30', 'US100', 'USTEC', 'NAS100', 'NDX', 'NQ', 'SPX', 'SP500', 'DJ30', 'DJI', 'DOW', 'US2000', 'RUSSELL',
  'GER40', 'GER30', 'DE40', 'DE30', 'DAX', 'UK100', 'FTSE', 'FRA40', 'CAC', 'EU50', 'EUSTX50', 'STOXX50', 'ESP35', 'IBEX',
  'ITA40', 'NETH25', 'SWI20', 'JP225', 'JPN225', 'NIKKEI', 'N225', 'HK50', 'HSI', 'HK33', 'CHINA50', 'CN50', 'CHINAH',
  'AUS200', 'ASX200', 'SG30', 'IND50', 'NIFTY', 'TWIX', 'KOSPI', 'VIX', 'USDX', 'DXY',
]
const FX = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'CNH', 'CNY', 'HKD', 'SGD', 'SEK',
  'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'TRY', 'ZAR', 'MXN', 'RUB', 'THB', 'INR', 'KRW', 'TWD',
  'ILS', 'BRL', 'IDR', 'MYR', 'PHP', 'VND',
])

// 去掉经纪商后缀：「.」「_」「-」之后的部分，以及结尾单个小写字母（EURUSDm / EURUSDc）
// Strip broker suffixes: anything after . _ -, and a single trailing lowercase letter
function baseCode(sym: string): string {
  const head = sym.split(/[._\-#]/)[0] || sym
  return (/^[A-Z0-9]{6,}[a-z]$/.test(head) ? head.slice(0, -1) : head).toUpperCase()
}

const startsWithAny = (code: string, list: string[]) => list.some((p) => code.startsWith(p))

export function symbolCategory(sym: string): SymbolCategory {
  const code = baseCode(sym)
  if (!code) return 'other'
  if (startsWithAny(code, CRYPTO) && !FX.has(code.slice(0, 3))) return 'crypto'
  if (startsWithAny(code, COMMODITY)) return 'commodity'
  if (startsWithAny(code, INDEX)) return 'index'
  if (/^[A-Z]{6}$/.test(code) && FX.has(code.slice(0, 3)) && FX.has(code.slice(3))) return 'forex'
  return 'other'
}
