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
    const token = getToken()
    if (!token) return

    let ws: WebSocket | null = null
    let reconnectTimer: number | undefined
    let closed = false

    const connect = () => {
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
          // WS 鉴权失败：只停止重连，不强制登出。
          // WS 仅是实时推送通道，其鉴权失败不应清除登录态——登录态是否失效
          // 应只由 REST 的 401 决定（见 client.ts）。否则一旦 WS 协议/部署不一致，
          // 会把用户直接踢回登录页。
          // WS auth failure: just stop reconnecting; do NOT sign the user out.
          // The WS is only a push channel; session validity is decided solely by
          // REST 401s. Otherwise a WS protocol/deploy mismatch would kick the
          // user back to the login page.
          if (msg.type === 'AUTH_FAIL') {
            closed = true
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
