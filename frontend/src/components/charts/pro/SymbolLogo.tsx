// 自选表的品种图标（TradingView 式，但图都是自己画的简化版，不用任何外部素材）：
//   外汇对 = 两面圆形国旗叠在一起（左上是基础货币、右下是报价货币，中间留一道透明缝）；
//   指数 = 所属国家 / 地区的国旗，美股三大指数用带数字的色圆（500 / 100 / 30）；
//   贵金属、原油、天然气、铜 = 带品类图形的色圆；加密货币 = 币种色圆 + 符号；
//   其余 = 中性圆 + 首字母。
// 国旗只取能一眼认出的主要元素（色块、十字、圆点），20px 下画细节反而糊。
// 透明缝用 mask 挖出来而不是描一圈底色：行有悬停、选中两种底色，描边色总会和其中一种对不上。
// Watchlist symbol logos (TradingView-like, but every glyph is our own simplified drawing):
// FX pairs are two overlapping round flags (base top-left, quote bottom-right, a transparent
// gap between); indices use their country's flag, the three big US indices a numbered disc;
// metals, oil, gas and copper a tinted disc with a glyph; crypto a coin-coloured disc with a
// symbol; anything else a neutral disc with its initial. Flags keep only what reads at 20px.
// The gap is cut with a mask rather than a background-coloured ring, because rows have
// hover and selected backgrounds a fixed ring colour can't match.
import { memo, useId, type ReactNode } from 'react'
import { symbolCategory } from '../../../utils/symbolCategory'

