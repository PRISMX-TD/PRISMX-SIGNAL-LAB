// Myfxbook 社区情绪抓取 / Myfxbook community sentiment scraper
// 开发环境通过 Vite proxy 抓取，生产环境通过 public CORS proxy。

export interface MyfxSentiment {
  longPct: number
  shortPct: number
}

// 关注的品种 / symbols we care about (BTC not on Myfxbook)
const WATCH_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'XAUUSD', 'XAGUSD']

const MYFXBOOK_URL = 'https://www.myfxbook.com/community/outlook'

/**
 * 从 Myfxbook 页面 HTML 解析各品种的多空比。
 * Parse long/short percentages per symbol from Myfxbook HTML.
 */
export async function fetchMyfxbookSentiment(): Promise<Record<string, MyfxSentiment>> {
  // 开发环境走 Vite proxy，生产环境走 CORS proxy
  const isDev = import.meta.env.DEV
  const url = isDev
    ? '/proxy/myfxbook'
    : `https://corsproxy.io/?${encodeURIComponent(MYFXBOOK_URL)}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Myfxbook fetch failed: ${res.status}`)
  const html = await res.text()

  const result: Record<string, MyfxSentiment> = {}

  for (const sym of WATCH_SYMBOLS) {
    const symPattern = new RegExp(
      `/community/outlook/${sym}[\\s\\S]*?Short[\\s\\S]*?(\\d+)%[\\s\\S]*?Long[\\s\\S]*?(\\d+)%`,
      'i',
    )
    const m = symPattern.exec(html)
    if (m) {
      result[sym] = { shortPct: parseInt(m[1], 10), longPct: parseInt(m[2], 10) }
    }
  }

  return result
}
