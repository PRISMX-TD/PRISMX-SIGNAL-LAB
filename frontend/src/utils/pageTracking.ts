// 页面停留上报：离开某个页面时把「路径 + 停留秒数」发给后端累加。
//
// 为什么用 fetch + keepalive 而不是 navigator.sendBeacon：
// sendBeacon 无法设置自定义请求头，而这个端点要求 Authorization: Bearer。
// 用 sendBeacon 就只能把 token 放进 body 或 query，等于把凭证从标准头挪到
// 更容易被日志/Referer 记录的位置，为一个统计功能降低凭证的安全性不值得。
// fetch(..., { keepalive: true }) 同样能在页面卸载后继续把请求发出去，且
// 支持完整请求头，是这里的正确工具。
//
// 上报失败一律静默：这是埋点，不是业务操作。用户不该因为统计没记上而看到
// 任何东西，也不该因此重试浪费带宽。
//
// Dwell-time reporting: on leaving a page, send "path + seconds" for the
// backend to accumulate.
//
// Why fetch + keepalive rather than navigator.sendBeacon: sendBeacon cannot set
// custom headers, and this endpoint requires Authorization: Bearer. Using it
// would mean moving the credential into the body or query string — out of the
// standard header and into somewhere more likely to be captured by logs or
// Referer. Weakening credential handling for a stats feature isn't worth it.
// fetch(..., { keepalive: true }) also survives page unload and supports full
// headers, making it the right tool here.
//
// Failures are always silent: this is telemetry, not a business action. Nothing
// should surface to the user, and nothing should be retried.
import { API_BASE, getToken } from '../api/client'

// 与后端 telemetry.ALLOWED_PATHS 对应。这里也过滤一遍，纯粹是省掉注定被
// 后端忽略的无用请求（例如 /login、/ 这些不在统计范围内的路径）。
// Mirrors the backend's telemetry.ALLOWED_PATHS. Filtering here too simply
// avoids firing requests the backend is guaranteed to ignore.
const TRACKED_PATHS = new Set([
  '/dashboard',
  '/app',
  '/charts',
  '/bind',
  '/orders',
  '/strategies',
  '/upgrade',
  '/account',
  '/download',
  '/admin',
  '/simulator',
])

// 低于这个秒数不上报：路由跳转途中的一闪而过（例如登录后自动重定向）不是
// 真正的"访问"，计进去会把平均停留时长压低。
// Below this, skip: a path flashed through during a redirect (e.g. the
// post-login bounce) isn't a real visit and would drag the average down.
const MIN_DWELL_SECONDS = 1

export function reportPageView(path: string, seconds: number) {
  if (!TRACKED_PATHS.has(path)) return
  if (seconds < MIN_DWELL_SECONDS) return

  const token = getToken()
  if (!token) return

  try {
    void fetch(`${API_BASE}/api/telemetry/pageview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path, seconds: Math.round(seconds) }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // 埋点失败静默 / telemetry failures are silent
  }
}
