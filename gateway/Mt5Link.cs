//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - MT5 连接层                                  |
//|                                                                  |
//| 职责:持有一条 Manager 长连接,断线自动重连,对外提供读账户/读持仓/ |
//| 下单/平仓/改单。所有 MT5 调用都在这里,上层 HTTP 不直接碰 SDK。   |
//|                                                                  |
//| 线程模型:Manager API 的调用不保证线程安全,而 HttpListener 是多   |
//| 线程的,所以所有 SDK 调用统一用 _gate 串行化。dealer 成交是毫秒级 |
//| 的,串行不会成为瓶颈,换来的是不会踩内存问题。                    |
//+------------------------------------------------------------------+
using System;
using System.Collections.Generic;
using System.Threading;
using MetaQuotes.MT5CommonAPI;
using MetaQuotes.MT5ManagerAPI;

namespace Prismx.Mt5Gateway
{
    /// <summary>
    /// 把异步的 DealerSend 转成同步等待。每次下单用一个新实例。
    ///
    /// 关键:回执是通过 OnDealerAnswer 的参数传进来的,必须在回调里 Assign
    /// 到自己的对象上。回调返回后那个 request 就不归我们管了,不能只存引用。
    /// </summary>
    internal sealed class DealerSink : CIMTDealerSink
    {
        private readonly ManualResetEventSlim _done = new ManualResetEventSlim(false);
        private readonly CIMTRequest _result;
        private readonly object _lock = new object();
        private MTRetCode _assign = MTRetCode.MT_RET_ERR_NOTFOUND;

        public DealerSink(CIMTRequest result)
        {
            _result = result;
        }

        public override void OnDealerAnswer(CIMTRequest request)
        {
            lock (_lock)
            {
                try
                {
                    // 把服务器答复复制出来,否则回调返回后就读不到了
                    _assign = _result.Assign(request);

                    Log.Info("OnDealerAnswer: id={0} retcode={1} price={2}",
                        request.ID(), request.ResultRetcode(), request.ResultPrice());
                }
                catch (Exception ex)
                {
                    Log.Error("拷贝 dealer 回执失败:{0}", ex.Message);
                }
            }

            _done.Set();
        }

        public override void OnDealerResult(CIMTConfirm confirm)
        {
            // 正常流程走 OnDealerAnswer;这里只记录,便于判断到底哪个回调触发了
            try
            {
                Log.Info("OnDealerResult: id={0} retcode={1}",
                    confirm.ID(), confirm.Retcode());
            }
            catch
            {
            }
        }

        public MTRetCode Wait(int timeoutMs)
        {
            if (!_done.Wait(timeoutMs))
                return MTRetCode.MT_RET_REQUEST_TIMEOUT;

            lock (_lock)
            {
                if (_assign != MTRetCode.MT_RET_OK)
                    return _assign;

                return _result.ResultRetcode();
            }
        }
    }

    /// <summary>连接状态回调:用于把断线记进日志并触发重连。</summary>
    internal sealed class ManagerSink : CIMTManagerSink
    {
        private readonly Mt5Link _link;

        public ManagerSink(Mt5Link link)
        {
            _link = link;
        }

        public override void OnConnect()
        {
            Log.Info("MT5 连接已建立");
            _link.MarkConnected(true);
        }

        public override void OnDisconnect()
        {
            Log.Warn("MT5 连接断开,将自动重连");
            _link.MarkConnected(false);
        }
    }

    /// <summary>
    /// 持仓变化事件。用于立即推送开/平仓,无需等 2 秒轮询。
    /// </summary>
    internal sealed class PositionEvent
    {
        public ulong Login;
        public ulong Ticket;
        public string Action = "";  // "add" 或 "delete"
    }

    /// <summary>
    /// 持仓订阅回调。探针已验证:回调在后台线程 tid=3,需要线程安全队列。
    /// 只关心 ADD/DELETE(结构变化),UPDATE(浮盈变化)不推——探针显示券商不推 UPDATE。
    /// </summary>
    internal sealed class PositionSink : CIMTPositionSink
    {
        // 线程安全队列:后台线程写,HTTP 线程读
        private readonly System.Collections.Concurrent.ConcurrentQueue<PositionEvent> _queue =
            new System.Collections.Concurrent.ConcurrentQueue<PositionEvent>();

        // 限流:避免队列无限增长(后端挂了或调用太慢时)
        private const int MaxQueueSize = 10000;
        private int _queueSize = 0;

        public override void OnPositionAdd(CIMTPosition p)
        {
            if (p == null) return;
            Enqueue(p.Login(), p.Position(), "add");
        }

        public override void OnPositionDelete(CIMTPosition p)
        {
            if (p == null) return;
            Enqueue(p.Login(), p.Position(), "delete");
        }

        // UPDATE 不处理:探针显示券商不推浮盈变化,只推结构变化
        public override void OnPositionUpdate(CIMTPosition p) { }

        private void Enqueue(ulong login, ulong ticket, string action)
        {
            // 限流:队列满时丢弃最老的事件
            int sz = System.Threading.Interlocked.Increment(ref _queueSize);
            if (sz > MaxQueueSize)
            {
                PositionEvent dummy;
                if (_queue.TryDequeue(out dummy))
                    System.Threading.Interlocked.Decrement(ref _queueSize);
            }

            _queue.Enqueue(new PositionEvent
            {
                Login = login,
                Ticket = ticket,
                Action = action
            });
        }

        /// <summary>
        /// 原子性取走队列全部事件。HTTP 接口调用,每 2 秒一次。
        /// </summary>
        public PositionEvent[] DequeueAll()
        {
            var list = new System.Collections.Generic.List<PositionEvent>();
            PositionEvent evt;

            while (_queue.TryDequeue(out evt))
            {
                list.Add(evt);
                System.Threading.Interlocked.Decrement(ref _queueSize);
            }

            return list.ToArray();
        }

        /// <summary>
        /// 队列当前长度。用于监控,超过阈值说明后端调用太慢或挂了。
        /// </summary>
        public int QueueSize
        {
            get { return _queueSize; }
        }
    }

    internal sealed class DealEvent
    {
        public ulong Login;
        public ulong Deal;      // 成交号 / deal ticket
        public ulong Position;  // 所属仓位号,0 表示这笔成交不挂在仓位上(入金/出金等)
    }

    /// <summary>
    /// 成交订阅回调。与 PositionSink 同构:回调在券商的后台线程上，所以队列必须线程安全。
    ///
    /// 这里的用途**不是**把成交明细直接喂给后端，而只是当一个"该去查了"的门铃：
    /// 收到事件就立刻触发那个已有的平仓扫描（它自带 15 分钟回看窗与归因逻辑），
    /// 而不是傻等下一次 3 秒轮询。所以只取 login 与仓位号，不搬运金额、手续费这些
    /// ——那些字段的口径（部分平仓分摊、隔夜费归属）已经在后端那套扫描里定好了，
    /// 在这里再实现一遍必然长歪。
    ///
    /// 只处理 OnDealAdd。OnDealUpdate/OnDealDelete 不管：成交是既成事实，
    /// 券商极少改写，真被改写了也会由兜底扫描纠正。
    ///
    /// Deal subscription callback, mirroring PositionSink: callbacks arrive on the
    /// broker's background thread, so the queue must be thread-safe.
    ///
    /// This is a doorbell, not a data channel. An event only means "go look now"
    /// and triggers the existing closed-trade scan (which owns the 15-minute
    /// lookback and the attribution rules) instead of waiting for the next 3s poll.
    /// Hence only login and position id travel across — reimplementing the money
    /// fields (partial-close allocation, swap attribution) here would inevitably
    /// drift from the backend's version.
    /// </summary>
    internal sealed class DealSink : CIMTDealSink
    {
        private readonly System.Collections.Concurrent.ConcurrentQueue<DealEvent> _queue =
            new System.Collections.Concurrent.ConcurrentQueue<DealEvent>();

        private const int MaxQueueSize = 10000;
        private int _queueSize = 0;

        public override void OnDealAdd(CIMTDeal d)
        {
            if (d == null) return;
            Enqueue(d.Login(), d.Deal(), d.PositionID());
        }

        // 成交是既成事实,改写/删除极少见,交给兜底扫描纠正即可。
        // Deals are facts on the ground; rewrites are rare and the fallback scan covers them.
        public override void OnDealUpdate(CIMTDeal d) { }
        public override void OnDealDelete(CIMTDeal d) { }

        private void Enqueue(ulong login, ulong deal, ulong position)
        {
            // 限流:队列满时丢弃最老的事件。丢事件只会退化成"等下一次兜底扫描",
            // 不会丢数据——真正的平仓明细始终由后端那次扫描从券商拉取。
            // Dropping the oldest event only degrades to "wait for the fallback scan";
            // no data is lost, since the scan is what actually fetches the details.
            int sz = System.Threading.Interlocked.Increment(ref _queueSize);
            if (sz > MaxQueueSize)
            {
                DealEvent dummy;
                if (_queue.TryDequeue(out dummy))
                    System.Threading.Interlocked.Decrement(ref _queueSize);
            }

            _queue.Enqueue(new DealEvent { Login = login, Deal = deal, Position = position });
        }

