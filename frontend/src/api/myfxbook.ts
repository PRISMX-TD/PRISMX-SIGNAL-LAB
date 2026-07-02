// Myfxbook 社区情绪抓取 / Myfxbook community sentiment scraper
// 通过后端代理 /api/proxy/myfxbook 获取页面并解析 HTML

export interface MyfxSentiment {
  longPct: number
  shortPct: number
}

// 关注的品种 / symbols we care about (BTC not on Myfxbook)
const WATCH_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'XAUUSD', 'XAGUSD']

/**
 * 从 Myfxbook 页面 HTML 解析各品种的多空比。
 * Parse long/short percentages per symbol from Myfxbook HTML.
 */
export async function fetchMyfxbookSentiment(): Promise<Record<string, MyfxSentiment>> {
  const res = await fetch('/api/proxy/myfxbook')
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
