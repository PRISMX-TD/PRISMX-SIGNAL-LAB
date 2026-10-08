// 比赛报名意图（spec §4）：访客从比赛推广链接 /c/<compId> 进来、还没登录时记下「想报
// 这场」，注册 / 登录 / 补全资料 / 直连绑定成功后把他送回 /competitions?c=<id>。
//
// 安全：id 会被拼进站内跳转地址，所以读、写、以及服务端下发的 pendingCompetition.id
// 一律过严格 UUID 校验（整串匹配，不容任何空白 / 控制字符 / 斜杠 / 编码）——这是防开放
// 跳转与路径注入的唯一闸门，拼接时不再做别的转义。
//
// 生命周期：14 天过期；key 刻意不在 store/auth.tsx 的 LOGOUT_KEEP_KEYS 里（登出即清）。
// resumeCompIntent 不清意图：新用户要走 注册 → 验证邮箱 → 绑定 三站，每站都可能要再
// 送一次；报名成功（或比赛已不存在）时由比赛页调用 clearCompIntent()。
//
// Competition intent (spec §4): when a logged-out visitor arrives via /c/<compId>, remember
// it and, after register / login / profile completion / direct bind, send them back to
// /competitions?c=<id>.
// Security: the id is spliced into an in-app URL, so every read, write and the server's
// pendingCompetition.id pass a strict whole-string UUID check — the single gate against open
// redirects and path injection; no other escaping is applied.
// Lifetime: 14 days; deliberately absent from LOGOUT_KEEP_KEYS (cleared on logout).
// resumeCompIntent does not consume it — a new user passes register → verify email → bind and
// may need sending back at each step; the competitions page clears it on successful entry.
import type { User } from '../api/types'
import { readJson, removeStorage, writeJson } from './safeStorage'

export const COMP_INTENT_KEY = 'prismx.compIntent'
export const COMP_INTENT_TTL_MS = 14 * 24 * 60 * 60 * 1000
// 时钟回拨容差：写入时间比现在还晚这么多就当被篡改（否则可以无限延长有效期）。
// Clock-skew allowance: a stamp further in the future than this is treated as tampering
// (it would otherwise extend the TTL indefinitely).
const FUTURE_SKEW_MS = 5 * 60 * 1000

// 不用 m 标志：JS 的 $ 在无 m 时只匹配串尾，结尾的 \n 也会被拒绝。
// No m flag: without it JS's $ matches only at the very end, so a trailing \n is rejected.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isCompId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export function storeCompIntent(compId: string): boolean {
  if (!isCompId(compId)) return false
  return writeJson(COMP_INTENT_KEY, { id: compId.toLowerCase(), ts: Date.now() })
}

export function readCompIntent(): string | null {
  const raw = readJson<unknown>(COMP_INTENT_KEY, null)
  if (raw == null) return null
  const now = Date.now()
  const { id, ts } = (typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as { id?: unknown; ts?: unknown }
  const valid =
    isCompId(id) &&
    typeof ts === 'number' &&
    Number.isFinite(ts) &&
    ts <= now + FUTURE_SKEW_MS &&
    now - ts <= COMP_INTENT_TTL_MS
  if (!valid) {
    // 过期 / 被改坏的条目顺手删掉，下次不再解析 / drop expired or tampered entries
    removeStorage(COMP_INTENT_KEY)
    return null
  }
  return (id as string).toLowerCase()
}

export function clearCompIntent(): void {
  removeStorage(COMP_INTENT_KEY)
}

/** 只在当前意图指向这场比赛时才清（大小写不敏感），返回是否清了。报名成功时用：
 *  报的是 A 场，不能顺手把指向 B 场的意图也清掉。
 *  Clears the intent only when it points at this competition (case-insensitive);
 *  returns whether it did. Entering competition A must not drop an intent for B. */
export function clearCompIntentFor(compId: string): boolean {
  if (readCompIntent() !== compId.toLowerCase()) return false
  clearCompIntent()
  return true
}

export type CompIntentUser = Pick<User, 'pendingCompetition'> | null | undefined

/** 有意图时返回站内比赛页地址，否则 null。本地意图优先，其次服务端 pendingCompetition。
 *  The in-app competition URL when there is an intent, else null. Local intent first,
 *  then the server's pendingCompetition. */
export function compIntentTarget(user: CompIntentUser): string | null {
  const local = readCompIntent()
  const pending = user?.pendingCompetition?.id
  const id = local ?? (isCompId(pending) ? pending.toLowerCase() : null)
  return id ? `/competitions?c=${id}` : null
}

/** 登录类页面的统一目的地：声明式 <Navigate> 与提交后的 navigate() 必须用同一个，
 *  见 LoginPage 里关于 v7_startTransition 的说明。没有意图时恒为 '/dashboard'。
 *  The single post-auth destination: the declarative <Navigate> and the imperative
 *  navigate() after submit must agree (see the v7_startTransition note in LoginPage).
 *  Exactly '/dashboard' when there is no intent. */
export function postAuthDestination(user: CompIntentUser): string {
  return compIntentTarget(user) ?? '/dashboard'
}

export type CompIntentNavigate = (to: string, options?: { replace?: boolean }) => void

/** 有意图就跳过去（replace）并返回 true；没有就什么都不做、返回 false，由调用方走原来的路。
 *  Navigates (replace) and returns true when there is an intent; otherwise does nothing and
 *  returns false so the caller keeps its original behaviour. */
export function resumeCompIntent(navigate: CompIntentNavigate, user: CompIntentUser): boolean {
  const target = compIntentTarget(user)
  if (!target) return false
  navigate(target, { replace: true })
  return true
}
