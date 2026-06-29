// 前端 WebSocket Hook：接收信号/订单/EA 状态推送。
// Client WebSocket hook: receive signal/order/EA-status pushes.
import { useEffect, useRef } from 'react'
import { getToken, API_BASE, triggerUnauthorized } from '../api/client'
import type { WSMessage } from '../api/types'

export function useClientSocket(onMessage: (msg: WSMessage) => void) {
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage

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
          // 鉴权失败：token 失效，停止重连并登出，避免静默重连死循环。
          // Auth failed: token invalid; stop reconnecting and sign out to avoid a silent loop.
          if (msg.type === 'AUTH_FAIL') {
            closed = true
            triggerUnauthorized()
            ws?.close()
            return
          }
          handlerRef.current(msg)
        } catch {
          /* ignore malformed */
        }
      }

      ws.onclose = () => {
        if (!closed) {
          // 断线自动重连 / auto reconnect
          reconnectTimer = window.setTimeout(connect, 2000)
        }
      }
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])
}
