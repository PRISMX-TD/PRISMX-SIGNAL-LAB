//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 查询通道(第二条及以上的 Manager 连接)       |
//|                                                                  |
//| 为什么要有:交易连接只有一条,所有 SDK 调用在 Mt5Link._gate 上排队。|
//| 后端给每个在线网关用户定时拉持仓(2 秒)、成交(3 秒)、挂单(5 秒)、 |
//| 资金(15 秒),每次都是一趟服务器往返(实盘几百毫秒),全程攥着 _gate |
//| ——实盘日志里下单在账号检查那一步干等 755ms,就是在等这些查询。    |
//| 在线用户一多,交易连接会被查询整个占满。                          |
//|                                                                  |
//| 做法:另开 N 条只做查询的连接(不开 pump、不开 dealer),各自一把锁。|
//| 查询走这里,交易连接的 _gate 只剩交易本身。任何一条查询连接不可用、|
//| 或者查询回了网络类错误,调用方退回交易连接照旧执行——功能不会因为 |
//| 这层优化而少一分,最差就是回到改造前的样子。                      |
//|                                                                  |
//| Why: there is one trading connection and every SDK call queues on |
//| Mt5Link._gate. The backend polls positions/deals/orders/funds for |
//| every online gateway user, each a server round trip held under    |
//| _gate — live logs showed orders waiting 755ms behind them. These  |
//| extra connections (no pump, no dealer, one lock each) carry the   |
//| queries so _gate is left to trading. Any unavailable channel or   |
//| network-class error falls back to the trading connection.         |
//+------------------------------------------------------------------+
using System;
using System.Threading;
using MetaQuotes.MT5CommonAPI;
using MetaQuotes.MT5ManagerAPI;

namespace Prismx.Mt5Gateway
{
    /// <summary>一条查询连接。/ One query-only Manager connection.</summary>
    internal sealed class ReadChannel : IDisposable
    {
        private sealed class Sink : CIMTManagerSink
        {
            private readonly ReadChannel _owner;

            public Sink(ReadChannel owner)
            {
                _owner = owner;
            }

            // 原生层回调:整段包住,异常绝不能漏回原生代码。
            // Native callbacks: wrapped whole, nothing may escape into native code.
            public override void OnConnect()
            {
                try { _owner._connected = true; }
                catch { }
            }

            public override void OnDisconnect()
            {
                try
                {
                    if (_owner._connected)
                        Log.Warn("查询通道 #{0} 连接断开,查询暂回交易连接,稍后重连", _owner._id);
                    _owner._connected = false;
                }
                catch { }
            }
        }

        private const uint ConnectTimeoutMs = 15000;

        private readonly Config _cfg;
        private readonly int _id;

        /// <summary>这条连接自己的锁,与交易连接的 _gate 无关。/ This channel's own lock.</summary>
        internal readonly object Gate = new object();

        private CIMTManagerAPI _manager;
        private Sink _sink;
        private volatile bool _connected;
        private int _nextRetryAt;
        private int _retryDelaySec = 5;
        private bool _loggedDown;

        /// <summary>
        /// 这条通道最近一次确认"服务器回过话"的时刻:连上、一次查询用完仍是连着的
        /// (调用方只在网络类错误时 MarkBroken)、或存活探测成功。
        /// Last proof of a server round trip: connect, a query released while still
        /// connected (callers MarkBroken only on network-class errors), or a probe.
        /// </summary>
        private volatile int _lastOkAt;

        /// <summary>
        /// 空闲这么久没有任何查询经过,才做一次存活探测。查询通道和交易连接一样会
        /// 半开,而它空闲时没有查询替它发现;但探测是一次真实的服务器请求,券商对
        /// manager 请求有频率限制,忙的时候查询本身就是探测,不必再加。
        /// Probe only after this much idle time. Query channels can go half-open too,
        /// and an idle one has no query to notice; but a probe is a real server request
        /// against a rate-limited manager login, and a busy channel's queries already
        /// serve as probes.
        /// </summary>
        private const int ProbeIdleMs = 30000;

        /// <summary>当前持锁者拿到 Gate 的时刻,供 Acquire 判断"是不是卡在一次超时里"。
        /// 由 ReadPool 在持锁时写。/ When the current holder took Gate; written by ReadPool
        /// under Gate so Acquire can tell a stuck holder from a busy one.</summary>
        internal volatile int HeldSince;