        /// <summary>原子性取走队列全部事件。</summary>
        public DealEvent[] DequeueAll()
        {
            var list = new System.Collections.Generic.List<DealEvent>();
            DealEvent evt;

            while (_queue.TryDequeue(out evt))
            {
                list.Add(evt);
                System.Threading.Interlocked.Decrement(ref _queueSize);
            }

            return list.ToArray();
        }

        /// <summary>队列当前长度。超过阈值说明后端调用太慢或挂了。</summary>
        public int QueueSize
        {
            get { return _queueSize; }
        }
    }

    /// <summary>下单/平仓/改单的统一返回。</summary>
    internal sealed class TradeResult
    {
        public bool Ok;
        public string Retcode = "";
        public string Message = "";
        public ulong Deal;
        public ulong Order;
        public double Price;

        // 仓位号。dealer 回执只给 Deal/Order,拿不到仓位号,所以开仓后要按成交号
        // 反查一次成交记录才能填上。后端靠这个号判断某笔平仓是不是本平台开的
        // 仓位——这是唯一不受回看窗口和 comment 被券商覆盖影响的依据。
        // The dealer confirmation exposes only Deal/Order, so this is filled by
        // looking the deal up afterwards. The backend needs it to tell whether a
        // close belongs to a platform-opened position: the only signal that
        // survives both the lookback window and brokers overwriting comments.
        public ulong Position;

        public static TradeResult Fail(string retcode, string message)
        {
            return new TradeResult { Ok = false, Retcode = retcode, Message = message };
        }
    }

    internal sealed class Mt5Link : IDisposable
    {
        private const uint ConnectTimeoutMs = 30000;

        private readonly Config _cfg;
        private readonly object _gate = new object();

        // 已加进 Selected 列表的品种,避免重复调用 SelectedAdd
        private readonly HashSet<string> _selected =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private CIMTManagerAPI _manager;
        private ManagerSink _sink;

        // 持仓订阅。开/平仓由服务器主动推,后端不必靠轮询才发现。
        // 探针实测:PositionSubscribe 返回 MT_RET_OK,回调在后台线程,
        // 且券商只推 ADD/DELETE 不推 UPDATE(浮盈仍需轮询)。
        private PositionSink _posSink;
        private volatile bool _posSubscribed;

        private DealSink _dealSink;
        private volatile bool _dealSubscribed;

        private volatile bool _connected;
        private volatile bool _stopping;
        private Thread _watchdog;

        // dealer 通道是否可用。代客下单必须先 DealerStart 成功,否则发出去的单
        // 收不到成交回执。
        //
        // 这个标志刻意与 _connected 分开:重连之后 DealerStart 可能失败(券商临时
        // 抽掉 RIGHT_TRADES_DEALER、或服务端一时不接受重入),而**连接本身是好的**。
        // 若把这种情况当成"重连失败"整体回退,查持仓、查余额这些只读接口会跟着一起
        // 不可用——为了下单不能用而让看盘也不能用,不划算。
        //
        // 所以这里的处理是:照常进入已连接状态,把 dealer 不可用记成 ERROR 日志并
        // 通过 /health 的 dealerActive 暴露出去,同时由 watchdog 每 10 秒单独重试
        // DealerStart。原本的故障形态是"下单静默失败直到人工重启",现在变成"看得见、
        // 且会自己恢复"。
        //
        // Whether the dealer channel is usable. Deliberately separate from
        // _connected: after a reconnect DealerStart can fail while the connection
        // itself is fine, and treating that as a failed reconnect would take the
        // read-only endpoints (positions, balance) down too — losing the ability to
        // watch the market because you can't trade is a bad trade. Instead we enter
        // the connected state as usual, log an ERROR, surface it via /health's
        // dealerActive, and let the watchdog retry DealerStart every 10s. The old
        // failure mode was "orders silently get no confirmation until someone
        // restarts it"; now it's visible and self-healing.
        private volatile bool _dealerActive;

        // 缓存: auto-resolve symbol suffix per (group, baseSymbol)
        private readonly Dictionary<string, string> _symbolCache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // 缓存: user's group per login
        private readonly Dictionary<ulong, string> _groupCache =
            new Dictionary<ulong, string>();

        // 缓存:品种手数限制(volMin/volMax/volStep)。每次开仓都要校验手数,
        // 原本每次都进 _gate 锁查一次 MT5。这些值几乎不变,缓存后既省一次
        // 往返,更重要的是少占 _gate 锁——那把锁串行化所有 MT5 调用,
        // 少占锁直接提升并发下单能力。断线重连时清空。
        // Symbol volume limits cache. Every open validates lot size, which used
        // to hit MT5 under _gate each time. These values rarely change; caching
        // saves a round trip and — more importantly — reduces _gate contention,
        // since that lock serialises every MT5 call. Cleared on reconnect.
        private readonly Dictionary<string, SymbolLimits> _limitsCache =
            new Dictionary<string, SymbolLimits>(StringComparer.OrdinalIgnoreCase);

        // 缓存:交易前的账号校验结果(账号是否存在 + 组是否在白名单)。
        //
        // 与 _groupCache 不同,这里**必须带 TTL**:白名单校验是安全边界,
        // 券商把账号移出允许交易的组之后,永久缓存会让它继续能下单直到
        // gateway 重启。_groupCache 用在 ResolveSymbol 里没这个问题
        // (猜错后缀只是下单失败),所以那边可以永久缓存。
        //
        // Tradability check cache (account exists + group allowed). Unlike
        // _groupCache this MUST expire: the whitelist is a security boundary, so
        // a permanent entry would keep letting an account trade after the broker
        // moved it out of an allowed group, until the gateway restarts.
        private readonly Dictionary<ulong, TradableEntry> _tradableCache =
            new Dictionary<ulong, TradableEntry>();

        private const int TradableCacheTtlMs = 60000;

        /// <summary>品种手数限制。</summary>
        internal struct SymbolLimits
        {
            public double VolMin;
            public double VolMax;
            public double VolStep;
        }

        /// <summary>账号可交易性的缓存条目。Group 留着供日志与错误信息用。</summary>
        private struct TradableEntry
        {
            public bool Exists;
            public string Group;
            public MTRetCode Res;
            public int AtTickCount;
        }

        public Mt5Link(Config cfg)
        {
            _cfg = cfg;
        }

        public bool IsConnected
        {
            get { return _connected; }
        }

        // 供 /health 暴露。false 表示连接正常但代客下单不可用——运维看到这个就该
        // 去查 manager 账号的 RIGHT_TRADES_DEALER 权限,而不是盲目重启进程。
        // Exposed via /health. False means the connection is fine but placing
        // orders on behalf of clients is not available.
        public bool IsDealerActive
        {
            get { return _dealerActive; }
        }

        internal void MarkConnected(bool value)
        {
            _connected = value;
        }

        //+------------------------------------------------------------------+
        //| 启动 dealer 通道,记录结果。返回是否成功。                        |
        //|                                                                  |
        //| 首次启动与重连后重试共用这一处,避免两边对返回码的处理长歪。      |
        //| 只在状态发生翻转时打日志:watchdog 每 10 秒重试一次,权限被永久吊销 |
        //| 时不能把日志刷满(那正是 #9 刚治过的病)。                          |
        //+------------------------------------------------------------------+
        private MTRetCode TryStartDealer(string reason)
        {
            MTRetCode res;
            lock (_gate)
            {
                res = _manager.DealerStart();
            }

            bool ok = res == MTRetCode.MT_RET_OK;
            if (ok)
            {
                if (!_dealerActive)
                    Log.Info("dealer 通道已启动({0})", reason);
            }
            else if (_dealerActive)
            {
                // 由可用翻转为不可用:这一条必须显眼,它意味着此刻所有下单都拿不到回执。
                Log.Error("DealerStart 失败:{0}({1})。代客下单将无法收到成交回执,"
                    + "通常是 manager 账号缺 RIGHT_TRADES_DEALER 权限;watchdog 会每 10 秒重试。",
                    res, reason);
            }

            _dealerActive = ok;
            return res;
        }

