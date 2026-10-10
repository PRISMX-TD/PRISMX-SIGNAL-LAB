// 邮件链接里的一次性令牌（/reset-password?token=…、/verify-email?token=…）：读一次，立刻从
// 地址栏抹掉。
//
// 令牌留在地址栏里会顺着很多路子出去：第三方脚本上报的页面地址（Meta Pixel 的 dl 参数）、
// 浏览器历史与同步、截图、用户复制地址求助……抹掉之后，为了「刷新一下」还能用，令牌另存一份
// 在 sessionStorage（只在本标签页、只对同一路径生效），流程成功后由页面清掉。
//
// One-time tokens from mail links are read once and immediately removed from the address
// bar (they would otherwise leak via third-party page-URL reporting such as the Meta
// Pixel's `dl`, history sync, screenshots, copy-pasted URLs). A copy is kept in
// sessionStorage — this tab only, same path only — so a reload still works; the page
// clears it once the flow succeeds.
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

type Stored = { path: string; token: string }

const normPath = (p: string) => (p || '/').toLowerCase().replace(/\/+$/, '') || '/'

/** 去掉查询串里的 token 参数，其余参数原样保留；返回 '' 或以 ? 开头的串。
 *  Drops the token param, keeping the rest; returns '' or a string starting with '?'. */
export function stripTokenParam(search: string): string {
  const q = new URLSearchParams(search)
  q.delete('token')
  const rest = q.toString()
  return rest ? `?${rest}` : ''
}

export function readTokenParam(search: string): string {
  return (new URLSearchParams(search).get('token') || '').trim()
}

export function saveStoredToken(key: string, path: string, token: string): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ path: normPath(path), token } satisfies Stored))
  } catch {
    // 存储不可用：只是刷新后要重新点邮件链接 / storage unavailable: reload just needs the mail link again
  }
}

/** 只认同一路径存下的令牌（/forgot-password 不会捡到 /reset-password 的）。
 *  Only returns a token saved for the same path. */
export function loadStoredToken(key: string, path: string): string {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return ''
    const v = JSON.parse(raw) as Partial<Stored>
    return v && typeof v.token === 'string' && v.path === normPath(path) ? v.token : ''
  } catch {
    return ''
  }
}

export function clearStoredToken(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // 忽略 / ignore
  }
}

/**
 * 取当前页的 ?token=：有就存一份并用 replace 导航把它从地址栏去掉（路径、其余参数、hash 不变）；
 * 没有就用本标签页里同一路径存过的那份。返回 [令牌, 清除函数]——流程成功后调清除函数。
 * Reads ?token=, stashes it and replace-navigates it out of the URL (path, other params
 * and hash kept); otherwise falls back to the copy saved for this path in this tab.
 * Returns [token, clear]; call clear once the flow succeeds.
 */
export function useUrlToken(storageKey: string): [string, () => void] {
  const location = useLocation()
  const navigate = useNavigate()
  const [token, setToken] = useState(() => {
    const fromUrl = readTokenParam(location.search)
    if (fromUrl) {
      saveStoredToken(storageKey, location.pathname, fromUrl)
      return fromUrl
    }
    return loadStoredToken(storageKey, location.pathname)
  })

  useEffect(() => {
    if (!new URLSearchParams(location.search).has('token')) return
    const fromUrl = readTokenParam(location.search)
    if (fromUrl) {
      // 同一页里又换了一个链接（极少见）：以地址栏的新令牌为准。
      // A different link opened in place (rare): the URL's token wins.
      saveStoredToken(storageKey, location.pathname, fromUrl)
      setToken(fromUrl)
    }
    navigate(
      { pathname: location.pathname, search: stripTokenParam(location.search), hash: location.hash },
      { replace: true, state: location.state },
    )
  }, [location.search, location.pathname, location.hash, location.state, navigate, storageKey])

  const clear = useCallback(() => clearStoredToken(storageKey), [storageKey])
  return [token, clear]
}
