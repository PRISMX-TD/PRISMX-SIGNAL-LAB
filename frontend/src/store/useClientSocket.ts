// 前端 WebSocket Hook：接收信号/订单/EA 状态推送。
// Client WebSocket hook: receive signal/order/EA-status pushes.
import { useEffect, useRef, useState } from 'react'
import { getToken, API_BASE } from '../api/client'
import type { WSMessage } from '../api/types'
import { netQuality, pingPayload } from './netQuality'
import { reconnectDelay } from './reconnectBackoff'

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
// 心跳每 5 秒检查一次（以前 10 秒）。以前「10 秒一拍 + 10 秒时限」，僵尸连接最坏要
// 20 秒才认出来——对一个下单产品，20 秒冻住却看着正常的报价太久了。现在最坏约 10 秒。
// Heartbeat checks every 5s (was 10s). With "10s interval + 10s deadline" a zombie
// took up to 20s to be caught — far too long to stare at plausible frozen quotes in
// a trading product. Worst case is now ~10s.
const HEARTBEAT_INTERVAL_MS = 5_000
// PING 之后多久没收到任何帧就判死。PONG 在任何能用的网络上都是百毫秒级，5 秒仍留了
// 一个数量级的余量。/ Silence after a PING that counts as dead. A PONG takes
// hundreds of ms on any usable network; 5s still leaves an order of magnitude.
const HEARTBEAT_TIMEOUT_MS = 5_000
// PING 的频率不跟着翻倍：后端每收一帧 PING 都要写几次 Redis（连接质量统计，见
// backend services/net_quality.py），全站连接数一乘就不是小数。所以心跳拍子虽是 5 秒，
// 但**最近 5 秒内刚收到过帧**（开市时报价 1.5 秒一帧）且上一次 PING 不到 10 秒时，
// 这一拍就不发——连接刚被证明活着，再问一次没有信息量。于是开市时仍是约 10 秒一帧
// PING（顶栏延迟读数照旧新鲜），只有安静时段（收市、周末）才是 5 秒一帧。
// The PING rate is deliberately not doubled: every PING costs the backend a few
// Redis writes (connection-quality stats, backend services/net_quality.py), which
// multiplies across all connections. So although the heartbeat ticks every 5s, a
// tick skips the PING when a frame arrived within the last 5s (quotes tick every
// 1.5s in market hours) and the last PING is under 10s old — the socket was just
// proven alive. Market hours therefore stay at ~one PING per 10s (the header
// latency reading stays fresh); only quiet sessions go to one per 5s.
const PING_MIN_GAP_MS = 10_000
// 回到前台 / 网络恢复时用的探测时限。这一刻用户正看着屏幕，宁可判快一点：判错的代价
// 只是一次多余的重连（首次重连只等约 300ms），判慢的代价是几秒钟"看起来正常"的假数据。
// Probe deadline used on resume / network-back. The user is looking at the
// screen right now, so err on the fast side: a false positive costs one spare
// reconnect (~300ms first retry), a slow verdict costs seconds of plausible-looking
// stale data.
const RESUME_PROBE_TIMEOUT_MS = 3_000

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
    // 当前期限到点的时刻（performance.now()），没有期限时无意义。
    // When the pending deadline fires (performance.now()); meaningless without one.
    let deadlineAt = 0
    let closed = false
    // 连续重连次数，只用于计算退避间隔；鉴权成功后归零。
    // Consecutive reconnect count, used only to compute the backoff delay;
    // reset to zero once auth succeeds.
    let attempt = 0
    // 最近一帧 PING 的发出时间，PONG 回来时算往返 / when the last PING left, for RTT on PONG
    let pingSentAt: number | null = null
    // 最近一次收到任何帧 / 发出 PING 的时刻（performance.now()），给心跳判断「这一拍要不要发」。
    // When any frame last arrived / a PING last left, for the "ping this tick?" decision.
    let lastFrameAt = 0
    let lastPingAt = 0

    // 断线重连采用指数退避 + 抖动，而不是固定间隔。
    //
    // 固定 2 秒重试的问题不在单个页面，而在总量：后端故障时每个开着的标签页
    // 都在每 2 秒撞一次门，后端刚要恢复就被自家前端的重连洪峰再打垮一次。
    // 退避把这个洪峰摊平；抖动（±25%）则避免所有标签页卡在同一毫秒一起重试。
    //
    // 首次重试约 300ms、封顶 10 秒，具体见 reconnectBackoff.ts 的说明。真正长时间
    // 断线时，下面的 online / visibilitychange 监听会在网络恢复或用户切回页面的瞬间
    // 立刻重连，不必等退避计时器走完。
    //
    // Reconnect with exponential backoff + jitter instead of a fixed interval.
    // The problem with a flat 2s retry isn't any single page, it's the total:
    // during an outage every open tab knocks every 2 seconds, and the backend
    // gets flattened by its own frontend's reconnect surge just as it comes
    // back. Backoff spreads that surge out and jitter keeps tabs from retrying
    // on the same millisecond. First retry ~300ms, capped at 10s — see
    // reconnectBackoff.ts. For genuinely long outages, the online /
    // visibilitychange listeners below reconnect the instant the network
    // returns or the user comes back, without waiting out the timer.
    const scheduleReconnect = () => {
      if (closed) return
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      const delay = reconnectDelay(attempt)
      attempt += 1
      reconnectTimer = window.setTimeout(connect, delay)
    }

    const clearDeadline = () => {
      if (deadlineTimer) window.clearTimeout(deadlineTimer)
      deadlineTimer = undefined
    }

    // 给出"时限内必须收到任何帧"的期限，但**绝不把已有的期限往后推**。
    //
    // 以前每次 PING 都先清掉旧期限再重新计时。心跳间隔与时限同为 10 秒时，下一次
    // PING 总是恰好在旧期限到点前一刻到来，把它清掉、再往后推 10 秒——期限永远不会
    // 触发，僵尸连接也就永远认不出来（切回前台的 5 秒探测同理，常被下一次心跳顶掉）。
    // 现在只有"收到一帧"能清掉期限；新的 PING 只能把期限提前（比如切回前台的短时限），
    // 不能推迟。
    //
    // Arm the "some frame must arrive by then" deadline, but never push an existing
    // one later. Each PING used to clear and re-arm it; with a 10s interval equal to
    // the 10s timeout the next PING always landed just before the old deadline and
    // postponed it again, so it never fired and zombies were never caught (the 5s
    // resume probe was often overridden the same way). Now only an incoming frame
    // clears the deadline; a new PING may bring it forward, never push it back.
    const armDeadline = (timeoutMs: number) => {
      const due = performance.now() + timeoutMs
      if (deadlineTimer !== undefined && deadlineAt <= due) return
      clearDeadline()
      deadlineAt = due
      deadlineTimer = window.setTimeout(dropDeadConnection, timeoutMs)
    }

    const stopHeartbeat = () => {
      if (heartbeatTimer) window.clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
      clearDeadline()
      pingSentAt = null
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
      netQuality.setState('offline')
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

    // 发一帧 PING，并给出"时限内必须收到任何帧"的最后期限（见 armDeadline）；任何一帧
    // 到达都会在 onmessage 里清掉这个期限。/ Send a PING and arm the "any frame must
    // arrive by then" deadline (see armDeadline); any incoming frame clears it in onmessage.
    const probe = (timeoutMs: number) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ type: 'PING', ...pingPayload() }))
        pingSentAt = performance.now()
        lastPingAt = pingSentAt
      } catch {
        // send 在 OPEN 态抛错本身就是坏了 / a throw while OPEN already means broken
        dropDeadConnection()
        return
      }
      armDeadline(timeoutMs)
    }

    const startHeartbeat = () => {
      stopHeartbeat()
      heartbeatTimer = window.setInterval(() => {
        const now = performance.now()
        // 刚收到过帧、且 PING 不久前才发过：连接活着，这一拍不发（见 PING_MIN_GAP_MS）。
        // A frame just arrived and a PING went out recently: alive, skip this tick.
        if (now - lastFrameAt < HEARTBEAT_INTERVAL_MS && now - lastPingAt < PING_MIN_GAP_MS) return
        probe(HEARTBEAT_TIMEOUT_MS)
      }, HEARTBEAT_INTERVAL_MS)
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
      // 建新连接之前先把上一条彻底摘干净。
      //
      // 上面 reconnectNow 只挡了 CONNECTING 与 OPEN 两态；readyState 为 CLOSING(2)
      // 时会直接走到这里，而那条旧 socket 的 onclose 仍挂着——它最终关闭时会再跑一次
      // scheduleReconnect()，于是第二条连接被建出来，两条并存：报价与持仓重复入账、
      // 后端连接数翻倍。切前台叠加弱网时最容易撞上，而这恰好是 reconnectNow 被调用
      // 得最频繁的时刻。
      // 摘钩子的手法与 dropDeadConnection 同源：先卸四个回调再 close()，让浏览器对
      // 一条已死 TCP 拖很久的关闭握手无论何时结束，都影响不到接替它的那条连接。
      //
      // Fully detach the previous socket before opening a new one. reconnectNow
      // above only short-circuits on CONNECTING and OPEN; readyState CLOSING(2)
      // falls through to here while the old socket still has its onclose
      // attached — when it finally closes it runs scheduleReconnect() again and a
      // second connection appears alongside the first: duplicated quote and
      // position updates, double the backend connection count. Most likely on
      // resume over a weak network, which is exactly when reconnectNow fires most
      // often. Detaching mirrors dropDeadConnection: drop the four callbacks,
      // then close(), so however long the browser drags out the closing handshake
      // on a dead TCP connection, its eventual events cannot touch the socket
      // that replaced it.
      const previous = ws
      ws = null
      // 心跳与它的期限一并停掉：旧连接的期限计时器若在新连接握手期间到点，
      // 会调用 dropDeadConnection() 再建一条——正是这里要防的那件事本身。
      // Stop the heartbeat and its deadline too: if the old connection's deadline
      // timer fires while the new one is still handshaking it calls
      // dropDeadConnection() and opens yet another socket — the very thing this
      // block exists to prevent.
      stopHeartbeat()
      if (previous) {
        previous.onopen = null
        previous.onmessage = null
        previous.onclose = null
        previous.onerror = null
        try {
          previous.close()
        } catch {
          /* 已经关了 / already closed */
        }
      }

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
        // 挂载期间没有 token：这一轮不连，但**不封死**本实例。
        //
        // 以前这里置 closed = true，而 closed 是 effect 作用域里的一次性开关：置真
        // 之后 scheduleReconnect / reconnectNow / onclose 全部提前 return，这个 hook
        // 实例再也不会建立连接。目前靠"登出会跳路由、Layout 卸载、hook 重新挂载"兜
        // 住；哪天 Layout 变成不卸载的持久外壳（或登出后停在同一棵树上），表现就是
        // 静默无数据：没有报错、没有断线横幅，只是永远不更新。
        // 只 return 的话，下一次 online / visibilitychange / 退避计时器都会再试一次，
        // 那时若 token 已经回来（重新登录）就自然接上。
        //
        // No token this round: skip the attempt but do *not* seal this instance.
        // This used to set closed = true, and `closed` is a one-way switch in the
        // effect's scope — once true, scheduleReconnect / reconnectNow / onclose
        // all return early and this hook instance never connects again. Today
        // that's survivable only because signing out navigates, unmounts Layout
        // and remounts the hook; the day Layout becomes a persistent shell (or a
        // logout keeps the same tree alive) the symptom is silent staleness — no
        // error, no offline banner, just data that never updates again. Simply
        // returning lets the next online / visibilitychange / backoff tick retry,
        // which picks up a token that has come back in the meantime.
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
        lastFrameAt = performance.now()
        netQuality.touch()
        try {
          const msg = JSON.parse(ev.data) as WSMessage
          // PONG 只为心跳而生，不交给业务层 / PONG exists only for the heartbeat
          if (msg.type === 'PONG') {
            if (pingSentAt != null) netQuality.addSample(performance.now() - pingSentAt)
            pingSentAt = null
            return
          }
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
            netQuality.setState('online')
            startHeartbeat()
            // 连上立刻测一次，不让图标空等一拍 / measure right away instead of waiting a tick
            probe(HEARTBEAT_TIMEOUT_MS)
          }
          handlerRef.current(msg)
        } catch {
          /* ignore malformed */
        }
      }

      // onerror 不参与控制流——WebSocket 规范保证 error 之后必然跟一个 close，
      // 重连一律由 onclose 驱动，这里再调度一次只会建出多余的连接。它的作用是
      // 让「握手阶段就失败」留下痕迹：那种情况下 onclose 的 code/reason 通常是空的，
      // 开发期没有这一行就只剩浏览器控制台一条红字，读不出是哪条连接。
      // 刻意不写进 utils/pushDiag：那是推送链路的诊断格子（注册/订阅/上报），
      // 诊断面板按步骤渲染，混进一条 WebSocket 记录会让面板说不清自己在说什么。
      // onerror deliberately drives nothing: the spec guarantees a close event
      // follows every error, reconnects are driven solely by onclose, and
      // scheduling here too would just open spare sockets. It exists so a
      // handshake-stage failure leaves a trace — onclose usually carries an empty
      // code/reason in that case, and without this line there is nothing but one
      // red line in the browser console. Deliberately not written into
      // utils/pushDiag: that map holds the push pipeline's steps (register /
      // subscribe / report) and the diagnostics panel renders them by step, so a
      // WebSocket entry would muddle what the panel is reporting.
      socket.onerror = () => {
        if (import.meta.env.DEV) console.error('[ws] connection error', { readyState: socket.readyState })
      }

      socket.onclose = () => {
        stopHeartbeat()
        netQuality.setState('offline')
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