        //+------------------------------------------------------------------+
        //| 加载 SDK 并建立首次连接                                          |
        //+------------------------------------------------------------------+
        public void Start()
        {
            MTRetCode res = SMTManagerAPIFactory.Initialize(null);
            if (res != MTRetCode.MT_RET_OK)
                throw new Exception("加载 Manager API 失败:" + res +
                    "(确认 MT5APIManager64.dll 与 exe 同目录)");

            uint version;
            res = SMTManagerAPIFactory.GetVersion(out version);
            if (res != MTRetCode.MT_RET_OK)
                throw new Exception("获取 Manager API 版本失败:" + res);

            if (version != SMTManagerAPIFactory.ManagerAPIVersion)
                throw new Exception(string.Format(
                    "Manager API 版本不匹配:DLL={0},需要={1}",
                    version, SMTManagerAPIFactory.ManagerAPIVersion));

            _manager = SMTManagerAPIFactory.CreateManager(
                SMTManagerAPIFactory.ManagerAPIVersion, out res);

            if (_manager == null || res != MTRetCode.MT_RET_OK)
                throw new Exception("创建 manager 接口失败:" + res);

            Log.Info("Manager API 已加载(版本 {0})", version);

            _sink = new ManagerSink(this);
            _manager.Subscribe(_sink);

            // 首次连接失败直接抛出,让进程启动失败而不是带着坏连接跑起来
            MTRetCode cres = ConnectOnce();
            if (cres != MTRetCode.MT_RET_OK)
                throw new Exception("连接 MT5 失败:" + cres + " " + DescribeConnectError(cres));

            // dealer 通道:代客下单必须先启动。
            // 首次启动仍然是硬失败——带着不能下单的通道把服务跑起来毫无意义,不如
            // 当场退出让人看见。**重连之后**的处理不同,见 _dealerActive 的说明。
            // First start still fails hard: booting a gateway that cannot place
            // orders is pointless. Post-reconnect handling differs — see _dealerActive.
            MTRetCode dres = TryStartDealer("首次启动");
            if (dres != MTRetCode.MT_RET_OK)
                throw new Exception("DealerStart 失败:" + dres +
                    "(通常是 manager 账号缺 RIGHT_TRADES_DEALER 权限)");

            SubscribePositions();
            SubscribeDeals();

            _watchdog = new Thread(WatchdogLoop);
            _watchdog.IsBackground = true;
            _watchdog.Name = "mt5-watchdog";
            _watchdog.Start();
        }

        //+------------------------------------------------------------------+
        //| 建立持仓订阅。失败不抛异常——订阅只是延迟优化,后端仍有轮询兜底, |
        //| 不该因为券商不给权限就让整个 gateway 起不来。                    |
        //+------------------------------------------------------------------+
        private void SubscribePositions()
        {
            try
            {
                lock (_gate)
                {
                    // 托管 sink 内部持有原生指针,构造后必须先 RegisterSink,
                    // 否则传进去的是空指针,订阅会返回 MT_RET_ERR_PARAMS。
                    PositionSink sink = new PositionSink();
                    MTRetCode reg = sink.RegisterSink();

                    if (reg != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("PositionSink.RegisterSink 失败:{0},持仓改由轮询兜底", reg);
                        return;
                    }

                    MTRetCode sub = _manager.PositionSubscribe(sink);
                    if (sub != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("PositionSubscribe 失败:{0},持仓改由轮询兜底", sub);
                        return;
                    }

                    _posSink = sink;
                    _posSubscribed = true;
                    Log.Info("持仓订阅已建立:开平仓将即时推送");
                }
            }
            catch (Exception ex)
            {
                Log.Error("建立持仓订阅异常:{0}", ex.Message);
            }
        }

        //+------------------------------------------------------------------+
        //| 建立成交订阅。与持仓订阅同样：失败不抛异常——订阅只是延迟优化,     |
        //| 后端仍有 3 秒轮询兜底,不该因为券商不给权限就让整个 gateway 起不来。|
        //|                                                                  |
        //| Establish the deal subscription. Like positions, a failure is not |
        //| fatal: this is a latency optimization and the backend still has   |
        //| its 3-second fallback scan.                                       |
        //+------------------------------------------------------------------+
        private void SubscribeDeals()
        {
            try
            {
                lock (_gate)
                {
                    // 与 PositionSink 相同的陷阱:托管 sink 内部持有原生指针,构造后
                    // 必须先 RegisterSink,否则传进去的是空指针,订阅会返回
                    // MT_RET_ERR_PARAMS。
                    // Same trap as PositionSink: the managed sink holds a native
                    // pointer and must be registered before subscribing.
                    DealSink sink = new DealSink();
                    MTRetCode reg = sink.RegisterSink();

                    if (reg != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("DealSink.RegisterSink 失败:{0},平仓明细改由轮询兜底", reg);
                        return;
                    }

                    MTRetCode sub = _manager.DealSubscribe(sink);
                    if (sub != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("DealSubscribe 失败:{0},平仓明细改由轮询兜底", sub);
                        return;
                    }

                    _dealSink = sink;
                    _dealSubscribed = true;
                    Log.Info("成交订阅已建立:平仓将即时触发明细拉取");
                }
            }
            catch (Exception ex)
            {
                Log.Error("建立成交订阅异常:{0}", ex.Message);
            }
        }

        /// <summary>
        /// 取走订阅积压的开/平仓事件。后端每轮调一次,拿到就立即推前端。
        /// 订阅没建立时返回空数组,后端退回纯轮询,行为与改动前一致。
        /// </summary>
        public PositionEvent[] DrainPositionEvents()
        {
            PositionSink sink = _posSink;
            if (sink == null)
                return new PositionEvent[0];

            // 不进 _gate:队列是 ConcurrentQueue,自己就是线程安全的,
            // 而 _gate 上排着 MT5 调用,没必要为读队列去等锁。
            return sink.DequeueAll();
        }

        /// <summary>订阅是否可用。/health 里暴露,便于确认延迟优化生效。</summary>
        public bool PositionSubscribed
        {
            get { return _posSubscribed; }
        }

        /// <summary>积压事件数。持续不为 0 说明后端没在消费。</summary>
        public int PositionEventBacklog
        {
            get
            {
                PositionSink sink = _posSink;
                return sink == null ? 0 : sink.QueueSize;
            }
        }

        /// <summary>
        /// 取走订阅积压的成交事件。语义与 DrainPositionEvents 一致：破坏性读取，
        /// 订阅没建立时返回空数组，后端退回纯轮询。
        /// Drain queued deal events; destructive read, empty when unsubscribed.
        /// </summary>
        public DealEvent[] DrainDealEvents()
        {
            DealSink sink = _dealSink;
            if (sink == null)
                return new DealEvent[0];

            return sink.DequeueAll();
        }

        /// <summary>成交订阅是否可用。后端据此决定兜底扫描用 3 秒还是 15 秒。</summary>
        public bool DealSubscribed
        {
            get { return _dealSubscribed; }
        }

        /// <summary>成交事件积压数。</summary>
        public int DealEventBacklog
        {
            get
            {
                DealSink sink = _dealSink;
                return sink == null ? 0 : sink.QueueSize;
            }
        }

        //+------------------------------------------------------------------+
        //| 诊断用:只连接,不启动 DealerStart                                  |
        //+------------------------------------------------------------------+
        public void ConnectOnly()
        {
            MTRetCode res = SMTManagerAPIFactory.Initialize(null);
            if (res != MTRetCode.MT_RET_OK)
                throw new Exception("加载 Manager API 失败:" + res);

            uint version;
            res = SMTManagerAPIFactory.GetVersion(out version);
            if (res != MTRetCode.MT_RET_OK)
                throw new Exception("获取版本失败:" + res);

            if (version != SMTManagerAPIFactory.ManagerAPIVersion)
                throw new Exception(string.Format("API 版本不匹配:DLL={0},需要={1}",
                    version, SMTManagerAPIFactory.ManagerAPIVersion));

            _manager = SMTManagerAPIFactory.CreateManager(
                SMTManagerAPIFactory.ManagerAPIVersion, out res);
            if (_manager == null || res != MTRetCode.MT_RET_OK)
                throw new Exception("创建 manager 接口失败:" + res);

            Log.Info("Manager API 已加载(版本 {0})", version);

            _sink = new ManagerSink(this);
            _manager.Subscribe(_sink);

            res = ConnectOnce();
            if (res != MTRetCode.MT_RET_OK)
                throw new Exception("连接失败:" + res + " " + DescribeConnectError(res));

            Log.Info("已连接(未启动 dealer 通道)");
        }

        private MTRetCode ConnectOnce()
        {
            lock (_gate)
            {
                // 只订阅需要的数据,不用 PUMP_MODE_FULL:
                // 全量推送会带来大量无用流量和内存占用。
                MTRetCode res = _manager.Connect(
                    _cfg.Server,
                    _cfg.ManagerLogin,
                    _cfg.ManagerPassword,
                    null,
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_USERS |
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_ORDERS |
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_POSITIONS |
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_SYMBOLS,
                    ConnectTimeoutMs);

                if (res == MTRetCode.MT_RET_OK)
                    _connected = true;

                return res;
            }
        }

