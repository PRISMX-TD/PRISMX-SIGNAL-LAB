// 记住用户上次下单用的 MT5 账户，下次打开下单界面默认选中它。
//
// 走 usePrefs 而不是直接写 localStorage：这套偏好是按用户存在后端的，换设备、
// 换浏览器都还在，并且有 WS 推送做多端同步。localStorage 只是它的离线兜底缓存，
// 所以首帧就能读到值，不必等云端加载完（否则每次打开都会先闪一下默认账户）。
//
// 只在**用户主动选择**时记忆。自动兜底（选中的账户掉线、被解绑而回落到第一个）
// 绝不能写进去——否则用户偏好的账户临时掉线一次，记忆就被冲掉了，等它回来也不会
// 再被默认选中。所以调用方要区分「用户点了下拉」和「代码自己纠正」两条路径。
//
// Remembers the MT5 account last used for ordering so the next order UI defaults
// to it. Backed by usePrefs (server-side, per user, synced across devices) rather
// than raw localStorage, with prefs' own localStorage cache making it readable on
// the first frame. Only *explicit* user picks are recorded: an automatic fallback
// (selected account went offline or got unbound) must never overwrite the memory,
// or one transient dropout would erase the preference for good.
import { useCallback } from 'react'
import { usePrefs } from '../store/prefs'
import type { MT5Account } from '../api/types'

const NS = 'trade'
const KEY = 'lastAccount'

export function useLastAccount() {
  const { getPref, setPref } = usePrefs()
  const lastLogin = getPref<string>(NS, KEY, '')

  const rememberAccount = useCallback(
    (login: string) => {
      if (login) setPref(NS, KEY, login)
    },
    [setPref],
  )

  return { lastLogin, rememberAccount }
}

/** 从候选账户里挑默认项：上次用过的还在就用它，否则退回第一个。
 *  Pick the default account: last used if still available, else the first one. */
export function pickDefaultAccount(accounts: MT5Account[], lastLogin: string): string {
  if (lastLogin && accounts.some((a) => a.login === lastLogin)) return lastLogin
  return accounts[0]?.login ?? ''
}
