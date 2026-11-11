//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 并发规则(2026-11-11 架构优化阶段 4)        |
//|                                                                  |
//| 交易入口的统一外壳。每笔交易进来先过这几道:                      |
//|   1. 锁被占太久 → 直接回"繁忙、未发出";                           |
//|   2. 断线时:开仓立刻回"重连中";平仓/改单/撤单最多排队等连接回来  |
//|      queue_closes_on_disconnect_ms(默认 10 秒);                   |
//|   3. 全网关同时在途的交易不超过 max_inflight_trades(64),每个账号  |
//|      同时在途的开仓不超过 max_open_inflight_per_account(8),排不上 |
//|      的最多等 2 秒(开仓)/ 3 秒(平仓);全平免排账号名额;          |
//|   4. 同一张仓位/挂单的操作排成一列,不并发;同一张仓位刚被全平过, |
//|      重复的全平直接回那一次的结果;                                |
//|   5. 下单时在 comment 末尾带一个由 clientOrderId 算出的短码,结果  |
//|      未知时按它到服务器核对(见 Mt5Link.Reconcile.cs)。            |
//| 重报价类拒绝的自动重试也在这里(只对"肯定没成交"的返回码)。        |
//|                                                                  |
//| Phase 4 of the 2026-11-11 order-path work: one shell around every |
//| trade entry — gate fail-fast, disconnect handling (opens refused, |
//| closes/modifies queue up to 10s), in-flight caps (64 global, 8    |
//| opens per account), per-ticket serialisation with duplicate full- |
//| close collapsing, the comment short code for reconciliation, and  |
//| requote retries for retcodes that guarantee nothing executed.     |
//+------------------------------------------------------------------+
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using MetaQuotes.MT5CommonAPI;

namespace Prismx.Mt5Gateway
{
    internal sealed partial class Mt5Link
    {
        private SemaphoreSlim _tradeSlots;
        private readonly object _guardInitLock = new object();

        private readonly ConcurrentDictionary<ulong, SemaphoreSlim> _openSlotsByLogin =
            new ConcurrentDictionary<ulong, SemaphoreSlim>();

        private readonly ConcurrentDictionary<ulong, SemaphoreSlim> _ticketLocks =
            new ConcurrentDictionary<ulong, SemaphoreSlim>();

        private struct RecentClose
        {
            public TradeResult Result;
            public int At;
        }

        // 刚被全平的仓位 → 那一次的结果,10 秒内重复的全平直接回它。
        // Recently fully closed positions → that close's result, for 10s.
        private readonly ConcurrentDictionary<ulong, RecentClose> _recentFullCloses =
            new ConcurrentDictionary<ulong, RecentClose>();

        private const int RecentFullCloseMs = 10000;

        private int _inflight;
        private int _queuedRejects;
        private int _dupClosesCollapsed;
        private int _requoteRetries;
        private int _closesQueuedOnDisconnect;

        public int TradesInflight { get { return Thread.VolatileRead(ref _inflight); } }
        public int TradeQueueRejects { get { return Thread.VolatileRead(ref _queuedRejects); } }
        public int DuplicateClosesCollapsed { get { return Thread.VolatileRead(ref _dupClosesCollapsed); } }
        public int RequoteRetries { get { return Thread.VolatileRead(ref _requoteRetries); } }
        public int ClosesQueuedOnDisconnect { get { return Thread.VolatileRead(ref _closesQueuedOnDisconnect); } }

        private SemaphoreSlim TradeSlots
        {
            get
            {
                if (_tradeSlots == null)
                {
                    lock (_guardInitLock)
                    {
                        if (_tradeSlots == null)
                            _tradeSlots = new SemaphoreSlim(_cfg.MaxInflightTrades, _cfg.MaxInflightTrades);
                    }
                }
                return _tradeSlots;
            }
        }

        /// <summary>本次调用的 comment 短码(同一线程同步执行整笔交易,所以用线程局部)。
        /// The comment code for the current call; a trade runs synchronously on one thread.</summary>
        [ThreadStatic]
        private static string _commentCode;