        public static string DescribeConnectError(MTRetCode res)
        {
            switch (res)
            {
                case MTRetCode.MT_RET_ERR_NETWORK:
                case MTRetCode.MT_RET_ERR_CONNECTION:
                    return "-> 地址/端口不通,或本机 IP 不在服务器白名单";
                case MTRetCode.MT_RET_ERR_PERMISSIONS:
                    return "-> 该账号没有 Manager 连接权限";
                default:
                    if (res.ToString().StartsWith("MT_RET_AUTH"))
                        return "-> 账号或密码错误";
                    return "";
            }
        }

        /// <summary>断线重连。指数退避,最多 30 秒一次。</summary>
        private void WatchdogLoop()
        {
            int delaySec = 2;
            // dealer 重试节流:连接正常但 dealer 掉了时,每 10 圈(约 10 秒)重试一次。
            // 不用每秒重试——权限类问题重试再密也不会更快好,只会白敲券商接口。
            int dealerRetryTick = 0;

            while (!_stopping)
            {
                Thread.Sleep(1000);

                if (_stopping || _connected)
                {
                    delaySec = 2;

                    // 连接还在、但 dealer 通道不可用:单独把它拉回来,不去动连接本身。
                    // 这是本分支存在的全部意义——旧代码在这里直接 continue,于是
                    // "连着但下不了单"这个状态一旦形成就只能靠人工重启解除。
                    // Connection is up but the dealer channel isn't: recover it on its
                    // own without touching the connection. The old code just continued
                    // here, so "connected but can't trade" could only be cleared by a
                    // manual restart.
                    if (!_stopping && _connected && !_dealerActive)
                    {
                        dealerRetryTick++;
                        if (dealerRetryTick >= 10)
                        {
                            dealerRetryTick = 0;
                            TryStartDealer("重试");
                        }
                    }
                    else
                    {
                        dealerRetryTick = 0;
                    }
                    continue;
                }

                Log.Warn("检测到未连接,{0} 秒后重连", delaySec);
                Thread.Sleep(delaySec * 1000);

                if (_stopping)
                    break;

                MTRetCode res = ConnectOnce();
                if (res == MTRetCode.MT_RET_OK)
                {
                    Log.Info("重连成功");

                    // 重连后 dealer 通道要重开,否则下单没有回执。
                    // Selected 列表是连接级状态,断线即失效,缓存要清掉重建。
                    // 手数限制与账号可交易性缓存同样清空:断线期间券商可能改过
                    // 品种配置或账号分组,拿旧值校验会放过本该拒绝的请求。
                    // Also clear the limits and tradability caches: the broker may
                    // have changed symbol config or account groups while we were
                    // down, and stale values would pass checks that should fail.
                    lock (_gate)
                    {
                        _selected.Clear();
                        _limitsCache.Clear();
                        _tradableCache.Clear();
                    }

                    // 重连后重开 dealer 通道。返回码此前被直接丢弃——它一旦失败,
                    // 之后所有下单都收不到成交回执,而日志里一个字都没有,只能靠
                    // 用户报"单子下不出去"才发现。现在失败会记 ERROR 并置
                    // dealerActive=false,上面的分支每 10 秒重试直到恢复。
                    // The return code used to be discarded here: if it failed, every
                    // subsequent order silently got no confirmation with nothing in the
                    // log. Now a failure is logged and retried until it recovers.
                    TryStartDealer("重连后");

                    // 持仓与成交订阅都要重建:断线时服务器已清掉我们的订阅状态
                    // Both subscriptions must be rebuilt: the server dropped them on disconnect
                    _posSubscribed = false;
                    SubscribePositions();
                    _dealSubscribed = false;
                    SubscribeDeals();

                    delaySec = 2;
                }
                else
                {
                    Log.Error("重连失败:{0}", res);
                    delaySec = Math.Min(delaySec * 2, 30);
                }
            }
        }

        //+------------------------------------------------------------------+
        //| 校验主密码。用于用户在网页上绑定 MT5 账号。                      |
        //|                                                                  |
        //| **只认主密码**,投资者密码这条路径已被移除。理由:投资者密码在券商 |
        //| 侧是只读凭证,而本网关绑定完成后所有操作都走 manager、不再校验任何 |
        //| 密码——用投资者密码绑上来,等于把"只能看"当场换成"能下单",是一次 |
        //| 权限提升。之前这里有个 investorOnly 参数,由 HTTP 请求体直接控制。 |
        //|                                                                  |
        //| Main password only; the investor-password path was removed. The   |
        //| investor password is a read-only credential at the broker, but    |
        //| everything after a successful bind here runs through the manager  |
        //| with no further password check — binding with it would upgrade    |
        //| read-only access to order placement. This used to be an           |
        //| `investorOnly` flag taken straight from the HTTP request body.    |
        //+------------------------------------------------------------------+
        public MTRetCode CheckPassword(ulong login, string password)
        {
            lock (_gate)
            {
                return _manager.UserPasswordCheck(
                    CIMTUser.EnUsersPasswords.USER_PASS_MAIN,
                    login,
                    password);
            }
        }

        /// <summary>读账号资料 + 资金。返回 null 表示读取失败。</summary>
        public AccountInfo GetAccount(ulong login, out MTRetCode res)
        {
            lock (_gate)
            {
                AccountInfo info = new AccountInfo();
                info.Login = login;

                using (CIMTUser user = _manager.UserCreate())
                {
                    res = _manager.UserRequest(login, user);
                    if (res != MTRetCode.MT_RET_OK)
                        return null;

                    info.Name = user.Name();
                    info.Group = user.Group();
                    info.Leverage = user.Leverage();
                    info.LastPassChange = user.LastPassChange();
                }

                using (CIMTAccount account = _manager.UserCreateAccount())
                {
                    res = _manager.UserAccountRequest(login, account);
                    if (res != MTRetCode.MT_RET_OK)
                        return null;

                    info.Balance = account.Balance();
                    info.Equity = account.Equity();
                    info.Margin = account.Margin();
                    info.MarginFree = account.MarginFree();
                }

                return info;
            }
        }

        /// <summary>
        /// 交易前的账号校验:账号是否存在 + 所在组。带 60 秒 TTL 缓存。
        ///
        /// 原本交易前调 GetAccount 做这件事,那会发**两次** MT5 请求
        /// (UserRequest + UserAccountRequest),而校验只用得到 group——
        /// 资金字段查了就丢。这里只发 UserRequest,并把结果缓存 60 秒。
        ///
        /// TTL 是刻意的:白名单是安全边界,不能像 _groupCache 那样永久缓存,
        /// 否则券商把账号移出允许组之后它还能继续下单。60 秒窗口是可接受的
        /// 有界损失。
        ///
        /// Pre-trade account check (existence + group), cached for 60s. The old
        /// path called GetAccount, which issues two MT5 requests where only the
        /// group is needed. The TTL is deliberate: the whitelist is a security
        /// boundary and must not be cached forever the way _groupCache is.
        /// </summary>
        /// <param name="group">账号所在组。账号不存在时为空字符串。</param>
        /// <returns>账号是否存在且可读。</returns>
        public bool CheckAccountGroup(ulong login, out string group, out MTRetCode res)
        {
            int now = Environment.TickCount;

            lock (_gate)
            {
                TradableEntry hit;
                if (_tradableCache.TryGetValue(login, out hit))
                {
                    // TickCount 会在约 49.7 天后回绕,unchecked 相减仍得到正确
                    // 的时间差(补码运算),不需要特殊处理。
                    // TickCount wraps after ~49.7 days; the unchecked subtraction
                    // still yields the correct delta via two's complement.
                    int age = unchecked(now - hit.AtTickCount);
                    if (age >= 0 && age < TradableCacheTtlMs)
                    {
                        group = hit.Group;
                        res = hit.Res;
                        return hit.Exists;
                    }
                }

                bool exists;
                using (CIMTUser user = _manager.UserCreate())
                {
                    res = _manager.UserRequest(login, user);
                    exists = res == MTRetCode.MT_RET_OK;
                    group = exists ? user.Group() : "";
                }

                TradableEntry entry;
                entry.Exists = exists;
                entry.Group = group;
                entry.Res = res;
                entry.AtTickCount = now;
                _tradableCache[login] = entry;

                return exists;
            }
        }

        /// <summary>读持仓。</summary>
        public PositionInfo[] GetPositions(ulong login, out MTRetCode res)
        {
            lock (_gate)
            {
                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    res = _manager.PositionRequest(login, arr);

                    // 账号一笔持仓都没有时,服务器返回 NOTFOUND。
                    // 这是正常状态而非错误,要返回空列表,不能当失败。
                    if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                    {
                        res = MTRetCode.MT_RET_OK;
                        return new PositionInfo[0];
                    }

                    if (res != MTRetCode.MT_RET_OK)
                        return null;

                    uint total = arr.Total();
                    PositionInfo[] list = new PositionInfo[total];
                    int n = 0;

                    for (uint i = 0; i < total; i++)
                    {
                        CIMTPosition p = arr.Next(i);
                        if (p == null)
                            continue;

                        list[n++] = new PositionInfo
                        {
                            Ticket = p.Position(),
                            Symbol = p.Symbol(),
                            Side = p.Action() == (uint)CIMTPosition.EnPositionAction.POSITION_BUY
                                ? "BUY" : "SELL",
                            Volume = SMTMath.VolumeToDouble(p.Volume()),
                            PriceOpen = p.PriceOpen(),
                            PriceCurrent = p.PriceCurrent(),
                            StopLoss = p.PriceSL(),
                            TakeProfit = p.PriceTP(),
                            Profit = p.Profit(),
                            Comment = p.Comment()
                        };
                    }

                    if (n != total)
                        Array.Resize(ref list, n);

                    return list;
                }
            }
        }