        public ReadChannel(Config cfg, int id)
        {
            _cfg = cfg;
            _id = id;

            // 必须从"现在"起算,不能留默认的 0:Environment.TickCount 在开机约 24.9 天后
            // 变成负数,TickCount - 0 < 0 会被当成"还没到重试时间",于是永远不去连
            // ——实盘 VPS 上正是这样,两条通道一次都没尝试,日志里也没有任何报错。
            // Must start from "now", not 0: TickCount goes negative after ~24.9 days of
            // uptime, and TickCount - 0 < 0 then reads as "not yet" forever — exactly
            // what happened on the live VPS, silently.
            _nextRetryAt = Environment.TickCount;
            _lastOkAt = Environment.TickCount;
            HeldSince = Environment.TickCount;
        }

        public bool IsConnected
        {
            get { return _connected; }
        }

        /// <summary>调用方须持有 Gate。/ Caller holds Gate.</summary>
        internal CIMTManagerAPI Manager
        {
            get { return _manager; }
        }

        /// <summary>
        /// 由查询通道自己的维护线程每秒调一次(Mt5Link.ReadPoolLoop,不占 watchdog):没连上
        /// 就按退避重试。只拿自己的锁,不碰 _gate。
        /// Called every second by the query-channel keeper thread (Mt5Link.ReadPoolLoop,
        /// not the watchdog); reconnects with back-off under this channel's own lock only.
        /// </summary>
        public void Maintain()
        {
            if (_connected)
            {
                ProbeIfIdle();
                return;
            }

            if (unchecked(Environment.TickCount - _nextRetryAt) < 0)
                return;

            // 拿不到锁说明有查询正在用它(比如正卡在一次超时里),下一秒再说。
            // Busy with a query (maybe mid-timeout); try again next second.
            if (!Monitor.TryEnter(Gate))
                return;

            try
            {
                MTRetCode res = ConnectLocked();

                if (res == MTRetCode.MT_RET_OK)
                {
                    _connected = true;
                    _lastOkAt = Environment.TickCount;
                    _retryDelaySec = 5;
                    _loggedDown = false;
                    Log.Info("查询通道 #{0} 已连接", _id);
                }
                else
                {
                    // 只在第一次失败时记 WARN,之后退避重试不刷屏;鉴权类错误退到 5 分钟,
                    // 免得被券商按反复登录失败封掉。
                    // Warn once, then back off quietly; auth errors back off to 5 min.
                    if (!_loggedDown)
                    {
                        _loggedDown = true;
                        Log.Warn("查询通道 #{0} 连接失败:{1} {2}(查询继续走交易连接,后台重试)",
                            _id, res, Mt5Link.DescribeConnectError(res));
                    }

                    bool auth = res.ToString().StartsWith("MT_RET_AUTH") ||
                        res == MTRetCode.MT_RET_ERR_PERMISSIONS;
                    _retryDelaySec = auth ? 300 : Math.Min(_retryDelaySec * 2, 60);
                    _nextRetryAt = unchecked(Environment.TickCount + _retryDelaySec * 1000);
                }
            }
            catch (Exception ex)
            {
                if (!_loggedDown)
                {
                    _loggedDown = true;
                    Log.Warn("查询通道 #{0} 连接异常:{1}", _id, ex.Message);
                }
                _nextRetryAt = unchecked(Environment.TickCount + 60000);
            }
            finally
            {
                Monitor.Exit(Gate);
            }
        }

        /// <summary>
        /// 轻量存活探测:空闲超过 ProbeIdleMs 才做,查一次 manager 自己的用户记录
        /// (与交易连接的半开探测同一个请求;这条连接不开 pump,本地没有可读的缓存,
        /// 每个查询都是服务器往返)。只有网络/连接/超时类错误判死——业务错误说明服务器
        /// 在回话。通道正被查询占着就不探:它忙就说明有人在用,用的结果自会说明死活。
        /// Idle-only liveness probe: the same UserRequest the trading link uses (this
        /// connection has no pump, so every query is a server round trip). Only network
        /// class errors count as dead. Skipped while a query holds the channel.
        /// </summary>
        private void ProbeIfIdle()
        {
            if (unchecked(Environment.TickCount - _lastOkAt) < ProbeIdleMs)
                return;

            if (!Monitor.TryEnter(Gate))
                return;

            HeldSince = Environment.TickCount;

            try
            {
                if (!_connected || _manager == null)
                    return;

                MTRetCode r;
                using (CIMTUser u = _manager.UserCreate())
                {
                    r = _manager.UserRequest(_cfg.ManagerLogin, u);
                }

                string code = r.ToString();
                if (code.Contains("NETWORK") || code.Contains("CONNECTION") || code.Contains("TIMEOUT"))
                    MarkBroken(r);
                else
                    _lastOkAt = Environment.TickCount;
            }
            catch (Exception ex)
            {
                if (_connected)
                    Log.Warn("查询通道 #{0} 存活探测异常:{1}", _id, ex.Message);
                MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
            }
            finally
            {
                Monitor.Exit(Gate);
            }
        }

