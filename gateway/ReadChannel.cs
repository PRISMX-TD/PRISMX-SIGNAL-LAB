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

        public ReadChannel(Config cfg, int id)
        {
            _cfg = cfg;
            _id = id;
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
        /// 由交易连接的 watchdog 每秒调一次:没连上就按退避重试。只拿自己的锁,不碰 _gate。
        /// Called by the trading watchdog every second; reconnects with back-off under
        /// this channel's own lock only.
        /// </summary>
        public void Maintain()
        {
            if (_connected)
                return;

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
    /// 查询通道池。Acquire 挑一条空闲且已连接的;都忙就在其中一条上排队;一条都没连上
    /// 返回 null,调用方退回交易连接。
    /// Pool of query channels. Acquire picks an idle connected one, queues on one if
    /// all are busy, or returns null so the caller falls back to the trading link.
    /// </summary>
    internal sealed class ReadPool : IDisposable
    {
        private readonly ReadChannel[] _channels;
        private int _rr;

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
        /// Returns a connected channel with its lock held (Release it), or null.
        /// </summary>
        public ReadChannel Acquire()
        {
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
                        return c;
                    Monitor.Exit(c.Gate);
                }
            }

            // 都忙:在一条已连接的上面排队。排队只拖慢查询,不影响交易。
            // All busy: queue on a connected one — only queries wait, never trades.
            for (int k = 0; k < n; k++)
            {
                ReadChannel c = _channels[(start + k) % n];
                if (!c.IsConnected)
                    continue;

                Monitor.Enter(c.Gate);
                if (c.IsConnected && c.Manager != null)
                    return c;
                Monitor.Exit(c.Gate);
            }

            return null;
        }

        public void Release(ReadChannel c)
        {
            Monitor.Exit(c.Gate);
        }

        public void Dispose()
        {
            foreach (ReadChannel c in _channels)
                c.Dispose();
        }
    }
}
