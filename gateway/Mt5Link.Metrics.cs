//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 下单耗时与健康状态(2026-11-11 阶段 5)        |
//|                                                                  |
//| 每笔交易记一条时间线(进门、拿到名额、发出、回执、结束),最近 500 |
//| 笔算 p50/p95;/health 里给出四档状态:                              |
//|   ok 正常 / slow 偏慢 / stalled 疑似阻塞 / down 断开。              |
//|                                                                  |
//| Phase 5: a per-trade timeline and p50/p95 over the last 500      |
//| trades; /health reports one of ok / slow / stalled / down.       |
//+------------------------------------------------------------------+
using System;
using System.Diagnostics;
using System.Threading;

namespace Prismx.Mt5Gateway
{
    /// <summary>一笔交易的时间线。/ One trade's timeline.</summary>
    internal sealed class TradeTimeline
    {
        public readonly string Kind;
        public readonly ulong Login;
        public readonly string Symbol;
        private readonly Stopwatch _sw = Stopwatch.StartNew();

        public long AdmittedMs = -1;
        public long TotalMs;

        public TradeTimeline(string kind, ulong login, string symbol)
        {
            Kind = kind;
            Login = login;
            Symbol = symbol;
        }

        public void Mark(string what)
        {
            if (what == "admitted")
                AdmittedMs = _sw.ElapsedMilliseconds;
        }

        public void Done(TradeResult r)
        {
            TotalMs = _sw.ElapsedMilliseconds;
        }
    }

    /// <summary>固定长度的耗时样本环,取分位数。/ A fixed ring of samples with percentiles.</summary>
    internal sealed class LatencyRing
    {
        private readonly long[] _v;
        private int _n;
        private int _next;
        private readonly object _lock = new object();

        public LatencyRing(int size) { _v = new long[size]; }

        public void Add(long ms)
        {
            lock (_lock)
            {
                _v[_next] = ms;
                _next = (_next + 1) % _v.Length;
                if (_n < _v.Length) _n++;
            }
        }

        public int Count { get { lock (_lock) return _n; } }

        /// <summary>p 取 0..100;没有样本返回 -1。/ p in 0..100; -1 with no samples.</summary>
        public long Percentile(int p)
        {
            long[] copy;
            lock (_lock)
            {
                if (_n == 0) return -1;
                copy = new long[_n];
                Array.Copy(_v, copy, _n);
            }

            Array.Sort(copy);
            int idx = (int)Math.Ceiling(p / 100.0 * copy.Length) - 1;
            return copy[Math.Max(0, Math.Min(copy.Length - 1, idx))];
        }
    }

    internal sealed partial class Mt5Link
    {
        private readonly LatencyRing _dealerLatency = new LatencyRing(500);
        private readonly LatencyRing _tradeLatency = new LatencyRing(500);
        private readonly LatencyRing _queueLatency = new LatencyRing(500);

        private int _tradesTotal;
        private int _tradesFailed;
        private int _tradesUnknown;
        private int _lastSlowTradeAt;

        public LatencyRing DealerLatency { get { return _dealerLatency; } }
        public LatencyRing TradeLatency { get { return _tradeLatency; } }
        public LatencyRing QueueLatency { get { return _queueLatency; } }
        public int TradesTotal { get { return Thread.VolatileRead(ref _tradesTotal); } }
        public int TradesFailed { get { return Thread.VolatileRead(ref _tradesFailed); } }
        public int TradesUnknown { get { return Thread.VolatileRead(ref _tradesUnknown); } }

        private void NoteDealerMs(long ms)
        {
            _dealerLatency.Add(ms);
        }

        private void NoteTrade(TradeTimeline tl, TradeResult r)
        {
            Interlocked.Increment(ref _tradesTotal);

            if (r == null || !r.Ok)
                Interlocked.Increment(ref _tradesFailed);
            if (r != null && r.SentUnknown)
                Interlocked.Increment(ref _tradesUnknown);

            // 没进到名额的(繁忙、断线)不算进耗时分布,否则 p50 会被"秒回的拒绝"拉低。
            // Only admitted trades count toward latency; instant rejects would skew it.
            if (tl.AdmittedMs >= 0)
            {
                _tradeLatency.Add(tl.TotalMs);
                _queueLatency.Add(tl.AdmittedMs);
            }

            if (tl.TotalMs >= 3000)
                _lastSlowTradeAt = Environment.TickCount;
        }