        //+--------------------------------------------------------------+
        //| 公开的交易入口 / public trade entries                         |
        //+--------------------------------------------------------------+

        public TradeResult OpenPosition(ulong login, string symbol, bool isBuy, double lots,
            double stopLoss, double takeProfit, string tag, string clientOrderId = null)
        {
            return Guarded("开仓", login, 0, true, false, false, clientOrderId,
                () => OpenPositionUnguarded(login, symbol, isBuy, lots, stopLoss, takeProfit, tag),
                "open", symbol);
        }

        public TradeResult ClosePosition(ulong login, ulong ticket, double lots, string tag,
            string clientOrderId = null)
        {
            bool full = lots <= 0;

            // 同一张仓位刚被全平过:重复的全平(用户连点、两个页面同时点)直接回那一次的结果。
            // A duplicate full close of a just-closed position gets that close's result.
            if (full)
            {
                TradeResult recent = RecentFullClose(ticket);
                if (recent != null)
                    return recent;
            }

            return Guarded("平仓", login, ticket, false, true, full, clientOrderId, () =>
            {
                // 排到这张仓位的锁之后再看一次:前面那笔全平可能刚做完。
                // Look again once this ticket's turn comes: the close ahead may have just finished.
                if (full)
                {
                    TradeResult again = RecentFullClose(ticket);
                    if (again != null)
                        return again;
                }

                TradeResult r = ClosePositionUnguarded(login, ticket, lots, tag);
                if (r.Ok && !r.Placed)
                    RememberFullCloseIfGone(ticket, r);
                return r;
            }, "close", null);
        }

        public TradeResult ModifyPosition(ulong login, ulong ticket, double? stopLoss, double? takeProfit)
        {
            return Guarded("改单", login, ticket, false, true, false, null,
                () => ModifyPositionUnguarded(login, ticket, stopLoss, takeProfit), "modify", null);
        }

        public TradeResult PlacePending(ulong login, string symbol, CIMTOrder.EnOrderType orderType,
            double lots, double price, double stopLoss, double takeProfit, string tag,
            string clientOrderId = null)
        {
            return Guarded("挂单", login, 0, true, false, false, clientOrderId,
                () => PlacePendingUnguarded(login, symbol, orderType, lots, price, stopLoss, takeProfit, tag),
                "pending", symbol);
        }

        public TradeResult ModifyPending(ulong login, ulong ticket, double? price, double? stopLoss,
            double? takeProfit)
        {
            return Guarded("改挂单", login, ticket, false, true, false, null,
                () => ModifyPendingUnguarded(login, ticket, price, stopLoss, takeProfit), "modify_pending", null);
        }

        public TradeResult CancelPending(ulong login, ulong ticket)
        {
            return Guarded("撤挂单", login, ticket, false, true, false, null,
                () => CancelPendingUnguarded(login, ticket), "cancel", null);
        }

        //+--------------------------------------------------------------+
        //| 外壳 / the shell                                              |
        //+--------------------------------------------------------------+

        /// <param name="isOpen">开新仓/新挂单:占账号名额,断线不排队。/ Opens: per-account slot, never queue.</param>
        /// <param name="mayQueueOnDisconnect">平仓/改单/撤单:断线时可以排队等连接回来。</param>
        /// <param name="fullClose">全平:不占账号名额,排队时间按平仓算。/ Full close: exempt from per-account caps.</param>
        private TradeResult Guarded(string what, ulong login, ulong ticket, bool isOpen,
            bool mayQueueOnDisconnect, bool fullClose, string clientOrderId, Func<TradeResult> run,
            string kind, string symbol)
        {
            Stopwatch sw = Stopwatch.StartNew();
            TradeTimeline tl = new TradeTimeline(kind, login, symbol);

            // 平仓类对"锁被占"更有耐心,见 EffectiveFailFastMs。/ Closes are more patient.
            int previousOverride = _failFastOverrideMs;
            _failFastOverrideMs = mayQueueOnDisconnect ? ProtectiveFailFastMs : 0;
            try
            {
                return GuardedCore(what, login, ticket, isOpen, mayQueueOnDisconnect, fullClose,
                    clientOrderId, run, kind, sw, tl);
            }
            finally
            {
                _failFastOverrideMs = previousOverride;
            }
        }