const code = (sym: string) => {
  const head = sym.split(/[._\-#]/)[0] || sym
  return (/^[A-Z0-9]{6,}[a-z]$/.test(head) ? head.slice(0, -1) : head).toUpperCase()
}

// 五角星路径 / five-point star path
function star(cx: number, cy: number, r: number, rot = -90): string {
  let d = ''
  for (let i = 0; i < 10; i++) {
    const a = ((rot + i * 36) * Math.PI) / 180
    const rr = i % 2 ? r * 0.42 : r
    d += `${i ? 'L' : 'M'}${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`
  }
  return d + 'Z'
}

const UNION = (
  <>
    <rect width="20" height="20" fill="#012169" />
    <path d="M0 0L20 20M20 0L0 20" stroke="#fff" strokeWidth="4" />
    <path d="M0 0L20 20M20 0L0 20" stroke="#c8102e" strokeWidth="1.4" />
    <path d="M10 0V20M0 10H20" stroke="#fff" strokeWidth="6" />
    <path d="M10 0V20M0 10H20" stroke="#c8102e" strokeWidth="3.4" />
  </>
)
const nordic = (bg: string, cross: string, inner?: string) => (
  <>
    <rect width="20" height="20" fill={bg} />
    <path d="M7 0V20M0 10H20" stroke={cross} strokeWidth={inner ? 5 : 3.6} />
    {inner && <path d="M7 0V20M0 10H20" stroke={inner} strokeWidth="2.4" />}
  </>
)
const bands = (dir: 'h' | 'v', colors: string[]) => (
  <>
    {colors.map((c, i) => {
      const s = 20 / colors.length
      return dir === 'h'
        ? <rect key={i} y={i * s} width="20" height={s + 0.1} fill={c} />
        : <rect key={i} x={i * s} width={s + 0.1} height="20" fill={c} />
    })}
  </>
)

// 20×20 坐标系里的旗面（外面再裁成圆）/ flag art in a 20×20 box, clipped to a circle outside
const FLAGS: Record<string, ReactNode> = {
  US: (
    <>
      <rect width="20" height="20" fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((i) => <rect key={i} y={(i * 20) / 13} width="20" height={20 / 13} fill="#b22234" />)}
      <rect width="10" height={(20 / 13) * 7} fill="#3c3b6e" />
      {[[2.5, 2.5], [5, 4.5], [7.5, 2.5], [2.5, 6.5], [7.5, 6.5], [5, 8.5]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="0.7" fill="#fff" />)}
    </>
  ),
  EU: (
    <>
      <rect width="20" height="20" fill="#003399" />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6
        return <circle key={i} cx={10 + 5.6 * Math.cos(a)} cy={10 + 5.6 * Math.sin(a)} r="0.95" fill="#ffcc00" />
      })}
    </>
  ),
  GB: UNION,
  JP: (<><rect width="20" height="20" fill="#fff" /><circle cx="10" cy="10" r="5" fill="#bc002d" /></>),
  CH: (<><rect width="20" height="20" fill="#da291c" /><path d="M8.3 4.5h3.4v3.8h3.8v3.4h-3.8v3.8H8.3v-3.8H4.5V8.3h3.8z" fill="#fff" /></>),
  AU: (
    <>
      <rect width="20" height="20" fill="#012169" />
      <g transform="scale(0.5)">{UNION}</g>
      <path d={star(5, 15.2, 2.2)} fill="#fff" />
      <path d={star(14.5, 6, 1.2)} fill="#fff" /><path d={star(17, 10, 1.2)} fill="#fff" />
      <path d={star(12.5, 11.5, 1.1)} fill="#fff" /><path d={star(14.5, 16, 1.3)} fill="#fff" />
    </>
  ),
  NZ: (
    <>
      <rect width="20" height="20" fill="#012169" />
      <g transform="scale(0.5)">{UNION}</g>
      {[[15, 6, 1.4], [17.3, 10, 1.3], [12.6, 11, 1.2], [15, 16, 1.6]].map(([x, y, r]) => (
        <path key={`${x}${y}`} d={star(x, y, r)} fill="#c8102e" stroke="#fff" strokeWidth="0.5" />
      ))}
    </>
  ),
  CA: (
    <>
      <rect width="20" height="20" fill="#fff" />
      <rect width="5.5" height="20" fill="#d52b1e" /><rect x="14.5" width="5.5" height="20" fill="#d52b1e" />
      <path d="M10 5l1 2 1.6-.6-.5 3 1.6-1 .4 1.4 1.3-.2-.8 2.2.6.6-3.2 1.2.2 1.4h-.4l-.3-1.3h-1l-.3 1.3h-.4l.2-1.4-3.2-1.2.6-.6-.8-2.2 1.3.2.4-1.4 1.6 1-.5-3 1.6.6z" fill="#d52b1e" />
    </>
  ),
  CN: (
    <>
      <rect width="20" height="20" fill="#de2910" />
      <path d={star(6, 7, 3)} fill="#ffde00" />
      <path d={star(11, 3.6, 0.9, -60)} fill="#ffde00" /><path d={star(12.6, 5.8, 0.9, -40)} fill="#ffde00" />
      <path d={star(12.6, 8.6, 0.9, -90)} fill="#ffde00" /><path d={star(11, 10.6, 0.9, -110)} fill="#ffde00" />
    </>
  ),
  HK: (
    <>
      <rect width="20" height="20" fill="#de2910" />
      {Array.from({ length: 5 }, (_, i) => <ellipse key={i} cx="10" cy="6.6" rx="1.7" ry="3.2" fill="#fff" transform={`rotate(${i * 72} 10 10)`} />)}
      <circle cx="10" cy="10" r="0.8" fill="#de2910" />
    </>
  ),
  SG: (
    <>
      <rect width="20" height="20" fill="#fff" /><rect width="20" height="10" fill="#ef3340" />
      <circle cx="6.4" cy="5" r="3" fill="#fff" /><circle cx="7.6" cy="5" r="2.8" fill="#ef3340" />
    </>
  ),
  DE: bands('h', ['#000', '#dd0000', '#ffce00']),
  FR: bands('v', ['#0055a4', '#fff', '#ef4135']),
  IT: bands('v', ['#009246', '#fff', '#ce2b37']),
  NL: bands('h', ['#ae1c28', '#fff', '#21468b']),
  ES: (<>{bands('h', ['#aa151b', '#f1bf00', '#f1bf00', '#aa151b'])}</>),
  IN: (<>{bands('h', ['#ff9933', '#fff', '#138808'])}<circle cx="10" cy="10" r="2" fill="none" stroke="#000080" strokeWidth="0.6" /></>),
  MX: (<>{bands('v', ['#006847', '#fff', '#ce1126'])}<circle cx="10" cy="10" r="1.6" fill="#8c5a2b" /></>),
  SE: nordic('#006aa7', '#fecc00'),
  NO: nordic('#ba0c2f', '#fff', '#00205b'),
  DK: nordic('#c8102e', '#fff'),
  TR: (<><rect width="20" height="20" fill="#e30a17" /><circle cx="8" cy="10" r="4.6" fill="#fff" /><circle cx="9.2" cy="10" r="3.7" fill="#e30a17" /><path d={star(13.4, 10, 1.9, 180)} fill="#fff" /></>),
  ZA: (
    <>
      <rect width="20" height="20" fill="#fff" />
      <rect width="20" height="7" fill="#e03c31" /><rect y="13" width="20" height="7" fill="#001489" />
      <path d="M0 0L10 10L0 20" fill="none" stroke="#007749" strokeWidth="5" />
      <path d="M0 3.5L6.5 10L0 16.5z" fill="#000" />
    </>
  ),
  PL: bands('h', ['#fff', '#dc143c']),
  KR: (<><rect width="20" height="20" fill="#fff" /><circle cx="10" cy="10" r="4.5" fill="#cd2e3a" /><path d="M5.5 10a4.5 4.5 0 009 0 2.25 2.25 0 00-4.5 0 2.25 2.25 0 01-4.5 0z" fill="#0047a0" /></>),
  TH: bands('h', ['#a51931', '#f4f5f8', '#2d2a4a', '#2d2a4a', '#f4f5f8', '#a51931']),
  MY: (
    <>
      {bands('h', ['#cc0001', '#fff', '#cc0001', '#fff', '#cc0001', '#fff', '#cc0001'])}
      <rect width="10" height="11.5" fill="#010066" />
      <circle cx="4.6" cy="5.8" r="3" fill="#fc0" /><circle cx="5.6" cy="5.8" r="2.6" fill="#010066" />
      <path d={star(8, 5.8, 1.6)} fill="#fc0" />
    </>
  ),
}

