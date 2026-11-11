// API 基础地址与多入口自动切换。
//
// 生产用 VITE_API_BASE 指向线上后端，开发留空走 Vite 代理（留空时本文件什么都不做）。
// 后端有七个入口，都到同一个新加坡后端：
//   · 主域名 api.prismxsignallab.com —— 大陆经香港边缘节点（ops/hk-edge），海外直连新加坡；
//   · 备用域名 api.pmxsl.com —— 也经香港，防的是「主域名被拉黑」；
//   · 第三域名 api.ljlhxhsys.com —— 也经香港，名字与平台毫无关联。2026-11-11 泉州（电信 / 移动）
//     按域名拉黑了前两个——连同它们的所有子域名，指向哪台服务器都一样；同一台服务器换个无关的
//     名字就能打开。以后再被拉黑，就再买一个新域名加在这里。
//   · 直连入口 api2.prismxsignallab.com、api2.pmxsl.com —— 不经香港、直接解析到新加坡源站，
//     原本防「香港节点 IP 被封」；泉州实测是按名字拦，这两个名字一样被拦（香港 IP 没封），
//     留给只拦了旧名字的地区。比香港慢，排在所有香港入口之后。
//   · IP 入口 https://43.134.110.47/_b —— 完全不用域名，直连新加坡源站，证书是签给 IP 本身的
//     （Let's Encrypt 短期 IP 证书，ops/sg-direct）。2026-11-11 泉州连当天新买的第三域名也拦
//     （指向新加坡也一样），只有不带我们域名的访问能通——没有名字可拉黑。永远排最后。
//     路径前缀 /_b：同一个 IP 的 `/` 给网页（IP 直开的网页入口），后端挪到 /_b/ 下，nginx 去掉
//     前缀再转发；所有调用方都是 `${API_BASE}/api…`、`/ws/client`、`/ops…` 这样拼，带前缀不影响。
//   · 香港 IP 入口 https://124.156.167.169/_b —— 同样不用域名，经香港边缘转新加坡（ops/hk-edge 的
//     default_server）。2026-11-11 泉州实测香港这台的 IP 没被封（封的只是名字），大陆走它比新加坡
//     IP 快，所以两个 IP 入口里它在前。
// 后端 CORS 与 vercel.json 的 CSP 全都已放行，任何页面（网站各域名、App 的 https://localhost）
// 连哪一个都行。
//
// 切换规则：
//   · 优先级：页面从哪个域名打开，就把那个域名的入口排最前（www2.* → 直连在前）；
//     其余按 主域名 → 备用 → 第三域名 → 直连。
//   · 上次探测出来能用的那个记在 localStorage，下次启动直接用它（App 里尤其重要：
//     入口被封后，不必每次冷启动都先撞一次墙）。
//   · 请求遇到网络层失败（连不上 / 超时，不是 HTTP 错误码）时，调用方报一次
//     reportApiFailure()：并发探测所有入口的根路径 `/`，**按优先级**取能用的那个——排在前面的
//     还没出结果就等它（最多 6 秒），不再是「谁先应答用谁」。否则大陆某些线路上新加坡偶尔
//     比香港先回，用户就被平白换到慢的那条。同一时刻只探一次，失败后 30 秒内不重复探。
//   · 当前不在首选入口上时，启动 15 秒后、之后每 5 分钟回头探一次排在前面的入口，通了就换回去
//     ——一次网络抖动落到后面入口的用户不会一直留在那里。
//   · API_BASE 是 `export let`：ES 模块的导出是活绑定，切换后所有 import 它的模块
//     下一次读取就是新值（REST、WebSocket 重连、遥测都不用改调用方式）。
//
// 管理员追加的入口（2026-11-11）：后台「运营设置 → 备用入口」填的地址，从 GET /api/site/entries
// 拉（启动 20 秒后、之后每 6 小时，能连上的时候），存 localStorage 的 prismx.apiEntries，排在
// 内置入口前面（页面自己的入口仍在最前）。现有名字和 IP 都被封时，事先加好的新入口不用发版本
// 就能接上；但只对拉到过列表的客户端有效，新入口也得先在服务器上搭好。注意网页 / PWA 受
// vercel.json 的 CSP 限制：新主机还要加进 connect-src 才能连（App 没有 CSP，不受影响）。
//
// Admin-added entries (2026-11-11): fetched from GET /api/site/entries (20 s after start, then
// every 6 h while reachable), stored in localStorage prismx.apiEntries and tried ahead of the
// built-ins (the page's own entry still first). Only clients that fetched the list benefit; the
// web/PWA additionally needs the new host in vercel.json's CSP connect-src (the App has no CSP).
//
// 单独成一个无依赖的小模块：clientErrorReport 在出错路径上也要用，不能拖进整个 client。
//
// API base and automatic failover across entry points.
//
// Prod points VITE_API_BASE at the backend; dev leaves it empty for the Vite proxy (this module
// then does nothing). Seven entry points, all reaching the same Singapore backend:
//   · main api.prismxsignallab.com — via the HK edge in mainland China (ops/hk-edge), direct abroad;
//   · backup api.pmxsl.com — also via HK; covers "the main domain is blacklisted";
//   · third api.ljlhxhsys.com — also via HK, a name unrelated to the product. On 2026-11-11
//     Quanzhou (China Telecom / Mobile) blacklisted the first two by name, every subdomain included,
//     whatever server they point at; the same server under an unrelated name opened fine. If this
//     one is blacklisted too, buy another domain and add it here.
//   · direct api2.prismxsignallab.com and api2.pmxsl.com — straight to the SG origin, no HK; cover
//     "the HK edge IP is blocked"; Quanzhou turned out to block by name (these names too, not the
//     HK IP), so they help only where just the old names are blocked. Slower; after every HK entry.
//   · IP entry https://43.134.110.47/_b — no domain at all, straight to the SG origin with a
//     certificate issued to the IP itself (Let's Encrypt short-lived IP cert, ops/sg-direct). On
//     2026-11-11 Quanzhou blocked even the third domain bought that day (pointed at SG too); only
//     access without one of our names got through — there is no name to blacklist. Always last.
//     The /_b prefix: `/` on that IP serves the website (the IP web entry), so the backend moves
//     under /_b/ and nginx strips it; every caller builds `${API_BASE}/api…`, `/ws/client`,
//     `/ops…`, so the prefix changes nothing for them.
//   · HK IP entry https://124.156.167.169/_b — no domain either, through the HK edge to SG (the
//     default_server in ops/hk-edge). Quanzhou does not block the HK IP itself (tested 2026-11-11),
//     and from the mainland it is faster than the SG IP, so it comes first of the two IP entries.
// Backend CORS and the vercel.json CSP allow all of them, so any page may use any of them.
//
// Rules:
//   · Priority: the entry of the domain the page was opened from goes first (www2.* → direct
//     first); the rest follow main → backup → third → direct.
//   · The last base a probe found working is kept in localStorage and used on the next start.
//   · On a network-level failure callers call reportApiFailure(): all entry points' `/` are probed
//     in parallel and the highest-priority one that answers wins — a higher-priority probe still
//     in flight is waited for (up to 6 s) instead of "first to answer wins", which on some
//     mainland routes would let SG beat HK and move users to the slow path for no reason.
//     One probe at a time, and none within 30 s of the last.
//   · While not on the preferred base, the higher-priority ones are re-probed 15 s after start and
//     every 5 min after; the first that answers is switched back to, so a blip doesn't leave a
//     user on a later entry for good.
//   · API_BASE is `export let`: ES module exports are live bindings, so every importer reads
//     the new value on its next access (REST, WebSocket reconnects and telemetry need no change).
//
// A dependency-free module so clientErrorReport can use it on the error path without pulling in client.