        private TradeResult GuardedCore(string what, ulong login, ulong ticket, bool isOpen,
            bool mayQueueOnDisconnect, bool fullClose, string clientOrderId, Func<TradeResult> run,
            string kind, Stopwatch sw, TradeTimeline tl)
        {
            TradeResult busy = GateBusyGuard();
            if (busy != null)
                return Finish(tl, busy, sw);

            // 断线:开仓立刻回"重连中"(什么都没发);平仓类最多等 queue_closes_on_disconnect_ms。
            // Disconnected: opens answer at once; close-type actions wait for a reconnect.
            // 只看 _connected:连着但 dealer 没起来(Program 的 closeall 用 ConnectOnly() 连接,
            // 从不 DealerStart)时照常往下走,由 SendDealerRequest 当场说清楚,不白等 10 秒。
            // Only _connected decides: connected without a dealer (closeall's ConnectOnly)
            // falls through to SendDealerRequest's clear error instead of waiting 10s.
            if (!_connected)
            {
                if (!mayQueueOnDisconnect || _cfg.QueueClosesOnDisconnectMs <= 0)
                {
                    return Finish(tl, LinkDownResult(), sw);
                }
                else if (!WaitForLink(_cfg.QueueClosesOnDisconnectMs))
                {
                    return Finish(tl, LinkDownResult(), sw);
                }
                else
                {
                    Interlocked.Increment(ref _closesQueuedOnDisconnect);
                    Log.Info("{0} 在断线期间排队,连接已恢复,继续执行 login={1} ticket={2}", what, login, ticket);
                }
            }

            int waitMs = isOpen ? _cfg.TradeQueueWaitMs : _cfg.CloseQueueWaitMs;
            int deadline = unchecked(Environment.TickCount + waitMs);

            SemaphoreSlim perAccount = null;
            SemaphoreSlim perTicket = null;
            bool gotGlobal = false, gotAccount = false, gotTicket = false;

            try
            {
                // 账号名额(只管开仓;全平永远不占)。/ Per-account slot (opens only).
                if (isOpen && !fullClose)
                {
                    int cap = _cfg.MaxOpenInflightPerAccount;
                    perAccount = _openSlotsByLogin.GetOrAdd(login, _ => new SemaphoreSlim(cap, cap));
                    gotAccount = perAccount.Wait(Remaining(deadline));
                    if (!gotAccount)
                        return Finish(tl, QueueFullResult(what, "该账号同时在处理的开仓已达上限"), sw);
                }

                // 同一张仓位/挂单排成一列。/ One at a time per ticket.
                if (ticket != 0)
                {
                    perTicket = _ticketLocks.GetOrAdd(ticket, _ => new SemaphoreSlim(1, 1));
                    gotTicket = perTicket.Wait(Remaining(deadline));
                    if (!gotTicket)
                        return Finish(tl, QueueFullResult(what, "同一仓位上一笔操作还在处理"), sw);
                }

                // 全网关名额。全平也占(它同样要发 dealer 请求),但排队时间按平仓算。
                // Gateway-wide slot; full closes take one too, with the close queueing cap.
                gotGlobal = TradeSlots.Wait(Remaining(deadline));
                if (!gotGlobal)
                    return Finish(tl, QueueFullResult(what, "网关同时在处理的交易已达上限"), sw);

                tl.Mark("admitted");
                Interlocked.Increment(ref _inflight);

                string previousCode = _commentCode;
                _commentCode = _cfg.CommentCode ? CommentCodeFor(clientOrderId) : null;

                try
                {
                    TradeResult r = run();

                    // 结果未知:按 comment 短码到服务器核对,核对出来写回幂等记录并发事件。
                    // Unknown outcome: reconcile by the comment code in the background.
                    if (r != null && r.SentUnknown && !string.IsNullOrEmpty(_commentCode)
                        && !string.IsNullOrEmpty(clientOrderId))
                        ScheduleReconcile(login, kind, clientOrderId, _commentCode, ticket, r);

                    return Finish(tl, r, sw);
                }
                finally
                {
                    _commentCode = previousCode;
                    Interlocked.Decrement(ref _inflight);
                }
            }
            finally
            {
                if (gotGlobal)
                    TradeSlots.Release();
                if (gotTicket)
                    perTicket.Release();
                if (gotAccount)
                    perAccount.Release();
            }
        }

