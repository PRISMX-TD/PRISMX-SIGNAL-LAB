// Vercel Serverless Function：代理 Myfxbook 社区情绪页面
// Vercel Serverless Function: proxies Myfxbook community sentiment page
// 部署路径: /api/proxy/myfxbook

export const config = {
  runtime: 'edge',
}

export default async function handler() {
  try {
    const resp = await fetch('https://www.myfxbook.com/community/outlook', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
    })
    if (!resp.ok) {
      return new Response(`Upstream error: ${resp.status}`, { status: 502 })
    }
    const html = await resp.text()
    return new Response(html, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        // CDN 缓存 5 分钟（与前端轮询周期一致）：所有用户共享一份缓存，
        // 降低对 Myfxbook 的请求量，也避免被其风控拉黑。
        // Cache at the CDN for 5 min (matches the frontend poll interval):
        // all users share one cached copy, keeping Myfxbook traffic minimal.
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    })
  } catch (e) {
    return new Response(String(e), { status: 500 })
  }
}