// 货币 → 国旗 / currency → flag
const CCY_FLAG: Record<string, string> = {
  USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CHF: 'CH', AUD: 'AU', NZD: 'NZ', CAD: 'CA', CNH: 'CN', CNY: 'CN',
  HKD: 'HK', SGD: 'SG', SEK: 'SE', NOK: 'NO', DKK: 'DK', TRY: 'TR', ZAR: 'ZA', MXN: 'MX', PLN: 'PL', KRW: 'KR',
  THB: 'TH', MYR: 'MY', INR: 'IN',
}

// 指数 → 国旗或数字徽章（前缀匹配，长的在前）/ index → flag or numbered badge (prefix match)
type Badge = { text: string; bg: string }
const INDEX_LOGO: [string, string | Badge][] = [
  ['US500', { text: '500', bg: '#c62828' }], ['SPX', { text: '500', bg: '#c62828' }], ['SP500', { text: '500', bg: '#c62828' }],
  ['US100', { text: '100', bg: '#1e88e5' }], ['USTEC', { text: '100', bg: '#1e88e5' }], ['NAS100', { text: '100', bg: '#1e88e5' }],
  ['NDX', { text: '100', bg: '#1e88e5' }], ['NQ', { text: '100', bg: '#1e88e5' }],
  ['US30', { text: '30', bg: '#00897b' }], ['DJ30', { text: '30', bg: '#00897b' }], ['DJI', { text: '30', bg: '#00897b' }], ['DOW', { text: '30', bg: '#00897b' }],
  ['US2000', { text: '2K', bg: '#6d4c41' }], ['RUSSELL', { text: '2K', bg: '#6d4c41' }],
  ['USDX', { text: '$', bg: '#2e7d32' }], ['DXY', { text: '$', bg: '#2e7d32' }], ['VIX', { text: 'VIX', bg: '#5e5e6a' }],
  ['GER', 'DE'], ['DE40', 'DE'], ['DE30', 'DE'], ['DAX', 'DE'], ['UK100', 'GB'], ['FTSE', 'GB'], ['FRA40', 'FR'], ['CAC', 'FR'],
  ['EU50', 'EU'], ['EUSTX', 'EU'], ['STOXX', 'EU'], ['ESP35', 'ES'], ['IBEX', 'ES'], ['ITA40', 'IT'], ['NETH25', 'NL'], ['SWI20', 'CH'],
  ['JP225', 'JP'], ['JPN225', 'JP'], ['NIKKEI', 'JP'], ['N225', 'JP'], ['HK50', 'HK'], ['HSI', 'HK'], ['HK33', 'HK'],
  ['CHINA', 'CN'], ['CN50', 'CN'], ['AUS200', 'AU'], ['ASX200', 'AU'], ['SG30', 'SG'], ['IND50', 'IN'], ['NIFTY', 'IN'], ['KOSPI', 'KR'],
]