        private TradeResult Finish(TradeTimeline tl, TradeResult r, Stopwatch sw)
        {
            if (r != null && r.ElapsedMs == 0)
                r.ElapsedMs = sw.ElapsedMilliseconds;

            tl.Done(r);
            NoteTrade(tl, r);
            return r;
        }

        private static int Remaining(int deadline)
        {
            return Math.Max(0, unchecked(deadline - Environment.TickCount));
        }

        private TradeResult QueueFullResult(string what, string why)
        {
            Interlocked.Increment(ref _queuedRejects);
            Log.Warn("{0} 排队超时:{1},本次指令未发往券商", what, why);
            return TradeResult.Fail(GatewayBusyRetcode,
                why + ",本次指令未发往券商,请稍后重试 / too many trades in flight, nothing was sent");
        }

        /// <summary>HTTP 入口用:平仓类请求断线时排队等连接。/ For the HTTP layer's close queueing.</summary>
        public bool WaitForLinkUp(int ms)
        {
            return WaitForLink(ms);
        }

        /// <summary>等连接与 dealer 都回来,最多 ms 毫秒。/ Wait up to ms for link and dealer.</summary>
        private bool WaitForLink(int ms)
        {
            int until = unchecked(Environment.TickCount + ms);
            while (!_stopping && unchecked(until - Environment.TickCount) > 0)
            {
                if (_connected && _dealerActive)
                    return true;
                Thread.Sleep(100);
            }
            return _connected && _dealerActive;
        }

        private TradeResult RecentFullClose(ulong ticket)
        {
            RecentClose rc;
            if (!_recentFullCloses.TryGetValue(ticket, out rc))
                return null;

            if (unchecked(Environment.TickCount - rc.At) > RecentFullCloseMs)
            {
                _recentFullCloses.TryRemove(ticket, out rc);
                return null;
            }

            Interlocked.Increment(ref _dupClosesCollapsed);
            Log.Info("仓位 #{0} 刚被全平过,重复的全平直接回那一次的结果", ticket);
            return rc.Result;
        }

        private void RememberFullCloseIfGone(ulong ticket, TradeResult r)
        {
            // 只记"仓位确实没了"的:部分平仓后仓位还在,不能挡住下一次平仓。
            // Only when the position is really gone; a partial close must not block the next.
            // 本地 pump 内存读,锁最多等 200ms;拿不到就不记(只是少一次去重,不影响平仓结果)。
            // A local pump read with a 200ms lock cap; on a miss just skip the dedupe.
            if (!Monitor.TryEnter(_gate, 200))
                return;

            NoteGateAcquired();
            try
            {
                using (CIMTPosition p = _manager.PositionCreate())
                {
                    if (p != null && _manager.PositionGetByTicket(ticket, p) == MTRetCode.MT_RET_OK)
                        return;
                }
            }
            finally
            {
                NoteGateReleasing();
                Monitor.Exit(_gate);
            }

            RecentClose rc;
            rc.Result = r;
            rc.At = Environment.TickCount;
            _recentFullCloses[ticket] = rc;

            // 顺手清掉过期的 / prune old entries
            if (_recentFullCloses.Count > 1000)
            {
                foreach (System.Collections.Generic.KeyValuePair<ulong, RecentClose> kv in _recentFullCloses)
                {
                    if (unchecked(Environment.TickCount - kv.Value.At) > RecentFullCloseMs)
                    {
                        RecentClose gone;
                        _recentFullCloses.TryRemove(kv.Key, out gone);
                    }
                }
            }
        }

