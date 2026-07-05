// Myfxbook 社区情绪抓取 / Myfxbook community sentiment scraper
// 通过 Vercel Edge Function /api/proxy/myfxbook 获取页面并解析 HTML

export interface MyfxSentiment {
  longPct: number
  shortPct: number
}

// 关注的品种 / symbols we care about (BTC not on Myfxbook)
const WATCH_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'XAUUSD', 'XAGUSD']

/**
 * 从 Myfxbook 页面 HTML 解析各品种的多空比。支持自动重试。
 * Parse long/short percentages per symbol from Myfxbook HTML. Auto-retries on failure.
 */
export async function fetchMyfxbookSentiment(): Promise<Record<string, MyfxSentiment>> {
  let lastError: Error | null = null

  // 最多重试 3 次 / retry up to 3 times
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `/api/proxy/myfxbook${attempt > 0 ? `?retry=${attempt}` : ''}`
      const res = await fetch(url)

      if (!res.ok) {
        const contentType = res.headers.get('content-type')
        if (contentType?.includes('application/json')) {
          // Edge Function 返回 JSON 错误响应
          const json = await res.json() as { error?: string; retryable?: boolean }
          if (json.retryable && attempt < 2) {
            // 等待后重试 / wait then retry
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
            continue
          }
          throw new Error(`Myfxbook error: ${json.error || res.status}`)
        }
        throw new Error(`Myfxbook fetch failed: ${res.status}`)
      }

      const html = await res.text()

      // 解析 HTML 中的多空比 / parse sentiment data from HTML
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
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < 2) {
        // 等待后重试 / wait then retry
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }

  throw lastError || new Error('Failed to fetch Myfxbook sentiment after 3 retries')
}