const MAIN_DOMAIN = 'prismxsignallab.com'
const BACKUP_DOMAIN = 'pmxsl.com'
const THIRD_DOMAIN = 'ljlhxhsys.com'
const BACKUP_BASE = `https://api.${BACKUP_DOMAIN}`
const THIRD_BASE = `https://api.${THIRD_DOMAIN}`
// 两个直连入口都解析到新加坡源站，名字分属两个域名。
// Both direct entries resolve to the SG origin, under different domains.
const DIRECT_MAIN_BASE = `https://api2.${MAIN_DOMAIN}`
const DIRECT_BACKUP_BASE = `https://api2.${BACKUP_DOMAIN}`
const DIRECT_WEB_HOSTS = [`www2.${MAIN_DOMAIN}`, `www2.${BACKUP_DOMAIN}`]
const SG_IP = '43.134.110.47'
const IP_BASE = `https://${SG_IP}/_b`
const HK_IP = '124.156.167.169'
const HK_IP_BASE = `https://${HK_IP}/_b`
const STORAGE_KEY = 'prismx.apiBase'
// 管理员在后台追加的入口（GET /api/site/entries），能连上时拉取、记在本地。
// Admin-added entries (GET /api/site/entries), fetched while connected and kept locally.
const ENTRIES_KEY = 'prismx.apiEntries'
const ENTRIES_MAX = 20
const ENTRIES_FIRST_MS = 20_000
const ENTRIES_EVERY_MS = 6 * 60 * 60_000
const PROBE_TIMEOUT_MS = 6_000
const PROBE_COOLDOWN_MS = 30_000
const RECHECK_FIRST_MS = 15_000
const RECHECK_EVERY_MS = 5 * 60_000

