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
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } catch (e) {
    return new Response(String(e), { status: 500 })
  }
}
