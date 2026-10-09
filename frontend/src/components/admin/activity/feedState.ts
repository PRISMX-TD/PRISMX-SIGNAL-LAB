// 操作日志列表的纯逻辑：翻页拼接、自动刷新的门槛、记住上次的分类。React 无关，单测直接钉。
// Pure list logic for the activity log: page merging, the auto-refresh gate and the
// remembered category. React-free so the tests pin it directly.
import type { ActivityCatFilter, ActivityItem, ActivitySub } from '../../../api/types'
import { readJson, writeJson } from '../../../utils/safeStorage'

export const PAGE_LIMIT = 50
export const AUTO_REFRESH_MS = 60_000
// 「列表在顶部」的容差：吸顶的日期分隔行、手机地址栏收放都会让 scrollY 差几十像素。
// Slack for "the list is at the top": sticky separators and the phone URL bar shift
// scrollY by a few dozen pixels.
export const AT_TOP_PX = 120

/**
 * 「加载更多」拿到的下一页拼到已有列表后面。契约 §1.1：后端为了不把一次管理员操作、一次
 * 爆仓切到两页，会沿某个源多取一段，所以下一页可能出现比本页末尾稍新的别的行——拼完按
 * ts 倒序重排（sort 是稳定的，同一时间戳保持后端给的源顺序）。key 已经出现过的丢掉：
 * 契约保证不会重复，这里是防自己——两次「加载更多」赶在一起时同一页可能到两遍。
 * Appends the next page. Contract §1.1: the backend reads a group to its end rather than
 * cut it, so a later page can hold rows slightly newer than this page's tail — re-sort by
 * ts desc after appending (stable sort keeps the backend's source order on ties). Keys
 * already present are dropped: the contract promises no repeats, this guards against our
 * own double "load more" landing the same page twice.
 */
export function mergePage(existing: ActivityItem[], incoming: ActivityItem[]): ActivityItem[] {
  const seen = new Set(existing.map((i) => i.key))
  const merged = existing.slice()
  for (const it of incoming) {
    if (seen.has(it.key)) continue
    seen.add(it.key)
    merged.push(it)
  }
  return sortByTs(merged)
}

/** ts 倒序；ts 是固定宽度的 UTC 字符串，直接比字符串即可。/ ts desc; fixed-width UTC strings compare as text. */
export function sortByTs(items: ActivityItem[]): ActivityItem[] {
  return items.slice().sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
}

/**
 * 合并行就地展开：展开了的行后面紧跟它的 children（child 自己不再嵌套，契约 §2）。
 * key 带上父行，同一个 child 不会因为两次出现而撞 key。
 * Merged rows expand in place: an expanded row is followed by its children (which never
 * nest further, contract §2). Child keys are scoped by the parent so they cannot collide.
 */
export function withChildren(
  items: ActivityItem[],
  expanded: ReadonlySet<string>,
): { key: string; item: ActivityItem; child: boolean; parent: ActivityItem }[] {
  const out: { key: string; item: ActivityItem; child: boolean; parent: ActivityItem }[] = []
  for (const it of items) {
    out.push({ key: it.key, item: it, child: false, parent: it })
    if (!expanded.has(it.key)) continue
    for (const c of it.children ?? []) out.push({ key: `${it.key}>${c.key}`, item: c, child: true, parent: it })
  }
  return out
}

export type AutoRefreshAction = 'skip' | 'refresh' | 'peek'

/**
 * 自动刷新每 60 秒问一次该做什么（设计 §6）：
 *   · 页面在后台、或上一次还没回来 → 什么都不做（不白打后端）；
 *   · 列表在顶部、详情没开 → 真刷新；
 *   · 否则只「偷看」一眼最新一条（limit=1），有新的就亮「有新记录 ↑」——直接刷新会把
 *     正在看的那几行从眼皮底下挪走，或者让详情里那一行和列表对不上。
 * 已经亮了提示就不再偷看：结论不会变，再查一次只是白花一次请求。
 * Every 60s the auto-refresh asks what to do (design §6): nothing while the page is hidden
 * or a load is still in flight; a real refresh when the list is at the top and no drawer
 * is open; otherwise only a limit=1 "peek" that lights the "new records" pill — a real
 * refresh would yank the rows being read, or leave the open drawer pointing at a row the
 * list no longer shows. Once the pill is lit there is nothing new to learn, so no peek.
 */
export function autoRefreshAction(s: {
  hidden: boolean
  busy: boolean
  atTop: boolean
  overlayOpen: boolean
  hasNew: boolean
}): AutoRefreshAction {
  if (s.hidden || s.busy) return 'skip'
  if (s.atTop && !s.overlayOpen) return 'refresh'
  return s.hasNew ? 'skip' : 'peek'
}

/**
 * 偷看到的最新一条是不是列表里还没有的新记录：时间不早于当前第一条，且 key 不在列表里——
 * 列表里的行和它们的 children 都算。合并是按页做的（连续的自动追踪合成一行 t:<id>），偷看
 * 只取 1 条、合并不了，回来的是同一笔的 o:<id>，它就是那一组的 children[0]，不是新记录。
 * 状态变化（处理中 → 成交）也不换 key，不算新记录。
 * Whether the peeked newest row is something the list doesn't show yet: no earlier than the
 * current top, and a key found neither among the rows nor their children. Merging happens
 * per page (consecutive trailing moves become one t:<id> row); a limit=1 peek can't merge
 * and returns the same move as o:<id>, which is that group's children[0] — not new. A status
 * change (pending → filled) keeps its key and is not new either.
 */