function pageHost(): string {
  return typeof location === 'undefined' ? '' : location.hostname
}

function onDomain(domain: string): boolean {
  const host = pageHost()
  return host === domain || host.endsWith(`.${domain}`)
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(base: string) {
  try {
    localStorage.setItem(STORAGE_KEY, base)
  } catch {
    // 隐私模式 / 配额满：记不住就下次再探一次，不影响本次。
    // Private mode / full quota: we just probe again next time.
  }
}

const configured = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '')

// 只认 https 基址：主机名或 IPv4、可选端口与路径前缀，无查询串 / 片段 / 结尾斜杠（与后端
// settings_store.normalize_api_entry 同一条规则）。本地存的值也过一遍：坏了就当没有。
// https bases only — hostname or IPv4, optional port and path prefix, no query / fragment /
// trailing slash (same rule as the backend's normalize_api_entry). Stored values are re-checked.
const ENTRY_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/

export function sanitizeEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 200 || !ENTRY_RE.test(item)) continue
    if (!out.includes(item)) out.push(item)
    if (out.length >= ENTRIES_MAX) break
  }
  return out
}

function readEntries(): string[] {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY)
    return raw ? sanitizeEntries(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function writeEntries(entries: string[]) {
  try {
    if (entries.length) localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries))
    else localStorage.removeItem(ENTRIES_KEY)
  } catch {
    // 记不住就下次再拉。/ Can't persist: fetched again next time.
  }
}

function candidateOrder(): string[] {
  const direct = [DIRECT_MAIN_BASE, DIRECT_BACKUP_BASE]
  const hk = [configured, BACKUP_BASE, THIRD_BASE]
  const ips = [HK_IP_BASE, IP_BASE]
  if (pageHost() === HK_IP) return [HK_IP_BASE, IP_BASE, ...hk, ...direct]
  if (pageHost() === SG_IP) return [IP_BASE, HK_IP_BASE, ...hk, ...direct]
  if (DIRECT_WEB_HOSTS.includes(pageHost())) return [...direct, ...hk, ...ips]
  // 页面所在域名的入口提前，其余顺序不变（Set 去重留第一次出现的位置）。
  // The page's own domain entry first, the rest in order (the Set keeps first occurrences).
  if (onDomain(THIRD_DOMAIN)) return [THIRD_BASE, ...hk, ...direct, ...ips]
  if (onDomain(BACKUP_DOMAIN)) return [BACKUP_BASE, ...hk, ...direct, ...ips]
  return [...hk, ...direct, ...ips]
}

// 合并顺序：页面不是从主域名打开时，页面自己那个入口仍排第一（同源最稳）；然后是管理员追加的
// 入口（管理员排的顺序，新 IP 可以排在被封的旧入口前面）；最后接上全部内置入口——列表写坏了
// 或被清空，也丢不了内置的。
// Merge order: when the page isn't on the main domain its own entry stays first (same origin is
// the safest); then the admin-added entries in admin order (a new IP can go ahead of a blocked
// one); then every built-in entry, so a bad or empty list never loses them.
function mergeCandidates(extra: readonly string[]): string[] {
  const builtin = candidateOrder()
  const own = builtin[0] !== configured ? [builtin[0]] : []
  return [...new Set([...own, ...extra, ...builtin])]
}

// 按优先级排好的全部入口；开发期（configured 为空）只有空串，不切换。`let`：拉到新列表后
// 整个换掉（ES 模块活绑定，导入方下次读就是新的）。
// All entry points in priority order; in dev (configured empty) just '' and no failover. `let`
// so a fetched list replaces it (live binding: importers see the new array on their next read).
export let API_CANDIDATES: readonly string[] = !configured ? [''] : mergeCandidates(readEntries())

function initialBase(): string {
  const stored = readStored()
  if (stored && API_CANDIDATES.includes(stored)) return stored
  return API_CANDIDATES[0]
}

export let API_BASE = initialBase()

let probing: Promise<void> | null = null
let lastProbeAt = -Infinity
let recheckTimer: ReturnType<typeof setTimeout> | undefined

async function probe(base: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    // 根路径返回 {"app": ..., "status": "ok"}：不查库、不鉴权，最便宜的"后端活着"信号。
    // `/` answers {"app": ..., "status": "ok"} with no DB or auth: the cheapest liveness signal.
    const res = await fetch(`${base}/`, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return base
  } finally {
    clearTimeout(timer)
  }
}

