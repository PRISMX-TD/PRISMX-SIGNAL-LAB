// 操作日志列表的纯逻辑：翻页拼接（去重 + 重排）、自动刷新的门槛、本机记住的分类与开关。
// Pure list logic: page merging (dedupe + re-sort), the auto-refresh gate, remembered prefs.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityItem } from '../../../api/types'
import {
  DEFAULT_PREFS, acceptLoadMore, autoRefreshAction, canLoadMore, isLoginQuery, isNewer, loadFailureReport, mergePage, phoneMatches,
  queryDigits, readPrefs, sortByTs, withChildren, writePrefs,
} from './feedState'

const row = (key: string, ts: string): ActivityItem => ({
  key,
  ts,
  at: null,
  cat: 'trade',
  kind: 'trade.open',
  params: {},
  status: 'ok',
  tags: [],
  abnormal: false,
  actor: { type: 'self', id: null, name: null, email: null },
  user: null,
  users_count: null,
  login: null,
  account: null,
  children: null,
})

describe('mergePage', () => {
  it('下一页里比本页末尾稍新的行插回正确位置，重复的 key 丢掉 / slightly newer rows re-sorted, repeats dropped', () => {
    const page1 = [row('o:3', '2026-10-09T06:00:03.000000Z'), row('o:2', '2026-10-09T06:00:02.000000Z')]
    // 契约 §1.1：下一页可能带比本页末尾稍新的别的源的行 / a later page may hold slightly newer rows
    const page2 = [row('a:9', '2026-10-09T06:00:02.500000Z'), row('o:2', '2026-10-09T06:00:02.000000Z'), row('o:1', '2026-10-09T06:00:01.000000Z')]
    expect(mergePage(page1, page2).map((r) => r.key)).toEqual(['o:3', 'a:9', 'o:2', 'o:1'])
  })
  it('同一时间戳保持后端给的顺序 / equal timestamps keep the backend order', () => {
    const ts = '2026-10-09T06:00:00.000000Z'
    expect(sortByTs([row('u:1', ts), row('e:1', ts), row('o:1', ts)]).map((r) => r.key)).toEqual(['u:1', 'e:1', 'o:1'])
  })
})

describe('withChildren（合并行就地展开 / expanding merged rows in place）', () => {
  it('只展开选中的那一行，children 紧跟其后 / only the expanded row, children right after it', () => {
    const group = { ...row('e:ca', '2026-10-09T06:00:05.000000Z'), children: [row('o:c1', '2026-10-09T06:00:01.000000Z'), row('o:c2', '2026-10-09T06:00:02.000000Z')] }
    const other = { ...row('s:so', '2026-10-09T06:00:04.000000Z'), children: [row('d:x', '2026-10-09T06:00:03.000000Z')] }
    const plain = row('o:1', '2026-10-09T06:00:00.000000Z')
    const collapsed = withChildren([group, other, plain], new Set())
    expect(collapsed.map((r) => r.key)).toEqual(['e:ca', 's:so', 'o:1'])
    const open = withChildren([group, other, plain], new Set(['e:ca']))
    expect(open.map((r) => [r.key, r.child])).toEqual([
      ['e:ca', false],
      ['e:ca>o:c1', true],
      ['e:ca>o:c2', true],
      ['s:so', false],
      ['o:1', false],
    ])
    expect(open[1].item.key).toBe('o:c1')
    expect(open[1].parent.key).toBe('e:ca')
  })
})

describe('autoRefreshAction', () => {
  const base = { hidden: false, busy: false, atTop: true, overlayOpen: false, hasNew: false }
  it('可见 + 在顶部 + 没开详情 → 真刷新 / visible, at top, no drawer → refresh', () => {
    expect(autoRefreshAction(base)).toBe('refresh')
  })
  it('页面在后台、或上一次还没回来 → 什么都不做 / hidden or busy → skip', () => {
    expect(autoRefreshAction({ ...base, hidden: true })).toBe('skip')
    expect(autoRefreshAction({ ...base, busy: true })).toBe('skip')
    expect(autoRefreshAction({ ...base, hidden: true, atTop: false })).toBe('skip')
  })
  it('不在顶部或详情开着 → 只偷看，亮过提示就不再看 / not at top or drawer open → peek, once', () => {
    expect(autoRefreshAction({ ...base, atTop: false })).toBe('peek')
    expect(autoRefreshAction({ ...base, overlayOpen: true })).toBe('peek')
    expect(autoRefreshAction({ ...base, atTop: false, hasNew: true })).toBe('skip')
    expect(autoRefreshAction({ ...base, overlayOpen: true, hasNew: true })).toBe('skip')
  })
  it('isNewer：出现了新 key 才算，状态变化不算 / only a new key counts, not a status change', () => {
    const top = row('o:2', '2026-10-09T06:00:02.000000Z')
    expect(isNewer(undefined, [top])).toBe(false)
    expect(isNewer(top, [])).toBe(true)
    expect(isNewer({ ...top, status: 'fail' }, [top])).toBe(false)
    expect(isNewer(row('e:7', '2026-10-09T06:00:05.000000Z'), [top])).toBe(true)
    expect(isNewer(row('e:7', '2026-10-09T06:00:01.000000Z'), [top])).toBe(false)
  })
  it('isNewer：偷看拿回的是合并追踪组里的那一笔（o:X 对 t:X）不算新 / the peeked o:X of a merged t:X trail is not new', () => {
    // 合并是按页做的：列表第一行是 t:X（children[0] 保留 o:X），limit=1 的偷看合并不了，回来 o:X、同一时刻
    // Merging is per page: the list's top is t:X (children[0] keeps o:X); a limit=1 peek can't merge and returns o:X at the same ts
    const T = '2026-10-09T06:02:00.000000Z'
    const trail = {
      ...row('t:X', T),
      kind: 'auto.sl',
      children: [row('o:X', T), row('o:W', '2026-10-09T06:01:00.000000Z'), row('o:V', '2026-10-09T06:00:00.000000Z')],
    }
    const list = [trail, row('o:1', '2026-10-09T05:59:00.000000Z')]
    expect(isNewer(row('o:X', T), list)).toBe(false)
    // 真的来了新的一笔（更晚的 o:Y）照样亮 / a genuinely newer move still lights the pill
    expect(isNewer(row('o:Y', '2026-10-09T06:03:00.000000Z'), list)).toBe(true)
    // 同一时刻、列表里没有的别的源的行也算新 / a same-ts row from another source the list lacks is new
    expect(isNewer(row('a:9', T), list)).toBe(true)
  })
})

