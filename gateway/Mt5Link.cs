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
using System.Globalization;
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

        /// <summary>
        /// 弃用这个 sink:之后到达的回调一律不再碰 _result。
        ///
        /// 为什么必须有:超时路径上调用方会 DealerUnsubscribe 然后 Dispose 掉 _result,
        /// 而 DealerUnsubscribe **不保证**等待已经进入回调的那一次调用返回——超时那
        /// 一刻恰恰是"回执正在路上"的典型场景。托管对象被 Dispose 之后原生层再回调
        /// 写进来,就是进程级 AccessViolation:catch 不住,直接杀进程,所有在途下单
        /// 一起中断。
        ///
        /// 这个方法本身要拿 _lock,所以它会**等待**正在执行的那次回调做完再返回;
        /// 返回之后再 Dispose 就是安全的。
        /// Abandon this sink so later callbacks never touch _result. DealerUnsubscribe
        /// does not wait for an in-flight callback, and a native callback writing into
        /// a disposed managed object is an uncatchable AccessViolation. Taking _lock
        /// here waits for any callback already running, making a later Dispose safe.
        /// </summary>
        public void Abandon()
        {
            lock (_lock)
            {
                _abandoned = true;
            }
        }

        /// <summary>
        /// 释放等待用的事件句柄。每笔交易 new 一个 DealerSink,而每笔都会 Wait(最长 60 秒)
        /// ——ManualResetEventSlim 一旦真正阻塞就会升级成内核事件;以前 finally 里把
        /// request / result 都 Dispose 了,独独漏了这个,于是交易路径上每笔漏一个句柄,
        /// 靠 GC 终结器慢慢回收。
        /// 必须在 Abandon() 之后调用:Abandon 会等正在执行的回调结束,此后回调只走
        /// 「_abandoned 分支」,而那个分支在 _waitReleased 为真时不再碰 _done。
        /// Release the wait handle. One DealerSink per trade, and every trade Waits (up to
        /// 60s), so the ManualResetEventSlim escalates to a kernel event; finally disposed
        /// request/result but never this, leaking one handle per trade to the finalizer.
        /// Call after Abandon(): from then on callbacks take the abandoned branch, which
        /// no longer touches _done once _waitReleased is set.
        /// </summary>
        public void ReleaseWait()
        {
            lock (_lock)
            {
                _waitReleased = true;
                _done.Dispose();
            }
        }

        private bool _abandoned;
        private bool _waitReleased;
        private bool _answered;
        private bool _linkDropped;

        /// <summary>连接断了、回执不会再来:叫醒等待方。回执已经到了的不受影响。
        /// The link died and no answer will come: wake the waiter. An answer that
        /// already arrived wins.</summary>
        public void CancelLinkDropped()
        {
            lock (_lock)
            {
                if (_answered || _abandoned || _waitReleased)
                    return;

                _linkDropped = true;
                _done.Set();
            }
        }

        /// <summary>等待是被断线叫醒的,而不是等到了回执。/ Woken by a drop, not an answer.</summary>
        public bool LinkDropped
        {
            get { lock (_lock) { return _linkDropped && !_answered; } }
        }

        public override void OnDealerAnswer(CIMTRequest request)
        {
            // _done.Set() 一律在锁内做:原来正常路径的 Set 在锁外,与 ReleaseWait 的
            // Dispose 之间有一个窗口——回调释放锁之后、Set 之前,超时路径恰好跑完
            // Abandon 与 ReleaseWait,这个 Set 就打在已释放的句柄上,而它在原生回调
            // 线程里,抛出来就是进程级崩溃。
            // Set() always under the lock: the old normal path Set outside it, leaving a
            // window between releasing the lock and Set where the timeout path could run
            // Abandon + ReleaseWait, so Set hit a disposed handle — on a native callback
            // thread, where an exception takes the process down.
            lock (_lock)
            {
                // 调用方已经放弃等待并即将/已经释放 _result:什么都不能碰。
                // The caller gave up and is about to dispose _result: touch nothing.
                if (_abandoned)
                {
                    if (!_waitReleased)
                        _done.Set();
                    return;
                }

                // 已经按断线叫醒过等待方,这份迟到的回执没人读了。
                // The waiter was already woken by a drop; nobody reads a late answer.
                if (_linkDropped)
                    return;

                _answered = true;

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

                _done.Set();
            }
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
                if (_linkDropped && !_answered)
                    return MTRetCode.MT_RET_REQUEST_TIMEOUT;

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

        // 这几个回调都是原生层调进来的:异常若从这里漏回原生代码,整个进程直接退出,
        // 所有在途交易一起中断。所以每个回调都整段包住,最多丢一条日志。
        // Called from native code: an exception escaping here ends the process and every
        // in-flight trade with it, so each callback is wrapped whole.
        public override void OnConnect()
        {
            try
            {
                Log.Info("MT5 连接已建立");
                _link.MarkConnected(true);
            }
            catch { }
        }

        public override void OnDisconnect()
        {
            try
            {
                Log.Warn("MT5 连接断开,将自动重连");
                _link.MarkConnected(false);
            }
            catch { }
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

        // 原生层回调:整段包住,异常绝不能漏回原生代码(见 ManagerSink)。
        // Native callbacks: wrapped whole, nothing may escape into native code.
        public override void OnPositionAdd(CIMTPosition p)
        {
            try
            {
                if (p == null) return;
                Enqueue(p.Login(), p.Position(), "add");
            }
            catch { }
        }

        public override void OnPositionDelete(CIMTPosition p)
        {
            try
            {
                if (p == null) return;
                Enqueue(p.Login(), p.Position(), "delete");
            }
            catch { }
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

    /// <summary>
    /// 挂单订阅回调:只**数** ADD/UPDATE/DELETE,不入队、不改任何行为。用途是验证券商是否推
    /// 挂单 UPDATE、本地 pump 库里的挂单能否代替 /orders 的服务器查询(见 Mt5Link.CompareLocalOrders),
    /// 计数经 /health 暴露。与 PositionSink 同样:回调整段包住,异常不能漏回原生层。
    /// Counts ADD/UPDATE/DELETE only; queues nothing and changes no behaviour. It exists to
    /// find out whether the broker pushes pending-order UPDATE and whether the local pump
    /// could stand in for the /orders server query. Counters go to /health.
    /// </summary>
    internal sealed class OrderSink : CIMTOrderSink
    {
        private int _add;
        private int _update;
        private int _delete;

        public override void OnOrderAdd(CIMTOrder o)
        {
            try { System.Threading.Interlocked.Increment(ref _add); }
            catch { }
        }

        public override void OnOrderUpdate(CIMTOrder o)
        {
            try { System.Threading.Interlocked.Increment(ref _update); }
            catch { }
        }

        public override void OnOrderDelete(CIMTOrder o)
        {
            try { System.Threading.Interlocked.Increment(ref _delete); }
            catch { }
        }

        public int AddCount { get { return _add; } }
        public int UpdateCount { get { return _update; } }
        public int DeleteCount { get { return _delete; } }
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
        // 这是整台服务器所有账号的成交,不只是我们的。512 在几百笔同时在途、别的账号
        // 也在成交时可能被挤掉,等的那一方只好退回服务器反查(慢、还要进 _gate)。
        // Every account's deals on the server, not just ours; 512 could evict a fill
        // before its waiter looked once hundreds of trades are in flight.
        private const int MaxFills = 4096;

        public override void OnDealAdd(CIMTDeal d)
        {
            // 原生层回调:整段包住(见 ManagerSink)。/ native callback, wrapped whole
            try
            {
                if (d == null) return;
                Enqueue(d.Login(), d.Deal(), d.PositionID());
                RememberFill(d);
            }
            catch { }
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
        // 重连时 ConnectOnce 在 _gate 里最长攥这么久。没有缩短:带 pump 的首次同步在
        // 券商慢时本来就要十几秒,缩了会把"慢但能连上"变成"永远连不上"。交易入口改成
        // 连接不在就立刻回 LinkDownResult,不再排这把锁,这 30 秒也就不再卡下单。
        // How long ConnectOnce may hold _gate while reconnecting. Not shortened: the
        // initial pump sync can take over ten seconds on a slow broker. Trade entries now
        // return LinkDownResult at once while disconnected instead of queueing on _gate.
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

        // 挂单订阅(只计数,验证用)。/ Pending-order subscription (counting only, for validation).
        private OrderSink _ordSink;
        private volatile bool _ordSubscribed;
        private int _ordSubscribedAt;

        private volatile bool _connected;
        private volatile bool _stopping;
        private Thread _watchdog;
        private Thread _selfHeal;

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
            public bool Missing;   // 仅品种缓存用:本组没有这个品种 / symbol cache only: not in the group
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
            // 该品种允许的成交模式位掩码(CIMTConSymbol.EnFillingFlags:FOK=1 / IOC=2 / BOC=4)。
            // 与手数限制同一次 SymbolGet 读出来,不额外多一次往返。
            // Allowed filling modes; read in the same SymbolGet as the volume limits.
            public uint FillFlags;
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
            if (!value)
            {
                // 断开时服务器侧的订阅就已经清空了。以前这里只翻 _connected,而
                // watchdog 只在 `!_connected` 的分支里重建订阅——SDK 自己完成一次
                // 断-连(OnDisconnect 紧跟 OnConnect)时,watchdog 那一秒看到的已经是
                // _connected==true,于是 _posSubscribed/_dealSubscribed 仍是 true 而
                // 服务器那边早就没有订阅了:事件永久不再到达,/health 还显示订阅"在"。
                // 在这里就把标志放倒,并请 watchdog 在"连着"的分支里补订阅。
                // The server clears our subscriptions on disconnect. This used to only
                // flip _connected, while resubscription lived in the watchdog's
                // "not connected" branch — so an SDK-internal reconnect (OnDisconnect
                // immediately followed by OnConnect) left both flags true with no
                // server-side subscription: events stop forever and /health still says
                // they are up. Lower the flags here and ask for a rebuild.
                _posSubscribed = false;
                _dealSubscribed = false;
                _ordSubscribed = false;
                _needResubscribe = true;

                // dealer 通道也随连接一起没了。以前这个标志断线后仍是 true,SDK 自己重连
                // 回来时没人重开 dealer,下单全部白等 60 秒超时,/health 还显示 dealer 正常。
                // The dealer channel dies with the connection. This used to stay true, so
                // after an SDK self-reconnect nobody restarted it and every order sat out
                // the 60s timeout while /health still said dealerActive.
                _dealerActive = false;

                // 正在等回执的请求一个也等不到了(旧会话上的回执不会再来)。立刻叫醒它们,
                // 按"结果未知"回给后端,而不是每笔都干等满 60 秒。
                // Requests waiting for an answer will never get one on the dead session.
                // Wake them now as "outcome unknown" instead of each waiting 60s.
                foreach (DealerSink s in _liveSinks.Keys)
                    s.CancelLinkDropped();
            }

            _connected = value;
        }

        /// <summary>连接翻转过,订阅需要重建。由 watchdog 在"已连接"分支里消费。
        /// Set on any disconnect; consumed by the watchdog's connected branch.</summary>
        private volatile bool _needResubscribe;

        /// <summary>正在等回执的 dealer 请求。断线时逐个叫醒。
        /// Dealer requests awaiting an answer; woken on disconnect.</summary>
        private readonly System.Collections.Concurrent.ConcurrentDictionary<DealerSink, byte> _liveSinks =
            new System.Collections.Concurrent.ConcurrentDictionary<DealerSink, byte>();

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
            SubscribeOrders();

            // 配置里点名的品种在启动时就选上,进程起来后的第一笔单不等首个 tick。
            // Pre-select the configured symbols so the very first order after start
            // does not wait for a first tick.
            PreselectSymbols(_cfg.PreselectSymbols, "启动");

            // 查询通道:连不上不影响启动,查询自动走交易连接。
            // Query channels: a failure never blocks startup; queries fall back to the
            // trading link.
            //
            // 连接与重连放在自己的线程里,不再占 watchdog,也不再拖慢启动:每条通道连接
            // 最长等 15 秒,券商慢或连不上时两条就是 30 秒——以前这段时间 watchdog 整个
            // 停着(交易连接的半开探测、重连、dealer 重试都跟着推迟),启动时则是 HTTP 迟迟
            // 不开始监听,后端把全部网关用户判离线。
            // Connects and reconnects run on their own thread, off the watchdog and off
            // the startup path: each channel may wait 15s to connect, so a slow broker
            // used to stall the watchdog (half-open probe, reconnect, dealer retry) or
            // delay the HTTP listener at startup by up to 30s.
            if (_cfg.ReadChannels > 0)
            {
                _reads = new ReadPool(_cfg);
                _readsKeeper = new Thread(ReadPoolLoop);
                _readsKeeper.IsBackground = true;
                _readsKeeper.Name = "mt5-read-channels";
                _readsKeeper.Start();
                Log.Info("查询通道 {0} 条,后台连接中(连上之前查询走交易连接)", _reads.Count);
            }

            _watchdog = new Thread(WatchdogLoop);
            _watchdog.IsBackground = true;
            _watchdog.Name = "mt5-watchdog";
            _watchdog.Start();

            // 自愈检查单独一条线程,且永远不会无限期地等 _gate(见 SelfHealLoop)。
            // Self-heal runs on its own thread that never blocks on _gate (see SelfHealLoop).
            _selfHeal = new Thread(SelfHealLoop);
            _selfHeal.IsBackground = true;
            _selfHeal.Name = "mt5-selfheal";
            _selfHeal.Start();
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

                    // 重连重建时先退掉上一份订阅。以前直接用新 sink 覆盖字段,旧的仍注册
                    // 在原生层——断线重连是常态(含 SDK 自愈那条分支),每次都漏一个。
                    // Unsubscribe the previous sink before replacing it: the field used
                    // to be overwritten while the old sink stayed registered natively,
                    // leaking one per reconnect (including the SDK self-heal branch).
                    if (_posSink != null)
                    {
                        try { _manager.PositionUnsubscribe(_posSink); }
                        catch (Exception ex) { Log.Warn("退订旧持仓 sink 失败:{0}", ex.Message); }
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

                    // 同 SubscribePositions:先退订旧 sink,免得每次重连漏一个。
                    // Same as SubscribePositions: drop the old sink first.
                    if (_dealSink != null)
                    {
                        try { _manager.DealUnsubscribe(_dealSink); }
                        catch (Exception ex) { Log.Warn("退订旧成交 sink 失败:{0}", ex.Message); }
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

        //+------------------------------------------------------------------+
        //| 挂单订阅:只为验证(见 OrderSink)。失败不抛异常、不影响任何业务。  |
        //| sink 持原生指针:构造后先 RegisterSink 再订阅;字段一直保留引用,    |
        //| 重连重建时先退订旧的,Dispose 时先 Unsubscribe——与持仓订阅同一套。  |
        //+------------------------------------------------------------------+
        private void SubscribeOrders()
        {
            try
            {
                lock (_gate)
                {
                    OrderSink sink = new OrderSink();
                    MTRetCode reg = sink.RegisterSink();

                    if (reg != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("OrderSink.RegisterSink 失败:{0},挂单验证计数不可用(不影响业务)", reg);
                        return;
                    }

                    MTRetCode sub = _manager.OrderSubscribe(sink);
                    if (sub != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("OrderSubscribe 失败:{0},挂单验证计数不可用(不影响业务)", sub);
                        return;
                    }

                    if (_ordSink != null)
                    {
                        try { _manager.OrderUnsubscribe(_ordSink); }
                        catch (Exception ex) { Log.Warn("退订旧挂单 sink 失败:{0}", ex.Message); }
                    }

                    _ordSink = sink;
                    _ordSubscribedAt = Environment.TickCount;
                    _ordSubscribed = true;
                    Log.Info("挂单订阅已建立(只计数,用于验证本地 pump 能否代替 /orders 服务器查询)");
                }
            }
            catch (Exception ex)
            {
                Log.Error("建立挂单订阅异常:{0}", ex.Message);
            }
        }

        // 挂单验证计数,/health 暴露。本地 pump 结果与服务器结果对比:只记数与日志,
        // /orders 始终返回服务器结果。
        // Pending-order validation counters on /health. Local pump vs server result;
        // /orders always returns the server result.
        private int _ordCompared;
        private int _ordSetMismatch;
        private int _ordFieldMismatch;
        private int _ordMismatchLogged;

        public int OrderAddEvents { get { OrderSink s = _ordSink; return s == null ? 0 : s.AddCount; } }
        public int OrderUpdateEvents { get { OrderSink s = _ordSink; return s == null ? 0 : s.UpdateCount; } }
        public int OrderDeleteEvents { get { OrderSink s = _ordSink; return s == null ? 0 : s.DeleteCount; } }
        public int OrdersCompared { get { return Thread.VolatileRead(ref _ordCompared); } }
        public int OrdersSetMismatch { get { return Thread.VolatileRead(ref _ordSetMismatch); } }
        public int OrdersFieldMismatch { get { return Thread.VolatileRead(ref _ordFieldMismatch); } }
        public bool OrderSubscribed { get { return _ordSubscribed; } }

        /// <summary>
        /// 把某账号的服务器挂单结果与本地 pump 库(OrderGetOpen)对比并计数。**只观测**:
        /// 不改 /orders 的返回值,拿不到 _gate(下单在用)就跳过这一次,任何异常吞掉。
        /// 订阅刚建立/重建后 30 秒内不比(pump 还在同步)。
        /// Compares the server's pending orders for a login with the local pump
        /// (OrderGetOpen) and counts. Observation only: never changes what /orders returns,
        /// skips when _gate is busy, swallows every exception, and stays quiet for 30s after
        /// (re)subscribing while the pump syncs.
        /// </summary>
        public void CompareLocalOrders(ulong login, OrderInfo[] server)
        {
            try
            {
                if (server == null || !_ordSubscribed || !_connected)
                    return;

                if (unchecked(Environment.TickCount - _ordSubscribedAt) < 30000)
                    return;

                OrderInfo[] local;

                if (!Monitor.TryEnter(_gate, 0))
                    return;

                try
                {
                    if (_manager == null)
                        return;

                    using (CIMTOrderArray arr = _manager.OrderCreateArray())
                    {
                        MTRetCode r = _manager.OrderGetOpen(login, arr);

                        if (r == MTRetCode.MT_RET_ERR_NOTFOUND)
                        {
                            local = new OrderInfo[0];
                        }
                        else if (r != MTRetCode.MT_RET_OK)
                        {
                            return;
                        }
                        else
                        {
                            uint total = arr.Total();
                            System.Collections.Generic.List<OrderInfo> list =
                                new System.Collections.Generic.List<OrderInfo>();

                            for (uint i = 0; i < total; i++)
                            {
                                CIMTOrder o = arr.Next(i);
                                if (o == null)
                                    continue;

                                list.Add(new OrderInfo
                                {
                                    Ticket = o.Order(),
                                    Symbol = o.Symbol(),
                                    Type = o.Type(),
                                    Volume = SMTMath.VolumeToDouble(o.VolumeCurrent()),
                                    PriceOrder = o.PriceOrder(),
                                    StopLoss = o.PriceSL(),
                                    TakeProfit = o.PriceTP(),
                                    Comment = o.Comment()
                                });
                            }

                            local = list.ToArray();
                        }
                    }
                }
                finally
                {
                    Monitor.Exit(_gate);
                }

                Interlocked.Increment(ref _ordCompared);

                bool setDiff = local.Length != server.Length;
                bool fieldDiff = false;
                string detail = "";

                if (!setDiff)
                {
                    foreach (OrderInfo s in server)
                    {
                        OrderInfo l = null;
                        foreach (OrderInfo x in local)
                        {
                            if (x.Ticket == s.Ticket)
                            {
                                l = x;
                                break;
                            }
                        }

                        if (l == null)
                        {
                            setDiff = true;
                            break;
                        }

                        if (l.Type != s.Type
                            || Math.Abs(l.Volume - s.Volume) > 1e-9
                            || Math.Abs(l.PriceOrder - s.PriceOrder) > 1e-9
                            || Math.Abs(l.StopLoss - s.StopLoss) > 1e-9
                            || Math.Abs(l.TakeProfit - s.TakeProfit) > 1e-9)
                        {
                            fieldDiff = true;
                            detail = string.Format("#{0} 服务器 价{1} SL{2} TP{3} 量{4} / 本地 价{5} SL{6} TP{7} 量{8}",
                                s.Ticket, s.PriceOrder, s.StopLoss, s.TakeProfit, s.Volume,
                                l.PriceOrder, l.StopLoss, l.TakeProfit, l.Volume);
                            break;
                        }
                    }
                }

                if (!setDiff && !fieldDiff)
                    return;

                if (setDiff)
                {
                    Interlocked.Increment(ref _ordSetMismatch);
                    detail = string.Format("挂单数 服务器 {0} / 本地 {1}", server.Length, local.Length);
                }
                else
                {
                    Interlocked.Increment(ref _ordFieldMismatch);
                }

                // 日志限量:前 20 条必记,之后每 100 条一条,免得验证期刷屏。
                // Log the first 20, then one in 100.
                int n = Interlocked.Increment(ref _ordMismatchLogged);
                if (n <= 20 || n % 100 == 0)
                    Log.Warn("挂单本地 pump 与服务器结果不一致(第 {0} 次,仅计数,返回值仍以服务器为准):login={1} {2}",
                        n, login, detail);
            }
            catch
            {
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

        /// <summary>半开探测的间隔与容忍次数。10 秒一探、连续 2 次失败才动手:
        /// 一次偶发失败仍不会把正常连接踢掉,而发现时延从原来的 90 秒压到 20 秒上下
        /// ——半开期间每一笔下单都要白等满 dealer 超时,这段时延就是用户直接看到的。
        /// Probe cadence and tolerance: one blip still never kills a healthy link, but
        /// detection drops from ~90s to ~20s — every order during a half-open waits out
        /// the dealer timeout, so this latency is exactly what users feel.</summary>
        private const int HeartbeatEverySec = 10;
        private const int HeartbeatFailLimit = 2;

        /// <summary>
        /// 下单等回执超时、或等待中连接断开时置位:watchdog 下一圈(1 秒内)立刻补一次
        /// 探测,不必等满 HeartbeatEverySec。dealer 超时往往就是半开的第一个信号。
        /// Raised on a dealer timeout or a drop mid-wait; the watchdog probes on its next
        /// pass instead of waiting for the regular slot. A dealer timeout is often the
        /// first sign of a half-open link.
        /// </summary>
        private volatile bool _probeRequested;

        /// <summary>
        /// 交易连接上最近一次确认"服务器回过话"的时刻:dealer 回执到达、或探测成功。
        /// 一个探测周期内有过回执,就说明这条连接此刻是通的,定时探测直接跳过——
        /// 探测要在 _gate 里做一次服务器往返,行情忙、下单密的时候正是最不该和下单
        /// 抢锁的时候,而那时恰好总有新鲜的回执。
        /// Last time the trading link proved a server round trip (a dealer answer or a
        /// successful probe). A fresh answer within one probe period makes the regular
        /// probe redundant, which keeps it off _gate exactly when trading is busiest.
        /// </summary>
        private volatile int _lastRoundTripAt = Environment.TickCount;

        /// <summary>
        /// 半开探测判死时置位。那一刻 SDK 并不知道连接死了(它没有回调 OnDisconnect),
        /// 也就不会自己去重连,watchdog 不必先等它自愈,直接断开重连。由 SDK 回调
        /// OnDisconnect 引起的断线不置位——SDK 自己会重连,仍要先给它一点时间,免得
        /// 两边撞车(见 WatchdogLoopCore 里"等待期间 SDK 已自行重连"那段)。
        /// Set when the half-open probe declares the link dead. The SDK doesn't know
        /// (no OnDisconnect) and won't reconnect by itself, so the watchdog reconnects
        /// without the grace period. SDK-reported drops don't set it: the SDK
        /// auto-reconnects and still gets a moment first so the two don't collide.
        /// </summary>
        private volatile bool _forcedDown;

        /// <summary>
        /// 管理后台「重连 MT5」按钮(POST /admin/reconnect)置位。HTTP 线程只立这个标志,
        /// 真正的断开重连仍由 watchdog 线程在下一圈(1 秒内)做,走与半开探测判死完全相同的
        /// 路径——连接状态只有一个线程在改,不会和 SDK 回调、重连流程撞车。
        /// Raised by the admin "reconnect MT5" button. The HTTP thread only sets it;
        /// the watchdog thread acts on its next pass via the same path as a
        /// probe-declared death, so one thread owns the link's state transitions.
        /// </summary>
        private volatile bool _reconnectRequested;

        /// <summary>请求一次主动重连;返回 false 表示当前本来就没连上(重连已在进行)。
        /// Ask for a reconnect; false when already disconnected (one is under way).</summary>
        public bool RequestReconnect()
        {
            if (!_connected)
                return false;
            _reconnectRequested = true;
            return true;
        }

        /// <summary>
        /// 存活探测:读一次品种总数,再做一次必须到服务器走一趟的查询。
        ///
        /// 选它是因为它不发交易请求、不碰 dealer,失败与否只反映"这条 Manager 连接
        /// 还能不能用"。抛异常或返回 0 都算失败——连着的时候品种表不可能是空的。
        ///
        /// 必须在 _gate 里做,也不能改走查询通道:Manager API 不保证线程安全,交易
        /// 连接上的一切调用都靠 _gate 串行(见文件头);而要探的恰恰是**交易连接**这一
        /// 根 TCP 会话——查询通道是另外几条连接,它们活着证明不了交易连接没有半开。
        /// 能做的是少探:见 _lastRoundTripAt。
        /// Must run under _gate and on the trading connection itself: the Manager API
        /// is not thread-safe (see the file header), and what is being tested is this
        /// very session — a query channel is a different connection and proves nothing
        /// about it. What we can do is probe less often; see _lastRoundTripAt.
        /// </summary>
        /// <returns>true 活着、false 判死、null 锁忙没探(不计入失败次数)。
        /// true alive, false dead, null = gate busy, probe skipped (not a failure).</returns>
        private bool? ProbeAlive()
        {
            // 带超时拿锁:锁忙只说明有调用在里面,不能证明连接死了;更不能让 watchdog
            // 无限期地卡在这里——真挂住了由 SelfHealLoop 负责退出。
            // Timed acquire: a busy gate isn't proof of death, and the watchdog must
            // not block forever here; a real hang is SelfHealLoop's job.
            if (!Monitor.TryEnter(_gate, ProbeGateWaitMs))
            {
                Log.Warn("存活探测:全局锁 {0} 毫秒内拿不到,本次跳过", ProbeGateWaitMs);
                return null;
            }

            try
            {
                if (_manager.SymbolTotal() <= 0)
                    return false;

                // 品种总数读的是本地 pump 缓存:隧道或券商静默断开时缓存还在,只看它
                // 永远判不出半开。再发一个必须到服务器走一趟的查询(查 manager 自己的
                // 用户记录)。只有网络/连接/超时类错误才算死——查不到、没权限之类的
                // 业务错误恰恰说明服务器在回话。
                // SymbolTotal reads the local pump cache, which survives a silent drop,
                // so it alone can never see a half-open link. Add a query that must
                // round-trip to the server. Only network/connection/timeout errors
                // count as dead — a business error (not found, no rights) means the
                // server answered.
                using (CIMTUser u = _manager.UserCreate())
                {
                    MTRetCode r = _manager.UserRequest(_cfg.ManagerLogin, u);
                    string code = r.ToString();

                    if (code.Contains("NETWORK") || code.Contains("CONNECTION") ||
                        code.Contains("TIMEOUT"))
                    {
                        Log.Warn("存活探测:服务器往返失败 {0}", r);
                        return false;
                    }
                }

                _lastRoundTripAt = Environment.TickCount;
                return true;
            }
            catch (Exception ex)
            {
                Log.Warn("存活探测异常:{0}", ex.Message);
                return false;
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }

        /// <summary>探测等锁的上限。/ Max wait for _gate before skipping a probe.</summary>
        private const int ProbeGateWaitMs = 5000;

        /// <summary>
        /// 连接恢复后要做的全部事情:清缓存、重选品种、重开 dealer、重建订阅。
        /// 两条恢复路径共用这一处——watchdog 自己重连,以及 SDK 自己断了又连上。
        /// 以前后者只补了订阅,dealer 没重开、缓存没清,于是"连着但下不了单"。
        /// Everything a restored link needs. Shared by both recovery paths — the
        /// watchdog's own reconnect and an SDK self-reconnect; the latter used to
        /// only resubscribe, leaving the dealer down and the caches stale.
        /// </summary>
        private void OnLinkRestored(string reason)
        {
            // 放在最前面:恢复过程中若又断一次,MarkConnected 会重新立起这个标志,
            // 下一圈 watchdog 就会再做一遍,而不是被末尾的清零吞掉。
            // Cleared first, so a drop during the restore re-raises it for the next pass.
            _needResubscribe = false;

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
                _symbolNames = null;   // 品种名快照同样重建 / rebuild the name snapshot too
                reselect = new List<string>(_everSelected);
            }

            // 读接口的组缓存同理 / same for the read-endpoint group cache
            ClearReadGroups();

            // 断线前交易过的品种 + 配置点名的品种,整批重新选上。否则重连后每个
            // 品种的第一笔单都要多等一次首个 tick。
            // Re-select everything traded before the drop plus the configured
            // list; otherwise the first order per symbol after a reconnect waits
            // for a first tick again.
            reselect.AddRange(_cfg.PreselectSymbols);
            PreselectSymbols(reselect, reason);

            // 重连后重开 dealer 通道。返回码此前被直接丢弃——它一旦失败,
            // 之后所有下单都收不到成交回执,而日志里一个字都没有,只能靠
            // 用户报"单子下不出去"才发现。现在失败会记 ERROR 并置
            // dealerActive=false,上面的分支每 10 秒重试直到恢复。
            // The return code used to be discarded here: if it failed, every
            // subsequent order silently got no confirmation with nothing in the
            // log. Now a failure is logged and retried until it recovers.
            RestartDealer(reason);

            // 持仓与成交订阅都要重建:断线时服务器已清掉我们的订阅状态
            // Both subscriptions must be rebuilt: the server dropped them on disconnect
            _posSubscribed = false;
            SubscribePositions();
            _dealSubscribed = false;
            SubscribeDeals();
            _ordSubscribed = false;
            SubscribeOrders();
        }

        /// <summary>重开 dealer 通道:先停(忽略结果)再启。SDK 自己重连时旧通道是否还
        /// 算"已启动"说不准,直接再 Start 可能被拒,先 Stop 最稳。
        /// Stop (result ignored) then start: after an SDK self-reconnect it's unclear
        /// whether the old channel still counts as started, so a bare Start may fail.</summary>
        private void RestartDealer(string reason)
        {
            lock (_gate)
            {
                try { _manager.DealerStop(); }
                catch { }
            }

            TryStartDealer(reason);
        }

        /// <summary>
        /// watchdog 线程入口。循环体里任何一处 SDK 调用抛出异常,在后台线程上都会直接
        /// 结束整个进程(在途交易全部中断,要等计划任务 2 分钟后拉起)。这里兜住、记一条、
        /// 歇 5 秒重新进入循环。
        /// Watchdog entry. An exception from any SDK call in the loop would end the whole
        /// process from this background thread; catch it, log, pause and re-enter.
        /// </summary>
        private void WatchdogLoop()
        {
            while (!_stopping)
            {
                try
                {
                    WatchdogLoopCore();
                    return;
                }
                catch (Exception ex)
                {
                    try { Log.Error("watchdog 异常,5 秒后继续:{0}", ex); }
                    catch { }
                    Thread.Sleep(5000);
                }
            }
        }

        //+------------------------------------------------------------------+
        //| 自愈:活着但卡死时自己退出,由计划任务在 2 分钟内拉起新进程       |
        //+------------------------------------------------------------------+

        // 计划任务只会拉起"已经没了"的进程;活着却卡死的(全局锁被一次挂住的 SDK 调用
        // 攥着、或者长时间连不上/下不了单)它看不出来,只能等人工重启。这两种情况都由
        // watchdog 自己判,到阈值就记一条日志并退出进程。在途请求的幂等记录已落盘,
        // 重启后按"结果未知"回放,不会重复执行。
        // The scheduled task only revives a process that is gone; one that's alive but
        // wedged (the global lock held by a hung SDK call, or unable to trade for a
        // long stretch) needed a manual restart. The watchdog now exits in both cases.
        // In-flight requests are on disk in the idempotency store and replay as
        // "outcome unknown" after the restart — never executed twice.

        /// <summary>全局锁连续这么久拿不到,判定为卡死。/ Global lock unobtainable this long = wedged.</summary>
        private const int GateStuckExitSec = 180;

        /// <summary>连续这么久"没连上或 dealer 不可用",重启进程试试。券商真挂了时每 15 分钟
        /// 重启一次也无害。/ This long unable to trade: try a fresh process.</summary>
        private const int DegradedExitSec = 15 * 60;

        private volatile int _gateFreeAt = Environment.TickCount;
        private volatile int _healthyAt = Environment.TickCount;

        /// <summary>距上次拿到全局锁的秒数,供 /health 暴露。/ Seconds since the global lock was last free.</summary>
        public int GateBlockedSec
        {
            get { return Math.Max(0, unchecked(Environment.TickCount - _gateFreeAt) / 1000); }
        }

        /// <summary>连续不能交易的秒数,供 /health 暴露。/ Seconds continuously unable to trade.</summary>
        public int DegradedSec
        {
            get { return Math.Max(0, unchecked(Environment.TickCount - _healthyAt) / 1000); }
        }

        /// <summary>
        /// 自愈线程入口。以前 CheckSelfHeal 挂在 watchdog 循环里,而 watchdog 自己也在
        /// 多处 lock (_gate)(探测、重启 dealer、恢复步骤、重连)——某个 SDK 调用攥着锁
        /// 挂住时,watchdog 先卡死在那几处,CheckSelfHeal 永远轮不到,180 秒自退从来
        /// 不会触发。现在它单独一条线程,只用带超时的 TryEnter 碰 _gate,永不阻塞。
        /// Self-heal thread. CheckSelfHeal used to run inside the watchdog loop, which
        /// itself takes _gate in several places (probe, dealer restart, restore,
        /// reconnect) — a hung SDK call holding the lock wedged the watchdog there
        /// first, so the 180s self-exit could never fire. It now has its own thread
        /// that only touches _gate through a timed TryEnter.
        /// </summary>
        private void SelfHealLoop()
        {
            while (!_stopping)
            {
                try
                {
                    Thread.Sleep(1000);
                    if (!_stopping)
                        CheckSelfHeal();
                }
                catch (Exception ex)
                {
                    try { Log.Error("自愈线程异常,继续:{0}", ex.Message); }
                    catch { }
                }
            }
        }

        private void CheckSelfHeal()
        {
            // 最多等 2 秒拿锁:正常交易只占它几毫秒,拿不到说明有调用挂在里面。
            // Wait up to 2s: a normal trade holds it for milliseconds.
            if (Monitor.TryEnter(_gate, 2000))
            {
                Monitor.Exit(_gate);
                _gateFreeAt = Environment.TickCount;
            }

            if (_connected && _dealerActive)
                _healthyAt = Environment.TickCount;

            string why = null;

            if (GateBlockedSec >= GateStuckExitSec)
                why = string.Format("全局锁已 {0} 秒拿不到(某个 MT5 调用挂住了)", GateBlockedSec);
            else if (DegradedSec >= DegradedExitSec)
                why = string.Format("已连续 {0} 分钟无法交易(connected={1} dealerActive={2})",
                    DegradedSec / 60, _connected, _dealerActive);

            // 正在正常停服(Dispose)时不要抢着 Exit。/ Don't exit during an orderly shutdown.
            if (why == null || _stopping)
                return;

            try { Log.Error("自愈:{0},退出进程,由计划任务重新拉起", why); }
            catch { }

            Environment.Exit(3);
        }

        /// <summary>重连退避的上限(秒)。原来是 30:断一次连、连两三次没连上,下一次
        /// 就要干等半分钟,而这段时间所有下单都只能回"重连中"。
        /// Reconnect back-off ceiling; was 30s, which left orders refused for half a
        /// minute after only a couple of failed attempts.</summary>
        private const int ReconnectMaxDelaySec = 10;

        /// <summary>断线重连。指数退避(1、2、4、8、10…秒),最多 10 秒一次;鉴权类错误 5 分钟。</summary>
        private void WatchdogLoopCore()
        {
            // 首次重连前的等待。SDK 报的断线(OnDisconnect)给它 1 秒自己连回去——它本来
            // 就会自动重连,我们抢着 Disconnect + Connect 只会把它刚恢复的连接踢掉;
            // 半开探测判死的那种(_forcedDown)SDK 不知情、不会自己连,不等,直接重连。
            // 原来固定先睡 2 秒,且中间不看 SDK 是否已经连回来。
            // Wait before the first attempt: 1s grace for an SDK-reported drop (it
            // auto-reconnects; racing it tears down what it just restored), none for a
            // probe-declared death (the SDK is unaware and won't reconnect). The old
            // code slept a fixed 2s without checking whether the SDK was already back.
            int delaySec = 1;
            // dealer 重试节流:连接正常但 dealer 掉了时,每 10 圈(约 10 秒)重试一次。
            // 不用每秒重试——权限类问题重试再密也不会更快好,只会白敲券商接口。
            int dealerRetryTick = 0;
            int heartbeatTick = 0;
            int heartbeatFails = 0;

            while (!_stopping)
            {
                Thread.Sleep(1000);

                // 自愈检查不在这里做:见 SelfHealLoop。
                // Self-heal lives on its own thread; see SelfHealLoop.

                if (_stopping || _connected)
                {
                    delaySec = 1;

                    // SDK 自己完成了一次断-连:订阅在服务器侧已被清掉,补回来。
                    // 这条分支是 G-03 的落点,详见 MarkConnected 里的说明。
                    // The SDK healed a drop on its own; rebuild the subscriptions.
                    if (!_stopping && _connected && _needResubscribe)
                    {
                        Log.Warn("检测到连接曾经中断(SDK 已自行重连),重做恢复步骤");
                        OnLinkRestored("SDK 自动重连后");
                    }

                    // 管理后台点了「重连 MT5」:按半开判死处理——放倒连接、立即重连。
                    // Admin asked for a reconnect: treat it like a probe-declared death.
                    if (!_stopping && _connected && _reconnectRequested)
                    {
                        _reconnectRequested = false;
                        Log.Warn("管理后台请求重连 MT5,主动断开并立即重连");
                        _forcedDown = true;
                        MarkConnected(false);
                        continue;
                    }
                    _reconnectRequested = false;

                    // 半开连接探测。watchdog 原来唯一的判据是 _connected,而这个标志
                    // 只由 SDK 的回调翻转——券商侧或 WireGuard 隧道静默断开、SDK 没
                    // 回调时,网关会一直自称已连接,所有请求超时直到人工重启。
                    // 每 HeartbeatEverySec 秒做一次极轻的探测(读品种总数,纯本地缓存
                    // 读,不发交易请求),连续失败 HeartbeatFailLimit 次就主动放倒
                    // _connected,让下面的重连分支接手。
                    // Half-open detection: _connected only flips from SDK callbacks, so
                    // a silent drop leaves the gateway claiming to be connected while
                    // everything times out. Probe cheaply and force a reconnect.
                    //
                    // 两处加速:dealer 超时/等待中断线后立刻补探一次(_probeRequested);
                    // 定时探测若这一周期内已有 dealer 回执证明连接是通的就跳过,不去 _gate
                    // 里和下单抢锁(_lastRoundTripAt)。补探不走这个跳过——它要回答的正是
                    // "刚才那次超时是不是连接的问题"。
                    // Two speed-ups: probe at once after a dealer timeout or mid-wait drop;
                    // skip the regular probe when a dealer answer already proved the link
                    // this period, keeping it off _gate. A requested probe never skips —
                    // it exists to ask whether that timeout was the link's fault.
                    if (!_stopping && _connected)
                    {
                        bool requested = _probeRequested;
                        bool due = ++heartbeatTick >= HeartbeatEverySec;

                        if (requested || due)
                        {
                            heartbeatTick = 0;
                            _probeRequested = false;

                            bool? probe;
                            if (!requested &&
                                unchecked(Environment.TickCount - _lastRoundTripAt) < HeartbeatEverySec * 1000)
                                probe = true;
                            else
                                probe = ProbeAlive();

                            if (probe == null)
                            {
                                // 锁忙,本次不算数;补探的请求留着下一圈再探。
                                // Gate busy: inconclusive; keep a requested probe pending.
                                if (requested)
                                    _probeRequested = true;
                            }
                            else if (probe.Value)
                            {
                                heartbeatFails = 0;
                            }
                            else if (++heartbeatFails >= HeartbeatFailLimit)
                            {
                                heartbeatFails = 0;
                                Log.Error("连续 {0} 次探测失败,判定连接已半开,主动断开以触发重连",
                                    HeartbeatFailLimit);
                                _forcedDown = true;
                                MarkConnected(false);
                                continue;
                            }
                            else if (requested)
                            {
                                Log.Warn("dealer 超时后的补充探测失败,{0} 秒后再探一次", HeartbeatEverySec);
                            }
                        }
                    }

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

                // 断开期间不再有探测结果可言,计数清零,连回来之后重新累计。
                // Probe counters mean nothing across a drop; start afresh once back.
                heartbeatTick = 0;
                heartbeatFails = 0;

                // 半开判死后的第一次重连不等(见 _forcedDown);其余按退避等。等的过程中
                // 每 100 毫秒看一眼:SDK 自己连回来了就不必睡满,马上交给下面的判断。
                // No wait for the first attempt after a probe-declared death (see
                // _forcedDown); otherwise back off, but look every 100ms so an SDK
                // self-reconnect is picked up without sleeping out the delay.
                bool forced = _forcedDown;
                _forcedDown = false;
                int waitMs = forced ? 0 : delaySec * 1000;

                if (waitMs > 0)
                    Log.Warn("检测到未连接,{0} 秒后重连", delaySec);
                else
                    Log.Warn("检测到未连接(半开探测判死),立即重连");

                int waitUntil = unchecked(Environment.TickCount + waitMs);
                while (!_stopping && !_connected && unchecked(waitUntil - Environment.TickCount) > 0)
                    Thread.Sleep(100);

                if (_stopping)
                    break;

                // 睡的这几秒里 SDK 可能已经自己连回去了(OnDisconnect 之后紧跟 OnConnect,
                // 它本来就会自动重连)。以前这里不看,照样 Disconnect + Connect:把刚恢复
                // 的好连接亲手踢掉、重新全量同步一遍,断线时间翻倍;多出来的这次断开还会
                // 把恰好在恢复窗口里发出的下单全部叫醒成"结果未知"。连上了就交给上面
                // "已连接"分支——_needResubscribe 还立着,它会做完整的恢复步骤。
                // The SDK may have reconnected by itself during the sleep (it does
                // auto-reconnect: OnDisconnect followed by OnConnect). This used to go
                // ahead with Disconnect + Connect anyway, tearing down the freshly
                // restored link, re-syncing from scratch, doubling the outage, and waking
                // any order sent in that window as "outcome unknown". If we're connected,
                // leave it to the connected branch above; _needResubscribe is still set,
                // so it runs the full restore.
                if (_connected)
                {
                    Log.Info("等待期间 SDK 已自行重连,不再重复重连");
                    continue;
                }

                // 先把旧会话彻底断掉再连。半开探测判死时只是放倒了标志,SDK 手里还攥着旧
                // 会话;不 Disconnect 就直接 Connect,可能一直报错,也可能"成功"却还是那根
                // 死掉的连接。
                // Tear down the old session first. The half-open path only lowers the
                // flag; connecting over a live SDK session may fail forever or "succeed"
                // onto the same dead socket.
                lock (_gate)
                {
                    try { _manager.Disconnect(); }
                    catch { }
                }

                MTRetCode res = ConnectOnce();
                if (res == MTRetCode.MT_RET_OK)
                {
                    Log.Info("重连成功");

                    OnLinkRestored("重连后");

                    delaySec = 1;
                }
                else
                {
                    Log.Error("重连失败:{0} {1}", res, DescribeConnectError(res));

                    // 密码/权限错误重试再勤也不会好,反而可能让券商按"反复登录失败"封 IP 或
                    // 账号。这类错误退到 5 分钟一次。
                    // Auth/permission failures won't heal by retrying and can get the IP or
                    // account blocked for repeated failed logins; back off to 5 minutes.
                    string rc = res.ToString();
                    bool authFailure = rc.StartsWith("MT_RET_AUTH") ||
                        res == MTRetCode.MT_RET_ERR_PERMISSIONS;
                    delaySec = authFailure ? 300 : Math.Min(delaySec * 2, ReconnectMaxDelaySec);
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

        //+------------------------------------------------------------------+
        //| 服务器查询:优先走查询通道(见 ReadChannel.cs),不可用时退回交易连接 |
        //+------------------------------------------------------------------+

        /// <summary>查询通道池;null 表示没开(read_channels = 0)。
        /// Query channel pool; null when disabled.</summary>
        private ReadPool _reads;

        /// <summary>维护查询通道的线程,见 Start 里的说明。/ Keeps the query channels connected.</summary>
        private Thread _readsKeeper;

        /// <summary>
        /// 查询通道维护线程:每秒看一眼,没连上的按各自的退避重连。与 watchdog 一样,
        /// 后台线程上漏出异常就是整个进程退出,所以每圈兜住。
        /// Query-channel keeper: once a second, reconnect channels that are down,
        /// each on its own back-off. Guarded like the watchdog — an exception escaping
        /// a background thread ends the process.
        /// </summary>
        private void ReadPoolLoop()
        {
            while (!_stopping)
            {
                try
                {
                    _reads.Maintain();
                }
                catch (Exception ex)
                {
                    try { Log.Error("查询通道维护异常:{0}", ex.Message); }
                    catch { }
                }

                Thread.Sleep(1000);
            }
        }

        /// <summary>查询通道:配置的条数与当前已连上的条数,供 /health 暴露。
        /// Configured and connected query channels, for /health.</summary>
        public int ReadChannelsConfigured
        {
            get { return _reads != null ? _reads.Count : 0; }
        }

        public int ReadChannelsConnected
        {
            get { return _reads != null ? _reads.ConnectedCount : 0; }
        }

        /// <summary>网络/连接/超时类错误:说明这条连接本身出了问题,而不是查询结果。
        /// Network/connection/timeout class: the link failed, not the query.</summary>
        private static bool IsLinkError(MTRetCode res)
        {
            string code = res.ToString();
            return code.Contains("NETWORK") || code.Contains("CONNECTION") || code.Contains("TIMEOUT");
        }

        /// <summary>读账号资料 + 资金。返回 null 表示读取失败。</summary>
        public AccountInfo GetAccount(ulong login, out MTRetCode res)
        {
            bool busy;
            return GetAccountCore(login, out res, out busy, true, false);
        }

        /// <summary>
        /// allowSpill=false:查询通道全忙(排满上限)时不溢到交易连接,readBusy=true、返回 null,
        /// 由 HTTP 层回 503 read_busy。allowSpill=true 与旧行为完全一致。
        /// allowSpill=false: when every query channel stays busy for the whole wait cap,
        /// do not spill onto the trading link; readBusy=true and null come back and the
        /// HTTP layer answers 503 read_busy. allowSpill=true is the old behaviour.
        /// </summary>
        public AccountInfo GetAccount(ulong login, out MTRetCode res, out bool readBusy, bool allowSpill)
        {
            return GetAccountCore(login, out res, out readBusy, allowSpill, true);
        }

        /// <summary>
        /// allowLocalStatic=true 只给每 15 秒一次的 /account 轮询:姓名/组/杠杆/改密时间优先取交易连接
        /// 本地 pump 的用户记录(内存读),只往服务器跑资金那一趟。/verify 与 selftest 传 false,
        /// 保持原来的两趟服务器请求。
        /// allowLocalStatic=true is for the 15s /account poll only: static fields come from the
        /// trading link local user pump (memory read) and only the funds request goes to the
        /// server. /verify and selftest pass false and keep the two-request path.
        /// </summary>
        private AccountInfo GetAccountCore(ulong login, out MTRetCode res, out bool readBusy,
            bool allowSpill, bool allowLocalStatic)
        {
            readBusy = false;
            bool saturated = false;
            ReadChannel rc = _reads != null ? _reads.Acquire(out saturated) : null;

            if (rc == null && saturated && !allowSpill)
            {
                readBusy = true;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return null;
            }

            if (rc != null)
            {
                try
                {
                    AccountInfo r = GetAccountOn(rc.Manager, rc.Gate, login, out res, allowLocalStatic);
                    if (!IsLinkError(res))
                        return r;
                    rc.MarkBroken(res);
                }
                catch (Exception ex)
                {
                    Log.Warn("查询通道执行 GetAccount 异常,改走交易连接:{0}", ex.Message);
                    rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                }
                finally
                {
                    _reads.Release(rc);
                }
            }

            return GetAccountOn(_manager, _gate, login, out res, allowLocalStatic);
        }

        /// <summary>某账号最近一次"从服务器读到"的改密时间与时刻。/ Last server-read password-change time.</summary>
        private struct PassSeen
        {
            public long LastPassChange;
            public int AtTickCount;
        }

        private readonly object _passSeenLock = new object();
        private readonly System.Collections.Generic.Dictionary<ulong, PassSeen> _passSeen =
            new System.Collections.Generic.Dictionary<ulong, PassSeen>();

        /// <summary>
        /// 本地静态资料的信任期:超过它就必须再向服务器读一次(顺带刷新基线)。改密时间用来撤销
        /// 失效绑定,不能只信本地 pump——pump 靠服务器推送更新,滞后就等于晚发现或(绑定刚
        /// 建立时)误判。所以本地值只在"与上次服务器读到的值完全相同"时才采用,不同(真改了
        /// 密码,或 pump 落后)一律回服务器读;相同也最多信 10 分钟。
        /// How long local static fields are trusted before a server re-read. The password-
        /// change time revokes stale bindings and the pump is push-updated, so a lagging pump
        /// could mean a late detection or, right after a bind, a false one. The local value is
        /// used only when it equals the last server-read value; any difference goes back to the
        /// server, and even an equal one is trusted for 10 minutes at most.
        /// </summary>
        private const int PassSeenTtlMs = 10 * 60 * 1000;

        /// <summary>
        /// 试着只用交易连接的本地 pump 填账号静态资料。任何一步不成立(没有服务器基线、基线
        /// 过期、_gate 忙、本地没有该用户、改密时间与基线不同、组为空)都返回 false,
        /// 调用方走原来的 UserRequest。拿 _gate 只等 50ms:不为一次读内存去和下单排队。
        /// Fill static fields from the trading link local pump. Every failed precondition
        /// returns false and the caller does the original UserRequest. _gate is tried for
        /// 50ms only - a memory read must not queue behind orders.
        /// </summary>
        private bool TryLocalUserStatic(ulong login, AccountInfo info)
        {
            if (!IsConnected)
                return false;

            if (!Monitor.TryEnter(_gate, 50))
                return false;

            try
            {
                return FillStaticFromPumpLocked(login, info);
            }
            catch
            {
                return false;
            }
            finally
            {
                Monitor.Exit(_gate);
            }
        }

        /// <summary>调用方须持有 _gate。前置条件与 TryLocalUserStatic 相同。
        /// Caller holds _gate; same preconditions as TryLocalUserStatic.</summary>
        private bool FillStaticFromPumpLocked(ulong login, AccountInfo info)
        {
            PassSeen seen;
            lock (_passSeenLock)
            {
                if (!_passSeen.TryGetValue(login, out seen))
                    return false;
            }

            int age = unchecked(Environment.TickCount - seen.AtTickCount);
            if (age < 0 || age >= PassSeenTtlMs)
                return false;

            if (_manager == null)
                return false;

            using (CIMTUser user = _manager.UserCreate())
            {
                if (user == null)
                    return false;

                if (_manager.UserGet(login, user) != MTRetCode.MT_RET_OK)
                    return false;

                long lastPass = user.LastPassChange();
                string group = user.Group();

                if (lastPass != seen.LastPassChange || string.IsNullOrEmpty(group))
                    return false;

                info.Name = user.Name();
                info.Group = group;
                info.Leverage = user.Leverage();
                info.LastPassChange = lastPass;
                return true;
            }
        }

        /// <summary>批量版:一次拿 _gate(50ms),命中的填进 infos,没命中的进 needUsers。
        /// Batch form: one 50ms try on _gate; hits go to infos, misses to needUsers.</summary>
        private void TryLocalUserStaticBatch(ulong[] logins,
            System.Collections.Generic.Dictionary<ulong, AccountInfo> infos,
            System.Collections.Generic.List<ulong> needUsers)
        {
            bool gotGate = IsConnected && Monitor.TryEnter(_gate, 50);

            try
            {
                foreach (ulong login in logins)
                {
                    AccountInfo info = new AccountInfo();
                    info.Login = login;
                    bool hit = false;

                    if (gotGate)
                    {
                        try { hit = FillStaticFromPumpLocked(login, info); }
                        catch { hit = false; }
                    }

                    if (hit)
                        infos[login] = info;
                    else
                        needUsers.Add(login);
                }
            }
            finally
            {
                if (gotGate)
                    Monitor.Exit(_gate);
            }
        }

        private AccountInfo GetAccountOn(CIMTManagerAPI m, object gate, ulong login, out MTRetCode res,
            bool allowLocalStatic)
        {
            AccountInfo info = new AccountInfo();
            info.Login = login;

            // 本地静态资料在进这条连接的锁之前取:它自己只短暂碰 _gate。
            // Local static fields first, before this connection lock is taken.
            bool haveStatic = allowLocalStatic && TryLocalUserStatic(login, info);

            lock (gate)
            {
                if (!haveStatic)
                {
                    using (CIMTUser user = m.UserCreate())
                    {
                        res = m.UserRequest(login, user);
                        if (res != MTRetCode.MT_RET_OK)
                            return null;

                        info.Name = user.Name();
                        info.Group = user.Group();
                        info.Leverage = user.Leverage();
                        info.LastPassChange = user.LastPassChange();
                    }

                    // 记下这次服务器读到的改密时间,作为之后本地 pump 值的比对基线。
                    // Record it as the baseline the local pump value is compared with.
                    PassSeen ps;
                    ps.LastPassChange = info.LastPassChange;
                    ps.AtTickCount = Environment.TickCount;
                    lock (_passSeenLock)
                        _passSeen[login] = ps;
                }

                using (CIMTAccount account = m.UserCreateAccount())
                {
                    res = m.UserAccountRequest(login, account);
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

                // 只缓存确定的结论:查到了、或服务器明确答复"没有/无权"。网络、超时这类
                // 临时错误不缓存——否则一次抖动会让这个账号整整 60 秒下不了单。
                // Cache only definitive answers (found, or an explicit not-found / no
                // rights). A transient network/timeout error must not lock the account
                // out of trading for the full 60s TTL.
                bool definitive = exists ||
                    res == MTRetCode.MT_RET_ERR_NOTFOUND ||
                    res == MTRetCode.MT_RET_ERR_PERMISSIONS;

                if (definitive)
                {
                    TradableEntry entry;
                    entry.Exists = exists;
                    entry.Group = group;
                    entry.Res = res;
                    entry.AtTickCount = now;
                    _tradableCache[login] = entry;
                }
                else
                {
                    _tradableCache.Remove(login);
                }

                // 顺手喂给 ResolveSymbol 的组缓存:同一笔开仓紧接着就要按组解析品种,
                // 没必要为同一个 login 再读一次。
                // Also feed ResolveSymbol's group cache: the same order resolves the
                // symbol by group right after this, no point reading the login twice.
                if (exists)
                    _groupCache[login] = new TimedString { Value = group, AtTickCount = now };

                return exists;
            }
        }

        //+------------------------------------------------------------------+
        //| 读接口的组白名单:/positions /orders /deals 及其批量版要先知道账号  |
        //| 在哪个组,才能按 allowed_groups 拒绝。                              |
        //|                                                                  |
        //| 顺序:本缓存(60 秒 TTL,与 _tradableCache 同理——白名单是安全边界, |
        //| 不能永久缓存)→ 交易连接本地 pump(内存读,_gate 只等 50ms,不和下单 |
        //| 排队)→ 都没有才向服务器 UserRequestByLogins 一次(整批一趟)。     |
        //| /account 与 /accounts-batch 读到的组经 RememberReadGroup 喂进来, |
        //| 所以 2 秒一轮的持仓批量几乎总是命中缓存,不增加往返。              |
        //| 服务器明确答复"没有"的 login 也缓存(Group=null),免得已删账号每轮  |
        //| 都触发一次往返。                                                   |
        //|                                                                  |
        //| Group lookup for the allowed_groups check on read endpoints. Cache |
        //| (60s TTL — a security boundary, same as _tradableCache) → local    |
        //| pump on the trading link (memory read, 50ms try on _gate) → one     |
        //| UserRequestByLogins for whatever is left. /account reads feed the  |
        //| cache, so the 2s positions poll practically never pays a round     |
        //| trip. Definitive not-found answers are cached too (Group=null).    |
        //+------------------------------------------------------------------+
        private struct ReadGroupEntry
        {
            public string Group;     // null = 服务器明确答复没有这个账号 / definitively not found
            public int AtTickCount;
        }

        private readonly object _readGroupLock = new object();
        private readonly Dictionary<ulong, ReadGroupEntry> _readGroupCache =
            new Dictionary<ulong, ReadGroupEntry>();

        private const int ReadGroupTtlMs = 60000;

        // 上限:批量接口每次最多 100 个 login,但调用方可以换着 login 打;只是缓存,满了就清。
        // Bounded: callers can cycle through logins; it is only a cache, so overflow clears it.
        private const int ReadGroupCacheMax = 100000;

        /// <summary>账号读接口拿到的组喂给读缓存。/ Feed a group seen by an account read.</summary>
        public void RememberReadGroup(ulong login, string group)
        {
            if (login != 0 && !string.IsNullOrEmpty(group))
                StoreReadGroup(login, group, Environment.TickCount);
        }

        private void StoreReadGroup(ulong login, string group, int now)
        {
            lock (_readGroupLock)
            {
                if (_readGroupCache.Count >= ReadGroupCacheMax && !_readGroupCache.ContainsKey(login))
                {
                    List<ulong> stale = new List<ulong>();
                    foreach (KeyValuePair<ulong, ReadGroupEntry> kv in _readGroupCache)
                    {
                        int age = unchecked(now - kv.Value.AtTickCount);
                        if (age < 0 || age >= ReadGroupTtlMs)
                            stale.Add(kv.Key);
                    }

                    foreach (ulong k in stale)
                        _readGroupCache.Remove(k);

                    if (_readGroupCache.Count >= ReadGroupCacheMax)
                        _readGroupCache.Clear();
                }

                ReadGroupEntry e;
                e.Group = group;
                e.AtTickCount = now;
                _readGroupCache[login] = e;
            }
        }

        /// <summary>重连时清空(断线期间券商可能换过组)。/ Cleared on reconnect.</summary>
        private void ClearReadGroups()
        {
            lock (_readGroupLock)
                _readGroupCache.Clear();
        }

        /// <summary>
        /// 解析一批 login 的组。返回 true 时 groups 里是存在的账号(login → 组),不在里面的
        /// 就是服务器明确答复没有;返回 false 表示有账号的组没能确定(通道忙 readBusy / 连接
        /// 错误 res),调用方须按读取失败处理——**不能**当成"没有"回空列表,否则后端会以为
        /// 持仓全平了。allowTradingLink=false(批量接口)时查询通道不可用就直接失败,不溢到 _gate。
        /// Resolves groups. true: groups holds every existing login; absent = definitively
        /// not found. false: some login could not be decided (busy / link error) — callers
        /// must treat it as a failed read, never as "no data". allowTradingLink=false (batch
        /// endpoints) fails instead of spilling onto the trading link.
        /// </summary>
        public bool ResolveReadGroups(ulong[] logins, bool allowTradingLink,
            out Dictionary<ulong, string> groups, out MTRetCode res, out bool readBusy)
        {
            groups = new Dictionary<ulong, string>();
            res = MTRetCode.MT_RET_OK;
            readBusy = false;

            int now = Environment.TickCount;
            List<ulong> miss = new List<ulong>();

            lock (_readGroupLock)
            {
                foreach (ulong login in logins)
                {
                    ReadGroupEntry e;
                    if (_readGroupCache.TryGetValue(login, out e))
                    {
                        int age = unchecked(now - e.AtTickCount);
                        if (age >= 0 && age < ReadGroupTtlMs)
                        {
                            if (e.Group != null)
                                groups[login] = e.Group;
                            continue;
                        }
                    }

                    miss.Add(login);
                }
            }

            if (miss.Count == 0)
                return true;

            // 本地 pump:内存读。_gate 只等 50ms,忙就跳过、走服务器。
            // Local pump: a memory read. Only a 50ms try on _gate; busy means go to the server.
            if (IsConnected && _manager != null && Monitor.TryEnter(_gate, 50))
            {
                try
                {
                    using (CIMTUser user = _manager.UserCreate())
                    {
                        if (user != null)
                        {
                            for (int i = miss.Count - 1; i >= 0; i--)
                            {
                                if (_manager.UserGet(miss[i], user) != MTRetCode.MT_RET_OK)
                                    continue;

                                string g = user.Group();
                                if (string.IsNullOrEmpty(g))
                                    continue;

                                groups[miss[i]] = g;
                                StoreReadGroup(miss[i], g, now);
                                miss.RemoveAt(i);
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log.Warn("本地 pump 读账号组异常,改问服务器:{0}", ex.Message);
                }
                finally
                {
                    Monitor.Exit(_gate);
                }
            }

            if (miss.Count == 0)
                return true;

            bool saturated = false;
            ReadChannel rc = _reads != null ? _reads.Acquire(out saturated) : null;

            if (rc == null && (saturated || !allowTradingLink))
            {
                readBusy = saturated;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return false;
            }

            if (rc != null)
            {
                try
                {
                    if (RequestGroupsOn(rc.Manager, rc.Gate, miss, groups, now, out res))
                        return true;
                    if (!IsLinkError(res))
                        return false;
                    rc.MarkBroken(res);
                }
                catch (Exception ex)
                {
                    Log.Warn("查询通道读账号组异常:{0}", ex.Message);
                    rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                    res = MTRetCode.MT_RET_ERR_NETWORK;
                }
                finally
                {
                    _reads.Release(rc);
                }

                if (!allowTradingLink)
                    return false;
            }

            return RequestGroupsOn(_manager, _gate, miss, groups, now, out res);
        }

        private bool RequestGroupsOn(CIMTManagerAPI m, object gate, List<ulong> miss,
            Dictionary<ulong, string> groups, int now, out MTRetCode res)
        {
            lock (gate)
            {
                using (CIMTUserArray ua = m.UserCreateArray())
                {
                    res = m.UserRequestByLogins(miss.ToArray(), ua);

                    // NOTFOUND = 一个都没有;单个 login 时 PERMISSIONS 也是确定的"看不见"
                    // (与 CheckAccountGroup 的口径一致)。
                    // NOTFOUND = none exist; for a single login PERMISSIONS is equally
                    // definitive (same rule as CheckAccountGroup).
                    bool none = res == MTRetCode.MT_RET_ERR_NOTFOUND ||
                        (res == MTRetCode.MT_RET_ERR_PERMISSIONS && miss.Count == 1);

                    if (!none && res != MTRetCode.MT_RET_OK)
                        return false;

                    HashSet<ulong> want = new HashSet<ulong>(miss);
                    uint total = none ? 0 : ua.Total();

                    for (uint i = 0; i < total; i++)
                    {
                        CIMTUser u = ua.Next(i);
                        if (u == null)
                            continue;

                        ulong l = u.Login();
                        if (!want.Remove(l))
                            continue;

                        string g = u.Group() ?? "";
                        groups[l] = g;
                        StoreReadGroup(l, g, now);
                    }

                    // 服务器没给的:不存在或本 manager 看不见——确定的"没有"。
                    // Not returned: missing or invisible to this manager — definitive.
                    foreach (ulong l in want)
                        StoreReadGroup(l, null, now);

                    res = MTRetCode.MT_RET_OK;
                    return true;
                }
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
            bool busy;
            return GetPositions(login, out res, out busy, true);
        }

        /// <summary>
        /// allowSpill=false:查询通道全忙(排满上限)时不溢到交易连接,readBusy=true、返回 null,
        /// 由 HTTP 层回 503 read_busy。allowSpill=true 与旧行为完全一致。
        /// allowSpill=false: when every query channel stays busy for the whole wait cap,
        /// do not spill onto the trading link; readBusy=true and null come back and the
        /// HTTP layer answers 503 read_busy. allowSpill=true is the old behaviour.
        /// </summary>
        public PositionInfo[] GetPositions(ulong login, out MTRetCode res, out bool readBusy, bool allowSpill)
        {
            readBusy = false;
            bool saturated = false;
            ReadChannel rc = _reads != null ? _reads.Acquire(out saturated) : null;

            if (rc == null && saturated && !allowSpill)
            {
                readBusy = true;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return null;
            }

            if (rc != null)
            {
                try
                {
                    PositionInfo[] r = GetPositionsOn(rc.Manager, rc.Gate, login, out res);
                    if (!IsLinkError(res))
                        return r;
                    rc.MarkBroken(res);
                }
                catch (Exception ex)
                {
                    Log.Warn("查询通道执行 GetPositions 异常,改走交易连接:{0}", ex.Message);
                    rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                }
                finally
                {
                    _reads.Release(rc);
                }
            }

            return GetPositionsOn(_manager, _gate, login, out res);
        }

        private PositionInfo[] GetPositionsOn(CIMTManagerAPI m, object gate, ulong login, out MTRetCode res)
        {
            lock (gate)
            {
                using (CIMTPositionArray arr = m.PositionCreateArray())
                {
                    res = m.PositionRequest(login, arr);

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
            bool busy;
            return GetOrders(login, out res, out busy, true);
        }

        /// <summary>
        /// allowSpill=false:查询通道全忙(排满上限)时不溢到交易连接,readBusy=true、返回 null,
        /// 由 HTTP 层回 503 read_busy。allowSpill=true 与旧行为完全一致。
        /// allowSpill=false: when every query channel stays busy for the whole wait cap,
        /// do not spill onto the trading link; readBusy=true and null come back and the
        /// HTTP layer answers 503 read_busy. allowSpill=true is the old behaviour.
        /// </summary>
        public OrderInfo[] GetOrders(ulong login, out MTRetCode res, out bool readBusy, bool allowSpill)
        {
            readBusy = false;
            bool saturated = false;
            ReadChannel rc = _reads != null ? _reads.Acquire(out saturated) : null;

            if (rc == null && saturated && !allowSpill)
            {
                readBusy = true;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return null;
            }

            if (rc != null)
            {
                try
                {
                    OrderInfo[] r = GetOrdersOn(rc.Manager, rc.Gate, login, out res);
                    if (!IsLinkError(res))
                        return r;
                    rc.MarkBroken(res);
                }
                catch (Exception ex)
                {
                    Log.Warn("查询通道执行 GetOrders 异常,改走交易连接:{0}", ex.Message);
                    rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                }
                finally
                {
                    _reads.Release(rc);
                }
            }

            return GetOrdersOn(_manager, _gate, login, out res);
        }

        private OrderInfo[] GetOrdersOn(CIMTManagerAPI m, object gate, ulong login, out MTRetCode res)
        {
            lock (gate)
            {
                using (CIMTOrderArray arr = m.OrderCreateArray())
                {
                    res = m.OrderRequestOpen(login, arr);

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
            bool busy;
            return GetDeals(login, fromUnix, toUnix, out res, out busy, true);
        }

        /// <summary>
        /// allowSpill=false:查询通道全忙(排满上限)时不溢到交易连接,readBusy=true、返回 null,
        /// 由 HTTP 层回 503 read_busy。allowSpill=true 与旧行为完全一致。
        /// allowSpill=false: when every query channel stays busy for the whole wait cap,
        /// do not spill onto the trading link; readBusy=true and null come back and the
        /// HTTP layer answers 503 read_busy. allowSpill=true is the old behaviour.
        /// </summary>
        public DealInfo[] GetDeals(ulong login, long fromUnix, long toUnix, out MTRetCode res, out bool readBusy, bool allowSpill)
        {
            readBusy = false;
            bool saturated = false;
            ReadChannel rc = _reads != null ? _reads.Acquire(out saturated) : null;

            if (rc == null && saturated && !allowSpill)
            {
                readBusy = true;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return null;
            }

            if (rc != null)
            {
                try
                {
                    DealInfo[] r = GetDealsOn(rc.Manager, rc.Gate, login, fromUnix, toUnix, out res);
                    if (!IsLinkError(res))
                        return r;
                    rc.MarkBroken(res);
                }
                catch (Exception ex)
                {
                    Log.Warn("查询通道执行 GetDeals 异常,改走交易连接:{0}", ex.Message);
                    rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                }
                finally
                {
                    _reads.Release(rc);
                }
            }

            return GetDealsOn(_manager, _gate, login, fromUnix, toUnix, out res);
        }

        private DealInfo[] GetDealsOn(CIMTManagerAPI m, object gate, ulong login, long fromUnix, long toUnix, out MTRetCode res)
        {
            lock (gate)
            {
                using (CIMTDealArray arr = m.DealCreateArray())
                {
                    res = m.DealRequest(login, fromUnix, toUnix, arr);

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

        //+------------------------------------------------------------------+
        //| 批量查询:一次服务器往返读一批账号(*RequestByLogins)。             |
        //|                                                                  |
        //| 只走查询通道:通道全忙 → readBusy;没配/没连上/都被卡住 → 直接失败,|
        //| 由后端退回逐人接口(逐人接口自己会退回交易连接)。**不**溢到交易    |
        //| 连接的 _gate:一次批量往返比单人的更长,不能去和下单抢锁。          |
        //| 每个 login 都在结果里占一个位置(没数据 = 空列表,与单人接口的     |
        //| NOTFOUND→空列表一致);账号不存在的不出现在 by 里。                 |
        //| 出错整体返回 false,不返回残缺结果。                               |
        //+------------------------------------------------------------------+
        private ReadChannel AcquireForBatch(out bool readBusy)
        {
            readBusy = false;

            if (_reads == null)
                return null;

            bool saturated;
            ReadChannel rc = _reads.Acquire(out saturated);
            readBusy = rc == null && saturated;
            return rc;
        }

        public bool GetPositionsBatch(ulong[] logins,
            out System.Collections.Generic.Dictionary<ulong, PositionInfo[]> by,
            out MTRetCode res, out bool readBusy)
        {
            by = null;
            res = MTRetCode.MT_RET_ERR_NETWORK;

            ReadChannel rc = AcquireForBatch(out readBusy);
            if (rc == null)
                return false;

            try
            {
                lock (rc.Gate)
                {
                    using (CIMTPositionArray arr = rc.Manager.PositionCreateArray())
                    {
                        res = rc.Manager.PositionRequestByLogins(logins, arr);

                        if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                            res = MTRetCode.MT_RET_OK;
                        else if (res != MTRetCode.MT_RET_OK)
                        {
                            if (IsLinkError(res))
                                rc.MarkBroken(res);
                            return false;
                        }

                        System.Collections.Generic.Dictionary<ulong, System.Collections.Generic.List<PositionInfo>> tmp =
                            new System.Collections.Generic.Dictionary<ulong, System.Collections.Generic.List<PositionInfo>>();
                        foreach (ulong l in logins)
                            tmp[l] = new System.Collections.Generic.List<PositionInfo>();

                        uint total = res == MTRetCode.MT_RET_OK ? arr.Total() : 0;

                        for (uint i = 0; i < total; i++)
                        {
                            CIMTPosition p = arr.Next(i);
                            if (p == null)
                                continue;

                            System.Collections.Generic.List<PositionInfo> bucket;
                            if (!tmp.TryGetValue(p.Login(), out bucket))
                                continue;

                            bucket.Add(new PositionInfo
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
                            });
                        }

                        by = new System.Collections.Generic.Dictionary<ulong, PositionInfo[]>();
                        foreach (System.Collections.Generic.KeyValuePair<ulong, System.Collections.Generic.List<PositionInfo>> kv in tmp)
                            by[kv.Key] = kv.Value.ToArray();

                        res = MTRetCode.MT_RET_OK;
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn("查询通道执行 GetPositionsBatch 异常:{0}", ex.Message);
                rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                by = null;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return false;
            }
            finally
            {
                _reads.Release(rc);
            }
        }

        public bool GetDealsBatch(ulong[] logins, long fromUnix, long toUnix,
            out System.Collections.Generic.Dictionary<ulong, DealInfo[]> by,
            out MTRetCode res, out bool readBusy)
        {
            by = null;
            res = MTRetCode.MT_RET_ERR_NETWORK;

            ReadChannel rc = AcquireForBatch(out readBusy);
            if (rc == null)
                return false;

            try
            {
                lock (rc.Gate)
                {
                    using (CIMTDealArray arr = rc.Manager.DealCreateArray())
                    {
                        res = rc.Manager.DealRequestByLogins(logins, fromUnix, toUnix, arr);

                        if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                            res = MTRetCode.MT_RET_OK;
                        else if (res != MTRetCode.MT_RET_OK)
                        {
                            if (IsLinkError(res))
                                rc.MarkBroken(res);
                            return false;
                        }

                        System.Collections.Generic.Dictionary<ulong, System.Collections.Generic.List<DealInfo>> tmp =
                            new System.Collections.Generic.Dictionary<ulong, System.Collections.Generic.List<DealInfo>>();
                        foreach (ulong l in logins)
                            tmp[l] = new System.Collections.Generic.List<DealInfo>();

                        uint total = res == MTRetCode.MT_RET_OK ? arr.Total() : 0;

                        for (uint i = 0; i < total; i++)
                        {
                            CIMTDeal d = arr.Next(i);
                            if (d == null)
                                continue;

                            System.Collections.Generic.List<DealInfo> bucket;
                            if (!tmp.TryGetValue(d.Login(), out bucket))
                                continue;

                            bucket.Add(new DealInfo
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
                            });
                        }

                        by = new System.Collections.Generic.Dictionary<ulong, DealInfo[]>();
                        foreach (System.Collections.Generic.KeyValuePair<ulong, System.Collections.Generic.List<DealInfo>> kv in tmp)
                            by[kv.Key] = kv.Value.ToArray();

                        res = MTRetCode.MT_RET_OK;
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn("查询通道执行 GetDealsBatch 异常:{0}", ex.Message);
                rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                by = null;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return false;
            }
            finally
            {
                _reads.Release(rc);
            }
        }

        /// <summary>
        /// 批量读账号资料 + 资金,语义同单人 /account(allowLocalStatic 那一路):静态资料优先取
        /// 本地 pump(须与上次服务器读到的改密时间一致,见 TryLocalUserStatic),其余一次
        /// UserRequestByLogins;资金一次 UserAccountRequestByLogins。两部分都拿到的 login 才进 by。
        /// Batch account read, same semantics as the polling /account: static fields from the
        /// local pump when trustworthy, the rest via one UserRequestByLogins; funds via one
        /// UserAccountRequestByLogins. Only logins with both parts land in by.
        /// </summary>
        public bool GetAccountsBatch(ulong[] logins,
            out System.Collections.Generic.Dictionary<ulong, AccountInfo> by,
            out MTRetCode res, out bool readBusy)
        {
            by = null;
            res = MTRetCode.MT_RET_ERR_NETWORK;

            ReadChannel rc = AcquireForBatch(out readBusy);
            if (rc == null)
                return false;

            try
            {
                System.Collections.Generic.Dictionary<ulong, AccountInfo> infos =
                    new System.Collections.Generic.Dictionary<ulong, AccountInfo>();
                System.Collections.Generic.List<ulong> needUsers = new System.Collections.Generic.List<ulong>();

                // 先取本地静态资料(只短暂碰 _gate),再进查询通道自己的锁。
                // Local static fields first (a brief touch of _gate), then this channel's lock.
                TryLocalUserStaticBatch(logins, infos, needUsers);

                lock (rc.Gate)
                {
                    CIMTManagerAPI m = rc.Manager;

                    if (needUsers.Count > 0)
                    {
                        using (CIMTUserArray ua = m.UserCreateArray())
                        {
                            res = m.UserRequestByLogins(needUsers.ToArray(), ua);

                            if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                                res = MTRetCode.MT_RET_OK;
                            else if (res != MTRetCode.MT_RET_OK)
                            {
                                if (IsLinkError(res))
                                    rc.MarkBroken(res);
                                return false;
                            }

                            uint ut = ua.Total();

                            for (uint i = 0; i < ut; i++)
                            {
                                CIMTUser u = ua.Next(i);
                                if (u == null)
                                    continue;

                                ulong ul = u.Login();
                                if (!needUsers.Contains(ul))
                                    continue;

                                AccountInfo info = new AccountInfo();
                                info.Login = ul;
                                info.Name = u.Name();
                                info.Group = u.Group();
                                info.Leverage = u.Leverage();
                                info.LastPassChange = u.LastPassChange();
                                infos[ul] = info;

                                PassSeen ps;
                                ps.LastPassChange = info.LastPassChange;
                                ps.AtTickCount = Environment.TickCount;
                                lock (_passSeenLock)
                                    _passSeen[ul] = ps;
                            }
                        }
                    }

                    System.Collections.Generic.Dictionary<ulong, AccountInfo> outMap =
                        new System.Collections.Generic.Dictionary<ulong, AccountInfo>();

                    using (CIMTAccountArray aa = m.UserCreateAccountArray())
                    {
                        res = m.UserAccountRequestByLogins(logins, aa);

                        if (res == MTRetCode.MT_RET_ERR_NOTFOUND)
                            res = MTRetCode.MT_RET_OK;
                        else if (res != MTRetCode.MT_RET_OK)
                        {
                            if (IsLinkError(res))
                                rc.MarkBroken(res);
                            return false;
                        }

                        uint at = aa.Total();

                        for (uint i = 0; i < at; i++)
                        {
                            CIMTAccount a = aa.Next(i);
                            if (a == null)
                                continue;

                            AccountInfo info;
                            if (!infos.TryGetValue(a.Login(), out info))
                                continue;

                            info.Balance = a.Balance();
                            info.Equity = a.Equity();
                            info.Margin = a.Margin();
                            info.MarginFree = a.MarginFree();
                            outMap[info.Login] = info;
                        }
                    }

                    by = outMap;
                    res = MTRetCode.MT_RET_OK;
                    return true;
                }
            }
            catch (Exception ex)
            {
                Log.Warn("查询通道执行 GetAccountsBatch 异常:{0}", ex.Message);
                rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                by = null;
                res = MTRetCode.MT_RET_ERR_NETWORK;
                return false;
            }
            finally
            {
                _reads.Release(rc);
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
                string group = GroupForLogin(login);

                if (group.Length == 0)
                    return baseSymbol;

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
                    //
                    // 先用一份**品种名快照**筛出前缀命中的少数几个,再只对这几个做
                    // SymbolGet 校验组可见性。原来是边遍历边对每个前缀命中的名字
                    // 现场 SymbolGet:_gate 串行化所有 MT5 调用(含正在进行的下单取价),
                    // 品种表几千条、三个别名都不命中时,会在锁内做上万次 SymbolGet,
                    // 期间所有下单/平仓/查询全排队。名字快照只建一次并缓存到重连,
                    // 之后每次未命中的解析只剩"内存里筛一遍 + 几次 SymbolGet"。
                    // Filter against a cached snapshot of symbol names first and only
                    // SymbolGet the few prefix hits. This used to SymbolGet inside the
                    // scan loop while holding _gate, which serializes every MT5 call —
                    // thousands of them per miss, with all trading queued behind it.
                    string upper = alias.ToUpperInvariant();
                    List<string> candidates = new List<string>();

                    foreach (string name in SymbolNamesLocked())
                    {
                        if (!name.ToUpperInvariant().StartsWith(upper))
                            continue;

                        // Check group access
                        using (CIMTConSymbol testSym = _manager.SymbolCreate())
                        {
                            if (_manager.SymbolGet(name, group, testSym) == MTRetCode.MT_RET_OK)
                                candidates.Add(name);
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

                // No match — return as-is, let caller handle the error.
                // Missing=true 记下"本组看不见":开仓/挂单据此当场给出说得清的原因,
                // 而不是发出去换一句"取价失败"(demo\STD-USD 没有比特币就是这样)。
                // Missing=true records "not visible to this group" so opens and pending
                // orders can refuse with a clear reason instead of a quote failure.
                _symbolCache[cacheKey] = new TimedString { Value = baseSymbol, AtTickCount = Environment.TickCount, Missing = true };
                Log.Warn("品种 {0} 在组 {1} 内找不到可交易的名字(该组可能没开通这个品种)", baseSymbol, group);
                return baseSymbol;
            }
        }

        /// <summary>
        /// 上一次 ResolveSymbol 是否判定该品种在账号所在组里不存在。读的是 ResolveSymbol
        /// 刚写进去的缓存,不多一次 MT5 调用;读不到组时返回 false,交给服务器判。
        /// Whether ResolveSymbol found no tradable name for this account's group. Reads
        /// the cache ResolveSymbol just filled (no extra MT5 call); false when the group
        /// is unknown, leaving the verdict to the server.
        /// </summary>
        private bool SymbolMissingForGroup(string group, string baseSymbol)
        {
            if (group.Length == 0)
                return false;

            lock (_gate)
            {
                TimedString cached;
                return _symbolCache.TryGetValue(
                           group.ToUpperInvariant() + "|" + baseSymbol.ToUpperInvariant(), out cached)
                       && Fresh(cached) && cached.Missing;
            }
        }

        private static TradeResult SymbolMissingResult(string group, string baseSymbol)
        {
            return TradeResult.Fail(MTRetCode.MT_RET_ERR_NOTFOUND.ToString(),
                string.Format("该账号所在组({0})没有开通 {1},无法下单", group, baseSymbol));
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

            // 连接不在就不去排 _gate(重连时它可能被 ConnectOnce 攥着 30 秒),直接说清楚。
            // Don't queue on _gate while the link is down; ConnectOnce may hold it 30s.
            if (!_connected)
            {
                res = MTRetCode.MT_RET_ERR_CONNECTION;
                return false;
            }

            res = MTRetCode.MT_RET_ERR_NOTFOUND;

            bool justSelected = false;
            int deadline = 0;

            for (int attempt = 0; ; attempt++)
            {
                lock (_gate)
                {
                    if (attempt == 0 && _selected.Add(symbol))
                    {
                        // 返回码原来被直接丢弃:一个写错的品种名会被永久当成"已选中",
                        // 之后每次取价只等 StaleTickWaitMs(300ms) 而不是 FirstTickWaitMs,
                        // 而且会被带进重连后的整批重选,日志里没有任何线索。
                        // 与 PreselectSymbols 一致:失败就回滚并 Warn。
                        // The return code used to be dropped, so a typo'd symbol was
                        // remembered as "selected" forever — later quotes waited only
                        // the short timeout and the name rode along into every
                        // post-reconnect re-selection, with nothing in the log.
                        MTRetCode sel = _manager.SelectedAdd(symbol);

                        if (sel != MTRetCode.MT_RET_OK)
                        {
                            _selected.Remove(symbol);
                            Log.Warn("SelectedAdd 失败:{0} -> {1}(品种名是否正确?)", symbol, sel);
                        }
                        else
                        {
                            _everSelected.Add(symbol);
                            justSelected = true;
                        }
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
        /// 券商品种名的快照,按需建一次。调用方须持有 _gate。
        ///
        /// 品种表在运行期几乎不变(券商上新品种是罕见操作),而遍历它是 ResolveSymbol
        /// 未命中时最贵的一步。断线重连会连同其它缓存一起清空(见 WatchdogLoop),
        /// 所以重连后能看到新上的品种。
        /// A cached snapshot of broker symbol names; caller holds _gate. Cleared on
        /// reconnect along with the other caches, so new symbols still show up.
        /// </summary>
        private List<string> SymbolNamesLocked()
        {
            if (_symbolNames != null)
                return _symbolNames;

            List<string> names = new List<string>();
            uint total = _manager.SymbolTotal();

            using (CIMTConSymbol scanSym = _manager.SymbolCreate())
            {
                for (uint i = 0; i < total; i++)
                {
                    if (_manager.SymbolNext(i, scanSym) != MTRetCode.MT_RET_OK)
                        continue;

                    string name = scanSym.Symbol();

                    if (!string.IsNullOrEmpty(name))
                        names.Add(name);
                }
            }

            _symbolNames = names;
            Log.Info("品种名快照已建立:{0} 条", names.Count);
            return _symbolNames;
        }

        private List<string> _symbolNames;

        /// <summary>
        /// 取账号所在组(带缓存),读不到返回空串。
        ///
        /// 这段原来内联在 ResolveSymbol 里,现在 GetSymbolLimits 也要按组读,所以抽出来。
        /// _gate 是 Monitor,同线程可重入,调用方持不持锁都能调。
        /// The account's group (cached), "" when unreadable. Extracted from
        /// ResolveSymbol now that the volume limits need it too; _gate is re-entrant.
        /// </summary>
        private string GroupForLogin(ulong login)
        {
            lock (_gate)
            {
                TimedString hit;
                if (_groupCache.TryGetValue(login, out hit) && Fresh(hit))
                    return hit.Value;

                // 本地 pump 库优先,见 ReadUserGroup。正常开仓路径走不到这里:
                // HandleOpen 前一步的 CheckAccountGroup 已经把组填进缓存了。
                // Pump first (see ReadUserGroup). The normal open path rarely gets
                // here: CheckAccountGroup one step earlier already filled the cache.
                string group;
                if (ReadUserGroup(login, out group) != MTRetCode.MT_RET_OK)
                    return "";

                _groupCache[login] = new TimedString { Value = group, AtTickCount = Environment.TickCount };
                return group;
            }
        }

        /// <summary>
        /// 取品种在**某个组**下的手数限制,用于下单前校验。
        ///
        /// 为什么必须带组:MT5 的组配置可以覆盖品种的 VolumeMin/Max/Step
        /// (「原油 WTI 步长 0.1、其余 0.01」这条约定本身就说明步长是分档的)。
        /// 原来这里用的是两参 SymbolGet,读到的是品种的**全局**配置,而同一个文件里
        /// ResolveSymbol 早就用的是带组的三参重载——两处口径不一致。
        /// 读错档位的后果不是下单被券商拒绝,而是订单被接受成一张永不成交的单并
        /// **锁死这张仓位**(2026-09-17 就是这么爆的),所以这里宁可多传一个参数。
        ///
        /// 带缓存:命中时不进 MT5,只读字典。缓存键必须带组,否则 A 组先查过
        /// XAUUSD.s,B 组再查就会拿到 A 组的限制——跨组串味比不缓存更糟。
        /// 手数限制属于品种/组配置,券商极少改动,断线重连时连同 Selected 列表一起清空重建。
        ///
        /// Volume limits for a symbol **as seen by one group**. MT5 groups can override
        /// VolumeMin/Max/Step, and this used to read the symbol's global config via the
        /// two-arg SymbolGet while ResolveSymbol already used the group-aware overload.
        /// An out-of-step volume is not rejected by the server; it is accepted as an
        /// order that can never fill and then blocks every close on that position.
        /// The cache key carries the group: without it the first group to look a symbol
        /// up would answer for every other group.
        /// </summary>
        public bool GetSymbolLimits(string symbol, string group, out double volMin, out double volMax,
            out double volStep, out MTRetCode res)
        {
            uint ignored;
            return GetSymbolLimits(symbol, group, out volMin, out volMax, out volStep,
                out ignored, out res);
        }

        public bool GetSymbolLimits(string symbol, string group, out double volMin, out double volMax,
            out double volStep, out uint fillFlags, out MTRetCode res)
        {
            volMin = 0;
            volMax = 0;
            volStep = 0;
            fillFlags = 0;
            res = MTRetCode.MT_RET_OK;

            string groupKey = string.IsNullOrEmpty(group) ? "" : group.ToUpperInvariant();
            string cacheKey = groupKey + "|" + symbol.ToUpperInvariant();

            lock (_gate)
            {
                SymbolLimits hit;
                if (_limitsCache.TryGetValue(cacheKey, out hit))
                {
                    volMin = hit.VolMin;
                    volMax = hit.VolMax;
                    volStep = hit.VolStep;
                    fillFlags = hit.FillFlags;
                    return true;
                }

                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    // 组读不出来时(账号查不到/pump 没同步)退回全局配置,与改动前同行为:
                    // 有一份可能不精确的限制,好过完全不校验。
                    // With no group (unknown login) fall back to the global config —
                    // the pre-change behavior. An approximate limit beats none.
                    res = groupKey.Length > 0
                        ? _manager.SymbolGet(symbol, group, sym)
                        : _manager.SymbolGet(symbol, sym);

                    if (res != MTRetCode.MT_RET_OK)
                        return false;

                    volMin = SMTMath.VolumeToDouble(sym.VolumeMin());
                    volMax = SMTMath.VolumeToDouble(sym.VolumeMax());
                    volStep = SMTMath.VolumeToDouble(sym.VolumeStep());
                    fillFlags = (uint)sym.FillFlags();

                    SymbolLimits entry;
                    entry.VolMin = volMin;
                    entry.VolMax = volMax;
                    entry.VolStep = volStep;
                    entry.FillFlags = fillFlags;
                    _limitsCache[cacheKey] = entry;

                    return true;
                }
            }
        }

        //+------------------------------------------------------------------+
        //| 交易时段 / Trading sessions                                      |
        //+------------------------------------------------------------------+
        // 为什么要在网关判休市(2026-10-25):周末用户在平台下单,dealer 请求照样发到
        // 券商,MT5 把它挂成一条「request adding」的待处理请求——既不成交也不拒绝,
        // 用户在 MT5 里看到一条自己删不掉的东西。下单前按品种配置里的交易时段
        // (SessionTrade,服务器时间)、假日表与 TradeMode 判一次,休市就当场拒。
        // 后端也会提前按同一份数据拦住,这里是最后一道闸。
        //
        // Why the gateway checks the session (2026-10-25): an order placed on a
        // weekend still reaches the broker as a dealer request, which MT5 parks as
        // "request adding" — neither filled nor rejected, and the user cannot remove
        // it. Before sending, check the symbol's trade sessions (server time), the
        // holiday table and TradeMode; refuse outright when closed. The backend
        // gates earlier on the same data; this is the last line.

        /// <summary>一个品种的交易时段快照,供 /symbol-sessions 与下单前检查共用。
        /// A symbol's trading-session snapshot, shared by /symbol-sessions and the
        /// pre-send check.</summary>
        public sealed class SymbolSessionInfo
        {
            public string Symbol = "";
            public string Group = "";
            /// <summary>CIMTConSymbol.EnTradeMode:0 禁止 / 1 只多 / 2 只空 / 3 只平 / 4 全部</summary>
            public int TradeMode;
            /// <summary>MT5 服务器本地时间(unix 秒,按服务器时区)/ server-local unix seconds</summary>
            public long ServerTime;
            /// <summary>服务器时间 − UTC,秒(按 15 分钟取整)/ server minus UTC, seconds</summary>
            public int ServerUtcOffsetSec;
            /// <summary>品种配置里是否配了任何交易时段。全空视为「读不到」,不据此拒单。
            /// Whether any trade session is configured; none at all means "unknown",
            /// and we never refuse on unknown.</summary>
            public bool SessionsKnown;
            /// <summary>今天(服务器日期)对该品种是不是假日 / whether today is a holiday for it</summary>
            public bool Holiday;
            public bool OpenNow;
            /// <summary>下一次开盘的 UTC unix 秒;0 = 未知 / next open, UTC unix seconds; 0 = unknown</summary>
            public long NextOpenUtc;
            /// <summary>按星期(0=周日)的交易时段,每段 [开始分钟, 结束分钟) / per weekday (0=Sunday)</summary>
            public List<int[]>[] Sessions = new List<int[]>[7];
        }

        private struct HolidayRule
        {
            public int Year;   // 0 = 每年 / every year
            public int Month;
            public int Day;
            public int WorkFrom;
            public int WorkTo;
            public List<string> Masks;
        }

        private static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /// <summary>
        /// 读品种交易时段。login 非 0 时按该账号的组解析品种名(XAUUSD -> XAUUSD.s)并
        /// 按组读配置;login 为 0(后端只是查状态、没有网关账号)时按基础名在品种表
        /// 里找最短匹配。
        /// Read a symbol's sessions. With a login the name is resolved through that
        /// account's group; without one (status query, no gateway account) the
        /// shortest match in the symbol table is used.
        /// </summary>
        public bool GetSymbolSessions(string symbol, ulong login, out SymbolSessionInfo info, out MTRetCode res)
        {
            info = null;
            res = MTRetCode.MT_RET_OK;

            if (!_connected)
            {
                res = MTRetCode.MT_RET_ERR_CONNECTION;
                return false;
            }

            lock (_gate)
            {
                string group = login != 0 ? GroupForLogin(login) : "";
                string resolved = login != 0 ? ResolveSymbol(login, symbol) : symbol;

                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    res = group.Length > 0
                        ? _manager.SymbolGet(resolved, group, sym)
                        : _manager.SymbolGet(resolved, sym);

                    if (res != MTRetCode.MT_RET_OK && group.Length == 0)
                    {
                        string any = AnySymbolNameLocked(symbol);

                        if (any != null)
                        {
                            resolved = any;
                            res = _manager.SymbolGet(resolved, sym);
                        }
                    }

                    if (res != MTRetCode.MT_RET_OK)
                        return false;

                    info = BuildSessionInfoLocked(sym, resolved, group);
                    return true;
                }
            }
        }

        /// <summary>没有账号上下文时,按基础名(含别名 BTCUSDT->BTCUSD)在品种表里找最短的
        /// 「同名或同名加后缀」。Without an account, find the shortest "same name or
        /// name plus suffix" in the symbol table (aliases included).</summary>
        private string AnySymbolNameLocked(string baseSymbol)
        {
            List<string> names = SymbolNamesLocked();
            string best = null;

            foreach (string alias in AliasCandidates(baseSymbol))
            {
                foreach (string name in names)
                {
                    if (!name.Equals(alias, StringComparison.OrdinalIgnoreCase)
                        && !name.StartsWith(alias + ".", StringComparison.OrdinalIgnoreCase))
                        continue;

                    if (best == null || name.Length < best.Length)
                        best = name;
                }

                if (best != null)
                    return best;
            }

            return null;
        }

        /// <summary>下单前的休市检查。休市返回一句说得清的原因,可交易或**判不了**返回 null:
        /// 服务器时间读不到、品种没配任何时段,都不据此拒单——宁可放给服务器判,也不
        /// 因为本地读不到配置就拒掉合法的单。
        /// Pre-send closed-market check. Returns a reason when closed, null when
        /// tradable or undeterminable (no server time, no sessions configured): never
        /// refuse on missing data.</summary>
        private string MarketClosedReason(string symbol, string group)
        {
            return ClosedReasonCore(symbol, group, false);
        }

        /// <summary>平仓 / 改单 / 改挂单 / 撤挂单前的休市检查(审计 A2,2026-10-26)。
        /// 这几条路以前不判时段,休市时 dealer 请求照样发出去:MT5 挂成删不掉的
        /// 「request adding」,平仓还带着收盘前最后一跳的价格。与开仓同一份判定,只是
        /// 「只平」品种照常放行(那是不许开新仓,不是休市);TradeMode 禁止交易时交给
        /// 服务器判。
        /// Closed-session check before a close / modify / pending modify / pending
        /// cancel (audit A2). These paths used to send dealer requests into a closed
        /// session, which MT5 parks as an unremovable "request adding" (a close also
        /// carrying the last pre-close tick). Same verdict as an open, except that a
        /// close-only symbol still passes (it bars new positions, it is not closed) and
        /// a disabled symbol is left to the server.</summary>
        private string ManageClosedReason(string symbol, string group)
        {
            return ClosedReasonCore(symbol, group, true);
        }

        private string ClosedReasonCore(string symbol, string group, bool manage)
        {
            try
            {
                lock (_gate)
                {
                    using (CIMTConSymbol sym = _manager.SymbolCreate())
                    {
                        MTRetCode res = group.Length > 0
                            ? _manager.SymbolGet(symbol, group, sym)
                            : _manager.SymbolGet(symbol, sym);

                        if (res != MTRetCode.MT_RET_OK)
                            return null;

                        SymbolSessionInfo info = BuildSessionInfoLocked(sym, symbol, group, manage);

                        if (info.OpenNow || info.ServerTime <= 0)
                            return null;

                        if (manage)
                        {
                            if (info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_DISABLED)
                                return null;
                        }
                        else if (info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_DISABLED
                            || info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_CLOSEONLY)
                            return "该品种当前禁止开仓(券商 TradeMode 限制) / trading disabled for this symbol";

                        if (!info.SessionsKnown)
                            return null;

                        string when = "";

                        if (info.NextOpenUtc > 0)
                        {
                            DateTime next = UnixEpoch.AddSeconds(info.NextOpenUtc).AddHours(8);
                            when = ",预计 " + next.ToString("MM-dd HH:mm", CultureInfo.InvariantCulture) + " (UTC+8) 开盘";
                        }

                        return "该品种休市中,不能下单" + when + " / market closed for this symbol";
                    }
                }
            }
            catch (Exception ex)
            {
                // 判定本身出错不该挡下单 / a failure in the check must not block the order
                Log.Warn("交易时段判定出错,已跳过:{0} -> {1}", symbol, ex.Message);
                return null;
            }
        }

        private List<HolidayRule> ReadHolidaysLocked()
        {
            List<HolidayRule> rules = new List<HolidayRule>();
            uint total = _manager.HolidayTotal();

            if (total == 0)
                return rules;

            using (CIMTConHoliday hol = _manager.HolidayCreate())
            {
                for (uint i = 0; i < total; i++)
                {
                    if (_manager.HolidayNext(i, hol) != MTRetCode.MT_RET_OK)
                        continue;

                    if (hol.Mode() != CIMTConHoliday.EnHolidayMode.HOLIDAY_ENABLED)
                        continue;

                    HolidayRule r;
                    r.Year = (int)hol.Year();
                    r.Month = (int)hol.Month();
                    r.Day = (int)hol.Day();
                    r.WorkFrom = (int)hol.WorkFrom();
                    r.WorkTo = (int)hol.WorkTo();
                    r.Masks = new List<string>();

                    uint masks = hol.SymbolTotal();

                    for (uint k = 0; k < masks; k++)
                    {
                        string m = hol.SymbolNext(k);

                        if (!string.IsNullOrEmpty(m))
                            r.Masks.Add(m);
                    }

                    rules.Add(r);
                }
            }

            return rules;
        }

        /// <summary>MT5 的品种掩码匹配:支持 * 与 ?,"!" 开头为排除;对品种路径与品种名各试一次。
        /// MT5 symbol-mask matching: * and ?, a leading "!" excludes; tried against both
        /// the symbol path and its name.</summary>
        private static bool HolidayAppliesTo(HolidayRule r, string name, string path)
        {
            bool included = false;

            foreach (string raw in r.Masks)
            {
                bool exclude = raw.StartsWith("!");
                string mask = exclude ? raw.Substring(1) : raw;
                bool hit = WildcardMatch(mask, path) || WildcardMatch(mask, name);

                if (!hit)
                    continue;

                if (exclude)
                    return false;

                included = true;
            }

            return included;
        }

        private static bool WildcardMatch(string pattern, string text)
        {
            if (string.IsNullOrEmpty(pattern) || text == null)
                return false;

            int p = 0, t = 0, starP = -1, starT = -1;

            while (t < text.Length)
            {
                if (p < pattern.Length && (pattern[p] == '?'
                    || char.ToUpperInvariant(pattern[p]) == char.ToUpperInvariant(text[t])))
                {
                    p++;
                    t++;
                }
                else if (p < pattern.Length && pattern[p] == '*')
                {
                    starP = p++;
                    starT = t;
                }
                else if (starP >= 0)
                {
                    p = starP + 1;
                    t = ++starT;
                }
                else
                {
                    return false;
                }
            }

            while (p < pattern.Length && pattern[p] == '*')
                p++;

            return p == pattern.Length;
        }

        /// <summary>某一天(服务器日期的天序号)对该品种的假日工作窗口:null = 不是假日,
        /// 否则 [from, to) 分钟,两者都 0 表示全天休市。
        /// The holiday work window for one server day: null = not a holiday, else
        /// [from, to) minutes with 0/0 meaning closed all day.</summary>
        private static int[] HolidayWindowFor(List<HolidayRule> rules, long dayIndex, string name, string path)
        {
            if (rules.Count == 0)
                return null;

            DateTime date = UnixEpoch.AddDays(dayIndex);

            foreach (HolidayRule r in rules)
            {
                if (r.Month != date.Month || r.Day != date.Day)
                    continue;

                if (r.Year != 0 && r.Year != date.Year)
                    continue;

                if (!HolidayAppliesTo(r, name, path))
                    continue;

                return new int[] { r.WorkFrom, r.WorkTo };
            }

            return null;
        }

        /// <summary>某一天实际可交易的时段:常规时段与假日窗口取交集。
        /// The day's effective sessions: regular sessions intersected with the holiday window.</summary>
        private static List<int[]> EffectiveSessions(List<int[]> regular, int[] holiday)
        {
            if (holiday == null)
                return regular;

            List<int[]> outList = new List<int[]>();

            if (holiday[0] == 0 && holiday[1] == 0)
                return outList;

            foreach (int[] s in regular)
            {
                int open = Math.Max(s[0], holiday[0]);
                int close = Math.Min(s[1], holiday[1]);

                if (close > open)
                    outList.Add(new int[] { open, close });
            }

            return outList;
        }

        private SymbolSessionInfo BuildSessionInfoLocked(CIMTConSymbol sym, string name, string group,
            bool closeOnlyTradable = false)
        {
            SymbolSessionInfo info = new SymbolSessionInfo();
            info.Symbol = name;
            info.Group = group;
            info.TradeMode = (int)sym.TradeMode();

            long serverTime = _manager.TimeServer();
            long utcNow = (long)(DateTime.UtcNow - UnixEpoch).TotalSeconds;
            info.ServerTime = serverTime;
            // 服务器时区不从配置猜(夏令时那周会错),直接拿「服务器时间 − 本机 UTC」按
            // 一刻钟取整。/ Derive the offset from server-vs-UTC rounded to 15 minutes
            // instead of trusting a configured zone (wrong in the DST changeover week).
            info.ServerUtcOffsetSec = (int)(Math.Round((serverTime - utcNow) / 900.0) * 900);

            bool any = false;

            using (CIMTConSymbolSession sess = _manager.SymbolSessionCreate())
            {
                for (uint w = 0; w < 7; w++)
                {
                    List<int[]> list = new List<int[]>();
                    uint total = sym.SessionTradeTotal(w);

                    for (uint i = 0; i < total; i++)
                    {
                        if (sym.SessionTradeNext(w, i, sess) != MTRetCode.MT_RET_OK)
                            continue;

                        int open = (int)sess.Open();
                        int close = (int)sess.Close();

                        if (close > open)
                            list.Add(new int[] { open, close });
                    }

                    list.Sort((a, b) => a[0].CompareTo(b[0]));
                    info.Sessions[w] = list;
                    any |= list.Count > 0;
                }
            }

            info.SessionsKnown = any;

            // closeOnlyTradable:平仓 / 改单 / 撤单的检查把「只平」也算可交易,只看时段
            // (见 ManageClosedReason)。/ For the manage check close-only counts as
            // tradable, so only the session decides (see ManageClosedReason).
            bool tradable = info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_FULL
                || info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_LONGONLY
                || info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_SHORTONLY
                || (closeOnlyTradable
                    && info.TradeMode == (int)CIMTConSymbol.EnTradeMode.TRADE_CLOSEONLY);

            if (serverTime <= 0 || !any)
            {
                // 读不到就按「可交易」报,但 SessionsKnown=false 让调用方知道这是没判。
                // Report tradable when unknown; SessionsKnown=false tells callers it wasn't judged.
                info.OpenNow = tradable;
                return info;
            }

            List<HolidayRule> holidays = ReadHolidaysLocked();
            string path = sym.Path() ?? "";

            long dayIndex = serverTime / 86400;
            int minute = (int)((serverTime - dayIndex * 86400) / 60);
            int[] todayHoliday = HolidayWindowFor(holidays, dayIndex, name, path);
            info.Holiday = todayHoliday != null;

            if (!tradable)
            {
                info.OpenNow = false;
                return info;
            }

            // 从今天起最多向前看 8 天找下一段时段。1970-01-01 是周四,MT5 的星期 0 = 周日。
            // Scan up to 8 days ahead. 1970-01-01 was a Thursday; MT5 weekday 0 = Sunday.
            for (int d = 0; d <= 8; d++)
            {
                long day = dayIndex + d;
                int weekday = (int)((day + 4) % 7);
                int[] holiday = d == 0 ? todayHoliday : HolidayWindowFor(holidays, day, name, path);
                List<int[]> sessions = EffectiveSessions(info.Sessions[weekday], holiday);

                foreach (int[] s in sessions)
                {
                    if (d == 0 && minute >= s[1])
                        continue;

                    if (d == 0 && minute >= s[0])
                    {
                        info.OpenNow = true;
                        info.NextOpenUtc = 0;
                        return info;
                    }

                    info.OpenNow = false;
                    info.NextOpenUtc = day * 86400 + (long)s[0] * 60 - info.ServerUtcOffsetSec;
                    return info;
                }
            }

            info.OpenNow = false;
            info.NextOpenUtc = 0;
            return info;
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
            // 连接不在就不去排 _gate,见 LinkDownResult。/ Don't queue on _gate; see LinkDownResult.
            if (!_connected)
                return LinkDownResult();

            Stopwatch sw = Stopwatch.StartNew();
            TradeResult r = OpenPositionCore(login, symbol, isBuy, lots, stopLoss, takeProfit, tag);
            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        /// <summary>发单前置步骤合计超过这个毫秒数就记一行分段耗时。
        /// Log the per-step breakdown when the pre-send steps exceed this.</summary>
        internal const int PrepSlowLogMs = 100;

        private TradeResult OpenPositionCore(ulong login, string symbol, bool isBuy, double lots,
            double stopLoss, double takeProfit, string tag)
        {
            // 发单前各步分段计时。实盘日志里见过 dealer 只用 155ms、整笔却 1.7 秒的开仓,
            // 多出来的时间就在这几步里;合计超过 PrepSlowLogMs 才记一行,平时不刷屏。
            // Per-step timing before the dealer send. Live logs showed a 1.7s open whose
            // dealer leg was 155ms; the rest is in these steps. Logged only when slow.
            Stopwatch prep = Stopwatch.StartNew();

            // 自动补后缀:不同组需要不同后缀品种(如 EURUSD.s)
            string requested = symbol;
            symbol = ResolveSymbol(login, symbol);
            long tResolve = prep.ElapsedMilliseconds;

            // 手数校验必须在补完后缀之后做,否则查不到品种、校验白写(详见
            // ValidateVolumeForSymbol 的注释)。非法手数不会被服务器当场拒绝,
            // 而是变成一张永不成交的订单,后患远大于一次明确的报错。
            // 手数限制按**账号所在组**读:组配置可以覆盖品种的最小/最大/步长。
            // Volume limits are read per account group, which can override the symbol's.
            string group = GroupForLogin(login);
            long tGroup = prep.ElapsedMilliseconds;

            // 本组压根没有这个品种(如 Make Capital demo 的 STD 组没有比特币):当场说清楚,
            // 别再走到取价那一步换一句"取价失败"。
            // The group doesn't offer this symbol at all: say so, not "quote failed".
            if (SymbolMissingForGroup(group, requested))
                return SymbolMissingResult(group, requested);

            // 休市不发 dealer 请求:发了也只会挂成「request adding」。见 MarketClosedReason。
            // Never send a dealer request into a closed market; see MarketClosedReason.
            string closedMsg = MarketClosedReason(symbol, group);

            if (closedMsg != null)
            {
                Log.Warn("开仓时品种休市,已拦下:login={0} {1} -> {2}", login, symbol, closedMsg);
                return TradeResult.Fail(MTRetCode.MT_RET_REQUEST_MARKET_CLOSED.ToString(), closedMsg);
            }

            string volErr = ValidateVolumeForSymbol(symbol, group, lots, "开仓");
            long tVolume = prep.ElapsedMilliseconds;

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

            bool quoted = GetQuote(symbol, out bid, out ask, out qres);
            long tQuote = prep.ElapsedMilliseconds;

            if (tQuote >= PrepSlowLogMs)
            {
                Log.Warn("开仓前置步骤偏慢 {0}ms:品种解析 {1}ms,账号组 {2}ms,手数校验 {3}ms,取价 {4}ms"
                    + "(login={5} {6})",
                    tQuote, tResolve, tGroup - tResolve, tVolume - tGroup, tQuote - tVolume,
                    login, symbol);
            }

            if (!quoted)
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
            // 但带了**止损**时不降级,整单拒绝:手数是按入场到止损的距离算的,止损
            // 被拒通常就是距离太近,此时手数被放得极大,去掉止损重发等于开一张无保护
            // 的重仓。2026-10-01 100405 就是这样:SL 距成交价 0.15、9.75 手裸奔,亏 6035。
            // 只带 TP 时仍降级——没有止损就没有按风险放大的手数,裸开风险与旧行为一致。
            //
            // With a stop-loss requested, reject instead: risk-sized lots scale with the
            // entry-to-SL distance, so a rejected stop usually means a tiny distance and a
            // huge volume — retrying without it opens an unprotected oversized position.
            if (wantLevels && !r.Ok && IsInvalidStops(r.Retcode) && stopLoss > 0)
            {
                Log.Warn("开仓请求的止损被拒({0}),整单拒绝不裸开:login={1} {2} lots={3} sl={4} price={5}",
                    r.Retcode, login, symbol, lots, stopLoss, price);

                return TradeResult.Fail(r.Retcode,
                    "止损离当前价太近,已拒绝下单(避免无止损开仓)/ Stop-loss too close to price, order rejected");
            }

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

            // 开仓答 PLACED 时也要确认真的成交了,与平仓路径对齐(见 ConfirmOpen)。
            // 必须排在补 SL/TP 之前:一张从未成交的订单上补改单毫无意义,
            // 只会再浪费一个 dealer 请求并可能把一条误导性的 Warn 写进日志。
            // Confirm a PLACED open actually filled, mirroring the close path. This
            // must run before the SL/TP repair: repairing levels on a position that
            // does not exist wastes a dealer request and logs a misleading warning.
            if (r.Ok && r.Placed)
                ConfirmOpen(login, symbol, fill, ref r);

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

                    // 这里的 0 是「没要求这一侧」,不是「清除」——翻译成 null。
                    // A 0 here means "not requested", not "clear": pass null.
                    TradeResult m = ModifyPosition(login, ticket,
                        stopLoss > 0 ? (double?)stopLoss : null,
                        takeProfit > 0 ? (double?)takeProfit : null);

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
        private string ValidateVolumeForSymbol(string symbol, string group, double lots, string what)
        {
            double volMin, volMax, volStep;
            MTRetCode sres;

            if (!GetSymbolLimits(symbol, group, out volMin, out volMax, out volStep, out sres))
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

            // 按仓位所属账号的组取限制:平仓和开仓必须用同一套档位,否则一边放行
            // 一边拦下,或者更糟——按别的组的步长放行一笔会锁死仓位的部分平仓。
            // Use the position owner's group so open and close share one rule set.
            string group = GroupForLogin(pos.Login);

            string err = ValidateVolumeForSymbol(pos.Symbol, group, lots, "平仓");
            if (err != null)
                return err;

            double volMin, volMax, volStep;
            MTRetCode sres;

            if (!GetSymbolLimits(pos.Symbol, group, out volMin, out volMax, out volStep, out sres))
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
        /// 确认一笔答复为 PLACED 的**开仓**是否真的成交了,没成交就把结果改成失败。
        ///
        /// 为什么需要它:SendDealerRequest 里那段注释论证过「这条路径只发市价单,
        /// PLACED 没有『已挂单但未成交』的歧义」——平仓腿用的是同一套论证,而生产
        /// 事故已经把它证伪了(订单挂上去、从未执行,并挡住后续平仓)。开仓腿踩到
        /// 同一个机制时的表现更糟:网关回 Ok=true,后端落 FILLED,用户看到一张服务器
        /// 上并不存在的仓位,之后的平仓一律 NOTFOUND。
        ///
        /// 两级确认,与 ConfirmClose 同构:
        ///   1. 成交订阅——开仓成交事件正常 150~200ms 内到,到了就是确认成交;
        ///   2. 向服务器重读仓位——订阅没建立或事件晚到时的权威依据。读到仓位=成交;
        ///      两次都读到 NOTFOUND=这张订单没执行。
        ///
        /// 重读失败(网络/权限)时不改判,维持"当成交"——与 ConfirmClose 取同一个
        /// 保守方向:把一笔真成交报成失败会诱导用户重复开仓,那是更贵的错误。
        ///
        /// 判定没成交时把 Position 清 0:否则那个"拿不到成交号就拿订单号顶替"的兜底
        /// 会给后端一个看似合法、服务器上却不存在的仓位号,平仓明细会挂在空号上。
        ///
        /// Confirms a PLACED open actually executed, mirroring ConfirmClose: fill
        /// subscription first, then an authoritative re-read. A failed re-read leaves
        /// the verdict alone (reporting a real fill as a failure invites a duplicate
        /// open). On a confirmed non-fill the position id is cleared, because the
        /// "fall back to the order ticket" path would otherwise hand the backend a
        /// plausible-looking id for a position that does not exist.
        /// </summary>
        private void ConfirmOpen(ulong login, string symbol, FillInfo fill, ref TradeResult r)
        {
            if (fill != null)
            {
                Log.Info("开仓成交事件已到,确认成交:login={0} {1} deal={2} position={3}",
                    login, symbol, fill.Deal, fill.Position);
                return;
            }

            // 上面那段已经把仓位号解析好了(成交事件 → 反查成交 → 退回订单号)。
            // 三条路都没给出编号时无从确认,只能维持原判并留一条日志。
            // The block above already resolved the ticket; with none of its three
            // sources yielding one there is nothing to re-read.
            ulong ticket = r.Position;

            if (ticket == 0)
            {
                Log.Warn("开仓答复 PLACED 但既无成交号也无订单号,无法确认是否成交:login={0} {1}",
                    login, symbol);
                return;
            }

            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (attempt > 0)
                    System.Threading.Thread.Sleep(ConfirmRecheckDelayMs);

                PositionSnapshot snap;
                bool ignored;
                MTRetCode res;

                // forceServer:本地 pump 快照可能还没收到这笔新仓位,这里要的是权威答案。
                // forceServer: the local pump may not have this brand-new position yet.
                if (ReadPosition(ticket, true, out snap, out ignored, out res))
                {
                    if (snap.Login == login)
                    {
                        Log.Info("仓位 #{0} 已在服务器上,确认开仓成交:login={1} {2} 手数={3}",
                            ticket, login, snap.Symbol, snap.Volume);
                        return;
                    }

                    // 编号存在但不属于这个账号:说明拿订单号顶替仓位号那一步撞号了,
                    // 这个编号不能交给后端。当成"没确认"处理。
                    // The id exists but belongs to someone else: the order-ticket
                    // fallback collided, so this id must not reach the backend.
                    Log.Warn("仓位 #{0} 属于账号 {1} 而非 {2},开仓仓位号不可信",
                        ticket, snap.Login, login);
                    break;
                }

                if (res != MTRetCode.MT_RET_ERR_NOTFOUND)
                {
                    Log.Warn("开仓后重读仓位 #{0} 失败({1}),无法确认是否成交,按成交处理", ticket, res);
                    return;
                }
            }

            Log.Warn("开仓请求被接受但未成交:login={0} {1} order={2} 服务器上查不到仓位 #{3},"
                     + "该订单可能挂在券商队列里",
                     login, symbol, r.Order, ticket);

            r.Ok = false;
            r.Retcode = PlacedUnconfirmed;
            r.Position = 0;
            r.Message = "开仓请求已被服务器接受,但未在确认时限内成交,服务器上查不到对应仓位。"
                      + "这张订单可能仍挂在券商的交易队列里。请不要重复提交,"
                      + "稍后核对持仓,必要时联系券商。";
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

            // 光"有成交事件"还不够,得是**这个仓位**的成交。
            // WaitRecentFill 也按订单号索引,而按订单号索引的那份记录在容量淘汰之前
            // 一直留着、读取也不会消耗它;dealer 回执给出 Deal==0、Order!=0 时,
            // 命中的可能是同一订单号下更早的一笔成交。所以仓位号对不上就不认,
            // 退回下面那两次向服务器重读——慢一点,但结论是权威的。
            // Having *a* fill isn't enough; it must be this position's. Fills are also
            // indexed by order ticket and reads don't consume them, so a confirmation
            // with Deal==0 could match an earlier fill under the same order. If the
            // position id disagrees, fall through to the authoritative re-read.
            if (fill != null && (fill.Position == 0 || fill.Position == ticket))
            {
                Log.Info("平仓成交事件已到,确认成交:ticket={0} deal={1}", ticket, fill.Deal);
                return;
            }

            if (fill != null)
            {
                Log.Warn("收到的成交事件属于仓位 #{0} 而非 #{1},不据此确认,改为向服务器重读",
                    fill.Position, ticket);
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

        /// <summary>
        /// 交易连接不在(SDK 报断线、半开探测判死、或正在重连)时的统一回复。
        ///
        /// 所有交易入口第一步就查 _connected,不在就立刻回这个,**不去排队等 _gate**:
        /// 重连时 ConnectOnce 在锁里最长攥 30 秒(ConnectTimeoutMs),以前这段时间进来的
        /// 下单先在账号解析、取价那几步排到锁,再白等,最后还是失败。这时什么都还没发往
        /// 券商,所以用 MT5 的 MT_RET_ERR_CONNECTION(SendDealerRequest 原本就回这个码):
        /// 后端不把它当"结果未知",按普通拒绝落 REJECTED——确定没执行、可以重下。
        /// The single answer while the trading link is down or reconnecting. Every trade
        /// entry checks _connected first and returns this at once instead of queueing on
        /// _gate, which ConnectOnce may hold for up to 30s. Nothing has reached the broker,
        /// so it is the plain MT_RET_ERR_CONNECTION (what SendDealerRequest already
        /// returned), which the backend records as REJECTED: certainly not executed.
        /// </summary>
        internal static TradeResult LinkDownResult()
        {
            return TradeResult.Fail(MTRetCode.MT_RET_ERR_CONNECTION.ToString(),
                "交易连接重连中,本次指令未发往券商,请稍后重试 / trading link is reconnecting, "
                + "nothing was sent to the broker");
        }

        public TradeResult ClosePosition(ulong login, ulong ticket, double lots, string tag)
        {
            if (!_connected)
                return LinkDownResult();

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

            // 休市不发平仓:dealer 请求会被挂成「request adding」,还带着收盘前的旧价。见 ManageClosedReason。
            // No close into a closed session; see ManageClosedReason.
            string closedMsg = ManageClosedReason(pos.Symbol, GroupForLogin(login));

            if (closedMsg != null)
            {
                Log.Warn("平仓时品种休市,已拦下:login={0} ticket={1} {2} -> {3}",
                    login, ticket, pos.Symbol, closedMsg);

                TradeResult shut = TradeResult.Fail(
                    MTRetCode.MT_RET_REQUEST_MARKET_CLOSED.ToString(), closedMsg);
                shut.ElapsedMs = sw.ElapsedMilliseconds;
                return shut;
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
                    // 按服务器手数重新校验一遍:请求的是部分平仓、而服务器手数已经不够时,
                    // SendClose 会把 lots >= 仓位手数当成全平——一笔部分平仓悄悄变成全平。
                    // 这种情况直接拒绝,让用户按真实手数重下。
                    // Re-validate against the server volume: if a partial close asks for
                    // more than is actually left, SendClose would treat it as a full
                    // close, silently turning a partial close into a full one. Reject.
                    string freshErr = ValidateCloseVolume(fresh, lots);
                    if (freshErr != null)
                    {
                        Log.Warn("本地仓位快照手数过期(本地 {0} / 服务器 {1}),按服务器手数校验不通过,不重发:login={2} ticket={3} lots={4} -> {5}",
                            pos.Volume, fresh.Volume, login, ticket, lots, freshErr);

                        TradeResult bad = TradeResult.Fail(
                            MTRetCode.MT_RET_REQUEST_INVALID_VOLUME.ToString(), freshErr);
                        bad.ElapsedMs = sw.ElapsedMilliseconds;
                        return bad;
                    }

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
        /// 读不到仓位时返回 **false**(视为未生效),让调用方多发一次改单。
        ///
        /// 这里原来返回 true,理由是"真丢了 SL/TP 会在后续持仓推送里暴露"——但
        /// PositionSink 明确不消费 UPDATE(见它的注释),那条兜底并不存在。于是网络
        /// 抖动或权限问题下,一个真的没落上的止损会被当成已生效,仓位裸奔且日志里
        /// 一个字都没有。两种错法的代价不对等:多发一次改单只是一个请求,漏掉止损
        /// 是仓位无保护,所以宁可多发。
        /// Returns false on a failed read so the caller re-sends the modify. It used
        /// to return true on the theory that a lost stop would surface in a later
        /// position push — but PositionSink deliberately ignores UPDATE events, so
        /// that fallback does not exist. An extra modify request is cheap; an
        /// unprotected position is not.
        /// </summary>
        private bool PositionHasLevels(ulong ticket, double stopLoss, double takeProfit)
        {
            try
            {
                lock (_gate)
                {
                    using (CIMTPositionArray arr = _manager.PositionCreateArray())
                    {
                        MTRetCode rres = _manager.PositionRequestByTickets(new ulong[] { ticket }, arr);

                        if (rres != MTRetCode.MT_RET_OK || arr.Total() == 0)
                        {
                            Log.Warn("核对仓位 #{0} 的 SL/TP 时读不到仓位({1}),按未生效处理并补发改单",
                                ticket, rres);
                            return false;
                        }

                        CIMTPosition p = arr.Next(0);
                        if (p == null)
                        {
                            Log.Warn("核对仓位 #{0} 的 SL/TP 时拿到空记录,按未生效处理并补发改单", ticket);
                            return false;
                        }

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
                // 与上面同理:核对不出来就按"没落上"处理,多发一次改单。
                // Same reasoning: unknown means re-send, not assume it landed.
                Log.Warn("核对仓位 SL/TP 失败,按未生效处理并补发改单:{0}", ex.Message);
                return false;
            }
        }

        //+------------------------------------------------------------------+
        //| 改持仓的 SL/TP。0 = 清除该项;null = 保留仓位上的现值,不碰。      |
        //|                                                                  |
        //| 两者必须分开。以前这里无条件对两侧都置 CHANGED 标志,而 MT5 对    |
        //| 「CHANGED + 价格 0」的语义是清除:一条只带 stopLoss 的改单(自动   |
        //| 仓管的保本 / 追踪止损就是这种形状)会把用户的止盈一并抹掉。       |
        //| 「保留」的做法与 OpenPositionCore 一致:不置该侧的 CHANGED 标志,  |
        //| 服务器就不碰那一侧。                                             |
        //| 桥接侧 mt5_worker._modify_position 同一语义;它的注释曾声称网关    |
        //| 「早就只对非 0 的一侧置标志」——那只对开仓成立,改单是这次才改的。 |
        //|                                                                  |
        //| 0 clears a side; null keeps the position's current value. These  |
        //| used to be the same thing here: both CHANGED flags were always    |
        //| set, so a stop-only modify (exactly what auto-management sends)   |
        //| wiped the take-profit. "Keep" mirrors OpenPositionCore: no        |
        //| CHANGED flag for that side, so the server leaves it alone.        |
        //+------------------------------------------------------------------+
        public TradeResult ModifyPosition(ulong login, ulong ticket,
            double? stopLoss, double? takeProfit)
        {
            if (!_connected)
                return LinkDownResult();

            Stopwatch sw = Stopwatch.StartNew();

            if (!stopLoss.HasValue && !takeProfit.HasValue)
                return TradeResult.Fail("MT_RET_ERR_PARAMS", "改单请求两侧都未指定 / neither stopLoss nor takeProfit given");

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

            // 休市不改止损止盈,见 ManageClosedReason / no modify into a closed session
            string closedMsg = ManageClosedReason(symbol, GroupForLogin(login));

            if (closedMsg != null)
            {
                Log.Warn("改单时品种休市,已拦下:login={0} ticket={1} {2} -> {3}",
                    login, ticket, symbol, closedMsg);

                TradeResult shut = TradeResult.Fail(
                    MTRetCode.MT_RET_REQUEST_MARKET_CLOSED.ToString(), closedMsg);
                shut.ElapsedMs = sw.ElapsedMilliseconds;
                return shut;
            }

            TradeResult r = SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_MODIFY);
                req.Symbol(symbol);
                req.Position(ticket);

                CIMTRequest.EnTradeActionFlags flags = 0;

                if (stopLoss.HasValue)
                {
                    req.PriceSL(stopLoss.Value);
                    flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_SL;
                }

                if (takeProfit.HasValue)
                {
                    req.PriceTP(takeProfit.Value);
                    flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_TP;
                }

                req.Flags(flags);
            });

            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        //+------------------------------------------------------------------+
        //| 挂单(限价 / 止损)                                                |
        //|                                                                  |
        //| 与市价开仓的三处关键差别:                                        |
        //|  1. Action 用 TA_DEALER_ORD_PENDING,不是 POS_EXECUTE;            |
        //|  2. PriceOrder 是**用户指定的触发价**,不是当前市价——这里取价     |
        //|     只为校验方向,不参与请求;                                     |
        //|  3. MT_RET_REQUEST_PLACED 在这里就是**正确的成功**:挂单本来就     |
        //|     只是"订单已建立、等待触发",没有"已挂单但未成交"的歧义。      |
        //|     因此绝不能像开仓那样走 ConfirmOpen 去找仓位——那笔仓位本来     |
        //|     就不该存在,确认只会把一次成功的挂单判成失败。                 |
        //|                                                                  |
        //| A pending order differs from a market open in three ways: the     |
        //| dealer action, PriceOrder carrying the user's trigger price       |
        //| rather than the market, and PLACED being the correct success      |
        //| (there is no fill to confirm — running ConfirmOpen here would     |
        //| turn a successful placement into a reported failure).             |
        //+------------------------------------------------------------------+
        public TradeResult PlacePending(ulong login, string symbol,
            CIMTOrder.EnOrderType orderType, double lots, double price,
            double stopLoss, double takeProfit, string tag)
        {
            if (!_connected)
                return LinkDownResult();

            Stopwatch sw = Stopwatch.StartNew();
            TradeResult r = PlacePendingCore(login, symbol, orderType, lots, price,
                stopLoss, takeProfit, tag);
            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        private TradeResult PlacePendingCore(ulong login, string symbol,
            CIMTOrder.EnOrderType orderType, double lots, double price,
            double stopLoss, double takeProfit, string tag)
        {
            string requested = symbol;
            symbol = ResolveSymbol(login, symbol);

            // 手数校验与市价开仓同一套:非法手数不会被当场拒,而是变成一张永不
            // 成交的订单。挂单本来就是"挂着等"的形状,这里更难被用户发现。
            // Same volume validation as a market open — an invalid volume is not
            // refused outright but becomes an order that can never fill, which is
            // even harder to notice on an order that is supposed to sit and wait.
            string group = GroupForLogin(login);

            if (SymbolMissingForGroup(group, requested))
                return SymbolMissingResult(group, requested);

            // 挂单同样不进休市的市场:MT5 周末也不接挂单请求,会挂成「request adding」。
            // Pending orders stay out of a closed market too: MT5 parks them the same way.
            string closedMsg = MarketClosedReason(symbol, group);

            if (closedMsg != null)
            {
                Log.Warn("挂单时品种休市,已拦下:login={0} {1} -> {2}", login, symbol, closedMsg);
                return TradeResult.Fail(MTRetCode.MT_RET_REQUEST_MARKET_CLOSED.ToString(), closedMsg);
            }

            string volErr = ValidateVolumeForSymbol(symbol, group, lots, "挂单");

            if (volErr != null)
            {
                Log.Warn("挂单手数不合法,已拦下:login={0} {1} lots={2} -> {3}",
                    login, symbol, lots, volErr);
                return TradeResult.Fail(
                    MTRetCode.MT_RET_REQUEST_INVALID_VOLUME.ToString(), volErr);
            }

            if (price <= 0)
                return TradeResult.Fail("MT_RET_ERR_PARAMS",
                    "挂单必须指定触发价 / a pending order needs a trigger price");

            // 触发价方向自查:买入限价必须低于卖价、买入止损必须高于卖价,反之亦然。
            // 服务器也会拒(MT_RET_REQUEST_INVALID_PRICE),但那是个裸返回码;这里
            // 当场给出说得清的原因,用户改一个数字就能过。
            // 取不到价就跳过这一步,交给服务器判——宁可少拦一次,也不要因为本地
            // 报价缺失就拒掉一张合法的挂单。
            // Local sanity check on the trigger price. The server rejects these too,
            // but only with a bare retcode; failing here says which way the price has
            // to move. Skipped when no quote is available: better to let the server
            // decide than to refuse a valid order over a missing local quote.
            double bid, ask;
            MTRetCode qres;

            if (GetQuote(symbol, out bid, out ask, out qres) && bid > 0 && ask > 0)
            {
                string priceErr = ValidatePendingPrice(orderType, price, bid, ask);

                if (priceErr != null)
                {
                    Log.Warn("挂单触发价方向不对,已拦下:login={0} {1} {2} price={3} bid={4} ask={5}",
                        login, symbol, orderType, price, bid, ask);
                    return TradeResult.Fail(
                        MTRetCode.MT_RET_REQUEST_INVALID_PRICE.ToString(), priceErr);
                }
            }

            // 成交模式必须显式指定。
            //
            // 这一条是生产实测补的(2026-09-23):不设 TypeFill 时默认值是 0 =
            // ORDER_FILL_FOK,本券商对挂单直接回 MT_RET_REQUEST_INVALID_FILL——
            // 而**市价开仓用同一个默认值却一路正常**,所以照抄 OpenPositionCore
            // 的写法在这里是错的,且错得很隐蔽:日志里只有一个返回码,看不出
            // 是哪个字段的问题。
            //
            // RETURN 才是挂单的标准模式:触发后能成交多少成交多少,剩余部分继续挂着。
            // FOK(全部成交否则取消)/ IOC(成交部分、撤销剩余)对一张"挂在那儿等"的
            // 单语义本来就别扭,只作为券商拒绝 RETURN 时的降级。
            //
            // Filling mode must be set explicitly. Verified in production: leaving it
            // at the default (0 = FOK) makes this broker answer INVALID_FILL for
            // pending orders — while market opens with that same default work fine, so
            // copying OpenPositionCore here was wrong in a way the logs barely show.
            // RETURN is the standard mode for a pending order; FOK/IOC are only the
            // fallback if the broker refuses it.
            CIMTOrder.EnOrderFilling used;

            TradeResult r = SendPendingRequest(symbol, group, out used, mode => req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_ORD_PENDING);
                req.Type(orderType);
                req.Volume(SMTMath.VolumeToInt(lots));
                req.Symbol(symbol);
                req.PriceOrder(price);
                req.TypeFill(mode);
                // GTC:挂单一直有效到成交或撤销。不做成可配置的到期时间——界面上
                // 没有这个输入,给一个用户没选过的到期时间比不给更糟。
                // GTC: valid until filled or cancelled. Deliberately not configurable —
                // the UI has no expiry field, and inventing one the user never chose
                // would be worse than none.
                req.TypeTime(CIMTOrder.EnOrderTime.ORDER_TIME_GTC);
                req.Comment(BuildComment(tag));

                // SL/TP 与开仓同一套写法:只设非 0 的那一侧并置对应 CHANGED 标志。
                // Same as the open path: only the non-zero side is set, with its flag.
                if (stopLoss > 0 || takeProfit > 0)
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

            // 注意:这里**不做**开仓那条"SL/TP 被拒就去掉重发"的降级。
            //
            // 开仓那边降级是对的:仓位马上就要存在,让它裸奔也好过下不出去。挂单
            // 相反——什么都还没建立,这时候悄悄把用户设的止损丢掉、回一个"挂单成功",
            // 等它某天触发时仓位是裸的,而用户完全不知情。直接报错,用户改一下价格
            // 重挂即可,零风险敞口。
            //
            // Deliberately no "retry without SL/TP" fallback here. On a market open
            // that degradation is right: the position is about to exist anyway, and
            // unprotected beats undeliverable. For a pending order nothing exists yet,
            // so silently dropping the stop and answering "placed" would leave an
            // unprotected position whenever it eventually triggers — with the user
            // never told. Failing loudly costs them one edit and risks nothing.
            if (r.Ok)
            {
                Log.Info("挂单已建立:login={0} {1} {2} {3} 手 @ {4} 成交模式={5} ticket={6}",
                    login, symbol, orderType, lots, price, used, r.Order);
            }

            return r;
        }

        /// <summary>
        /// 发一个挂单类的 dealer 请求,并在券商拒绝成交模式时降级重发一次。
        ///
        /// 挂单必须显式带 TypeFill(见 PlacePendingCore 里的实测记录),而"带哪个"要看
        /// 券商:先用 RETURN(挂单的标准模式),被拒再换一个品种自己声明支持的。下挂单
        /// 与改挂单共用这一段,免得两边各写一份、其中一边忘了降级。
        ///
        /// 只在 INVALID_FILL 这一个返回码上重试,且只重试一次:这个码的含义是"这张单
        /// 没被受理",所以重发不存在挂出两张的风险;换成别的失败码就不能这么做。候选
        /// 来自品种配置的 FillFlags 位掩码,不是瞎猜——猜错只会换来第二个同样的返回码。
        ///
        /// `build(mode)` 按给定成交模式产出填请求的委托;`used` 回传最终用的那个模式。
        ///
        /// Send a pending-order dealer request, degrading once if the broker refuses the
        /// filling mode. Shared by placement and modification so the fallback cannot go
        /// missing on one of them. Retried only on INVALID_FILL ("not accepted"), so a
        /// re-send can never leave two orders resting, and only with a mode the symbol
        /// itself declares.
        /// </summary>
        private TradeResult SendPendingRequest(string symbol, string group,
            out CIMTOrder.EnOrderFilling used, Func<CIMTOrder.EnOrderFilling, Action<CIMTRequest>> build)
        {
            used = CIMTOrder.EnOrderFilling.ORDER_FILL_RETURN;
            TradeResult r = SendDealerRequest(build(used));

            if (r.Ok || r.Retcode != MTRetCode.MT_RET_REQUEST_INVALID_FILL.ToString())
                return r;

            CIMTOrder.EnOrderFilling alt;
            uint declared;

            if (!TryAlternateFilling(symbol, group, used, out alt, out declared))
            {
                // FillFlags 是排查这条路的**唯一**有用数字:0 = 品种配置没读出来,
                // 非 0 = 券商只认它里面那几种而我们都试过了。
                // FillFlags is the one number worth having here: 0 means the symbol
                // config could not be read, non-zero means we exhausted what it allows.
                Log.Warn("挂单成交模式 {0} 被拒,该品种没有其它可用模式:{1} FillFlags={2}",
                    used, symbol, declared);
                return r;
            }

            Log.Warn("挂单成交模式 {0} 被拒,改用 {1} 重试一次:{2} FillFlags={3}",
                used, alt, symbol, declared);
            used = alt;
            return SendDealerRequest(build(used));
        }

        /// <summary>
        /// 挑一个该品种声明支持、且与当前不同的成交模式;没有就返回 false。
        ///
        /// 位掩码来自品种配置(`CIMTConSymbol.FillFlags`):FOK=1 / IOC=2 / BOC=4。
        /// 刻意**不把 BOC 当候选**:那是 book-or-cancel(只挂不吃),语义与"到价成交"
        /// 完全不同,拿它当降级会把用户的单变成另一种东西。读不到品种配置时也返回
        /// false——宁可回那个明确的 INVALID_FILL,也不要瞎试一个模式。
        ///
        /// Pick a filling mode the symbol declares and that differs from the current
        /// one. BOC is deliberately excluded: book-or-cancel is a different instruction,
        /// not a degraded form of this one. Unreadable symbol config yields false, so
        /// the caller returns the broker's explicit INVALID_FILL rather than guessing.
        /// </summary>
        private bool TryAlternateFilling(string symbol, string group,
            CIMTOrder.EnOrderFilling current, out CIMTOrder.EnOrderFilling alt, out uint flags)
        {
            alt = CIMTOrder.EnOrderFilling.ORDER_FILL_RETURN;
            flags = 0;

            double volMin, volMax, volStep;
            MTRetCode sres;

            if (!GetSymbolLimits(symbol, group, out volMin, out volMax, out volStep,
                    out flags, out sres))
                return false;

            const uint FILL_FLAGS_FOK = 1;
            const uint FILL_FLAGS_IOC = 2;

            if ((flags & FILL_FLAGS_FOK) != 0 && current != CIMTOrder.EnOrderFilling.ORDER_FILL_FOK)
            {
                alt = CIMTOrder.EnOrderFilling.ORDER_FILL_FOK;
                return true;
            }

            if ((flags & FILL_FLAGS_IOC) != 0 && current != CIMTOrder.EnOrderFilling.ORDER_FILL_IOC)
            {
                alt = CIMTOrder.EnOrderFilling.ORDER_FILL_IOC;
                return true;
            }

            return false;
        }

        /// <summary>
        /// 挂单触发价的方向自查。合法返回 null,不合法返回可直接展示给用户的原因。
        ///
        /// 限价 = 在比现价更有利的位置等,止损 = 在更不利的位置突破后追。买单参照
        /// ask(买入的成交价),卖单参照 bid,与市价开仓取价的口径一致。
        ///
        /// 不检查最小止损距离(SYMBOL_TRADE_STOPS_LEVEL):那是按品种配的,这里没有
        /// 现成入口,而服务器会拒。方向搞反是最常见的一种错,挡住它收益最大。
        ///
        /// Direction check for a pending order's trigger price. Limit orders wait at a
        /// better price than the market, stop orders chase a worse one; buys compare
        /// against ask and sells against bid, matching how market opens pick a price.
        /// The per-symbol minimum stop distance is left to the server — getting the
        /// direction backwards is the common mistake and the one worth catching.
        /// </summary>
        internal static string ValidatePendingPrice(CIMTOrder.EnOrderType orderType,
            double price, double bid, double ask)
        {
            switch (orderType)
            {
                case CIMTOrder.EnOrderType.OP_BUY_LIMIT:
                    return price < ask ? null
                        : "买入限价必须低于当前卖价 " + ask.ToString(CultureInfo.InvariantCulture)
                          + " / buy limit must be below ask";
                case CIMTOrder.EnOrderType.OP_BUY_STOP:
                    return price > ask ? null
                        : "买入止损必须高于当前卖价 " + ask.ToString(CultureInfo.InvariantCulture)
                          + " / buy stop must be above ask";
                case CIMTOrder.EnOrderType.OP_SELL_LIMIT:
                    return price > bid ? null
                        : "卖出限价必须高于当前买价 " + bid.ToString(CultureInfo.InvariantCulture)
                          + " / sell limit must be above bid";
                case CIMTOrder.EnOrderType.OP_SELL_STOP:
                    return price < bid ? null
                        : "卖出止损必须低于当前买价 " + bid.ToString(CultureInfo.InvariantCulture)
                          + " / sell stop must be below bid";
                default:
                    return "不支持的挂单类型 / unsupported pending order type";
            }
        }

        /// <summary>
        /// 把 HTTP 层的挂单类型名解析成 SDK 枚举。认不出来返回 false。
        /// Parse the wire-level pending type name into the SDK enum.
        /// </summary>
        internal static bool TryParsePendingType(string name, out CIMTOrder.EnOrderType type)
        {
            switch ((name ?? "").ToUpperInvariant())
            {
                case "BUY_LIMIT": type = CIMTOrder.EnOrderType.OP_BUY_LIMIT; return true;
                case "SELL_LIMIT": type = CIMTOrder.EnOrderType.OP_SELL_LIMIT; return true;
                case "BUY_STOP": type = CIMTOrder.EnOrderType.OP_BUY_STOP; return true;
                case "SELL_STOP": type = CIMTOrder.EnOrderType.OP_SELL_STOP; return true;
                default: type = CIMTOrder.EnOrderType.OP_BUY; return false;
            }
        }

        //+------------------------------------------------------------------+
        //| 改挂单:触发价 / 止损 / 止盈                                      |
        //|                                                                  |
        //| 三项的语义与改持仓(ModifyPosition)完全一致:null = 保留现值、     |
        //| 0 = 清除(仅 SL/TP;触发价没有"清除"这回事,0 当作没传)。          |
        //| 三项都没传就不发 dealer,直接回参数错——发一个什么都不改的请求    |
        //| 只会白占一个 dealer 名额,还会在日志里留下一条看不出意图的记录。  |
        //|                                                                  |
        //| Same semantics as ModifyPosition: null keeps, 0 clears (SL/TP only —    |
        //| a trigger price has no "clear", so 0 reads as absent). With nothing      |
        //| specified no dealer request goes out.                                    |
        //+------------------------------------------------------------------+
        public TradeResult ModifyPending(ulong login, ulong ticket,
            double? price, double? stopLoss, double? takeProfit)
        {
            if (!_connected)
                return LinkDownResult();

            Stopwatch sw = Stopwatch.StartNew();
            TradeResult r = ModifyPendingCore(login, ticket, price, stopLoss, takeProfit);
            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        private TradeResult ModifyPendingCore(ulong login, ulong ticket,
            double? price, double? stopLoss, double? takeProfit)
        {
            if (!price.HasValue && !stopLoss.HasValue && !takeProfit.HasValue)
                return TradeResult.Fail("MT_RET_ERR_PARAMS",
                    "改挂单请求三项都未指定 / neither price, stopLoss nor takeProfit given");

            OrderInfo ord;
            ulong ordLogin;
            MTRetCode ores;

            // 与撤单同一条前置:读回这张挂单。这里除了校验归属,还要拿它的品种、
            // 类型、手数填进请求——ORD_MODIFY 改的是这张单的某几项,其余项必须
            // 原样带上,不能留空让服务器去猜。
            // Same prologue as the cancel path: read the order back, both to verify
            // ownership and to echo the fields this request is not changing.
            if (!ReadPendingOrder(ticket, out ord, out ordLogin, out ores))
                return TradeResult.Fail(ores.ToString(),
                    "找不到挂单 #" + ticket + "(可能已成交、已过期或已撤销)");

            if (ordLogin != login)
                return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                    "挂单 #" + ticket + " 不属于账号 " + login);

            // 休市不改挂单,见 ManageClosedReason / no pending modify into a closed session
            string closedMsg = ManageClosedReason(ord.Symbol, GroupForLogin(login));

            if (closedMsg != null)
            {
                Log.Warn("改挂单时品种休市,已拦下:login={0} ticket={1} {2} -> {3}",
                    login, ticket, ord.Symbol, closedMsg);
                return TradeResult.Fail(MTRetCode.MT_RET_REQUEST_MARKET_CLOSED.ToString(), closedMsg);
            }

            double newPrice = price.HasValue && price.Value > 0 ? price.Value : ord.PriceOrder;

            // 改了触发价就再查一次方向。挂单挂了一阵之后行情可能已经走到触发价的另
            // 一侧,这时把买入限价往上拖会越过市价、变成一张服务器必拒的单——当场
            // 说清楚"该往哪边改",比回一个 MT_RET_REQUEST_INVALID_PRICE 有用得多。
            // Re-check the direction when the trigger moves: the market may have crossed
            // the order's price while it rested, and dragging a buy limit above the
            // market produces a request the server will certainly refuse. Saying which
            // way it has to move beats echoing INVALID_PRICE.
            if (price.HasValue)
            {
                double bid, ask;
                MTRetCode qres;

                if (GetQuote(ord.Symbol, out bid, out ask, out qres) && bid > 0 && ask > 0)
                {
                    string priceErr = ValidatePendingPrice(
                        (CIMTOrder.EnOrderType)ord.Type, newPrice, bid, ask);

                    if (priceErr != null)
                    {
                        Log.Warn("改挂单触发价方向不对,已拦下:login={0} ticket={1} price={2} bid={3} ask={4}",
                            login, ticket, newPrice, bid, ask);
                        return TradeResult.Fail(
                            MTRetCode.MT_RET_REQUEST_INVALID_PRICE.ToString(), priceErr);
                    }
                }
            }

            CIMTOrder.EnOrderFilling usedFill;

            TradeResult r = SendPendingRequest(ord.Symbol, GroupForLogin(login), out usedFill, mode => req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_ORD_MODIFY);
                req.Order(ticket);
                req.Symbol(ord.Symbol);
                req.Type((CIMTOrder.EnOrderType)ord.Type);
                req.Volume(SMTMath.VolumeToInt(ord.Volume));
                req.PriceOrder(newPrice);
                req.TypeFill(mode);
                req.TypeTime(CIMTOrder.EnOrderTime.ORDER_TIME_GTC);

                CIMTRequest.EnTradeActionFlags flags = 0;

                if (price.HasValue)
                    flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_PRICE;

                // 没传的那一侧不置 CHANGED 标志,服务器就不碰它——与 ModifyPosition
                // 同一套。传 0 仍然是清除:标志置上、价格给 0。
                // An unspecified side gets no CHANGED flag and the server leaves it
                // alone, exactly as in ModifyPosition. An explicit 0 still clears.
                if (stopLoss.HasValue)
                {
                    req.PriceSL(stopLoss.Value);
                    flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_SL;
                }

                if (takeProfit.HasValue)
                {
                    req.PriceTP(takeProfit.Value);
                    flags |= CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_TP;
                }

                req.Flags(flags);
            });

            if (r.Ok)
            {
                Log.Info("改挂单成功:login={0} ticket={1} price={2} SL={3} TP={4}",
                    login, ticket,
                    price.HasValue ? newPrice.ToString(CultureInfo.InvariantCulture) : "keep",
                    stopLoss.HasValue ? stopLoss.Value.ToString(CultureInfo.InvariantCulture) : "keep",
                    takeProfit.HasValue ? takeProfit.Value.ToString(CultureInfo.InvariantCulture) : "keep");
            }

            return r;
        }

        //+------------------------------------------------------------------+
        //| 撤挂单                                                           |
        //|                                                                  |
        //| 先读回这张挂单:一是校验归属(不能让 A 账号撤掉 B 账号的单),      |
        //| 二是把品种/类型/手数/价格原样填回请求——服务器对 ORD_REMOVE 主要  |
        //| 认订单号,但填全了才不至于在某些配置下被判成参数不全。            |
        //| 读不到就说明它已经不在了(成交、过期、或早就被撤),这时回一个      |
        //| 说得清的"挂单不存在",而不是让 dealer 白等一轮再回裸返回码。      |
        //|                                                                  |
        //| Read the order back first: to verify ownership, and to echo its   |
        //| fields into the request. A missing order means it already filled, |
        //| expired or was cancelled — answered here rather than after a      |
        //| wasted dealer round trip.                                         |
        //+------------------------------------------------------------------+
        public TradeResult CancelPending(ulong login, ulong ticket)
        {
            if (!_connected)
                return LinkDownResult();

            Stopwatch sw = Stopwatch.StartNew();
            TradeResult r = CancelPendingCore(login, ticket);
            r.ElapsedMs = sw.ElapsedMilliseconds;
            return r;
        }

        private TradeResult CancelPendingCore(ulong login, ulong ticket)
        {
            OrderInfo ord;
            ulong ordLogin;
            MTRetCode ores;

            if (!ReadPendingOrder(ticket, out ord, out ordLogin, out ores))
                return TradeResult.Fail(ores.ToString(),
                    "找不到挂单 #" + ticket + "(可能已成交、已过期或已撤销)");

            if (ordLogin != login)
                return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                    "挂单 #" + ticket + " 不属于账号 " + login);

            // 休市不撤挂单,见 ManageClosedReason / no pending cancel into a closed session
            string closedMsg = ManageClosedReason(ord.Symbol, GroupForLogin(login));

            if (closedMsg != null)
            {
                Log.Warn("撤挂单时品种休市,已拦下:login={0} ticket={1} {2} -> {3}",
                    login, ticket, ord.Symbol, closedMsg);
                return TradeResult.Fail(MTRetCode.MT_RET_REQUEST_MARKET_CLOSED.ToString(), closedMsg);
            }

            return SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_ORD_REMOVE);
                req.Order(ticket);
                req.Symbol(ord.Symbol);
                req.Type((CIMTOrder.EnOrderType)ord.Type);
                req.Volume(SMTMath.VolumeToInt(ord.Volume));
                req.PriceOrder(ord.PriceOrder);
            });
        }

        /// <summary>
        /// 按票号向服务器读一张挂单。找不到返回 false。
        /// Read one pending order by ticket from the server; false when it is gone.
        /// </summary>
        private bool ReadPendingOrder(ulong ticket, out OrderInfo info, out ulong login, out MTRetCode res)
        {
            info = null;
            login = 0;

            lock (_gate)
            {
                using (CIMTOrderArray arr = _manager.OrderCreateArray())
                {
                    res = _manager.OrderRequestByTickets(new ulong[] { ticket }, arr);

                    if (res != MTRetCode.MT_RET_OK || arr.Total() == 0)
                    {
                        if (res == MTRetCode.MT_RET_OK)
                            res = MTRetCode.MT_RET_ERR_NOTFOUND;
                        return false;
                    }

                    CIMTOrder o = arr.Next(0);

                    if (o == null)
                    {
                        res = MTRetCode.MT_RET_ERR_NOTFOUND;
                        return false;
                    }

                    login = o.Login();
                    info = new OrderInfo
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
                    return true;
                }
            }
        }

        //+------------------------------------------------------------------+
        //| dealer 请求的公共流程:建对象 -> 填参数 -> 发送 -> 等回执         |
        //+------------------------------------------------------------------+
        private TradeResult SendDealerRequest(Action<CIMTRequest> fill)
        {
            if (!_connected)
                return LinkDownResult();

            // dealer 通道没起来时立刻说清楚,而不是白等满 DealerTimeoutMs(默认 60 秒)
            // 再报一个"超时"。这条以前没有,于是 Program 的 closeall(用 ConnectOnly()
            // 连接,根本没 DealerStart)会在每一笔仓位上空等 60 秒——而那是出事时最后
            // 的人工兜底手段,最不该是这个表现。
            // Fail fast when the dealer channel isn't up instead of waiting out the full
            // 60s timeout per request — which is exactly what the emergency close-all
            // tool used to do on every position.
            if (!_dealerActive)
                return TradeResult.Fail("MT_RET_ERR_NOTIMPLEMENT",
                    "dealer 通道未启动,无法代客下单(用 Start() 而不是 ConnectOnly(),"
                    + "或检查 manager 账号的 RIGHT_TRADES_DEALER 权限)");

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
                    _liveSinks[sink] = 0;

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

                // 超时或等待中断线:请求**已经发出去了**,券商那边可能已经成交。以前回的是
                // 普通失败码 MT_RET_REQUEST_TIMEOUT,后端把它落成 REJECTED("被拒绝"),用户
                // 于是换一个新 clientOrderId 重下——真仓里就多一笔。改回"已发出、结果未知",
                // 后端落 FAILED 并提示先核对持仓。
                // Timed out or the link dropped mid-wait: the request *was sent* and may
                // have filled. The plain MT_RET_REQUEST_TIMEOUT used to land as REJECTED,
                // inviting a re-place under a new clientOrderId — a duplicate position.
                // Report "sent, outcome unknown" so the backend records FAILED.
                if (res == MTRetCode.MT_RET_REQUEST_TIMEOUT)
                {
                    bool dropped = sink.LinkDropped;
                    Log.Warn("dealer 请求 {0} {1},未收到答复,结果未知", requestId,
                        dropped ? "等待中连接断开" : "超时");

                    // 请 watchdog 立刻补探一次:dealer 不答往往就是连接半开的第一个信号,
                    // 不必等下一个定时探测。断线叫醒的那种,标志留到连回来之后再探。
                    // Ask the watchdog to probe now: a silent dealer is often the first
                    // sign of a half-open link. After a drop it fires once reconnected.
                    _probeRequested = true;

                    TradeResult unknown = TradeResult.Fail(PlacedUnconfirmed,
                        (dropped ? "等待成交回执时与 MT5 的连接断开" : "等待成交回执超时")
                        + ",这笔指令可能已经执行。请先核对持仓与成交记录,不要直接重下。");
                    unknown.DealerMs = dealerMs;
                    return unknown;
                }

                // 收到了回执(不论成交与否):这条连接此刻确实能和服务器往返,
                // 这一周期的定时探测可以省掉。
                // An answer arrived, fill or not: the link round-trips right now, so
                // this period's regular probe can be skipped.
                _lastRoundTripAt = Environment.TickCount;

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
                // 先退订,确保原生层不再**发起**新的回调。
                // First unsubscribe so the native layer starts no new callbacks.
                lock (_gate)
                {
                    if (sink != null)
                    {
                        try { _manager.DealerUnsubscribe(sink); }
                        catch { }
                    }
                }

                // 再弃用 sink。这一步会等已经进入回调的那一次执行完——DealerUnsubscribe
                // 并不保证这件事,而超时路径正是"回执在路上"的典型时刻。不这么做,
                // 下面的 Dispose 就可能让原生回调写进已释放的托管对象:进程级
                // AccessViolation,catch 不住,所有在途下单一起中断。
                // 放在 _gate 之外:Abandon 可能要等回调跑完,而回调里会写日志、不该
                // 让它和这把全局锁纠缠在一起。
                // Then abandon the sink, which waits out any callback already running —
                // something DealerUnsubscribe does not guarantee. Done outside _gate so
                // waiting for a callback never interleaves with the global lock.
                if (sink != null)
                {
                    byte ignoredByte;
                    _liveSinks.TryRemove(sink, out ignoredByte);
                    sink.Abandon();
                    // Abandon 之后回调再也不碰这个句柄,可以放心释放(见 ReleaseWait 说明)。
                    // Safe once abandoned: no callback touches the handle any more.
                    sink.ReleaseWait();
                }

                lock (_gate)
                {
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
                case MTRetCode.MT_RET_REQUEST_INVALID_FILL:
                    // 兜底那句("检查品种名、手数、保证金、市场是否开市")把人引向
                    // 四个都不相干的方向:这个码只说明**成交模式**不被该品种接受,
                    // 与品种名、手数、保证金、开市与否统统无关。挂单路径已经会自动
                    // 换一个品种声明支持的模式重试,走到这里说明连那个也被拒了。
                    // The generic fallback points at four irrelevant things; this code is
                    // only ever about the filling mode. The pending path already retries
                    // with a mode the symbol declares, so reaching here means that failed too.
                    return "该品种不接受本次请求的成交模式(filling mode),日志里的 FillFlags 是它声明支持的模式";
                case MTRetCode.MT_RET_REQUEST_INVALID_PRICE:
                    // 同理:价格类拒绝不该被说成"检查手数和保证金"。挂单最常见的原因
                    // 是触发价离现价太近(小于品种的最小止损距离)。
                    // Price rejections must not read as "check your volume and margin";
                    // for a pending order the usual cause is a trigger too close to market.
                    return "价格不被接受(挂单触发价可能离现价太近,小于该品种的最小距离)";
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

                    if (_ordSink != null)
                    {
                        try { _manager.OrderUnsubscribe(_ordSink); }
                        catch { }
                    }

                    _manager.Disconnect();
                    _manager.Dispose();
                    _manager = null;
                }
            }

            // 先等维护线程退出,免得它在 Dispose 之后又把通道连回去。
            // Let the keeper exit first so it can't reconnect a channel after Dispose.
            if (_readsKeeper != null)
            {
                _readsKeeper.Join(3000);
                _readsKeeper = null;
            }

            if (_reads != null)
            {
                _reads.Dispose();
                _reads = null;
            }

            SMTManagerAPIFactory.Shutdown();
        }
    }
}