type Glyph = { bg: string; fg: string; art: ReactNode }
const BAR = <path d="M5.5 12.8h9l-1.6-5.6H7.1z" />
const DROP = <path d="M10 4.6c2.2 3 3.6 5 3.6 6.8a3.6 3.6 0 01-7.2 0c0-1.8 1.4-3.8 3.6-6.8z" />
const FLAME = <path d="M10 4.4c.4 2 2.9 3.2 2.9 6.2a2.9 2.9 0 01-5.8 0c0-1.4.7-2.2 1.5-2.9 0 1 .5 1.6 1 1.6-.3-1.6-.2-3.4.4-4.9z" />
const COMMODITY_LOGO: [string, Glyph][] = [
  ['XAU', { bg: '#c9a227', fg: '#fff4c4', art: BAR }], ['GOLD', { bg: '#c9a227', fg: '#fff4c4', art: BAR }],
  ['XAG', { bg: '#8e9aa6', fg: '#f1f4f7', art: BAR }], ['SILVER', { bg: '#8e9aa6', fg: '#f1f4f7', art: BAR }],
  ['XPT', { bg: '#7d8ea3', fg: '#eef2f7', art: BAR }], ['PLAT', { bg: '#7d8ea3', fg: '#eef2f7', art: BAR }],
  ['XPD', { bg: '#7c7f95', fg: '#eeeff6', art: BAR }], ['PALL', { bg: '#7c7f95', fg: '#eeeff6', art: BAR }],
  ['XCU', { bg: '#b06a3b', fg: '#ffe2cc', art: BAR }], ['COPPER', { bg: '#b06a3b', fg: '#ffe2cc', art: BAR }],
  ['XNG', { bg: '#2f6db5', fg: '#dcecff', art: FLAME }], ['NGAS', { bg: '#2f6db5', fg: '#dcecff', art: FLAME }],
  ['NATGAS', { bg: '#2f6db5', fg: '#dcecff', art: FLAME }], ['GAS', { bg: '#2f6db5', fg: '#dcecff', art: FLAME }],
]
const OIL: Glyph = { bg: '#3a3530', fg: '#e8d9b5', art: DROP }

const CRYPTO_LOGO: Record<string, Glyph> = {
  BTC: { bg: '#f7931a', fg: '#fff', art: <text x="10" y="14.1" textAnchor="middle" fontSize="11.5" fontWeight="700" fontFamily="Arial, sans-serif">₿</text> },
  ETH: { bg: '#627eea', fg: '#fff', art: <><path d="M10 3.6l3.8 6.4L10 12.3 6.2 10z" /><path d="M10 13.2l3.8-2.4L10 16.4l-3.8-5.6z" opacity="0.75" /></> },
}
const CRYPTO_COLOR: Record<string, string> = {
  XRP: '#23292f', SOL: '#7b4cdb', LTC: '#345d9d', BCH: '#0ac18e', DOGE: '#c2a633', ADA: '#0033ad', BNB: '#e0a91c',
  DOT: '#e6007a', LINK: '#2a5ada', AVAX: '#e84142', TRX: '#d9261c', TON: '#0098ea', MATIC: '#7b3fe4', SHIB: '#e3420a',
}

function Disc({ bg, children }: { bg: string; children?: ReactNode }) {
  return (<><circle cx="10" cy="10" r="10" fill={bg} />{children}</>)
}

/** 一面圆形国旗，画在 (x,y) 起、边长 d 的方格里 / one round flag in a d×d box at (x,y) */
function RoundFlag({ id, flag, x = 0, y = 0, d = 20 }: { id: string; flag: string; x?: number; y?: number; d?: number }) {
  return (
    <svg x={x} y={y} width={d} height={d} viewBox="0 0 20 20">
      <clipPath id={id}><circle cx="10" cy="10" r="10" /></clipPath>
      <g clipPath={`url(#${id})`}>{FLAGS[flag]}</g>
      <circle cx="10" cy="10" r="9.6" fill="none" stroke="rgb(255 255 255 / 0.14)" strokeWidth="0.8" />
    </svg>
  )
}