describe('加载更多与刷新 / load more vs refresh', () => {
  it('刷新进行中不能加载更多 / no load more while a refresh is in flight', () => {
    expect(canLoadMore({ next: 'c1', loadingMore: false, refreshing: false })).toBe(true)
    expect(canLoadMore({ next: 'c1', loadingMore: false, refreshing: true })).toBe(false)
    expect(canLoadMore({ next: 'c1', loadingMore: true, refreshing: false })).toBe(false)
    expect(canLoadMore({ next: null, loadingMore: false, refreshing: false })).toBe(false)
  })
  it('游标被刷新换掉之后回来的那一页丢掉；刷新拿回同一个第一页时照常接上 / a page fetched with a replaced cursor is dropped', () => {
    // 第一页 A 的游标 c1；刷新期间来了新记录，新的第一页 A′ 的游标是 c1′——按 c1 取的下一页拼上去会漏行
    // Page A had cursor c1; new rows arrived during a refresh, A′ has c1′ — a page fetched with c1 would leave a gap
    expect(acceptLoadMore('c1', 'c1′')).toBe(false)
    expect(acceptLoadMore('c1', null)).toBe(false)
    expect(acceptLoadMore('c1', 'c1')).toBe(true)
  })
})

describe('读取失败怎么提示 / how a failed load is reported', () => {
  it('停在错误块上时自动刷新再失败不弹提示，只更新那一块 / a failed retry over the error block updates the block, no toast', () => {
    expect(loadFailureReport('refresh', 'error')).toBe('block')
    expect(loadFailureReport('initial', 'loading')).toBe('block')
    // 手上有旧列表：保留列表、弹一条提示 / a list is still shown: keep it, one toast
    expect(loadFailureReport('refresh', 'ready')).toBe('toast')
  })
})

describe('纯数字搜索 / digits-only search', () => {
  it('5–12 位纯数字按 MT5 账号查（与后端 _LOGIN_RE 一致）/ 5–12 digits are an MT5 login, as in the backend', () => {
    expect(isLoginQuery('62345678')).toBe(true)
    expect(isLoginQuery(' 13800138000 ')).toBe(true)
    expect(isLoginQuery('1234')).toBe(false)
    expect(isLoginQuery('1234567890123')).toBe(false)
    expect(isLoginQuery('+8613800138000')).toBe(false)
    expect(isLoginQuery('meilin')).toBe(false)
  })
  it('分隔符与后端同样去掉 / separators are dropped exactly as the backend does', () => {
    expect(isLoginQuery('138 0013 8000')).toBe(true)
    expect(isLoginQuery('6234-5678')).toBe(true)
    expect(isLoginQuery('(012) 345.6789')).toBe(true)
    expect(isLoginQuery('138 0013 8000 12')).toBe(false)
    expect(isLoginQuery('+86 138 0013 8000')).toBe(false)
    expect(queryDigits(' (012) 345-67.89 ')).toBe('0123456789')
  })
  it('不带「+」、带本地前导 0 的手机号也对得上 / phone numbers typed without the "+" or with a local leading 0', () => {
    expect(phoneMatches('13800138000', '+8613800138000')).toBe(true)
    expect(phoneMatches('0123456789', '+60123456789')).toBe(true)
    expect(phoneMatches('60123456789', '+60123456789')).toBe(true)
    expect(phoneMatches('13800138000', '+8613900139000')).toBe(false)
    expect(phoneMatches('13800138000', null)).toBe(false)
    expect(phoneMatches('00000', '+60123456789')).toBe(false)
  })
})

describe('readPrefs / writePrefs', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubStorage = () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
    return store
  }

  it('写了再读回来 / round trip', () => {
    stubStorage()
    writePrefs({ cat: 'trade', sub: 'sltp', auto: true })
    expect(readPrefs()).toEqual({ cat: 'trade', sub: 'sltp', auto: true })
  })
  it('坏值逐项退回默认 / bad values fall back per field', () => {
    const store = stubStorage()
    store.set('prismx_admin_activity_prefs', JSON.stringify({ cat: 'nope', sub: 'sltp', auto: 'yes' }))
    expect(readPrefs()).toEqual({ cat: 'all', sub: 'sltp', auto: false })
    store.set('prismx_admin_activity_prefs', '{not json')
    expect(readPrefs()).toEqual(DEFAULT_PREFS)
  })
  it('存储被禁用时不抛、按默认 / blocked storage never throws', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
    })
    expect(readPrefs()).toEqual(DEFAULT_PREFS)
    expect(() => writePrefs({ cat: 'admin', sub: 'all', auto: true })).not.toThrow()
  })
})
