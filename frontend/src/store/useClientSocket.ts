// 前端 WebSocket Hook：接收信号/订单/EA 状态推送。
// Client WebSocket hook: receive signal/order/EA-status pushes.
import { useEffect, useRef } from 'react'
import { getToken } from '../api/client'
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
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws/client?token=${token}`)

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WSMessage
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
