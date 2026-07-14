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
          if (msg.type === 'AUTH_OK') setConnected(true)
          handlerRef.current(msg)
        } catch {
          /* ignore malformed */
        }
      }

      ws.onclose = () => {
        setConnected(false)
        if (!closed) {
          // 断线自动重连 / auto reconnect
          reconnectTimer = window.setTimeout(connect, 2000)
        }
      }
    }

    connect()

    return () => {
      closed = true
      setConnected(false)
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  return connected
}
