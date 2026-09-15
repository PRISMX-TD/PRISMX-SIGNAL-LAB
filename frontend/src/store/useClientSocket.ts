// 前端 WebSocket Hook：接收信号/订单/EA 状态推送。
// Client WebSocket hook: receive signal/order/EA-status pushes.
import { useEffect, useRef, useState } from 'react'
import { getToken, API_BASE } from '../api/client'
import type { WSMessage } from '../api/types'

// 应用层心跳。协议层的 ping/pong 由浏览器自动应答、页面 JS 看不见，所以它只能让
// **服务端**发现死连接；而出问题的是客户端这一侧——安卓 App 切后台再回前台，TCP 早被
// 运营商 NAT 或系统休眠掐断，`readyState` 却仍是 OPEN：onclose 永远不来，下面的重连
// 逻辑永远不触发，报价冻住、新信号一条都收不到（2026-09-15 两名用户反馈"同一台手机
// 网页有信号、App 没有"，根因就是这条僵尸连接；网页版每次打开都是新加载，撞不上）。
// 页面只有一种办法把僵尸认出来：定时发一帧 PING，时限内**一帧都没收到**就判死、主动
// 断开重连。判据是"有没有收到任何帧"而不是"有没有收到 PONG"——开市时报价每 1.5 秒
// 一帧，本身就是心跳；PONG 只在安静时段（周末、收市）补上这个空档。
//
// App-level heartbeat. Protocol ping/pong is answered by the browser and
// invisible to page JS, so it only lets the *server* spot dead sockets; the
// failing side is the client. An Android WebView resumed from the background may
// hold a socket whose TCP was long cut by carrier NAT or device sleep while
// readyState still reads OPEN: onclose never fires, the reconnect logic below
// never runs, quotes freeze and no new signal ever arrives (the 2026-09-15
// "web shows signals, app doesn't" reports; the web page is a fresh load every
// time and never hits it). The only way the page can tell a zombie from a quiet
// connection is to send a PING on a timer and drop the socket if *no frame at
// all* arrives within the deadline. Any frame counts, not just PONG — during
// market hours quotes tick every 1.5s and are the heartbeat; PONG only covers
// the silence of weekends and closed sessions.
const HEARTBEAT_INTERVAL_MS = 25_000
// PING 之后多久没收到任何帧就判死。10 秒对任何能用的网络都绰绰有余；再长只是让用户
// 多盯几秒冻住的报价。/ Silence after a PING that counts as dead. Ten seconds is
// ample on any usable network; longer just means staring at frozen quotes.
const HEARTBEAT_TIMEOUT_MS = 10_000
// 回到前台 / 网络恢复时用的探测时限。这一刻用户正看着屏幕，宁可判快一点：判错的代价
// 只是一次多余的重连，判慢的代价是几秒钟"看起来正常"的假数据。
// Probe deadline used on resume / network-back. The user is looking at the
// screen right now, so err on the fast side: a false positive costs one spare
// reconnect, a slow verdict costs seconds of plausible-looking stale data.
const RESUME_PROBE_TIMEOUT_MS = 5_000

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
    let heartbeatTimer: number | undefined
    let deadlineTimer: number | undefined
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

    const clearDeadline = () => {
      if (deadlineTimer) window.clearTimeout(deadlineTimer)
      deadlineTimer = undefined
    }

    const stopHeartbeat = () => {
      if (heartbeatTimer) window.clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
      clearDeadline()
    }

    // 僵尸连接的处置：不等 onclose（它正是不会来的那个事件），自己把这条连接判死。
    // 先摘掉旧连接的全部回调再 close()：浏览器对一条 TCP 已死的连接执行关闭握手可能
    // 拖很久，等它终于放弃时补发的 onclose 不能再影响新连接的状态。
    // Dealing with a zombie: don't wait for onclose (it is precisely the event
    // that won't come); declare the socket dead ourselves. Detach every callback
    // before close(): the browser may take a long time to give up the closing
    // handshake on a dead TCP connection, and the onclose it eventually fires
    // must not touch the state of the connection that replaced it.
    const dropDeadConnection = () => {
      const dead = ws
      ws = null
      stopHeartbeat()
      if (dead) {
        dead.onopen = null
        dead.onmessage = null
        dead.onclose = null
        dead.onerror = null
        try {
          dead.close()
        } catch {
          /* 已经关了 / already closed */
        }
      }
      setConnected(false)
      if (closed) return
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      attempt = 0
      connect()
    }

    // 发一帧 PING，并给出"时限内必须收到任何帧"的最后期限；任何一帧到达都会在
    // onmessage 里清掉这个期限。/ Send a PING and arm the "any frame must arrive
    // by then" deadline; any incoming frame clears it in onmessage.
    const probe = (timeoutMs: number) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ type: 'PING' }))
      } catch {
        // send 在 OPEN 态抛错本身就是坏了 / a throw while OPEN already means broken
        dropDeadConnection()
        return
      }
      clearDeadline()
      deadlineTimer = window.setTimeout(dropDeadConnection, timeoutMs)
    }

    const startHeartbeat = () => {
      stopHeartbeat()
      heartbeatTimer = window.setInterval(() => probe(HEARTBEAT_TIMEOUT_MS), HEARTBEAT_INTERVAL_MS)
    }

    // 有"情况变了"的明确信号时立即处理：网络恢复、或用户把页面切回前台。
    // 连接不在就立刻重连并清零退避；连接"看起来还在"（OPEN）则**不再直接相信它**——
    // 这正是僵尸连接最常出现的时刻——而是发一帧 PING 用更短的时限探一次，探不通
    // 就走 dropDeadConnection 重连。
    // Act at once on a definite "something changed" signal: the network came
    // back, or the user brought the page to the foreground. No connection →
    // reconnect now and reset backoff. A connection that *looks* alive (OPEN) is
    // no longer taken at its word — this is exactly when zombies show up — it
    // gets a PING with a short deadline instead, and dropDeadConnection handles
    // the failure.
    const reconnectNow = () => {
      if (closed) return
      if (ws && ws.readyState === WebSocket.CONNECTING) return
      if (ws && ws.readyState === WebSocket.OPEN) {
        probe(RESUME_PROBE_TIMEOUT_MS)
        return
      }
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
      const socket = new WebSocket(`${wsBase}/ws/client`)
      ws = socket

      socket.onopen = () => {
        // 首帧提交 JWT 鉴权 / submit JWT for auth as the first frame
        socket.send(JSON.stringify({ type: 'AUTH', token }))
      }

      socket.onmessage = (ev) => {
        // 任何一帧到达都证明连接活着，先清掉心跳期限再做别的。
        // Any frame proves the connection alive; clear the deadline before anything else.
        clearDeadline()
        try {
          const msg = JSON.parse(ev.data) as WSMessage
          // PONG 只为心跳而生，不交给业务层 / PONG exists only for the heartbeat
          if (msg.type === 'PONG') return
          // WS 鉴权失败：关闭并交给 onclose 用下一轮读到的新 token 重试，
          // 不强制登出、也不永久放弃——登录态是否失效只由 REST 的 401 决定
          // （见 client.ts）。真正登出时上面的"没有 token"分支会停止重连。
          // WS auth failure: close and let onclose retry with whatever fresh
          // token the next attempt reads; never sign the user out here and
          // never give up permanently — session validity is decided solely by
          // REST 401s. A real logout is caught by the "no token" branch above.
          if (msg.type === 'AUTH_FAIL') {
            socket.close()
            return
          }
          // 鉴权通过才算真正连上：onopen 只代表握手完成 / only AUTH_OK counts as connected;
          // onopen merely means the handshake finished
          if (msg.type === 'AUTH_OK') {
            setConnected(true)
            // 连上了才算这一轮重连成功，退避从头开始 / a successful round resets backoff
            attempt = 0
            startHeartbeat()
          }
          handlerRef.current(msg)
        } catch {
          /* ignore malformed */
        }
      }

      socket.onclose = () => {
        stopHeartbeat()
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
      stopHeartbeat()
      ws?.close()
    }
  }, [])

  return connected
}