        //+--------------------------------------------------------------+
        //| 重报价自动重试 / requote retries                               |
        //+--------------------------------------------------------------+

        private const int RequoteMaxRetries = 2;
        private const int RequoteBudgetMs = 500;

        /// <summary>
        /// 这几个返回码都说明"这一笔没有执行"(价格变了、没价、太频繁),换个新价再发一次是
        /// 安全的。超时、结果未知、LOCKED、CONNECTION 这类说不准执行没执行的,绝不重试。
        /// These retcodes all mean "not executed" (price moved, no price, too frequent), so a
        /// re-send at a fresh price is safe. Timeouts, unknown outcomes, LOCKED and CONNECTION
        /// are ambiguous and never retried.
        /// </summary>
        private static bool IsRequoteLike(string retcode)
        {
            return retcode == MTRetCode.MT_RET_REQUEST_REQUOTE.ToString()
                || retcode == MTRetCode.MT_RET_REQUEST_PRICE_CHANGED.ToString()
                || retcode == MTRetCode.MT_RET_REQUEST_PRICE_OFF.ToString()
                || retcode == MTRetCode.MT_RET_REQUEST_TOO_MANY.ToString();
        }

        /// <summary>
        /// 发一次;重报价类拒绝最多再发 2 次,总共不超过 0.5 秒。attempt 每次都要自己重新取价。
        /// Send once; on a requote-type rejection re-send up to twice within 0.5s total.
        /// attempt must fetch a fresh price each time.
        /// </summary>
        private TradeResult RetryRequotes(string what, Func<int, TradeResult> attempt)
        {
            Stopwatch sw = Stopwatch.StartNew();
            TradeResult r = attempt(0);

            for (int i = 1; i <= RequoteMaxRetries && _cfg.AutoRetryRequotes; i++)
            {
                if (r == null || r.Ok || !IsRequoteLike(r.Retcode))
                    break;

                if (sw.ElapsedMilliseconds >= RequoteBudgetMs)
                    break;

                Interlocked.Increment(ref _requoteRetries);
                Log.Info("{0} 被拒({1}),换新价第 {2} 次重发", what, r.Retcode, i);
                Thread.Sleep(30);
                r = attempt(i);
            }

            return r;
        }

        //+--------------------------------------------------------------+
        //| comment 短码 / comment short code                             |
        //+--------------------------------------------------------------+

        /// <summary>
        /// 由 clientOrderId 算出的 6 位短码(SHA-1 前 4 字节取模 36^6,base36)。同一个账号里
        /// 撞码的概率约二十亿分之一,而核对时还要再对账号、方向、品种。
        /// A 6-character code from clientOrderId (first 4 bytes of SHA-1 mod 36^6, base36).
        /// Collisions within one account are ~1 in 2 billion, and reconciliation also checks
        /// the account, side and symbol.
        /// </summary>
        internal static string CommentCodeFor(string clientOrderId)
        {
            if (string.IsNullOrEmpty(clientOrderId))
                return null;

            byte[] h;
            using (SHA1 sha = SHA1.Create())
                h = sha.ComputeHash(Encoding.UTF8.GetBytes(clientOrderId));

            uint v = ((uint)h[0] << 24) | ((uint)h[1] << 16) | ((uint)h[2] << 8) | h[3];
            v %= 2176782336u;   // 36^6

            const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
            char[] c = new char[6];
            for (int i = 5; i >= 0; i--)
            {
                c[i] = digits[(int)(v % 36)];
                v /= 36;
            }

            return "C" + new string(c);
        }
    }
}
