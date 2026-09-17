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
using System.Diagnostics;
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

        // UPDATE 不入队:探针显示券商不推浮盈变化,只推结构变化。但要**数一数**:
        // 平仓/改单现在先读本地 pump 库里的仓位快照(见 Mt5Link.ReadPosition),
        // 快照能不能跟上部分平仓/改 SL·TP,取决于服务器是否推 UPDATE。这个计数
        // 经 /health 的 positionUpdateEvents 暴露——上线后它一直是 0,就说明快照
        // 只能靠 ADD/DELETE 刷新,手数类拒绝后的服务器重读兜底就不是白写的。
        // UPDATE events are counted (not queued): close/modify now read the local
        // pump snapshot first, and whether that snapshot tracks partial closes and
        // SL/TP edits depends on the server pushing UPDATE. Exposed via /health so
        // production tells us; a permanent 0 means the server-reread fallback matters.
        private int _updateCount = 0;

        public override void OnPositionUpdate(CIMTPosition p)
        {
            System.Threading.Interlocked.Increment(ref _updateCount);
        }

        /// <summary>收到过的 UPDATE 事件数。只用于 /health 诊断。</summary>
        public int UpdateCount
        {
            get { return _updateCount; }
        }

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
    /// 一笔成交在订阅回调里带来的、dealer 开仓回执本身没有的几个字段。
    ///
    /// OpenPosition 拿它省掉成交后的两次服务器往返:回执只有成交号/订单号,仓位号
    /// 以前要 DealRequestByTickets 反查,SL/TP 是否落上以前要 PositionRequestByTickets
    /// 核对——而这两样成交记录里本来就有(PriceSL/PriceTP 是成交时刻仓位上的止损止盈,
    /// 后端的平仓明细一直在用这两个字段)。
    ///
    /// The fields a deal callback carries that the dealer confirmation lacks. The
    /// confirmation has only deal/order tickets; the position id used to cost a
    /// DealRequestByTickets and the SL/TP check a PositionRequestByTickets, yet the
    /// deal record already has both (its PriceSL/PriceTP are the position's levels
    /// at fill time — the closed-trade feed has relied on them all along).
    /// </summary>
    internal sealed class FillInfo
    {
        public ulong Deal;
        public ulong Order;
        public ulong Position;
        public double PriceSL;
        public double PriceTP;
        public uint Digits;
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

        // 最近成交的按号索引。与上面的队列是两条互不相干的消费路径:队列是给后端的
        // 门铃(破坏性读取),这份索引是给 OpenPosition 就地取仓位号和 SL/TP 的,按
        // 容量淘汰最老的,不随队列被取走而消失。开仓线程按成交号(或 PLACED 回执里
        // 只有的订单号)等在 _fillLock 上,回调一到就 PulseAll 唤醒。
        // Index of recent fills by ticket, independent of the queue above: the queue
        // is the backend's doorbell (drained destructively); this index serves
        // OpenPosition's post-fill lookup and is evicted by capacity, not by reads.
        // The opening thread waits on _fillLock keyed by deal (or, for a PLACED
        // confirmation that has no deal yet, by order) and is woken by PulseAll.
        private readonly object _fillLock = new object();
        private readonly Dictionary<ulong, FillInfo> _fillsByDeal = new Dictionary<ulong, FillInfo>();
        private readonly Dictionary<ulong, FillInfo> _fillsByOrder = new Dictionary<ulong, FillInfo>();
        private readonly Queue<ulong> _fillArrival = new Queue<ulong>();
        private const int MaxFills = 512;

        public override void OnDealAdd(CIMTDeal d)
        {
            if (d == null) return;
            Enqueue(d.Login(), d.Deal(), d.PositionID());
            RememberFill(d);
        }

        // 成交是既成事实,改写/删除极少见,交给兜底扫描纠正即可。
        // Deals are facts on the ground; rewrites are rare and the fallback scan covers them.
        public override void OnDealUpdate(CIMTDeal d) { }
        public override void OnDealDelete(CIMTDeal d) { }

        private void RememberFill(CIMTDeal d)
        {
            FillInfo f;
            try
            {
                f = new FillInfo
                {
                    Deal = d.Deal(),
                    Order = d.Order(),
                    Position = d.PositionID(),
                    PriceSL = d.PriceSL(),
                    PriceTP = d.PriceTP(),
                    Digits = d.Digits()
                };
            }
            catch (Exception ex)
            {
                // 读不出来就当没这条事件:OpenPosition 等不到会退回服务器反查。
                // Treat as missing; OpenPosition falls back to the server lookups.
                Log.Warn("读取成交回调字段失败:{0}", ex.Message);
                return;
            }

            if (f.Deal == 0)
                return;

            lock (_fillLock)
            {
                _fillsByDeal[f.Deal] = f;
                if (f.Order != 0)
                    _fillsByOrder[f.Order] = f;
                _fillArrival.Enqueue(f.Deal);

                while (_fillArrival.Count > MaxFills)
                {
                    ulong old = _fillArrival.Dequeue();
                    FillInfo gone;
                    if (!_fillsByDeal.TryGetValue(old, out gone))
                        continue;
                    _fillsByDeal.Remove(old);

                    FillInfo byOrder;
                    if (gone.Order != 0 && _fillsByOrder.TryGetValue(gone.Order, out byOrder)
                        && byOrder.Deal == old)
                        _fillsByOrder.Remove(gone.Order);
                }

                Monitor.PulseAll(_fillLock);
            }
        }

        /// <summary>
        /// 按成交号或订单号取这笔成交,没到就等,最多 timeoutMs。两个号都为 0 直接返回 null。
        /// Look up a fill by deal or order ticket, waiting up to timeoutMs for it to arrive.
        /// </summary>
        public FillInfo WaitFill(ulong deal, ulong order, int timeoutMs)
        {
            if (deal == 0 && order == 0)
                return null;

            int deadline = unchecked(Environment.TickCount + timeoutMs);

            lock (_fillLock)
            {
                while (true)
                {
                    FillInfo f;
                    if (deal != 0 && _fillsByDeal.TryGetValue(deal, out f))
                        return f;
                    if (order != 0 && _fillsByOrder.TryGetValue(order, out f))
                        return f;

                    int remaining = unchecked(deadline - Environment.TickCount);
                    if (remaining <= 0)
                        return null;

                    Monitor.Wait(_fillLock, remaining);
                }
            }
        }

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

        // 仓位号。dealer 回执只给 Deal/Order,拿不到仓位号,开仓后从成交订阅送来的
        // 那条成交记录里取(见 FillInfo);订阅不可用时才按成交号向服务器反查。后端
        // 靠这个号判断某笔平仓是不是本平台开的仓位——这是唯一不受回看窗口和
        // comment 被券商覆盖影响的依据。
        // The dealer confirmation exposes only Deal/Order; this comes from the deal
        // pushed by the subscription (see FillInfo), or from a server lookup when the
        // subscription is unavailable. The backend needs it to tell whether a close
        // belongs to a platform-opened position: the only signal that survives both
        // the lookback window and brokers overwriting comments.
        public ulong Position;

        // 耗时(毫秒)。写进日志与回执,让"下单慢"能区分是网关内部慢还是券商 dealer
        // 慢——此前线上没有任何一个数字能回答这个问题。
        // Timings in ms, logged and returned so "orders are slow" can be split into
        // gateway-internal time and broker dealer time; nothing measured this before.
        public long ElapsedMs;   // 整个开仓/平仓/改单调用 / the whole call
        public long DealerMs;    // 其中等 dealer 回执的部分 / of which: waiting for the dealer

        // dealer 只答了 MT_RET_REQUEST_PLACED:请求被接受、订单已建立——但这条答复
        // 本身**不证明它成交了**。DONE/DONE_PARTIAL 才是服务器认账的成交。
        // 2026-09-17 的事故就出在这个差别上:一笔 0.015 手的平仓拿到 PLACED,被当成
        // 成交回给用户,实际订单挂在仓位上从未执行,此后该仓位的每一次平仓都被
        // MT_RET_REQUEST_CLOSE_ORDER_EXIST 挡下,持续三个半小时直到爆仓。
        // 调用方看到这个标志,就必须自己确认成交,不能直接当成功。
        //
        // The dealer answered PLACED: accepted and an order was created — which does
        // not prove it executed. Only DONE/DONE_PARTIAL are fills the server stands
        // behind. A 0.015-lot close that answered PLACED was reported as filled while
        // its order sat on the position, blocking every later close for 3.5 hours
        // until stop-out. Callers seeing this flag must confirm the fill themselves.
        public bool Placed;

        public static TradeResult Fail(string retcode, string message)
        {
            return new TradeResult { Ok = false, Retcode = retcode, Message = message };
        }
    }

    /// <summary>仓位的静态字段快照,平仓/改单前读一次。</summary>
    internal struct PositionSnapshot
    {
        public ulong Login;
        public string Symbol;
        public bool IsBuy;
        public double Volume;
    }

    internal sealed class Mt5Link : IDisposable
    {
        private const uint ConnectTimeoutMs = 30000;

        private readonly Config _cfg;
        private readonly object _gate = new object();

        // 已加进 Selected 列表的品种,避免重复调用 SelectedAdd
        private readonly HashSet<string> _selected =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // 本进程曾选中过的全部品种。Selected 列表是连接级状态,重连时 _selected 要
        // 清空,而这一份不清:它们就是这条网关实际交易过的品种,重连后整批重新选上,
        // 断线后的第一笔单就不必再等首个 tick(见 GetQuote)。
        // Every symbol ever selected by this process. The Selected list is per
        // connection so _selected is cleared on reconnect; this set is not, and gets
        // re-selected wholesale after a reconnect so the first order afterwards does
        // not wait for a first tick (see GetQuote).
        private readonly HashSet<string> _everSelected =
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

        // 缓存: auto-resolve symbol suffix per (group, baseSymbol)。带 TTL,见下。
        private readonly Dictionary<string, TimedString> _symbolCache =
            new Dictionary<string, TimedString>(StringComparer.OrdinalIgnoreCase);

        // 缓存: user's group per login。
        //
        // 以前这两个缓存永久有效、重连也不清:理由是"猜错后缀只是下单失败"。
        // 但券商把账号换组之后,这里会一直拿旧组名去解析品种,下单就**持续**失败
        // 直到 gateway 重启——不是失败一次,而是每一次。5 分钟 TTL 把"换组后不可
        // 交易"的窗口压到可接受,重连时也一并清空(断线期间最可能发生换组)。
        // These two used to live forever and survive reconnects, on the theory that
        // a wrong suffix only fails one order. But after a broker moves an account
        // to another group, the stale group name makes *every* order fail until the
        // gateway restarts. A 5-minute TTL bounds that window; both are also
        // cleared on reconnect, when a group change is most likely to have happened.
        private readonly Dictionary<ulong, TimedString> _groupCache =
            new Dictionary<ulong, TimedString>();

        private const int ResolveCacheTtlMs = 5 * 60 * 1000;

        private struct TimedString
        {
            public string Value;
            public int AtTickCount;
        }

        private static bool Fresh(TimedString entry)
        {
            return unchecked(Environment.TickCount - entry.AtTickCount) < ResolveCacheTtlMs;
        }

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

            // 配置里点名的品种在启动时就选上,进程起来后的第一笔单不等首个 tick。
            // Pre-select the configured symbols so the very first order after start
            // does not wait for a first tick.
            PreselectSymbols(_cfg.PreselectSymbols, "启动");

            _watchdog = new Thread(WatchdogLoop);
            _watchdog.IsBackground = true;
            _watchdog.Name = "mt5-watchdog";
            _watchdog.Start();
        }

        /// <summary>
        /// 把一批品种加进 Selected 列表,让服务器开始推它们的行情。
        ///
        /// 只处理还没选中的;逐个加而不用 SelectedAddBatch,是为了一个名字写错不至于
        /// 连累整批,并且能把写错的那个点名记进日志。
        /// Adds symbols to the Selected list so the server streams their ticks. One
        /// at a time rather than SelectedAddBatch so a single bad name neither sinks
        /// the batch nor goes unnamed in the log.
        /// </summary>
        private void PreselectSymbols(IEnumerable<string> symbols, string reason)
        {
            int added = 0;

            lock (_gate)
            {
                foreach (string s in symbols)
                {
                    if (string.IsNullOrEmpty(s) || !_selected.Add(s))
                        continue;

                    MTRetCode r = _manager.SelectedAdd(s);
                    if (r != MTRetCode.MT_RET_OK)
                    {
                        _selected.Remove(s);
                        Log.Warn("预选品种 {0} 失败:{1}(preselect_symbols 要填券商的真实品种名,含后缀)", s, r);
                        continue;
                    }

                    _everSelected.Add(s);
                    added++;
                }
            }

            if (added > 0)
                Log.Info("已预选 {0} 个品种({1}),这些品种的首笔下单不必等首个 tick", added, reason);
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

        /// <summary>收到过的持仓 UPDATE 事件数。/health 诊断用,见 PositionSink。</summary>
        public int PositionUpdateEvents
        {
            get
            {
                PositionSink sink = _posSink;
                return sink == null ? 0 : sink.UpdateCount;
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
                    List<string> reselect;
                    lock (_gate)
                    {
                        _selected.Clear();
                        _limitsCache.Clear();
                        _tradableCache.Clear();
                        _groupCache.Clear();
                        _symbolCache.Clear();
                        reselect = new List<string>(_everSelected);
                    }

                    // 断线前交易过的品种 + 配置点名的品种,整批重新选上。否则重连后每个
                    // 品种的第一笔单都要多等一次首个 tick。
                    // Re-select everything traded before the drop plus the configured
                    // list; otherwise the first order per symbol after a reconnect waits
                    // for a first tick again.
                    reselect.AddRange(_cfg.PreselectSymbols);
                    PreselectSymbols(reselect, "重连后");

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

                res = ReadUserGroup(login, out group);
                bool exists = res == MTRetCode.MT_RET_OK;

                TradableEntry entry;
                entry.Exists = exists;
                entry.Group = group;
                entry.Res = res;
                entry.AtTickCount = now;
                _tradableCache[login] = entry;

                // 顺手喂给 ResolveSymbol 的组缓存:同一笔开仓紧接着就要按组解析品种,
                // 没必要为同一个 login 再读一次。
                // Also feed ResolveSymbol's group cache: the same order resolves the
                // symbol by group right after this, no point reading the login twice.
                if (exists)
                    _groupCache[login] = new TimedString { Value = group, AtTickCount = now };

                return exists;
            }
        }

        /// <summary>
        /// 读账号所在组。调用方须持有 _gate。
        ///
        /// 先查本地 pump 库:连接时开了 PUMP_MODE_USERS,账号资料的改动(含换组)由
        /// 服务器主动推过来,所以 UserGet 是内存读,不发网络请求。本地没有(pump 还没
        /// 同步到、或 manager 无权看见这个账号)才退回 UserRequest 向服务器要一次——
        /// 无权看见的账号两边都是 NOTFOUND,行为与只走 UserRequest 时一致。
        ///
        /// Reads the account's group; caller holds _gate. Local pump database first:
        /// PUMP_MODE_USERS is on and user changes (group moves included) are pushed,
        /// so UserGet is an in-memory read. Falls back to a UserRequest round trip
        /// only when the pump lacks the login (not yet synced, or not visible to this
        /// manager — NOTFOUND either way, same as the old UserRequest-only path).
        /// </summary>
        private MTRetCode ReadUserGroup(ulong login, out string group)
        {
            using (CIMTUser user = _manager.UserCreate())
            {
                MTRetCode r = _manager.UserGet(login, user);
                if (r != MTRetCode.MT_RET_OK)
                    r = _manager.UserRequest(login, user);

                group = r == MTRetCode.MT_RET_OK ? (user.Group() ?? "") : "";
                return r;
            }
        }

        /// <summary>
        /// 读仓位的静态字段(账号、品种、方向、手数)。调用方**不**持锁。
        ///
        /// 先查本地 pump 库(PUMP_MODE_POSITIONS,开/平仓由服务器推过来),命中就是
        /// 内存读;本地没有才向服务器 PositionRequestByTickets 要一次。forceServer 跳过
        /// 本地直接问服务器,给"本地快照可能过期"的兜底路径用。
        ///
        /// fromPump 告诉调用方这份快照来自本地:手数可能落后于服务器(部分平仓之后
        /// 服务器若不推 UPDATE,本地还是旧手数),平仓拿到手数类拒绝时要据此决定要不要
        /// 按服务器数据重发。
        ///
        /// Reads a position's static fields; caller does not hold the lock. Local pump
        /// snapshot first (PUMP_MODE_POSITIONS is on), server request only when the
        /// pump lacks the ticket. forceServer skips the pump for the "snapshot may be
        /// stale" fallback. fromPump lets ClosePosition know the volume may lag the
        /// server and decide whether to re-send on a volume rejection.
        /// </summary>
        private bool ReadPosition(ulong ticket, bool forceServer,
            out PositionSnapshot snap, out bool fromPump, out MTRetCode res)
        {
            snap = new PositionSnapshot();
            fromPump = false;

            lock (_gate)
            {
                if (!forceServer)
                {
                    using (CIMTPosition p = _manager.PositionCreate())
                    {
                        if (p != null)
                        {
                            res = _manager.PositionGetByTicket(ticket, p);
                            if (res == MTRetCode.MT_RET_OK)
                            {
                                FillSnapshot(ref snap, p);
                                fromPump = true;
                                return true;
                            }
                        }
                    }
                }

                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    res = _manager.PositionRequestByTickets(new ulong[] { ticket }, arr);
                    if (res != MTRetCode.MT_RET_OK)
                        return false;

                    CIMTPosition p = arr.Total() > 0 ? arr.Next(0) : null;
                    if (p == null)
                    {
                        res = MTRetCode.MT_RET_ERR_NOTFOUND;
                        return false;
                    }

                    FillSnapshot(ref snap, p);
                    return true;
                }
            }
        }

        private static void FillSnapshot(ref PositionSnapshot snap, CIMTPosition p)
        {
            snap.Login = p.Login();
            snap.Symbol = p.Symbol();
            snap.IsBuy = p.Action() == (uint)CIMTPosition.EnPositionAction.POSITION_BUY;
            snap.Volume = SMTMath.VolumeToDouble(p.Volume());
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
        /// 时间参数与返回的 deal.time 都在**服务器墙钟**参照系里(本券商 UTC+3),
        /// 与 Bridge 那边 MetaTrader5 Python 包的陷阱是同一个。网关不换算:后端按
        /// "本平台开仓腿的服务器时间 − orders.created_at"观测偏移并在落库前减掉
        /// (routers/gateway.observe_server_offset),查询窗口的 from 也按偏移前移。
        /// 此处原先写着"Manager API 走 int64 秒,不存在那个参照系陷阱"——错的,
        /// 2026-09-05 已被一笔漂进别场比赛的平仓证伪。
        /// Both the arguments and the returned deal.time live in the **server wall
        /// clock** frame (UTC+3 for this broker) — the same trap as the bridge's
        /// MetaTrader5 package. The gateway does not convert; the backend observes
        /// the offset and subtracts it before persisting. The earlier note claiming
        /// the Manager API was immune was wrong (disproved 2026-09-05).
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
                            Comment = d.Comment(),
                            Reason = (uint)d.Reason(),
                            PriceSL = d.PriceSL(),
                            PriceTP = d.PriceTP()
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
                TimedString groupHit;
                if (_groupCache.TryGetValue(login, out groupHit) && Fresh(groupHit))
                {
                    group = groupHit.Value;
                }
                else
                {
                    // 本地 pump 库优先,见 ReadUserGroup。正常开仓路径走不到这里:
                    // HandleOpen 前一步的 CheckAccountGroup 已经把组填进缓存了。
                    // Pump first (see ReadUserGroup). The normal open path rarely gets
                    // here: CheckAccountGroup one step earlier already filled the cache.
                    MTRetCode r = ReadUserGroup(login, out group);
                    if (r != MTRetCode.MT_RET_OK)
                        return baseSymbol;
                    _groupCache[login] = new TimedString { Value = group, AtTickCount = Environment.TickCount };
                }

                string cacheKey = group.ToUpperInvariant() + "|" + baseSymbol.ToUpperInvariant();

                TimedString cached;
                if (_symbolCache.TryGetValue(cacheKey, out cached) && Fresh(cached))
                    return cached.Value;

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
                            _symbolCache[cacheKey] = new TimedString { Value = alias, AtTickCount = Environment.TickCount };
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

                        _symbolCache[cacheKey] = new TimedString { Value = resolved, AtTickCount = Environment.TickCount };
                        return resolved;
                    }
                }

                // No match — return as-is, let caller handle the error
                _symbolCache[cacheKey] = new TimedString { Value = baseSymbol, AtTickCount = Environment.TickCount };
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

        // 等首个 tick 的节奏。以前是固定睡 700 毫秒再看一次:tick 通常几十毫秒就到,
        // 那 700 毫秒里绝大部分是白等;偶尔慢过 700 毫秒的又直接判失败。现在每 20 毫秒
        // 看一次,到了就走;刚选中的品种最多等 1.5 秒,早已选中却没报价的(停市、无
        // 行情)不值得等那么久,最多 300 毫秒。
        // First-tick wait pacing. The old fixed 700ms sleep was mostly dead time (the
        // tick usually lands within tens of ms) and still failed the occasional slower
        // one. Poll every 20ms instead: up to 1.5s for a freshly selected symbol, only
        // 300ms for one selected long ago that simply has no quote (closed market).
        private const int TickPollStepMs = 20;
        private const int FirstTickWaitMs = 1500;
        private const int StaleTickWaitMs = 300;

        /// <summary>
        /// 取当前买卖价。
        ///
        /// 注意:品种在配置表里存在,并不等于有报价。Manager 只会收到"已选中"
        /// (Selected)品种的行情推送。所以这里先把品种加进选中列表,再取价;
        /// 首个 tick 还没推到就短间隔轮询等它,见上面的常量。
        /// </summary>
        public bool GetQuote(string symbol, out double bid, out double ask, out MTRetCode res)
        {
            bid = 0;
            ask = 0;
            res = MTRetCode.MT_RET_ERR_NOTFOUND;

            bool justSelected = false;
            int deadline = 0;

            for (int attempt = 0; ; attempt++)
            {
                lock (_gate)
                {
                    if (attempt == 0 && _selected.Add(symbol))
                    {
                        _manager.SelectedAdd(symbol);
                        _everSelected.Add(symbol);
                        justSelected = true;
                    }

                    MTTickShort tick;
                    res = _manager.TickLast(symbol, out tick);

                    if (res == MTRetCode.MT_RET_OK && (tick.bid > 0 || tick.ask > 0))
                    {
                        bid = tick.bid;
                        ask = tick.ask;
                        return true;
                    }
                }

                if (attempt == 0)
                    deadline = unchecked(Environment.TickCount +
                        (justSelected ? FirstTickWaitMs : StaleTickWaitMs));

                if (unchecked(deadline - Environment.TickCount) <= 0)
                    return false;

                Thread.Sleep(TickPollStepMs);
            }
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
            Stopwatch sw = Stopwatch.StartNew();
            TradeResult r = OpenPositionCore(login, symbol, isBuy, lots, stopLoss, takeProfit, tag);
            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        private TradeResult OpenPositionCore(ulong login, string symbol, bool isBuy, double lots,
            double stopLoss, double takeProfit, string tag)
        {
            // 自动补后缀:不同组需要不同后缀品种(如 EURUSD.s)
            symbol = ResolveSymbol(login, symbol);

            // 手数校验必须在补完后缀之后做,否则查不到品种、校验白写(详见
            // ValidateVolumeForSymbol 的注释)。非法手数不会被服务器当场拒绝,
            // 而是变成一张永不成交的订单,后患远大于一次明确的报错。
            string volErr = ValidateVolumeForSymbol(symbol, lots, "开仓");

            if (volErr != null)
            {
                Log.Warn("开仓手数不合法,已拦下:login={0} {1} lots={2} -> {3}",
                    login, symbol, lots, volErr);
                return TradeResult.Fail(
                    MTRetCode.MT_RET_REQUEST_INVALID_VOLUME.ToString(), volErr);
            }

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

            // 回执没有仓位号。成交订阅通常在 dealer 回执之前或同时就把这笔成交推过来了,
            // 里面既有仓位号,也有成交时刻仓位上的 SL/TP——先用它,下面两次服务器往返
            // (反查仓位号、核对 SL/TP)在正常路径上就都省掉了。订阅没建立、或事件迟迟
            // 不到,才退回原来的 DealRequestByTickets 反查。
            // 查不到也只是退化成旧行为(0),不影响这笔已成交的仓位。
            //
            // The confirmation carries no position id. The deal subscription usually
            // delivers this fill before or alongside the dealer answer, with both the
            // position id and the position's SL/TP at fill time — use that and skip
            // both post-fill server round trips on the happy path. Fall back to the
            // DealRequestByTickets lookup when the subscription is down or the event
            // is late. A miss just degrades to 0 and never affects the filled position.
            FillInfo fill = null;

            if (r.Ok)
            {
                Stopwatch fw = Stopwatch.StartNew();
                fill = WaitRecentFill(r.Deal, r.Order);

                if (fill != null)
                {
                    r.Position = fill.Position;
                    Log.Info("成交事件 {0}ms 内到达,仓位号与 SL/TP 就地取得,免两次反查:deal={1} position={2}",
                        fw.ElapsedMilliseconds, fill.Deal, fill.Position);
                }
                else
                {
                    if (r.Deal != 0)
                        r.Position = GetDealPosition(r.Deal);

                    Log.Info("成交事件 {0}ms 内未到(订阅{1}),退回服务器反查仓位号:deal={2} order={3}",
                        fw.ElapsedMilliseconds, _dealSubscribed ? "在" : "不在", r.Deal, r.Order);
                }

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
            // 实测服务器会正确接受开仓请求里的 SL/TP,所以正常路径下这里应该什么都
            // 不用发。成交事件在手时,直接比成交记录里的 SL/TP,零往返;成交记录说没
            // 落上(或压根没拿到成交记录),再向服务器核对一次仓位——成交记录里这两个
            // 字段在这家券商上是否总是填的没有实测过,不能只凭它就多发一个 dealer 请求。
            // 留着整段是因为静默丢失止损的后果是仓位裸奔——宁可多查一次。
            //
            // Safety net: verify the levels actually landed and only repair when they
            // did not. With the fill event in hand this is a local comparison (zero
            // round trips); when the event says the levels are missing, or there is
            // no event, confirm against the server once before spending a dealer
            // request on a repair — whether this broker always fills the deal's SL/TP
            // fields has not been verified. The block stays because a silently
            // dropped stop-loss leaves the position unprotected.
            if (r.Ok && (stopLoss > 0 || takeProfit > 0))
            {
                // 改单要的是仓位号;订阅拿到了就用真仓位号(净额账号里它可能不等于
                // 订单号),否则沿用旧的订单号/成交号假设。
                // Modify wants the position id; prefer the real one from the fill
                // (on netting accounts it can differ from the order ticket).
                ulong ticket = r.Position != 0 ? r.Position : (r.Order != 0 ? r.Order : r.Deal);

                bool levelsOk = fill != null
                    && LevelsMatch(fill.PriceSL, fill.PriceTP, stopLoss, takeProfit,
                        LevelTolerance(fill.Digits, stopLoss > 0 ? stopLoss : takeProfit));

                if (!levelsOk && ticket != 0)
                    levelsOk = PositionHasLevels(ticket, stopLoss, takeProfit);

                if (ticket != 0 && !levelsOk)
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
        /// <summary>
        /// 按品种的手数限制校验手数(最小、最大、步长)。返回 null 表示通过。
        ///
        /// symbol 必须是**已补后缀的真实品种名**。这一点踩过坑:原先开仓的校验写在
        /// HttpServer.HandleOpen 里,拿的是请求里的基础名(XAUUSD),而券商真实品种是
        /// XAUUSD.s,SymbolGet 查不到就直接跳过校验——那段校验对本券商从来没生效过。
        /// 现在两条路径都在补完后缀之后才校验:开仓在 ResolveSymbol 之后,平仓用仓位
        /// 快照里的品种名(本来就是真实名)。
        ///
        /// Validates a volume against the symbol's min/max/step. `symbol` must be the
        /// resolved broker name: the old check lived in HandleOpen and used the base
        /// name (XAUUSD) while the real symbol is XAUUSD.s, so SymbolGet missed and the
        /// check silently did nothing. Both paths now validate after resolution.
        /// </summary>
        private string ValidateVolumeForSymbol(string symbol, double lots, string what)
        {
            double volMin, volMax, volStep;
            MTRetCode sres;

            if (!GetSymbolLimits(symbol, out volMin, out volMax, out volStep, out sres))
            {
                Log.Warn("读不到 {0} 的手数限制({1}),跳过{2}手数校验", symbol, sres, what);
                return null;
            }

            if (volMin > 0 && lots < volMin - VolumeEpsilon)
                return string.Format("{0}手数 {1} 低于 {2} 的最小手数 {3}",
                    what, lots, symbol, volMin);

            if (volMax > 0 && lots > volMax + VolumeEpsilon)
                return string.Format("{0}手数 {1} 超过 {2} 的最大手数 {3}",
                    what, lots, symbol, volMax);

            if (!IsMultipleOf(lots, volStep))
                return string.Format("{0}手数 {1} 不是 {2} 手数步长 {3} 的整数倍",
                    what, lots, symbol, volStep);

            return null;
        }

        /// <summary>
        /// 平仓手数是否合法。返回 null 表示通过,否则返回给用户看的原因。
        ///
        /// 全平(lots<=0)不校验:仓位自身的手数必然是合法的。部分平仓才需要,
        /// 而且要卡三件事——不超过仓位手数、不低于品种最小手数、是手数步长的
        /// 整数倍,外加平完之后的**剩余**手数也得能独立成立。
        ///
        /// 为什么非卡不可:非法手数不会被服务器当场拒绝,而是被接受成一张永远
        /// 不会成交的订单(答复 MT_RET_REQUEST_PLACED),然后挂在仓位上,让这张
        /// 仓位再也平不掉。2026-09-17 就是这么爆的——0.015 手,黄金步长 0.01。
        /// 拿不到品种限制时不拦,维持旧行为交给服务器裁决。
        ///
        /// Validates a partial-close volume. A full close is exempt: the position's
        /// own volume is valid by definition. An out-of-step volume is not rejected
        /// outright by the server — it is accepted as an order that can never fill
        /// (answered PLACED) and then blocks every further close on that position.
        /// </summary>
        private string ValidateCloseVolume(PositionSnapshot pos, double lots)
        {
            if (lots <= 0)
                return null;

            if (lots > pos.Volume + VolumeEpsilon)
                return string.Format("平仓手数 {0} 超过仓位手数 {1}", lots, pos.Volume);

            string err = ValidateVolumeForSymbol(pos.Symbol, lots, "平仓");
            if (err != null)
                return err;

            double volMin, volMax, volStep;
            MTRetCode sres;

            if (!GetSymbolLimits(pos.Symbol, out volMin, out volMax, out volStep, out sres))
                return null;

            // 剩余手数同样要能独立成立,否则服务器一样不会执行这笔部分平仓。
            double rest = pos.Volume - lots;

            if (rest > VolumeEpsilon && volMin > 0 && rest < volMin - VolumeEpsilon)
                return string.Format("平掉 {0} 手后仅剩 {1} 手,低于 {2} 的最小手数 {3},请改为全平",
                    lots, rest, pos.Symbol, volMin);

            return null;
        }

        /// <summary>手数比较用的容差。MT5 手数以 1/10000 手为整数单位,1e-9 远小于它。</summary>
        private const double VolumeEpsilon = 1e-9;

        /// <summary>确认平仓时两次重读仓位之间的间隔,见 ConfirmClose。</summary>
        private const int ConfirmRecheckDelayMs = 250;

        /// <summary>
        /// value 是否为 step 的整数倍。step<=0(拿不到步长)时一律通过。
        /// 浮点直接取模不可靠:0.03/0.01 在二进制里是 2.9999999999999996。
        /// Whether value is a whole multiple of step; a plain modulo is unreliable
        /// because 0.03/0.01 evaluates to 2.9999999999999996 in binary floating point.
        /// </summary>
        private static bool IsMultipleOf(double value, double step)
        {
            if (step <= 0)
                return true;

            double n = Math.Round(value / step);
            return Math.Abs(value - n * step) <= step * 1e-6 + VolumeEpsilon;
        }

        /// <summary>
        /// 确认一笔答复为 PLACED 的平仓是否真的成交了,没成交就把结果改成失败。
        ///
        /// 两级确认,都不成立才判定没成交:
        ///   1. 成交订阅——平仓成交与开仓成交同源,按成交号/订单号就地认领,正常
        ///      路径 150~200ms 内到,不必往服务器跑。
        ///   2. 向服务器重读仓位——订阅没建立或事件晚到时的权威依据。仓位没了
        ///      =全平成交;手数变小=部分成交;手数一点没动=这张订单没执行。
        ///
        /// 重读失败(网络/权限)时不改判:宁可维持旧的"当成交"行为,也不要把一笔
        /// 真成交报成失败——那会诱导用户重复平仓。
        ///
        /// Confirms a PLACED close actually executed, downgrading the result if not.
        /// Deal subscription first, then an authoritative re-read of the position. A
        /// failed re-read leaves the result alone: reporting a real fill as a failure
        /// would invite a duplicate close, which is the worse error.
        /// </summary>
        private void ConfirmClose(ulong ticket, double volumeBefore, ref TradeResult r)
        {
            FillInfo fill = WaitRecentFill(r.Deal, r.Order);

            if (fill != null)
            {
                Log.Info("平仓成交事件已到,确认成交:ticket={0} deal={1}", ticket, fill.Deal);
                return;
            }

            // 向服务器重读仓位。读到「手数没变」不能立刻定罪:成交订阅整个断开时
            // WaitRecentFill 是立即返回的,这一读会紧贴着 dealer 回执发出,完全可能
            // 读到还没更新的仓位。所以复核一次,两次都说没变才判定没成交。
            // Re-read from the server. "Unchanged" on the first read is not proof: with
            // the subscription down WaitRecentFill returns instantly, so this read can
            // race the server's own update. Only a second, later read settles it.
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (attempt > 0)
                    System.Threading.Thread.Sleep(ConfirmRecheckDelayMs);

                PositionSnapshot after;
                bool ignored;
                MTRetCode res;

                if (!ReadPosition(ticket, true, out after, out ignored, out res))
                {
                    if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                    {
                        Log.Info("仓位 #{0} 已不存在,确认全平成交", ticket);
                        return;
                    }

                    Log.Warn("平仓后重读仓位 #{0} 失败({1}),无法确认是否成交,按成交处理", ticket, res);
                    return;
                }

                if (after.Volume < volumeBefore - VolumeEpsilon)
                {
                    Log.Info("仓位 #{0} 手数 {1} -> {2},确认成交", ticket, volumeBefore, after.Volume);
                    return;
                }
            }

            // 两次重读手数都纹丝不动:订单建立了,但这笔平仓没有成交。
            Log.Warn("平仓请求被接受但未成交:ticket={0} order={1} 仓位手数仍是 {2},"
                     + "该订单可能挂在券商队列里并挡住后续平仓",
                     ticket, r.Order, volumeBefore);

            r.Ok = false;
            r.Retcode = PlacedUnconfirmed;
            r.Message = "平仓请求已被服务器接受,但未在确认时限内成交,仓位手数没有变化。"
                      + "这张订单可能仍挂在券商的交易队列里,并会挡住对同一仓位的后续平仓。"
                      + "请不要重复提交,稍后核对持仓,必要时联系券商。";
        }

        /// <summary>
        /// 「服务器收下了但没成交」的返回码。不是 MT5 的原生码,是网关自己的判定,
        /// 后端据此把订单落成 FAILED 而不是 REJECTED——它既不是成交也不是拒绝。
        /// Gateway-issued retcode (not an MT5 one) for "accepted but never executed",
        /// which the backend records as FAILED rather than REJECTED: it is neither.
        /// </summary>
        public const string PlacedUnconfirmed = "MT_RET_REQUEST_PLACED_UNCONFIRMED";

        public TradeResult ClosePosition(ulong login, ulong ticket, double lots, string tag)
        {
            Stopwatch sw = Stopwatch.StartNew();

            PositionSnapshot pos;
            bool fromPump;
            MTRetCode pres;

            // 仓位先从本地 pump 库读(内存),不再每次都向服务器要一次——这是平仓路径
            // 上除 dealer 回执之外唯一的一次网络往返。
            // Read the position from the local pump first; this was the only network
            // round trip on the close path besides the dealer answer itself.
            if (!ReadPosition(ticket, false, out pos, out fromPump, out pres))
                return TradeResult.Fail(pres.ToString(), "找不到仓位 #" + ticket);

            if (pos.Login != login)
                return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                    "仓位 #" + ticket + " 不属于账号 " + login);

            // 手数先过一遍本地校验。非法手数发出去不会被当场拒绝,而是变成一张
            // 挂在仓位上、永远不会成交的订单,把这张仓位彻底锁死(见 ValidateCloseVolume)。
            string volErr = ValidateCloseVolume(pos, lots);

            if (volErr != null)
            {
                Log.Warn("平仓手数不合法,已拦下:login={0} ticket={1} lots={2} -> {3}",
                    login, ticket, lots, volErr);

                TradeResult bad = TradeResult.Fail(
                    MTRetCode.MT_RET_REQUEST_INVALID_VOLUME.ToString(), volErr);
                bad.ElapsedMs = sw.ElapsedMilliseconds;
                return bad;
            }

            // 确认成交时要拿"发请求之前"的仓位手数做对照。下面手数过期重发那条
            // 分支会换用服务器读回来的手数,所以这里是个变量而不是常量。
            double volumeBefore = pos.Volume;

            TradeResult r = SendClose(login, ticket, pos, lots, tag);

            // 本地快照的手数可能过期:部分平仓之后,服务器若不推 UPDATE,本地还是旧手数,
            // 全平就会带着偏大的手数被拒。手数类拒绝 + 快照来自本地 → 向服务器重读一次,
            // 手数确实不同才重发。被拒的请求没有成交,重发不会平两次;仍是同一笔 HTTP
            // 请求,幂等键也不变。
            // The pump volume can be stale: after a partial close, if the server does
            // not push UPDATE, a full close goes out with the old, larger volume and is
            // rejected. On a volume rejection of a pump-sourced snapshot, re-read from
            // the server and re-send once if the volume actually differs. A rejected
            // request executed nothing, so re-sending cannot close twice.
            if (!r.Ok && fromPump && IsVolumeRejection(r.Retcode))
            {
                PositionSnapshot fresh;
                bool ignored;
                MTRetCode fres;

                if (ReadPosition(ticket, true, out fresh, out ignored, out fres)
                    && fresh.Login == login
                    && Math.Abs(fresh.Volume - pos.Volume) > 1e-9)
                {
                    Log.Warn("本地仓位快照手数过期(本地 {0} / 服务器 {1}),按服务器数据重发平仓:login={2} ticket={3}",
                        pos.Volume, fresh.Volume, login, ticket);

                    volumeBefore = fresh.Volume;
                    r = SendClose(login, ticket, fresh, lots, tag);
                }
            }

            // dealer 答 PLACED 只说明订单已建立,不等于成交。必须确认,否则一笔
            // 从未执行的平仓会被当成成功回给用户,而它还会挡住后续所有平仓。
            // A PLACED answer is not a fill; confirm it, or an unexecuted close is
            // reported as success while it blocks every further close.
            if (r.Ok && r.Placed)
                ConfirmClose(ticket, volumeBefore, ref r);

            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        private TradeResult SendClose(ulong login, ulong ticket, PositionSnapshot pos, double lots, string tag)
        {
            string symbol = pos.Symbol;
            bool posIsBuy = pos.IsBuy;
            double closeVolume = (lots > 0 && lots < pos.Volume) ? lots : pos.Volume;

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
        /// 手数类拒绝:INVALID_VOLUME(10014)与 INVALID_CLOSE_VOLUME(10038)。只有这两个
        /// 值得按服务器手数重发;其它拒绝原因换了手数也一样过不去。
        /// Volume rejections worth a re-send with the server's volume; other reasons
        /// would fail again regardless.
        /// </summary>
        private static bool IsVolumeRejection(string retcode)
        {
            return retcode == MTRetCode.MT_RET_REQUEST_INVALID_VOLUME.ToString()
                || retcode == MTRetCode.MT_RET_REQUEST_INVALID_CLOSE_VOLUME.ToString();
        }

        // 成交事件通常与 dealer 回执几乎同时到,这个上限只防订阅静默失效时白等。
        // 等不到就退回服务器反查,行为与改造前一致,只是多花了这点时间。
        // The fill event normally lands alongside the dealer answer; this cap only
        // bounds the wait when the subscription has silently died. On expiry the
        // caller falls back to the server lookup, as before.
        private const int FillEventWaitMs = 300;

        private FillInfo WaitRecentFill(ulong deal, ulong order)
        {
            DealSink sink = _dealSink;
            if (sink == null || !_dealSubscribed)
                return null;

            return sink.WaitFill(deal, order, FillEventWaitMs);
        }

        /// <summary>
        /// SL/TP 的比对容差:品种最小报价单位的 50 倍。券商可能因最小止损距离微调
        /// 价位,那不算丢失。digits 拿不到(0)时退回一个宽松的相对值。
        /// Tolerance for SL/TP comparison: 50 points of the symbol; brokers may nudge
        /// a level to satisfy the minimum stop distance, which is not a loss. Falls
        /// back to a loose relative value when digits are unknown.
        /// </summary>
        private static double LevelTolerance(uint digits, double reference)
        {
            if (digits > 0 && digits < 15)
                return Math.Pow(10, -(int)digits) * 50;

            return Math.Max(Math.Abs(reference), 1.0) * 0.001;
        }

        /// <summary>只比较 stopLoss/takeProfit 中非 0 的那一侧。</summary>
        private static bool LevelsMatch(double actualSl, double actualTp,
            double stopLoss, double takeProfit, double tolerance)
        {
            if (stopLoss > 0 && Math.Abs(actualSl - stopLoss) > tolerance)
                return false;

            if (takeProfit > 0 && Math.Abs(actualTp - takeProfit) > tolerance)
                return false;

            return true;
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

                        // 容差按品种精度推算:digits 拿不到时退回一个宽松的相对值
                        uint digits = 0;
                        using (CIMTConSymbol sym = _manager.SymbolCreate())
                        {
                            if (_manager.SymbolGet(p.Symbol(), sym) == MTRetCode.MT_RET_OK)
                                digits = sym.Digits();
                        }

                        return LevelsMatch(p.PriceSL(), p.PriceTP(), stopLoss, takeProfit,
                            LevelTolerance(digits, stopLoss > 0 ? stopLoss : takeProfit));
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
            Stopwatch sw = Stopwatch.StartNew();

            // 改单只要品种名和归属校验,本地 pump 快照足够——品种不会变,登录号不会变,
            // 手数过期与否在这里无关紧要。
            // Modify only needs the symbol and the ownership check; the pump snapshot
            // is enough since neither symbol nor login ever changes, and a stale volume
            // is irrelevant here.
            PositionSnapshot pos;
            bool fromPump;
            MTRetCode pres;

            if (!ReadPosition(ticket, false, out pos, out fromPump, out pres))
                return TradeResult.Fail(pres.ToString(), "找不到仓位 #" + ticket);

            if (pos.Login != login)
                return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                    "仓位 #" + ticket + " 不属于账号 " + login);

            string symbol = pos.Symbol;

            TradeResult r = SendDealerRequest(req =>
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

            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
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
                Stopwatch dsw = Stopwatch.StartNew();
                res = sink.Wait(_cfg.DealerTimeoutMs);
                long dealerMs = dsw.ElapsedMilliseconds;

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
                            Message = result.ResultComment() ?? "",
                            DealerMs = dealerMs,
                            // PLACED 要调用方再确认一次,见 TradeResult.Placed。
                            Placed = res == MTRetCode.MT_RET_REQUEST_PLACED
                        };
                    }
                }

                string comment;
                lock (_gate)
                {
                    comment = result.ResultComment() ?? "";
                }

                TradeResult failed = TradeResult.Fail(res.ToString(),
                    comment.Length > 0 ? comment : DescribeTradeError(res));
                failed.DealerMs = dealerMs;
                return failed;
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