        /// <summary>读挂单。</summary>
        public OrderInfo[] GetOrders(ulong login, out MTRetCode res)
        {
            lock (_gate)
            {
                using (CIMTOrderArray arr = _manager.OrderCreateArray())
                {
                    res = _manager.OrderRequestOpen(login, arr);

                    // 同上:没有挂单时返回 NOTFOUND,属正常状态
                    if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                    {
                        res = MTRetCode.MT_RET_OK;
                        return new OrderInfo[0];
                    }

                    if (res != MTRetCode.MT_RET_OK)
                        return null;

                    uint total = arr.Total();
                    OrderInfo[] list = new OrderInfo[total];
                    int n = 0;

                    for (uint i = 0; i < total; i++)
                    {
                        CIMTOrder o = arr.Next(i);
                        if (o == null)
                            continue;

                        list[n++] = new OrderInfo
                        {
                            Ticket = o.Order(),
                            Symbol = o.Symbol(),
                            Type = o.Type(),
                            Volume = SMTMath.VolumeToDouble(o.VolumeCurrent()),
                            PriceOrder = o.PriceOrder(),
                            StopLoss = o.PriceSL(),
                            TakeProfit = o.PriceTP(),
                            Comment = o.Comment()
                        };
                    }

                    if (n != total)
                        Array.Resize(ref list, n);

                    return list;
                }
            }
        }

        /// <summary>
        /// 读一段时间内的成交历史(Unix 秒,闭区间)。
        ///
        /// 时间参数由 MT5 服务器按 UTC 秒解读,直接传 Unix 时间戳即可 —— 不像
        /// Bridge 那边用 MetaTrader5 Python 包时要先换算服务器本地时区(见
        /// bridge/mt5_worker.py 的 _server_now 注释)。Manager API 走的是
        /// int64 秒,不存在那个参照系陷阱。
        /// </summary>
        public DealInfo[] GetDeals(ulong login, long fromUnix, long toUnix, out MTRetCode res)
        {
            lock (_gate)
            {
                using (CIMTDealArray arr = _manager.DealCreateArray())
                {
                    res = _manager.DealRequest(login, fromUnix, toUnix, arr);

                    // 区间内没有任何成交时返回 NOTFOUND,属正常状态
                    if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                    {
                        res = MTRetCode.MT_RET_OK;
                        return new DealInfo[0];
                    }

                    if (res != MTRetCode.MT_RET_OK)
                        return null;

                    uint total = arr.Total();
                    DealInfo[] list = new DealInfo[total];
                    int n = 0;

                    for (uint i = 0; i < total; i++)
                    {
                        CIMTDeal d = arr.Next(i);
                        if (d == null)
                            continue;

                        list[n++] = new DealInfo
                        {
                            Ticket = d.Deal(),
                            PositionId = d.PositionID(),
                            Symbol = d.Symbol(),
                            Action = d.Action(),
                            Entry = d.Entry(),
                            Volume = SMTMath.VolumeToDouble(d.Volume()),
                            Price = d.Price(),
                            Profit = d.Profit(),
                            Commission = d.Commission(),
                            Storage = d.Storage(),
                            Time = d.Time(),
                            Comment = d.Comment()
                        };
                    }

                    if (n != total)
                        Array.Resize(ref list, n);

                    return list;
                }
            }
        }

        /// <summary>
        /// 按成交号反查其所属仓位号,取不到返回 0。
        ///
        /// dealer 回执(CIMTRequest)只有 ResultDeal/ResultOrder,没有仓位号,而
        /// 后端判断归属只能靠仓位号:开仓腿的 comment 虽然带前缀,但平仓腿的
        /// comment 由服务器写(TP/SL 触发时会变成 "[tp 4177.62]" 之类),指望它
        /// 带前缀是不可靠的。所以开仓成功后按成交号查一次,把仓位号带回去。
        ///
        /// 单笔查询,失败不影响已成交的仓位,调用方当作 0 处理即可。
        ///
        /// Resolves a deal ticket to its position id (0 if unavailable). The
        /// dealer confirmation has no position id, and closing-leg comments are
        /// written by the server (TP/SL fills look like "[tp 4177.62]"), so the
        /// backend can't rely on the prefix to attribute a close. Looking the
        /// deal up right after the open is what makes attribution reliable.
        /// </summary>
        public ulong GetDealPosition(ulong dealTicket)
        {
            if (dealTicket == 0)
                return 0;

            lock (_gate)
            {
                using (CIMTDealArray arr = _manager.DealCreateArray())
                {
                    if (arr == null)
                        return 0;

                    MTRetCode res = _manager.DealRequestByTickets(
                        new ulong[] { dealTicket }, arr);

                    if (res != MTRetCode.MT_RET_OK || arr.Total() == 0)
                        return 0;

                    CIMTDeal d = arr.Next(0);
                    return d == null ? 0 : d.PositionID();
                }
            }
        }

        //+------------------------------------------------------------------+
        //| 品种名自动后缀匹配                                              |
        //|                                                                  |
        //| 不同组交易需要不同后缀品种(例如 demo\STD-USD 用 EURUSD.s)。      |
        //| 这个方法根据用户所在组,自动把裸品种名映射为可交易的带后缀品种。  |
        //+------------------------------------------------------------------+
        public string ResolveSymbol(ulong login, string baseSymbol)
        {
            lock (_gate)
            {
                // --- 1. lookup group ---
                string group;
                if (!_groupCache.TryGetValue(login, out group))
                {
                    using (CIMTUser user = _manager.UserCreate())
                    {
                        MTRetCode r = _manager.UserRequest(login, user);
                        if (r != MTRetCode.MT_RET_OK)
                            return baseSymbol;
                        group = user.Group();
                        _groupCache[login] = group;
                    }
                }

                string cacheKey = group.ToUpperInvariant() + "|" + baseSymbol.ToUpperInvariant();

                string cached;
                if (_symbolCache.TryGetValue(cacheKey, out cached))
                    return cached;

                // 每个别名写法都走一遍"精确匹配 -> 前缀扫描"。只按传进来的名字
                // 扫是不够的:比特币的信号名是 BTCUSDT,券商品种表里以它为前缀的
                // 名字一个也没有,于是原样发出去、必然被拒。
                // Try "exact match -> prefix scan" for each alias spelling. The
                // name as given isn't enough: Bitcoin arrives as BTCUSDT and no
                // broker symbol starts with that, so it used to go out unchanged
                // and always got rejected.
                foreach (string alias in AliasCandidates(baseSymbol))
                {
                    // --- 2. exact match first ---
                    using (CIMTConSymbol sym = _manager.SymbolCreate())
                    {
                        if (_manager.SymbolGet(alias, group, sym) == MTRetCode.MT_RET_OK)
                        {
                            _symbolCache[cacheKey] = alias;
                            return alias;
                        }
                    }

                    // --- 3. scan symbol table for prefixed matches ---
                    string upper = alias.ToUpperInvariant();
                    List<string> candidates = new List<string>();
                    uint total = _manager.SymbolTotal();

                    using (CIMTConSymbol scanSym = _manager.SymbolCreate())
                    {
                        for (uint i = 0; i < total; i++)
                        {
                            if (_manager.SymbolNext(i, scanSym) != MTRetCode.MT_RET_OK)
                                continue;

                            string name = scanSym.Symbol();
                            if (string.IsNullOrEmpty(name))
                                continue;

                            if (!name.ToUpperInvariant().StartsWith(upper))
                                continue;

                            // Check group access
                            using (CIMTConSymbol testSym = _manager.SymbolCreate())
                            {
                                if (_manager.SymbolGet(name, group, testSym) == MTRetCode.MT_RET_OK)
                                    candidates.Add(name);
                            }
                        }
                    }

                    // pick shortest suffix (closest to base name)
                    if (candidates.Count > 0)
                    {
                        candidates.Sort((a, b) => a.Length.CompareTo(b.Length));

                        string resolved = candidates[0];

                        Log.Info("品种名自动匹配: {0} -> {1} (组={2})",
                            baseSymbol, resolved, group);

                        _symbolCache[cacheKey] = resolved;
                        return resolved;
                    }
                }

                // No match — return as-is, let caller handle the error
                _symbolCache[cacheKey] = baseSymbol;
                return baseSymbol;
            }
        }