export function isNewer(peekTop: ActivityItem | undefined, current: readonly ActivityItem[]): boolean {
  if (!peekTop) return false
  const top = current[0]
  if (!top) return true
  if (peekTop.ts < top.ts) return false
  for (const it of current) {
    if (it.key === peekTop.key) return false
    if ((it.children ?? []).some((c) => c.key === peekTop.key)) return false
  }
  return true
}

/**
 * 「加载更多」能不能点：刷新进行中不行——刷新会换掉第一页和游标，拿旧游标取的下一页拼到
 * 新的第一页后面，中间会漏掉几行，而且看不出来。
 * Whether "load more" may run: not while a refresh is in flight — the refresh replaces the
 * first page and the cursor, and a page fetched with the old cursor appended to the new
 * first page silently skips the rows in between.
 */
export function canLoadMore(s: { next: string | null; loadingMore: boolean; refreshing: boolean }): boolean {
  return !!s.next && !s.loadingMore && !s.refreshing
}

/**
 * 「加载更多」回来时还认不认：发出时用的游标已经被刷新换掉，就丢掉这一页（理由同上）。
 * 刷新拿回同一个第一页时游标没变，照常接上。
 * Whether a "load more" result still applies: drop it when a refresh has replaced the cursor
 * it was fetched with (same reason). A refresh that returned the same first page keeps the
 * cursor, so the page is still accepted.
 */
export function acceptLoadMore(cursorSent: string, cursorNow: string | null): boolean {
  return cursorSent === cursorNow
}

/**
 * 首屏 / 刷新失败怎么告诉人：首屏、或者页面本来就停在「没加载出来」，就更新那一整块（不弹
 * 提示——自动刷新每分钟重试一次，弹窗会每分钟叠一条）；只有手上有旧列表时才弹一条提示。
 * How a failed load is reported: the first load, or any load while the page already shows
 * the error block, updates that block (no toast — the auto-refresh retries every minute and
 * would stack one per minute); only a refresh over a list that is still shown gets a toast.
 */
export function loadFailureReport(mode: 'initial' | 'refresh', phase: 'loading' | 'ready' | 'error'): 'block' | 'toast' {
  return mode === 'initial' || phase === 'error' ? 'block' : 'toast'
}

/** 后端把（去掉分隔符后）5–12 位纯数字先当 MT5 账号、再当手机号查（activity_feed._LOGIN_RE）。
 *  The backend reads 5–12 digits (separators dropped) as an MT5 login, then as a phone number. */
export function isLoginQuery(q: string): boolean {
  return /^\d{5,12}$/.test(queryDigits(q))
}

/**
 * 搜索词去掉空格 / 横线 / 括号 / 点之后的样子——后端（activity_feed._PHONE_SEP_RE）先这样
 * 处理再判断是不是纯数字：先按 MT5 账号查，没人持有这个账号就按手机号查。
 * The search text without spaces, dashes, brackets and dots — the backend
 * (activity_feed._PHONE_SEP_RE) normalises it this way before deciding it is all digits:
 * an MT5 login first, then a phone number when nobody holds that login.
 */
export function queryDigits(q: string): string {
  return q.trim().replace(/[\s\-().]/g, '')
}

/**
 * 这串数字是不是这个手机号（号码存 E.164，人手输入常常不带「+」区号、或带着本地的前导 0）：
 * 号码里包含它，或者去掉前导 0 之后是号码的结尾——与用户表搜索同一口径（admin.list_users）。
 * Whether the digits are this phone number (stored E.164, typed without the "+" country code
 * or with a local leading 0): contained in the number, or its tail once leading zeros go —
 * the same rule as the users-table search (admin.list_users).
 */
export function phoneMatches(q: string, phone: string | null | undefined): boolean {
  const digits = (phone ?? '').replace(/\D/g, '')
  const typed = q.replace(/\D/g, '')
  if (!digits || !typed) return false
  const tail = typed.replace(/^0+/, '')
  return digits.includes(typed) || (!!tail && digits.endsWith(tail))
}

// ---- 记住上次的分类与自动刷新开关（只是本机的方便，读写失败当没有）----
// ---- Remembered category and auto-refresh (a per-device convenience; failures read as unset) ----
const PREFS_KEY = 'prismx_admin_activity_prefs'
const CATS: ActivityCatFilter[] = ['all', 'account', 'mt5', 'trade', 'admin']
const SUBS: ActivitySub[] = ['all', 'open_close', 'sltp']

export interface ActivityPrefs {
  cat: ActivityCatFilter
  sub: ActivitySub
  auto: boolean
}

export const DEFAULT_PREFS: ActivityPrefs = { cat: 'all', sub: 'all', auto: false }

/** 读不到、读到旧格式或被手改坏的值，一律逐项退回默认。/ Anything unreadable falls back per field. */
export function readPrefs(): ActivityPrefs {
  const raw = readJson<Partial<Record<keyof ActivityPrefs, unknown>> | null>(PREFS_KEY, null)
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFS
  return {
    cat: CATS.includes(raw.cat as ActivityCatFilter) ? (raw.cat as ActivityCatFilter) : DEFAULT_PREFS.cat,
    sub: SUBS.includes(raw.sub as ActivitySub) ? (raw.sub as ActivitySub) : DEFAULT_PREFS.sub,
    auto: raw.auto === true,
  }
}

export function writePrefs(p: ActivityPrefs): void {
  writeJson(PREFS_KEY, p)
}