        /// <summary>一次查询用完、通道仍连着:记为一次成功往返。调用方持 Gate。
        /// A query finished and the channel is still up: counts as a round trip.</summary>
        internal void NoteReleased()
        {
            if (_connected)
                _lastOkAt = Environment.TickCount;
        }

        private MTRetCode ConnectLocked()
        {
            if (_manager == null)
            {
                MTRetCode cres;
                _manager = SMTManagerAPIFactory.CreateManager(
                    SMTManagerAPIFactory.ManagerAPIVersion, out cres);

                if (_manager == null || cres != MTRetCode.MT_RET_OK)
                {
                    _manager = null;
                    return cres == MTRetCode.MT_RET_OK ? MTRetCode.MT_RET_ERR_MEM : cres;
                }

                _sink = new Sink(this);
                _manager.Subscribe(_sink);
            }
            else
            {
                // 先彻底断开旧会话再连,理由同交易连接的重连。
                // Tear down the old session first, as the trading reconnect does.
                try { _manager.Disconnect(); }
                catch { }
            }

            // 只做请求-应答式查询,不需要服务器推任何数据。
            // Request/response queries only; nothing needs to be pumped.
            return _manager.Connect(_cfg.Server, _cfg.ManagerLogin, _cfg.ManagerPassword,
                null, CIMTManagerAPI.EnPumpModes.PUMP_MODE_NONE, ConnectTimeoutMs);
        }

        /// <summary>查询回了网络类错误:判这条连接坏了,交给 Maintain 重连。调用方持 Gate。
        /// A network-class error: mark broken for Maintain to reconnect. Caller holds Gate.</summary>
        internal void MarkBroken(MTRetCode why)
        {
            if (_connected)
                Log.Warn("查询通道 #{0} 查询返回 {1},判定断开,稍后重连", _id, why);

            _connected = false;
            _nextRetryAt = unchecked(Environment.TickCount + 2000);
        }

        public void Dispose()
        {
            lock (Gate)
            {
                _connected = false;

                if (_manager == null)
                    return;

                try
                {
                    if (_sink != null)
                        _manager.Unsubscribe(_sink);
                    _manager.Disconnect();
                    _manager.Dispose();
                }
                catch { }

                _manager = null;
            }
        }
    }

    /// <summary>
    /// 查询通道池。Acquire 挑一条空闲且已连接的;都忙就在它们上面限时排队;一条都没连上、
    /// 或连着的全被卡住的查询攥着,返回 null,调用方退回交易连接。
    /// Pool of query channels. Acquire picks an idle connected one, waits on them for a
    /// bounded time if all are busy, or returns null (none connected, or every connected
    /// one held by a stuck query) so the caller falls back to the trading link.
    /// </summary>
    internal sealed class ReadPool : IDisposable
    {
        private readonly ReadChannel[] _channels;
        private int _rr;

        /// <summary>
        /// 都忙时每条通道每次试等的时长。原来是 Monitor.Enter 无限期等:一条通道卡在
        /// 一次网络超时里(半开时每个查询要等满 SDK 的超时),排在它后面的查询就跟着
        /// 一起等,直到后端 15 秒读超时。
        /// Per-attempt wait on a busy channel. This used to be an unbounded Monitor.Enter:
        /// with a channel stuck in a network timeout, every query queued behind it waited
        /// until the backend's 15s read timeout.
        /// </summary>
        private const int AcquireSliceMs = 250;

        /// <summary>
        /// 持锁者攥着一条通道超过这么久,就当它卡住了,不再在它上面等。正常一次查询是
        /// 几百毫秒;卡住的往往是等满十几秒的网络超时。
        /// A holder past this is treated as stuck. A normal query takes a few hundred ms;
        /// a stuck one is usually sitting out a network timeout of ten-plus seconds.
        /// </summary>
        private const int StuckHolderMs = 2000;

        /// <summary>
        /// 排队总时长上限,到点仍拿不到就退回交易连接。不设得更短(比如一次 250ms 就退):
        /// 查询一多就会成批涌到交易连接的 _gate 上和下单抢锁——查询通道存在的全部意义
        /// 就是不让这件事发生。所以"忙"只让查询多等一会儿,"卡住"才让它改道。
        /// Overall queueing cap before falling back. Not shorter (e.g. give up after one
        /// 250ms try): a query burst would then spill onto the trading link's _gate and
        /// contend with orders — the very thing these channels exist to prevent. Busy
        /// means wait a little longer; only stuck means reroute.
        /// </summary>
        private const int AcquireMaxWaitMs = 1500;

        public ReadPool(Config cfg)
        {
            _channels = new ReadChannel[Math.Max(0, cfg.ReadChannels)];
            for (int i = 0; i < _channels.Length; i++)
                _channels[i] = new ReadChannel(cfg, i + 1);
        }