        /// <summary>
        /// 四档健康状态。down:连接断开;stalled:交易锁被占超过 fail-fast 或最近 dealer 回执超时;
        /// slow:近期下单 p95 超过 2 秒,或 1 分钟内有超过 3 秒的单;其余 ok。
        /// Four states: down (no link), stalled (gate held past fail-fast, or unknown outcomes
        /// pending), slow (p95 over 2s or a 3s+ trade in the last minute), ok otherwise.
        /// </summary>
        public string HealthState
        {
            get
            {
                if (!_connected)
                    return "down";

                long held = _gateTrace.HeldMs;
                if ((_cfg.GateFailFastMs > 0 && held >= _cfg.GateFailFastMs) || PendingReconciles > 0)
                    return "stalled";

                long p95 = _tradeLatency.Count >= 5 ? _tradeLatency.Percentile(95) : -1;
                bool recentSlow = _lastSlowTradeAt != 0
                    && unchecked(Environment.TickCount - _lastSlowTradeAt) < 60000;

                if (p95 >= 2000 || recentSlow)
                    return "slow";

                return "ok";
            }
        }

        /// <summary>写 /health 的下单路径部分。/ The order-path block of /health.</summary>
        public void DescribeOrderPath(JsonWriter j)
        {
            j.BeginObject("orderPath")
                .Field("state", HealthState)
                .FieldLong("tradesInflight", TradesInflight)
                .FieldLong("tradesTotal", TradesTotal)
                .FieldLong("tradesFailed", TradesFailed)
                .FieldLong("tradesUnknown", TradesUnknown)
                .FieldLong("queueRejects", TradeQueueRejects)
                .FieldLong("duplicateClosesCollapsed", DuplicateClosesCollapsed)
                .FieldLong("requoteRetries", RequoteRetries)
                .FieldLong("closesQueuedOnDisconnect", ClosesQueuedOnDisconnect)
                .FieldLong("tradeP50Ms", _tradeLatency.Percentile(50))
                .FieldLong("tradeP95Ms", _tradeLatency.Percentile(95))
                .FieldLong("dealerP50Ms", _dealerLatency.Percentile(50))
                .FieldLong("dealerP95Ms", _dealerLatency.Percentile(95))
                .FieldLong("queueP95Ms", _queueLatency.Percentile(95))
                .FieldLong("samples", _tradeLatency.Count)
                .FieldLong("gateHeldMs", _gateTrace.HeldMs)
                .Field("gateHolder", _gateTrace.Site ?? "")
                .FieldLong("gateSlowHolds", GateSlowHolds)
                .FieldLong("gateMaxHoldMs", GateMaxHoldMs)
                .FieldLong("gateFailFasts", GateFailFasts)
                .Field("tickCache", TickCacheState)
                .FieldLong("tickServed", TickServed)
                .FieldLong("tickCompared", TickCompared)
                .FieldLong("tickMismatch", TickMismatch)
                .FieldLong("helperRuns", HelperRuns)
                .FieldLong("helperUnavailable", HelperUnavailable)
                .FieldLong("tradingLinkReads", TradingLinkReads)
                .FieldLong("passiveProbeSkips", PassiveProbeSkips)
                .FieldLong("pendingReconciles", PendingReconciles)
                .FieldLong("reconcileFilled", ReconcileFilled)
                .FieldLong("reconcileNotFilled", ReconcileNotFilled)
                .FieldLong("reconcileGaveUp", ReconcileGaveUp)
                .FieldLong("eventHead", Events.Head)
                .Field("eventInstance", EventRing.InstanceId);

            DescribeMirror(j);

            if (_reads != null)
                _reads.Describe(j);

            j.EndObject();
        }
    }
}