        //+------------------------------------------------------------------+
        //| 品种别名:同一个品种在信号侧与券商侧的不同写法                   |
        //|                                                                  |
        //| 传进来的名字排第一,其余别名依次兜底。桥接(mt5_worker)与后端     |
        //| (symbol_aliases)各有一份同样的表,三处各自维护:这边解决的是      |
        //| "券商把它叫什么",不要合并。                                      |
        //|                                                                  |
        //| 表外的加密品种走通用规则:TradingView 的加密警报一律以 USDT 计价  |
        //| (BTCUSDT/ETHUSDT/XRPUSDT),券商的加密 CFD 一律是 …USD,去掉尾巴   |
        //| 那个 T 即可,不必逐个币种登记。                                   |
        //+------------------------------------------------------------------+
        private static readonly string[][] AliasGroups = new string[][]
        {
            new string[] { "BTCUSD", "BTCUSDT" },
            new string[] { "WTI", "USOIL", "XTIUSD", "WTICOUSD", "CL" },
        };

        internal static List<string> AliasCandidates(string baseSymbol)
        {
            List<string> list = new List<string>();
            if (string.IsNullOrEmpty(baseSymbol))
                return list;

            list.Add(baseSymbol);
            string upper = baseSymbol.ToUpperInvariant();

            foreach (string[] alias_group in AliasGroups)
            {
                if (Array.IndexOf(alias_group, upper) < 0)
                    continue;
                foreach (string name in alias_group)
                {
                    if (!list.Contains(name))
                        list.Add(name);
                }
            }

            if (upper.Length > 4 && upper.EndsWith("USDT"))
            {
                string alt = upper.Substring(0, upper.Length - 1);
                if (!list.Contains(alt))
                    list.Add(alt);
            }

            return list;
        }

        /// <summary>
        /// 取当前买卖价。
        ///
        /// 注意:品种在配置表里存在,并不等于有报价。Manager 只会收到"已选中"
        /// (Selected)品种的行情推送。所以这里先把品种加进选中列表,再取价。
        /// 首次取价可能因为推送还没到而失败,重试一次即可。
        /// </summary>
        public bool GetQuote(string symbol, out double bid, out double ask, out MTRetCode res)
        {
            bid = 0;
            ask = 0;
            res = MTRetCode.MT_RET_ERR_NOTFOUND;

            for (int attempt = 0; attempt < 2; attempt++)
            {
                lock (_gate)
                {
                    if (_selected.Add(symbol))
                        _manager.SelectedAdd(symbol);

                    MTTickShort tick;
                    res = _manager.TickLast(symbol, out tick);

                    if (res == MTRetCode.MT_RET_OK && (tick.bid > 0 || tick.ask > 0))
                    {
                        bid = tick.bid;
                        ask = tick.ask;
                        return true;
                    }
                }

                // 刚加进选中列表,等一下首个 tick 推过来
                if (attempt == 0)
                    Thread.Sleep(700);
            }

            return false;
        }

        /// <summary>
        /// 按子串查品种名。用于确认真实品种名(可能带 .m / .raw 等后缀)。
        /// contains 留空则返回前 limit 个。
        /// </summary>
        public string[] FindSymbols(string contains, int limit, out MTRetCode res)
        {
            res = MTRetCode.MT_RET_OK;

            List<string> names = new List<string>();

            lock (_gate)
            {
                // 枚举内存里的品种表(连接时已订阅 PUMP_MODE_SYMBOLS)。
                // 不用 SymbolRequestArray:它的 mask/group 匹配语义不好把握,
                // 本地枚举后自己过滤更可靠。
                uint total = _manager.SymbolTotal();

                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    for (uint i = 0; i < total && names.Count < limit; i++)
                    {
                        if (_manager.SymbolNext(i, sym) != MTRetCode.MT_RET_OK)
                            continue;

                        string name = sym.Symbol();
                        if (string.IsNullOrEmpty(name))
                            continue;

                        if (string.IsNullOrEmpty(contains) ||
                            name.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            names.Add(name);
                        }
                    }
                }
            }

