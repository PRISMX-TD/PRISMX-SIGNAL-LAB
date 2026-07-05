// Vercel Serverless Function：代理 Myfxbook 社区情绪页面
// Vercel Serverless Function: proxies Myfxbook community sentiment page
// 部署路径: /api/proxy/myfxbook

export const config = {
  runtime: 'edge',
}

export default async function handler(request: Request) {
  const url = new URL(request.url)

  // 支持重试参数（用于前端手动重试）/ support retry param for manual retry
  const retryCount = parseInt(url.searchParams.get('retry') || '0', 10)
  const maxRetries = 3

  try {
    // 使用多个 User-Agent 和请求头来避免被拦截 / Use multiple strategies to avoid blocking
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    ]
    const ua = userAgents[retryCount % userAgents.length]

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10s 超时 / 10s timeout

    const resp = await fetch('https://www.myfxbook.com/community/outlook', {
      signal: controller.signal,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Referer': 'https://www.myfxbook.com/',
        'Cache-Control': 'no-cache',
      },
    })

    clearTimeout(timeoutId)

    if (!resp.ok) {
      // 如果状态码是 429（限流）或 5xx，建议前端重试 / If rate-limited or server error, suggest retry
      if ((resp.status === 429 || resp.status >= 500) && retryCount < maxRetries) {
        return new Response(
          JSON.stringify({
            error: `Upstream ${resp.status}`,
            retryable: true,
            nextRetry: `/api/proxy/myfxbook?retry=${retryCount + 1}`,
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ error: `Upstream error: ${resp.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const html = await resp.text()

    // 验证我们确实获得了有效的 HTML（不是错误页面）
    // Verify we got actual content, not an error page
    if (!html || html.length < 1000 || !html.includes('community/outlook')) {
      return new Response(
        JSON.stringify({ error: 'Invalid response from Myfxbook' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // CDN 缓存 5 分钟（与前端轮询周期一致）
        // Cache at the CDN for 5 min (matches the frontend poll interval)
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    })
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e)

    // 超时或网络错误可重试 / Timeout/network errors are retryable
    const isRetryable = errorMsg.includes('timeout') || errorMsg.includes('abort')

    if (isRetryable && retryCount < maxRetries) {
      return new Response(
        JSON.stringify({
          error: errorMsg,
          retryable: true,
          nextRetry: `/api/proxy/myfxbook?retry=${retryCount + 1}`,
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
