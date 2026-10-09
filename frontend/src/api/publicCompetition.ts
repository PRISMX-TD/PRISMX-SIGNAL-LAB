// 公开比赛页的接口（设计 §3.1）：未登录访客用，裸 fetch，**不走 request()**。
// 原因：request() 会自动带上本机存的登录 token（公开页被已登录的浏览器打开时也会带），
// 401 时还会清登录态、写操作失败会切换入口——这些对一个无需身份的公开接口都是错的副作用。
// 这里一律不带 Authorization、不带 cookie（credentials: 'omit'），失败只抛带状态码的
// PublicHttpError，由页面区分 404（不存在/未公开）与其他（稍后刷新）。
// 入口仍用 apiBase 的 API_BASE（活绑定，跟随主备切换）；网络错误时顺手报一次故障，让
// apiBase 去探测备用入口。
// Public competition endpoints (spec §3.1) for logged-out visitors: bare fetch, never
// request(). request() attaches the stored session token (also when a signed-in browser
// opens the public page), clears the session on 401 and switches entry points on failed
// writes — all wrong for an identity-free public endpoint. No Authorization, no cookies;
// failures throw PublicHttpError with the status so the page can tell 404 from "retry later".
// The base is apiBase's live API_BASE; a network error reports a failure so apiBase can probe
// the backup entry.
import { API_BASE, reportApiFailure } from './apiBase'
import type { PublicCompetition, PublicCompetitionEvent } from './types'

export class PublicHttpError extends Error {
  status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.name = 'PublicHttpError'
    this.status = status
  }
}

const TIMEOUT_MS = 15_000

// 导出给其它公开接口复用（游客预览、站点配置）：同样不带身份、不碰登录态。
// Exported for the other public endpoints (guest preview, site config): same identity-free fetch.
export async function publicGetJson<T>(path: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (err) {
    void reportApiFailure()
    throw err
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new PublicHttpError(res.status)
  return (await res.json()) as T
}

export const publicCompetitionApi = {
  featured: () => publicGetJson<{ id: string | null }>('/public/competitions/featured'),
  detail: (id: string) => publicGetJson<PublicCompetition>(`/public/competitions/${encodeURIComponent(id)}`),
  // 漏斗打点：后端永远 204。keepalive 让点击 CTA 后立刻跳页时请求也能发出去；
  // 任何失败都吞掉——打点绝不能挡住访客。
  // Funnel ping: always 204 server-side. keepalive lets it survive the navigation that
  // follows a CTA click; every failure is swallowed — a ping must never block the visitor.
  event: (body: PublicCompetitionEvent): Promise<void> =>
    fetch(`${API_BASE}/api/public/competitions/event`, {
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(
      () => undefined,
      () => undefined,
    ),
}
