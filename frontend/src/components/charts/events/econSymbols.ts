// 品种 → 影响它的财经数据货币。图表上只标与当前品种相关的财经事件：
//   外汇对 = 两条腿（CNH 记作 CNY，日历里人民币数据的货币是 CNY）；
//   贵金属 / 原油 / 天然气 / 美元指数 / 加密货币 = 美元（以美元计价，美国数据影响最大），
//     XAUEUR 这类非美元报价再加上报价货币；
//   指数 = 所在市场的货币（HK50 受内地数据影响，给 HKD + CNY）；认不出的一律美元。
// Symbol → currencies whose economic releases move it. The chart only marks events relevant to
// the symbol: FX pairs = both legs (CNH counts as CNY, which is what the calendar uses for China);
// metals / oil / gas / the dollar index / crypto = USD (USD-priced, US data matters most), plus
// the quote currency for non-USD crosses such as XAUEUR; indices = their market's currency (HK50
// also reacts to mainland data, so HKD + CNY); anything unrecognised falls back to USD.
import { symbolCategory } from '../../../utils/symbolCategory'

const FX = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'CNH', 'CNY', 'HKD', 'SGD', 'SEK',
  'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'TRY', 'ZAR', 'MXN', 'RUB', 'THB', 'INR', 'KRW', 'TWD',
  'ILS', 'BRL', 'IDR', 'MYR', 'PHP', 'VND',
])

// 指数前缀 → 货币（长的在前，前缀匹配）/ index prefix → currencies (longest first, prefix match)
const INDEX_CCY: [string, string[]][] = [
  ['USDX', ['USD']], ['DXY', ['USD']],
  ['US500', ['USD']], ['US100', ['USD']], ['US2000', ['USD']], ['US30', ['USD']], ['USTEC', ['USD']], ['NAS100', ['USD']],
  ['NDX', ['USD']], ['NQ', ['USD']], ['SPX', ['USD']], ['SP500', ['USD']], ['DJ30', ['USD']], ['DJI', ['USD']], ['DOW', ['USD']],
  ['RUSSELL', ['USD']], ['VIX', ['USD']],
  ['GER', ['EUR']], ['DE40', ['EUR']], ['DE30', ['EUR']], ['DAX', ['EUR']], ['FRA40', ['EUR']], ['CAC', ['EUR']],
  ['EU50', ['EUR']], ['EUSTX', ['EUR']], ['STOXX', ['EUR']], ['ESP35', ['EUR']], ['IBEX', ['EUR']], ['ITA40', ['EUR']], ['NETH25', ['EUR']],
  ['SWI20', ['CHF']],
  ['UK100', ['GBP']], ['FTSE', ['GBP']],
  ['JP225', ['JPY']], ['JPN225', ['JPY']], ['NIKKEI', ['JPY']], ['N225', ['JPY']],
  ['HK50', ['HKD', 'CNY']], ['HSI', ['HKD', 'CNY']], ['HK33', ['HKD', 'CNY']], ['CHINAH', ['HKD', 'CNY']],
  ['CHINA50', ['CNY']], ['CN50', ['CNY']], ['CHINA', ['CNY']],
  ['AUS200', ['AUD']], ['ASX200', ['AUD']],
  ['SG30', ['SGD']], ['IND50', ['INR']], ['NIFTY', ['INR']], ['KOSPI', ['KRW']], ['TWIX', ['TWD']],
]

// 去掉经纪商后缀（与 symbolCategory 相同的规则）/ strip broker suffixes (same rule as symbolCategory)
function baseCode(sym: string): string {
  const head = sym.trim().split(/[._\-#]/)[0] || sym
  return (/^[A-Z0-9]{6,}[a-z]$/.test(head) ? head.slice(0, -1) : head).toUpperCase()
}

const norm = (c: string) => (c === 'CNH' ? 'CNY' : c)

export function currenciesForSymbol(symbol: string): string[] {
  const code = baseCode(symbol)
  if (!code) return ['USD']
  const cat = symbolCategory(symbol)
  const out: string[] = []
  const add = (c: string) => { const n = norm(c); if (!out.includes(n)) out.push(n) }
  if (cat === 'forex') {
    add(code.slice(0, 3))
    add(code.slice(3, 6))
    return out
  }
  if (cat === 'index') {
    const hit = INDEX_CCY.find(([p]) => code.startsWith(p))
    return hit ? [...hit[1]] : ['USD']
  }
  if (cat === 'commodity' || cat === 'crypto') {
    add('USD')
    // XAUEUR / BTCJPY：报价货币也算 / the quote leg counts too
    const tail = code.slice(-3)
    if (code.length >= 6 && FX.has(tail)) add(tail)
    return out
  }
  return ['USD']
}

// 日历里 currency 为空时按国家补 / country → currency when a release has no currency
const COUNTRY_CCY: Record<string, string> = {
  US: 'USD', EU: 'EUR', EA: 'EUR', EMU: 'EUR', DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', AT: 'EUR', BE: 'EUR', FI: 'EUR', GR: 'EUR',
  GB: 'GBP', UK: 'GBP', JP: 'JPY', CN: 'CNY', HK: 'HKD', AU: 'AUD', NZ: 'NZD', CA: 'CAD', CH: 'CHF',
  SG: 'SGD', SE: 'SEK', NO: 'NOK', DK: 'DKK', KR: 'KRW', IN: 'INR', ZA: 'ZAR', MX: 'MXN', TR: 'TRY',
}

export function currencyOf(g: { currency: string | null; country: string }): string {
  const c = (g.currency ?? '').toUpperCase()
  if (c) return norm(c)
  return COUNTRY_CCY[(g.country ?? '').toUpperCase()] ?? (g.country ?? '').toUpperCase()
}