// 并发探测，按传入顺序（优先级）取第一个通的：排在它前面的都失败了才算数，所以一个更靠前的
// 还在探就等它。全部失败才 reject。
// Probe in parallel and take the first in the given (priority) order that answers: it only counts
// once every base ahead of it has failed, so a higher-priority probe still in flight is waited for.
// Rejects only if all fail.
function bestByPriority(bases: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const state: (boolean | undefined)[] = bases.map(() => undefined)
    const settle = () => {
      for (let i = 0; i < bases.length; i++) {
        if (state[i] === undefined) return
        if (state[i]) return resolve(bases[i])
      }
      reject(new Error('all failed'))
    }
    bases.forEach((b, i) => {
      probe(b).then(
        () => {
          state[i] = true
          settle()
        },
        () => {
          state[i] = false
          settle()
        },
      )
    })
  })
}

function switchTo(base: string) {
  if (base !== API_BASE && import.meta.env.DEV) console.info('[api] switching to', base)
  API_BASE = base
  writeStored(base)
  scheduleRecheck(RECHECK_EVERY_MS)
}

// 不在首选入口上时，定时回头探排在前面的入口，通了就换回去；已在首选上就什么都不排。
// While off the preferred base, periodically re-probe the ones ahead of it and switch back to the
// first that answers; nothing is scheduled once on the preferred base.
function scheduleRecheck(delay: number) {
  if (recheckTimer !== undefined) clearTimeout(recheckTimer)
  recheckTimer = undefined
  if (API_CANDIDATES.length < 2 || API_BASE === API_CANDIDATES[0]) return
  recheckTimer = setTimeout(recheck, delay)
}

async function recheck() {
  recheckTimer = undefined
  const idx = API_CANDIDATES.indexOf(API_BASE)
  const better = API_CANDIDATES.slice(0, idx < 0 ? API_CANDIDATES.length : idx)
  // 正在为一次失败探测：它结束时会自己决定入口，这里下一轮再来。
  // A failure probe is running and will pick the base itself; try again next round.
  if (probing || better.length === 0) return scheduleRecheck(RECHECK_EVERY_MS)
  try {
    switchTo(await bestByPriority(better))
  } catch {
    scheduleRecheck(RECHECK_EVERY_MS)
  }
}

scheduleRecheck(RECHECK_FIRST_MS)

// 从当前入口拉一次管理员的入口列表；变了就记下并重排候选。失败（断网、旧后端没有这个接口、
// 返回不是合法列表）一律静默，下一轮再来。
// Fetch the admin entry list from the current base; if it changed, persist and re-rank the
// candidates. Any failure (offline, an old backend without the endpoint, a malformed body) is
// silent and retried next round.
export async function refreshEntries(): Promise<void> {
  if (!configured) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/api/site/entries`, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return
    const body: unknown = await res.json()
    const raw = body && typeof body === 'object' ? (body as { entries?: unknown }).entries : undefined
    if (!Array.isArray(raw)) return
    const entries = sanitizeEntries(raw)
    if (JSON.stringify(entries) === JSON.stringify(readEntries())) return
    writeEntries(entries)
    API_CANDIDATES = mergeCandidates(entries)
    scheduleRecheck(RECHECK_EVERY_MS)
  } catch {
    // 下一轮再拉。/ Retry next round.
  } finally {
    clearTimeout(timer)
  }
}

function scheduleEntries(delay: number) {
  if (!configured) return
  setTimeout(() => {
    void refreshEntries().finally(() => scheduleEntries(ENTRIES_EVERY_MS))
  }, delay)
}

scheduleEntries(ENTRIES_FIRST_MS)

// 报告一次网络层失败，按需切换入口。返回的 Promise 在探测结束后 resolve（从不 reject），
// 调用方可以 await 它再重试，也可以不管。
// Report a network-level failure and switch entry points if needed. The promise resolves once
// probing is done (never rejects); callers may await it before retrying, or ignore it.
export function reportApiFailure(): Promise<void> {
  if (API_CANDIDATES.length < 2) return Promise.resolve()
  if (probing) return probing
  if (performance.now() - lastProbeAt < PROBE_COOLDOWN_MS) return Promise.resolve()
  lastProbeAt = performance.now()
  probing = bestByPriority(API_CANDIDATES)
    .then(switchTo)
    .catch(() => {
      // 全都连不上：多半是用户自己断网了，保持现状。
      // Nothing reachable: most likely the user is offline; keep the current base.
    })
    .finally(() => {
      probing = null
    })
  return probing
}
