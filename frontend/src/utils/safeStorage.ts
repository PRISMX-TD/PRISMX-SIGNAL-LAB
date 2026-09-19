// localStorage / sessionStorage 的安全读写 / guarded Web Storage access
//
// 为什么需要这一层：Web Storage 的每一次访问都可能**同步抛异常**，而不只是
// 返回 null——Safari 无痕模式、企业策略禁用站点数据、部分内嵌 WebView 下，
// 连 `localStorage` 这个属性本身都会抛 SecurityError。全站有三十多处裸调用，
// 其中 store/auth.tsx 与 i18n/index.ts 那两处位于**模块/Provider 初始化路径**，
// 在 ErrorBoundary 之外：抛一次就是整站白屏，而且坏状态不会自己消失，用户每次
// 打开都是白屏，只能手动清站点数据。安卓 App（WebView 不重装）尤其致命。
//
// 设计取舍：读失败一律当成"没有这个值"，写失败一律静默丢弃。缓存是加速与
// 离线兜底，不是真相来源——真相在后端。让一次写不进缓存去打断用户正在做的事，
// 代价远大于收益（此前 X-Refreshed-Token 的续期写入就因为这个把本来成功的请求
// 变成了报错）。需要知道写没写成的调用方看 setItem 的布尔返回值。
//
// Guarded Web Storage access. Every Web Storage call can throw *synchronously*
// rather than merely return null: in Safari private mode, with site data
// disabled by enterprise policy, and inside some embedded WebViews, even
// touching the `localStorage` property raises SecurityError. Two of the site's
// thirty-odd raw call sites (store/auth.tsx and i18n/index.ts) sit on the
// module / provider init path, outside any ErrorBoundary — one throw there is a
// site-wide blank page that never clears itself, since the bad condition
// persists across reloads. On the Android app (whose WebView is never
// reinstalled) that is terminal.
//
// Trade-off: a failed read is treated as "no such value", a failed write is
// silently dropped. Storage here is a cache and an offline fallback, never the
// source of truth — that lives on the backend. Letting a failed cache write
// interrupt what the user is doing costs far more than it buys (the
// X-Refreshed-Token renewal write used to turn successful requests into errors
// for exactly this reason). Callers that must know pass on setItem's boolean.

type Store = 'local' | 'session'

function backing(kind: Store): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage
  } catch {
    // 属性访问本身就会抛 / the property access itself can throw
    return null
  }
}

export function readStorage(key: string, kind: Store = 'local'): string | null {
  try {
    return backing(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** 写入成功返回 true；配额满 / 隐私模式下返回 false，不抛。
 *  Returns true on success; false (never a throw) when quota is full or storage is blocked. */
export function writeStorage(key: string, value: string, kind: Store = 'local'): boolean {
  try {
    const s = backing(kind)
    if (!s) return false
    s.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function removeStorage(key: string, kind: Store = 'local'): void {
  try {
    backing(kind)?.removeItem(key)
  } catch {
    /* 同上，删不掉也不该打断调用方 / same rationale: a failed delete must not propagate */
  }
}

// 读 + JSON.parse 的组合。解析失败会**主动删掉那份缓存**再返回 fallback：
// 坏值留在存储里意味着下次打开还是同一个错，而这些缓存全部可以从后端重建。
// 这正是 auth.tsx 启动时那次裸 JSON.parse 造成永久白屏的修法。
// Read + JSON.parse. A parse failure *removes* the offending entry before
// returning the fallback: leaving a corrupt value behind means the same failure
// on every future load, and every one of these caches can be rebuilt from the
// backend. This is the fix for the bare JSON.parse in auth.tsx's lazy state
// initialiser, which turned one bad value into a permanent blank page.
export function readJson<T>(key: string, fallback: T, kind: Store = 'local'): T {
  const raw = readStorage(key, kind)
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    removeStorage(key, kind)
    return fallback
  }
}

export function writeJson(key: string, value: unknown, kind: Store = 'local'): boolean {
  try {
    return writeStorage(key, JSON.stringify(value), kind)
  } catch {
    // JSON.stringify 也会抛（循环引用 / BigInt）/ stringify throws too (cycles, BigInt)
    return false
  }
}