            return names.ToArray();
        }

        /// <summary>品种表总数。用于判断品种数据是否已同步。</summary>
        public uint SymbolTotal()
        {
            lock (_gate)
            {
                return _manager.SymbolTotal();
            }
        }

        /// <summary>
        /// 取品种的手数限制,用于下单前校验。
        ///
        /// 带缓存:命中时不进 MT5,只读字典。手数限制属于品种配置,券商极少改动,
        /// 断线重连时会连同 Selected 列表一起清空重建。
        /// </summary>
        public bool GetSymbolLimits(string symbol, out double volMin, out double volMax,
            out double volStep, out MTRetCode res)
        {
            volMin = 0;
            volMax = 0;
            volStep = 0;
            res = MTRetCode.MT_RET_OK;

            lock (_gate)
            {
                SymbolLimits hit;
                if (_limitsCache.TryGetValue(symbol, out hit))
                {
                    volMin = hit.VolMin;
                    volMax = hit.VolMax;
                    volStep = hit.VolStep;
                    return true;
                }

                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    res = _manager.SymbolGet(symbol, sym);
                    if (res != MTRetCode.MT_RET_OK)
                        return false;

                    volMin = SMTMath.VolumeToDouble(sym.VolumeMin());
                    volMax = SMTMath.VolumeToDouble(sym.VolumeMax());
                    volStep = SMTMath.VolumeToDouble(sym.VolumeStep());

                    SymbolLimits entry;
                    entry.VolMin = volMin;
                    entry.VolMax = volMax;
                    entry.VolStep = volStep;
                    _limitsCache[symbol] = entry;

                    return true;
                }
            }
        }

        //+------------------------------------------------------------------+
        //| 市价开仓                                                         |
        //+------------------------------------------------------------------+
        /// <summary>
        /// 市价开仓。
        ///
        /// dealer 请求必须带明确成交价:dealer 扮演交易台角色,由它给出价格,
        /// 传 0 会被服务器判定 MT_RET_REQUEST_INVALID。这里取当前 ask/bid。
        ///
        /// SL/TP 直接放在开仓请求里,不再事后补一次 POS_MODIFY——省掉一整轮
        /// 券商往返,而多数订单都带止损止盈。
        ///
        /// 这一点是**实测**确认的,不是照搬文档:此前注释称「官方示例开仓不带
        /// SL/TP,要用独立的 POS_MODIFY」,但那只是示例的写法,不是 API 约束。
        /// SDK 里 IMTRequest 确实有 PriceSL/PriceTP,只是找不到 POS_EXECUTE
        /// 携带它们的先例,语义未知。用 SlTpProbe 在 demo\STD-USD 组实测:
        /// 请求 SL=1.05322/TP=1.25322,回执 MT_RET_REQUEST_DONE,回查仓位
        /// #18649601 的实际值与请求值完全一致。
        /// (SlTpProbe 是一次性验证工具,会真实下单,验证完成后已从部署目录移除;
        ///  需要重跑时从 git 历史取回 SlTpProbe.cs 与 build-sltp-probe.ps1。
        ///  SlTpProbe was a one-shot verification tool that places a real order;
        ///  it was removed from the deployment directory once this was confirmed.
        ///  Recover it from git history if the experiment ever needs repeating.)
        ///
        /// 仍保留成交后的补救改单:仅在服务器确实没落上 SL/TP 时触发。合并后
        /// 正常路径不会走到那里,但这是止损,静默丢失的代价是仓位裸奔,
        /// 值得留一层兜底。
        ///
        /// SL/TP go in the open request itself rather than a follow-up
        /// POS_MODIFY, saving a full broker round trip. Verified empirically
        /// with SlTpProbe (the old comment claimed the API required a separate
        /// modify, but that was only how the samples happened to do it). The
        /// post-fill repair path is kept as a safety net: it now only fires if
        /// the server silently dropped the levels, and a lost stop-loss means
        /// an unprotected position.
        /// </summary>
        public TradeResult OpenPosition(ulong login, string symbol, bool isBuy, double lots,
            double stopLoss, double takeProfit, string tag)
        {
            // 自动补后缀:不同组需要不同后缀品种(如 EURUSD.s)
            symbol = ResolveSymbol(login, symbol);

            // 先取价:买用 ask,卖用 bid
            double bid, ask;
            MTRetCode qres;

            if (!GetQuote(symbol, out bid, out ask, out qres))
            {
                return TradeResult.Fail(qres.ToString(),
                    "取价失败,无法下单(品种名是否正确?该品种是否有行情?)");
            }

            double price = isBuy ? ask : bid;

            if (price <= 0)
                return TradeResult.Fail("MT_RET_REQUEST_PRICE_OFF", "该品种当前无有效报价");

            bool wantLevels = stopLoss > 0 || takeProfit > 0;

            TradeResult r = SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE);
                req.Type(isBuy ? CIMTOrder.EnOrderType.OP_BUY : CIMTOrder.EnOrderType.OP_SELL);
                req.Volume(SMTMath.VolumeToInt(lots));
                req.Symbol(symbol);
                req.PriceOrder(price);
                req.Comment(BuildComment(tag));

                // SL/TP 随开仓请求一起发。只设非 0 的那一侧,并对应置 CHANGED 标志:
                // 没要求的一侧不该被当成「改成 0」。
                if (wantLevels)
                {
                    CIMTRequest.EnTradeActionFlags flags = 0;

                    if (stopLoss > 0)
                    {
                        req.PriceSL(stopLoss);
                        flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_SL;
                    }

                    if (takeProfit > 0)
                    {
                        req.PriceTP(takeProfit);
                        flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_TP;
                    }

                    req.Flags(flags);
                }
            });

            // SL/TP 无效导致整单被拒时,去掉 SL/TP 重发,把开仓和设止损的成败解耦。
            //
            // 这是必须的:合并前这两件事是分开的两个请求,止损价违反品种最小距离
            // (MT_RET_REQUEST_INVALID_STOPS)只会让改单失败,仓位照样开出来。
            // 合并后同一个请求里带了无效止损会让**开仓本身**失败——用户本来能下的
            // 单变成下不了。生产日志里这个返回码真实出现过,不是假想场景。
            //
            // 降级后仍会走下面的补救改单,失败时提示与旧实现一致。
            //
            // If invalid stops sink the whole request, retry without them so that
            // opening and setting levels fail independently, as they did before the
            // merge. Otherwise an order that used to fill (unprotected) would now be
            // rejected outright — this retcode does occur in production logs.
            if (wantLevels && !r.Ok && IsInvalidStops(r.Retcode))
            {
                Log.Warn("开仓请求带的 SL/TP 被拒({0}),去掉 SL/TP 重发:login={1} {2}",
                    r.Retcode, login, symbol);

                r = SendDealerRequest(req =>
                {
                    req.Login(login);
                    req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE);
                    req.Type(isBuy ? CIMTOrder.EnOrderType.OP_BUY : CIMTOrder.EnOrderType.OP_SELL);
                    req.Volume(SMTMath.VolumeToInt(lots));
                    req.Symbol(symbol);
                    req.PriceOrder(price);
                    req.Comment(BuildComment(tag));
                });
            }

            // 回执没有仓位号,按成交号反查补上。后端拿它作为归属判定的依据,
            // 查不到也只是退化成旧行为(0),不影响这笔已成交的仓位。
            // The confirmation carries no position id; resolve it from the deal.
            // A failure just degrades to 0 and never affects the filled position.
            if (r.Ok)
            {
                if (r.Deal != 0)
                    r.Position = GetDealPosition(r.Deal);

                // PLACED 的回执里成交号可能还是 0(成交在订单建立之后才产生),这时退回
                // 用订单号:MT5 的仓位号就是开仓订单的 ticket,两者在同一个编号空间。
                // 这只是拿不到成交号时的兜底——填错的代价与填 0 相同(归属退化成靠
                // comment 前缀判断),不会影响这笔已成交的仓位本身。
                // On a PLACED confirmation the deal ticket can still be 0, since the
                // deal is created after the order. Fall back to the order ticket: in
                // MT5 a position id is the ticket of the order that opened it.
                if (r.Position == 0 && r.Order != 0)
                    r.Position = r.Order;
            }

            // 兜底:确认 SL/TP 真的落在仓位上,没落上才补一次改单。
            //
            // 实测服务器会正确接受开仓请求里的 SL/TP,所以正常路径下这里只多一次
            // 本地查仓(读 pump 缓存,不发网络请求),不会再发第二个 dealer 请求。
            // 留着它是因为静默丢失止损的后果是仓位裸奔——宁可多查一次。
            //
            // Safety net: verify the levels actually landed and only repair when
            // they did not. On the happy path this costs one local position read
            // (served from the pump cache, no network) instead of a second dealer
            // round trip. It stays because a silently dropped stop-loss leaves the
            // position unprotected.
            if (r.Ok && (stopLoss > 0 || takeProfit > 0))
            {
                ulong ticket = r.Order != 0 ? r.Order : r.Deal;

                if (ticket != 0 && !PositionHasLevels(ticket, stopLoss, takeProfit))
                {
                    Log.Warn("开仓请求的 SL/TP 未生效,补发改单:login={0} ticket={1}",
                        login, ticket);

                    TradeResult m = ModifyPosition(login, ticket, stopLoss, takeProfit);

                    if (!m.Ok)
                    {
                        Log.Warn("开仓成功但设置 SL/TP 失败:login={0} ticket={1} {2}",
                            login, ticket, m.Retcode);

                        r.Message = "已成交,但 SL/TP 设置失败:" + m.Retcode;
                    }
                }
            }

            return r;
        }

        //+------------------------------------------------------------------+
        //| 平仓(支持部分平仓:lots 传 0 表示全平)                          |
        //|                                                                  |
        //| 平仓要先读出原仓位:方向要反,而且必须带 TA_FLAG_CLOSE 标记,      |
        //| 否则服务器会当成反向开新仓(变成对锁),不是平仓。                 |
        //+------------------------------------------------------------------+
        public TradeResult ClosePosition(ulong login, ulong ticket, double lots, string tag)
        {
            string symbol;
            bool posIsBuy;
            double posVolume;

            lock (_gate)
            {
                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    MTRetCode r = _manager.PositionRequestByTickets(new ulong[] { ticket }, arr);
                    if (r != MTRetCode.MT_RET_OK || arr.Total() == 0)
                        return TradeResult.Fail(r.ToString(), "找不到仓位 #" + ticket);

                    CIMTPosition p = arr.Next(0);
                    if (p == null)
                        return TradeResult.Fail("MT_RET_ERR_NOTFOUND", "找不到仓位 #" + ticket);

                    if (p.Login() != login)
                        return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                            "仓位 #" + ticket + " 不属于账号 " + login);

                    symbol = p.Symbol();
                    posIsBuy = p.Action() == (uint)CIMTPosition.EnPositionAction.POSITION_BUY;
                    posVolume = SMTMath.VolumeToDouble(p.Volume());
                }
            }

            double closeVolume = (lots > 0 && lots < posVolume) ? lots : posVolume;

            // 同开仓:dealer 请求必须带明确价格。
            // 平仓方向与持仓相反,所以买仓用 bid 平,卖仓用 ask 平。
            double bid, ask;
            MTRetCode qres;

            if (!GetQuote(symbol, out bid, out ask, out qres))
                return TradeResult.Fail(qres.ToString(), "取价失败,无法平仓");

            double price = posIsBuy ? bid : ask;

            if (price <= 0)
                return TradeResult.Fail("MT_RET_REQUEST_PRICE_OFF", "该品种当前无有效报价");

            return SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE);
                // 平仓 = 反方向成交
                req.Type(posIsBuy ? CIMTOrder.EnOrderType.OP_SELL : CIMTOrder.EnOrderType.OP_BUY);
                req.Volume(SMTMath.VolumeToInt(closeVolume));
                req.Symbol(symbol);
                req.PriceOrder(price);
                req.Position(ticket);
                req.Flags(CIMTRequest.EnTradeActionFlags.TA_FLAG_CLOSE);
                req.Comment(BuildComment(tag));
            });
        }

        /// <summary>
        /// 判断返回码是否为「止损止盈价位无效」。
        ///
        /// 只认这一个返回码才降级重发:别的失败原因(余额不足、无交易权限、
        /// 市场关闭)去掉 SL/TP 也一样会失败,重发只是白发一个请求。
        ///
        /// MT_RET_REQUEST_INVALID_STOPS = 10016,SDK 里只有这一个表示止损无效
        /// (MT5APIConstants.h:150),没有其它同义返回码。
        /// </summary>
        private static bool IsInvalidStops(string retcode)
        {
            return retcode == MTRetCode.MT_RET_REQUEST_INVALID_STOPS.ToString();
        }

        /// <summary>
        /// 查仓位上的 SL/TP 是否已符合预期。用于开仓后确认服务器真的落上了。
        ///
        /// 只比较 stopLoss/takeProfit 中非 0 的那一侧。容差取品种最小报价单位的
        /// 若干倍:券商可能因最小止损距离微调价位,那不算丢失。
        ///
        /// 读不到仓位时返回 true(视为已生效),避免因为一次查询失败就多发一个
        /// 无谓的改单请求——真丢了 SL/TP 会在后续持仓推送里暴露。
        /// </summary>
        private bool PositionHasLevels(ulong ticket, double stopLoss, double takeProfit)
        {
            try
            {
                lock (_gate)
                {
                    using (CIMTPositionArray arr = _manager.PositionCreateArray())
                    {
                        if (_manager.PositionRequestByTickets(new ulong[] { ticket }, arr)
                                != MTRetCode.MT_RET_OK || arr.Total() == 0)
                            return true;

                        CIMTPosition p = arr.Next(0);
                        if (p == null)
                            return true;

                        double actualSl = p.PriceSL();
                        double actualTp = p.PriceTP();

                        // 容差按品种精度推算:digits 拿不到时退回一个宽松的相对值
                        double tolerance = 0.0;
                        using (CIMTConSymbol sym = _manager.SymbolCreate())
                        {
                            if (_manager.SymbolGet(p.Symbol(), sym) == MTRetCode.MT_RET_OK)
                                tolerance = Math.Pow(10, -(int)sym.Digits()) * 50;
                        }
                        if (tolerance <= 0)
                            tolerance = Math.Max(actualSl, 1.0) * 0.001;

                        if (stopLoss > 0 && Math.Abs(actualSl - stopLoss) > tolerance)
                            return false;

                        if (takeProfit > 0 && Math.Abs(actualTp - takeProfit) > tolerance)
                            return false;

                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn("核对仓位 SL/TP 失败,按已生效处理:{0}", ex.Message);
                return true;
            }
        }

        //+------------------------------------------------------------------+
        //| 改持仓的 SL/TP。传 0 表示清除该项。                              |
        //+------------------------------------------------------------------+
        public TradeResult ModifyPosition(ulong login, ulong ticket,
            double stopLoss, double takeProfit)
        {
            string symbol;

            lock (_gate)
            {
                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    MTRetCode r = _manager.PositionRequestByTickets(new ulong[] { ticket }, arr);
                    if (r != MTRetCode.MT_RET_OK || arr.Total() == 0)
                        return TradeResult.Fail(r.ToString(), "找不到仓位 #" + ticket);

                    CIMTPosition p = arr.Next(0);
                    if (p == null)
                        return TradeResult.Fail("MT_RET_ERR_NOTFOUND", "找不到仓位 #" + ticket);

                    if (p.Login() != login)
                        return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                            "仓位 #" + ticket + " 不属于账号 " + login);

                    symbol = p.Symbol();
                }
            }

            return SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_MODIFY);
                req.Symbol(symbol);
                req.Position(ticket);
                req.PriceSL(stopLoss);
                req.PriceTP(takeProfit);
                req.Flags(CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_SL |
                          CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_TP);
            });
        }

        //+------------------------------------------------------------------+
        //| dealer 请求的公共流程:建对象 -> 填参数 -> 发送 -> 等回执         |
        //+------------------------------------------------------------------+
        private TradeResult SendDealerRequest(Action<CIMTRequest> fill)
        {
            if (!_connected)
                return TradeResult.Fail("MT_RET_ERR_CONNECTION", "MT5 未连接");

            CIMTRequest request = null;
            CIMTRequest result = null;
            DealerSink sink = null;

            try
            {
                uint requestId;
                MTRetCode res;

                lock (_gate)
                {
                    request = _manager.RequestCreate();
                    result = _manager.RequestCreate();

                    if (request == null || result == null)
                        return TradeResult.Fail("MT_RET_ERR_MEM", "创建 request 对象失败");

                    request.Clear();
                    fill(request);

                    sink = new DealerSink(result);

                    // 必须先注册,否则原生层不会回调,表现为"发出去了但永远没答复"
                    MTRetCode reg = sink.RegisterSink();
                    if (reg != MTRetCode.MT_RET_OK)
                        return TradeResult.Fail(reg.ToString(), "注册 dealer 回调失败");

                    res = _manager.DealerSend(request, sink, out requestId);
                }

                if (res != MTRetCode.MT_RET_OK)
                    return TradeResult.Fail(res.ToString(), "DealerSend 失败");

                Log.Info("dealer 请求已发送(id={0}),等待服务器答复(上限 {1} 秒)",
                    requestId, _cfg.DealerTimeoutMs / 1000);

                // 等待时不持锁,否则会把其它请求全堵住
                res = sink.Wait(_cfg.DealerTimeoutMs);

                if (res == MTRetCode.MT_RET_REQUEST_TIMEOUT)
                    Log.Warn("dealer 请求 {0} 超时,未收到答复", requestId);

                // 请求被退回队列:通常是服务器上另有 dealer 插件在处理同一队列,
                // 或该品种当时取不到价。这不是成交,要当失败处理。
                if (res == MTRetCode.MT_RET_REQUEST_RETURN ||
                    res == MTRetCode.MT_RET_REQUEST_REQUOTE_RETURN)
                {
                    Log.Warn("dealer 请求 {0} 被退回队列({1}),未成交", requestId, res);
                }

                // MT_RET_REQUEST_PLACED 也是成功。
                //
                // 这个返回码的意思是"请求已被系统接受、订单已建立",不同券商的执行
                // 模式决定回哪一个:即时执行通常回 DONE,市价执行(Market Execution)
                // 会先回 PLACED,成交紧随其后。以前只认 DONE/DONE_PARTIAL,于是真仓
                // 首单出现了最糟的一种失败形态——**仓位已经开出来了,前端却报"下单被
                // 拒绝"**。用户看到失败会去重下,结果是重复开仓;后端那边这笔又被记成
                // REJECTED,orders 表里没有 FILLED 记录,平仓明细的仓位号归属也跟着丢。
                //
                // 这条路径只发 OP_BUY/OP_SELL 市价单(TA_DEALER_POS_EXECUTE),不会产生
                // 挂单,所以 PLACED 在这里没有"已挂单但未成交"的歧义。
                //
                // MT_RET_REQUEST_PLACED means the request was accepted and the order
                // created. Instant-execution servers answer DONE; market-execution
                // ones answer PLACED first and fill right after. Accepting only DONE
                // produced the worst failure shape on the first live order: the
                // position was open while the UI said "rejected", inviting a duplicate
                // submit and leaving the backend with a REJECTED row for a filled
                // trade. This path only ever sends market orders, so PLACED carries no
                // "pending, unfilled" ambiguity here.
                if (res == MTRetCode.MT_RET_REQUEST_DONE ||
                    res == MTRetCode.MT_RET_REQUEST_DONE_PARTIAL ||
                    res == MTRetCode.MT_RET_REQUEST_PLACED)
                {
                    lock (_gate)
                    {
                        return new TradeResult
                        {
                            Ok = true,
                            Retcode = res.ToString(),
                            Deal = result.ResultDeal(),
                            Order = result.ResultOrder(),
                            Price = result.ResultPrice(),
                            Message = result.ResultComment() ?? ""
                        };
                    }
                }

                string comment;
                lock (_gate)
                {
                    comment = result.ResultComment() ?? "";
                }

                return TradeResult.Fail(res.ToString(),
                    comment.Length > 0 ? comment : DescribeTradeError(res));
            }
            finally
            {
                lock (_gate)
                {
                    // 先退订,确保原生层不再回调这个 sink
                    if (sink != null)
                    {
                        try { _manager.DealerUnsubscribe(sink); }
                        catch { }
                    }

                    if (request != null) request.Dispose();
                    if (result != null) result.Dispose();
                }

                // sink 被原生层持有,GC 不知道。必须显式保活到用完为止,
                // 否则可能在等回执的过程中被回收,回调打到已释放的对象上。
                GC.KeepAlive(sink);
            }
        }

        private static string DescribeTradeError(MTRetCode res)
        {
            switch (res)
            {
                case MTRetCode.MT_RET_REQUEST_TIMEOUT:
                    return "服务器未在超时内答复,确认 dealer 通道与请求路由配置";
                case MTRetCode.MT_RET_ERR_PERMISSIONS:
                    return "权限不足,确认 manager 账号有 RIGHT_TRADES_DEALER";
                default:
                    return "交易被拒绝(检查品种名、手数、保证金、市场是否开市)";
            }
        }

        private string BuildComment(string tag)
        {
            // Manager API 的 request 没有 magic 字段,只能用 comment 标记来源。
            // MT5 的 comment 字段有长度上限,这里截断到 31 字符保险。
            string c = string.IsNullOrEmpty(tag)
                ? _cfg.CommentPrefix
                : _cfg.CommentPrefix + "-" + tag;

            return c.Length > 31 ? c.Substring(0, 31) : c;
        }

        public void Dispose()
        {
            _stopping = true;

            if (_watchdog != null)
            {
                _watchdog.Join(3000);
                _watchdog = null;
            }

            if (_manager != null)
            {
                lock (_gate)
                {
                    _manager.DealerStop();

                    if (_sink != null)
                        _manager.Unsubscribe(_sink);

                    if (_posSink != null)
                    {
                        try { _manager.PositionUnsubscribe(_posSink); }
                        catch { }
                    }

                    if (_dealSink != null)
                    {
                        try { _manager.DealUnsubscribe(_dealSink); }
                        catch { }
                    }

                    _manager.Disconnect();
                    _manager.Dispose();
                    _manager = null;
                }
            }

            SMTManagerAPIFactory.Shutdown();
        }
    }
}