function Letter({ text, bg, fg = '#fff', size = 9 }: { text: string; bg: string; fg?: string; size?: number }) {
  const fs = text.length >= 3 ? size * 0.72 : text.length === 2 ? size * 0.92 : size
  return (
    <Disc bg={bg}>
      <text x="10" y="10" dy="0.36em" textAnchor="middle" fill={fg} fontSize={fs} fontWeight="700" fontFamily="var(--pt-font, system-ui), sans-serif">{text}</text>
    </Disc>
  )
}

function art(sym: string, uid: string): ReactNode {
  const c = code(sym)
  const cat = symbolCategory(sym)
  if (cat === 'forex') {
    const base = CCY_FLAG[c.slice(0, 3)]
    const quote = CCY_FLAG[c.slice(3, 6)]
    const back = quote ? <RoundFlag id={`${uid}q`} flag={quote} x={7} y={7} d={13} /> : <svg x={7} y={7} width={13} height={13} viewBox="0 0 20 20"><Letter text={c[3]} bg="#4a4a55" size={12} /></svg>
    const front = base ? <RoundFlag id={`${uid}b`} flag={base} d={14} /> : <svg width={14} height={14} viewBox="0 0 20 20"><Letter text={c[0]} bg="#4a4a55" size={12} /></svg>
    return (
      <>
        {/* 前面那面旗外扩一圈挖掉后面的旗，留出透明缝 / cut a gap around the front flag out of the back one */}
        <mask id={`${uid}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20">
          <rect width="20" height="20" fill="#fff" />
          <circle cx="7" cy="7" r="8.2" fill="#000" />
        </mask>
        <g mask={`url(#${uid}m)`}>{back}</g>
        {front}
      </>
    )
  }
  if (cat === 'index') {
    const hit = INDEX_LOGO.find(([p]) => c.startsWith(p))?.[1]
    if (typeof hit === 'string') return <RoundFlag id={`${uid}f`} flag={hit} />
    if (hit) return <Letter text={hit.text} bg={hit.bg} size={10} />
  }
  if (cat === 'commodity') {
    const hit = COMMODITY_LOGO.find(([p]) => c.startsWith(p))?.[1]
    if (hit) return <Disc bg={hit.bg}><g fill={hit.fg}>{hit.art}</g></Disc>
    if (/^(WTI|BRENT|BRN|UKOIL|USOIL|OIL|CL|XTI|XBR)/.test(c)) return <Disc bg={OIL.bg}><g fill={OIL.fg}>{OIL.art}</g></Disc>
    return <Letter text={c[0]} bg="#4d6b3c" />
  }
  if (cat === 'crypto') {
    const key = Object.keys(CRYPTO_LOGO).find((k) => c.startsWith(k))
    if (key) { const g = CRYPTO_LOGO[key]; return <Disc bg={g.bg}><g fill={g.fg}>{g.art}</g></Disc> }
    const ck = Object.keys(CRYPTO_COLOR).find((k) => c.startsWith(k))
    return <Letter text={c[0]} bg={ck ? CRYPTO_COLOR[ck] : '#4a4a55'} />
  }
  return <Letter text={(c[0] || '?')} bg="#4a4a55" />
}

/** 单个货币的圆形国旗（图上财经事件的提示卡用）；没有国旗的货币画首字母圆。
 *  One currency's round flag (the chart's econ-event card); currencies without a flag get a letter disc. */
export const CurrencyFlag = memo(function CurrencyFlag({ currency, size = 16, className }: { currency: string; size?: number; className?: string }) {
  const uid = 'cf' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const flag = CCY_FLAG[currency.toUpperCase()]
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" aria-hidden focusable="false">
      {flag ? <RoundFlag id={uid} flag={flag} /> : <Letter text={(currency[0] || '?').toUpperCase()} bg="#4a4a55" />}
    </svg>
  )
})

export default memo(function SymbolLogo({ symbol, size = 20, className }: { symbol: string; size?: number; className?: string }) {
  // useId 带冒号，放进 url(#…) 前去掉 / useId contains colons; strip them for url(#…)
  const uid = 'sl' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" aria-hidden focusable="false">
      {art(symbol, uid)}
    </svg>
  )
})