        public int Count
        {
            get { return _channels.Length; }
        }

        public int ConnectedCount
        {
            get
            {
                int n = 0;
                foreach (ReadChannel c in _channels)
                    if (c.IsConnected)
                        n++;
                return n;
            }
        }

        public void Maintain()
        {
            foreach (ReadChannel c in _channels)
            {
                try { c.Maintain(); }
                catch { }
            }
        }

        /// <summary>
        /// 拿到一条已连接的查询通道并持有它的锁;调用方用完必须 Release。null = 没有可用的。
        /// saturated=true 只在"有连着的通道、也没被卡住,但排队等满上限仍全忙"时给出:
        /// 调用方(读接口)据此回 503 read_busy,不再把这次查询溢到交易连接的 _gate 上和
        /// 下单抢锁。没配/没连上/连着的全被卡住(半开)时 saturated=false,调用方照旧退回
        /// 交易连接——那是"通道坏了"而不是"通道忙",数据不能因此断。
        /// Returns a connected channel with its lock held (Release it), or null.
        /// saturated is true only when channels are connected and healthy but all stayed
        /// busy for the whole wait cap: the read endpoint then answers 503 read_busy
        /// instead of spilling the query onto the trading link's _gate, where it would
        /// contend with orders. Not configured / not connected / all stuck (half-open)
        /// leaves saturated false and the caller falls back as before.
        /// </summary>
        public ReadChannel Acquire(out bool saturated)
        {
            saturated = false;
            int n = _channels.Length;
            if (n == 0)
                return null;

            int start = Interlocked.Increment(ref _rr) & int.MaxValue;

            // 先找空闲的 / an idle one first
            for (int k = 0; k < n; k++)
            {
                ReadChannel c = _channels[(start + k) % n];
                if (!c.IsConnected)
                    continue;

                if (Monitor.TryEnter(c.Gate))
                {
                    if (c.IsConnected && c.Manager != null)
                    {
                        c.HeldSince = Environment.TickCount;
                        return c;
                    }
                    Monitor.Exit(c.Gate);
                }
            }

            // 都忙:在已连接的通道上轮流限时等。排队只拖慢查询,不影响交易。持锁者攥得太久
            // (卡在一次网络超时里)的通道不再等它;连着的全都卡住、或者等满上限,就返回
            // null 让调用方退回交易连接。以前这里是 Monitor.Enter 无限期等。
            // All busy: take turns waiting on connected channels with a timeout — only
            // queries wait, never trades. A channel whose holder is stuck (sitting out a
            // network timeout) is skipped; if all are stuck, or the cap runs out, return
            // null so the caller falls back. This used to be an unbounded Monitor.Enter.
            int deadline = unchecked(Environment.TickCount + AcquireMaxWaitMs);

            while (true)
            {
                bool anyWorthWaiting = false;

                for (int k = 0; k < n; k++)
                {
                    ReadChannel c = _channels[(start + k) % n];
                    if (!c.IsConnected)
                        continue;

                    if (unchecked(Environment.TickCount - c.HeldSince) >= StuckHolderMs)
                    {
                        // 看上去卡住了,但也可能恰好刚放掉:不等,只试一下。
                        // Looks stuck, but may have just been released: try, don't wait.
                        if (Monitor.TryEnter(c.Gate))
                        {
                            if (c.IsConnected && c.Manager != null)
                            {
                                c.HeldSince = Environment.TickCount;
                                return c;
                            }
                            Monitor.Exit(c.Gate);
                        }
                        continue;
                    }

                    anyWorthWaiting = true;

                    int left = unchecked(deadline - Environment.TickCount);
                    if (left <= 0)
                    {
                        saturated = true;
                        return null;
                    }

                    if (Monitor.TryEnter(c.Gate, Math.Min(AcquireSliceMs, left)))
                    {
                        if (c.IsConnected && c.Manager != null)
                        {
                            c.HeldSince = Environment.TickCount;
                            return c;
                        }
                        Monitor.Exit(c.Gate);
                    }
                }

                if (!anyWorthWaiting || unchecked(deadline - Environment.TickCount) <= 0)
                {
                    saturated = anyWorthWaiting;
                    return null;
                }
            }
        }

        public void Release(ReadChannel c)
        {
            // 仍连着说明这次查询没有撞上网络类错误(那种调用方会先 MarkBroken),
            // 记一次成功往返,空闲探测就不必再发。
            // Still connected means no network-class error (the caller would have
            // called MarkBroken first): record a round trip so the idle probe stays quiet.
            c.NoteReleased();
            Monitor.Exit(c.Gate);
        }

        public void Dispose()
        {
            foreach (ReadChannel c in _channels)
                c.Dispose();
        }
    }
}
