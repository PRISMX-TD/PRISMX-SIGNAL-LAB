// 前端 WebSocket Hook：接收信号/订单/EA 状态推送。
// Client WebSocket hook: receive signal/order/EA-status pushes.
import { useEffect, useRef, useState } from 'react'
import { getToken, API_BASE } from '../api/client'
import type { WSMessage } from '../api/types'

// 返回当前 WebSocket 连接状态，供上层在断线时提示"数据可能已过时"。
// Returns the current WebSocket connection state, so callers can warn that
// quotes/positions may be stale while disconnected.
export function useClientSocket(onMessage: (msg: WSMessage) => void): boolean {
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!getToken()) return

    let ws: WebSocket | null = null
    let reconnectTimer: number | undefined
    let closed = false
    // 连续重连次数，只用于计算退避间隔；鉴权成功后归零。
    // Consecutive reconnect count, used only to compute the backoff delay;
    // reset to zero once auth succeeds.
    let attempt = 0

    // 断线重连采用指数退避 + 抖动，而不是固定间隔。
    //
    // 固定 2 秒重试的问题不在单个页面，而在总量：后端故障时每个开着的标签页
    // 都在每 2 秒撞一次门，后端刚要恢复就被自家前端的重连洪峰再打垮一次。
    // 退避把这个洪峰摊平；抖动（±25%）则避免所有标签页卡在同一毫秒一起重试。
    //
    // 首次重试仍然约 2 秒——用户感知到的"断一下就回来"没有变慢，只有连续失败
    // 才逐步退到 4/8/16/30 秒封顶。真正长时间断线时，下面的 online /
    // visibilitychange 监听会在网络恢复或用户切回页面的瞬间立刻重连，不必等
    // 退避计时器走完。
    //
    // Reconnect with exponential backoff + jitter instead of a fixed interval.
    // The problem with a flat 2s retry isn't any single page, it's the total:
    // during an outage every open tab knocks every 2 seconds, and the backend
    // gets flattened by its own frontend's reconnect surge just as it comes
    // back. Backoff spreads that surge out; the ±25% jitter keeps tabs from
    // retrying on the same millisecond. The first retry is still ~2s, so a
    // brief blip feels exactly as fast as before — only repeated failures back
    // off to a 30s ceiling. For genuinely long outages, the online /
    // visibilitychange listeners below reconnect the instant the network
    // returns or the user comes back, without waiting out the timer.
    const scheduleReconnect = () => {
      if (closed) return
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      const base = Math.min(30000, 2000 * 2 ** attempt)
      const delay = base * (0.75 + Math.random() * 0.5)
      attempt += 1
      reconnectTimer = window.setTimeout(connect, delay)
    }

    // 有"情况变了"的明确信号时立即重连：网络恢复、或用户把页面切回前台。
    // 退避的目的只是别在后端躺平时空转重试，一旦有理由相信这次会成功，就该
    // 马上试，并把退避计数清零。
    // Reconnect immediately on a definite "something changed" signal: the
    // network came back, or the user brought the tab to the foreground.
    // Backoff exists to avoid spinning against a dead backend; when there's
    // reason to believe this attempt will work, try at once and reset the count.
    const reconnectNow = () => {
      if (closed) return
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      attempt = 0
      connect()
    }

    const connect = () => {
      // 每次(重)连都重新读取 token，而不是在 effect 顶层读一次存进闭包。
      // 该 effect 只在挂载时跑一次（deps=[]），如果 token 只读一次，页面挂着
      // 超过 JWT 有效期（1 天）后，即便滑动续期早把 localStorage 里的 token
      // 换新了，这里重连时仍在用最初那个、此刻已真正过期的 token——鉴权必
      // 然失败，导致下面的分支永久停止重连，断线横幅却一直显示"正在重连"。
      // Re-read the token on every (re)connect instead of once at the top of
      // the effect. This effect only runs once on mount (deps=[]); if the
      // token were captured once, a page left open past the JWT lifetime
      // (1 day) would keep reconnecting with that original, now genuinely
      // expired token — even though sliding renewal has long since swapped in
      // a fresh one in localStorage. Auth would keep failing, permanently
      // stopping reconnects below, while the banner kept claiming otherwise.
      const token = getToken()
      if (!token) {
        // 挂载期间登出：没有 token 就不再尝试连接 / signed out while mounted: nothing to connect with
        closed = true
        return
      }

      // 优先用 VITE_API_BASE 指向的线上后端；未配置则回退到当前页面 host（开发期走代理）。
      // Prefer the backend from VITE_API_BASE; fall back to current host (dev proxy) when unset.
      let wsBase: string
      if (API_BASE) {
        wsBase = API_BASE.replace(/^http/, 'ws')
      } else {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        wsBase = `${proto}://${location.host}`
      }
      // 不再把 token 放进 URL（会被代理/网关日志记录），改为连接后发送首帧鉴权。
      // Don't put the token in the URL (logged by proxies/gateways); send an AUTH frame after connect.
      ws = new WebSocket(`${wsBase}/ws/client`)

      ws.onopen = () => {
        // 首帧提交 JWT 鉴权 / submit JWT for auth as the first frame
        ws?.send(JSON.stringify({ type: 'AUTH', token }))
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WSMessage
          // WS 鉴权失败：关闭并交给 onclose 用下一轮读到的新 token 重试，
          // 不强制登出、也不永久放弃——登录态是否失效只由 REST 的 401 决定
          // （见 client.ts）。真正登出时上面的"没有 token"分支会停止重连。
          // WS auth failure: close and let onclose retry with whatever fresh
          // token the next attempt reads; never sign the user out here and
          // never give up permanently — session validity is decided solely by
          // REST 401s. A real logout is caught by the "no token" branch above.
          if (msg.type === 'AUTH_FAIL') {
            ws?.close()
            return
          }
          // 鉴权通过才算真正连上：onopen 只代表握手完成 / only AUTH_OK counts as connected;
          // onopen merely means the handshake finished
          if (msg.type === 'AUTH_OK') {
            setConnected(true)
            // 连上了才算这一轮重连成功，退避从头开始 / a successful round resets backoff
            attempt = 0
          }
          handlerRef.current(msg)
        } catch {
          /* ignore malformed */
        }
      }

      ws.onclose = () => {
        setConnected(false)
        if (!closed) scheduleReconnect()
      }
    }

    const handleOnline = () => reconnectNow()
    const handleVisibility = () => {
      if (!document.hidden) reconnectNow()
    }
    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisibility)

    connect()

    return () => {
      closed = true
      setConnected(false)
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  return connected
}
