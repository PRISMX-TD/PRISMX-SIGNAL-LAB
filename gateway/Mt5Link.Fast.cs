//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 下单专线只跑下单(2026-11-11 架构优化阶段 1) |
//|                                                                  |
//| 交易连接只有一条,所有调用在 _gate 上排队。以前不少"非下单"的调用 |
//| 也在这把锁里做服务器往返:存活探测、开仓后反查仓位号、核对止损、  |
//| 确认成交时重读仓位、读挂单、核对密码、查询通道忙时的查询改道……券商 |
//| 一慢,这些往返就把下单堵在后面。这里把它们挪走:                  |
//|   - 服务器往返一律走"辅助通道"(查询通道池里保留的一条),         |
//|   - 存活改看"有没有数据在进来"(报价推送、已收字节数),           |
//|   - 报价与休市判断有缓存,不必每笔都进锁,                         |
//|   - 锁被占太久时新单直接回"未发出",不再排队干等。                 |
//|                                                                  |
//| Phase 1 of the 2026-11-11 order-path work: the trading link does   |
//| trading only. Server round trips that used to run under _gate      |
//| (liveness probe, post-fill lookups, confirmation re-reads, pending |
//| reads, password checks, query spill) move to a reserved helper     |
//| channel; liveness becomes passive (ticks, bytes read); quotes and  |
//| market-hours verdicts are cached; and a long-held gate makes new   |
//| orders fail fast as "not sent" instead of queueing.                |
//+------------------------------------------------------------------+
using System;
using System.Collections.Concurrent;
using System.Threading;
using MetaQuotes.MT5CommonAPI;
using MetaQuotes.MT5ManagerAPI;

namespace Prismx.Mt5Gateway
{
    /// <summary>报价推送回调:只记最新一跳,不做任何别的事。/ Tick callback: remembers the last tick only.</summary>
    internal sealed class TickSink : CIMTTickSink
    {
        private readonly Mt5Link _link;

        public TickSink(Mt5Link link)
        {
            _link = link;
        }

        // 原生层回调:整段包住,异常绝不能漏回原生代码(见 ManagerSink)。
        // Native callback: wrapped whole, nothing may escape into native code.
        public override void OnTick(string symbol, MTTickShort tick)
        {
            try { _link.OnTickArrived(symbol, tick); }
            catch { }
        }
    }

    internal sealed partial class Mt5Link
    {
        //+--------------------------------------------------------------+
        //| 报价缓存 / tick cache                                         |
        //+--------------------------------------------------------------+

        private struct CachedTick
        {
            public double Bid;
            public double Ask;
            public int At;
            public int Gen;
        }

        private readonly ConcurrentDictionary<string, CachedTick> _ticks =
            new ConcurrentDictionary<string, CachedTick>(StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// 已选中品种的无锁副本(与 _selected 同步维护)。缓存报价只对已选中的品种有意义:
        /// 没选中的品种服务器不推行情,缓存里那一跳可能是很久以前的。
        /// Lock-free mirror of _selected; a cached tick only means something for a
        /// selected symbol, since unselected ones receive no ticks.
        /// </summary>
        private readonly ConcurrentDictionary<string, byte> _selectedFast =
            new ConcurrentDictionary<string, byte>(StringComparer.OrdinalIgnoreCase);

        private TickSink _tickSink;
        private volatile bool _tickSubscribed;

        // 每次(重新)订阅加一:断线前收到的报价不算数。/ Bumped per (re)subscription.
        private volatile int _tickGen;
        private volatile int _lastTickAt = Environment.TickCount - 3600 * 1000;

        private int _tickCompared;
        private int _tickMismatch;
        private int _tickServed;
        private int _tickMismatchLogged;

        /// <summary>缓存的报价超过这么久没更新就不用,回去读 TickLast。/ Older ticks fall back to TickLast.</summary>
        private const int TickCacheMaxAgeMs = 10000;

        /// <summary>auto 模式:对比过这么多次、不一致不超过 2% 才开始用缓存。
        /// auto mode: serve from cache only after this many comparisons with ≤2% mismatches.</summary>
        private const int TickCacheValidateMin = 50;

        internal void OnTickArrived(string symbol, MTTickShort tick)
        {
            if (string.IsNullOrEmpty(symbol))
                return;

            int now = Environment.TickCount;
            _lastTickAt = now;

            if (tick.bid <= 0 && tick.ask <= 0)
                return;

            CachedTick c;
            c.Bid = tick.bid;
            c.Ask = tick.ask;
            c.At = now;
            c.Gen = _tickGen;
            _ticks[symbol] = c;
        }

        private bool TickCacheValidated
        {
            get
            {
                int compared = Thread.VolatileRead(ref _tickCompared);
                int mismatch = Thread.VolatileRead(ref _tickMismatch);
                return compared >= TickCacheValidateMin && mismatch * 50 <= compared;
            }
        }

        /// <summary>当前报价缓存的状态:off / shadow / auto-validating / on。/ Tick cache state for /health.</summary>
        public string TickCacheState
        {
            get
            {
                string mode = _cfg.TickCache;
                if (mode == "off")
                    return "off";
                if (!_tickSubscribed)
                    return "unsubscribed";
                if (mode == "shadow")
                    return "shadow";
                if (mode == "on")
                    return "on";
                return TickCacheValidated ? "on" : "validating";
            }
        }

        public int TickCompared { get { return Thread.VolatileRead(ref _tickCompared); } }
        public int TickMismatch { get { return Thread.VolatileRead(ref _tickMismatch); } }
        public int TickServed { get { return Thread.VolatileRead(ref _tickServed); } }

        private void SubscribeTicks()
        {
            if (_cfg.TickCache == "off")
                return;

            try
            {
                using (EnterGate())
                {
                    TickSink sink = new TickSink(this);
                    MTRetCode reg = sink.RegisterSink();
                    if (reg != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("TickSink.RegisterSink 失败:{0},报价缓存不可用(取价照旧进锁读)", reg);
                        return;
                    }

                    MTRetCode sub = _manager.TickSubscribe(sink);
                    if (sub != MTRetCode.MT_RET_OK)
                    {
                        Log.Warn("TickSubscribe 失败:{0},报价缓存不可用(取价照旧进锁读)", sub);
                        return;
                    }

                    if (_tickSink != null)
                    {
                        try { _manager.TickUnsubscribe(_tickSink); }
                        catch (Exception ex) { Log.Warn("退订旧报价 sink 失败:{0}", ex.Message); }
                    }

                    _tickSink = sink;
                    _tickGen++;
                    _ticks.Clear();
                    _tickSubscribed = true;
                    Log.Info("报价订阅已建立(报价缓存模式 {0})", _cfg.TickCache);
                }
            }
            catch (Exception ex)
            {
                Log.Error("建立报价订阅异常:{0}", ex.Message);
            }
        }

        /// <summary>
        /// 不进锁取价:只在模式允许、品种已选中、这一跳属于当前订阅、且足够新时命中。
        /// Lock-free quote: only when the mode allows, the symbol is selected, the tick
        /// belongs to the current subscription and is fresh enough.
        /// </summary>
        private bool TryCachedQuote(string symbol, out double bid, out double ask)
        {
            bid = 0;
            ask = 0;

            string mode = _cfg.TickCache;
            if (mode == "off" || mode == "shadow" || !_tickSubscribed)
                return false;

            if (mode != "on" && !TickCacheValidated)
                return false;

            if (!_selectedFast.ContainsKey(symbol))
                return false;

            CachedTick c;
            if (!_ticks.TryGetValue(symbol, out c) || c.Gen != _tickGen)
                return false;

            int age = unchecked(Environment.TickCount - c.At);
            if (age < 0 || age > TickCacheMaxAgeMs || c.Bid <= 0 || c.Ask <= 0)
                return false;

            bid = c.Bid;
            ask = c.Ask;
            Interlocked.Increment(ref _tickServed);
            return true;
        }

        /// <summary>
        /// 影子对比:进锁读到的 TickLast 与缓存比一比,只计数。缓存那一跳刚到(50ms 内)
        /// 不比——推送和 TickLast 的先后说不准,比了只会多出假的不一致。
        /// Shadow comparison of TickLast against the cache, counting only. Skipped when
        /// the cached tick is under 50ms old: the ordering of the push and TickLast is
        /// not defined, so comparing would only add false mismatches.
        /// </summary>
        private void ShadowCompareTick(string symbol, double bid, double ask)
        {
            if (!_tickSubscribed)
                return;

            CachedTick c;
            if (!_ticks.TryGetValue(symbol, out c) || c.Gen != _tickGen)
                return;

            int age = unchecked(Environment.TickCount - c.At);
            if (age < 50 || age > TickCacheMaxAgeMs)
                return;

            Interlocked.Increment(ref _tickCompared);

            if (Math.Abs(c.Bid - bid) <= 1e-12 && Math.Abs(c.Ask - ask) <= 1e-12)
                return;

            Interlocked.Increment(ref _tickMismatch);
            int n = Interlocked.Increment(ref _tickMismatchLogged);
            if (n <= 10 || n % 200 == 0)
                Log.Warn("报价缓存与 TickLast 不一致(第 {0} 次,仅计数):{1} 缓存 {2}/{3} / TickLast {4}/{5}",
                    n, symbol, c.Bid, c.Ask, bid, ask);
        }

        //+--------------------------------------------------------------+
        //| 休市判断缓存 / market-hours verdict cache                      |
        //+--------------------------------------------------------------+

        private struct SessionVerdict
        {
            public string Message;   // null = 可交易或判不了 / tradable or undeterminable
            public int Until;
        }

        private readonly ConcurrentDictionary<string, SessionVerdict> _sessionVerdicts =
            new ConcurrentDictionary<string, SessionVerdict>(StringComparer.OrdinalIgnoreCase);

        private const int SessionVerdictMaxMs = 30000;

        private static string SessionKey(string symbol, string group, bool manage)
        {
            return symbol + "|" + (group ?? "") + "|" + (manage ? "m" : "o");
        }

        private bool TryCachedVerdict(string key, out string message)
        {
            message = null;

            if (!_cfg.SessionCache)
                return false;

            SessionVerdict v;
            if (!_sessionVerdicts.TryGetValue(key, out v))
                return false;

            if (unchecked(v.Until - Environment.TickCount) <= 0)
                return false;

            message = v.Message;
            return true;
        }

        /// <summary>
        /// 记下一次判定。有效期到这一分钟结束为止(交易时段按分钟划分,边界不会落在
        /// 一分钟中间),最多 30 秒;读不到服务器时间就只记 5 秒。
        /// Store a verdict until the end of the current server minute (sessions are
        /// minute-aligned, so no boundary falls inside one), capped at 30s; 5s when
        /// the server time is unknown.
        /// </summary>
        private void StoreVerdict(string key, string message, long serverTime)
        {
            if (!_cfg.SessionCache)
                return;

            int ttl = 5000;
            if (serverTime > 0)
            {
                long secLeft = 60 - (serverTime % 60);
                ttl = (int)Math.Min(SessionVerdictMaxMs, Math.Max(0, secLeft * 1000 - 500));
            }

            if (ttl <= 0)
                return;

            SessionVerdict v;
            v.Message = message;
            v.Until = unchecked(Environment.TickCount + ttl);
            _sessionVerdicts[key] = v;
        }

        //+--------------------------------------------------------------+
        //| 辅助通道 / helper channel                                     |
        //+--------------------------------------------------------------+

        /// <summary>辅助通道排队上限。/ Queueing cap for the helper channel.</summary>
        private const int HelperWaitMs = 2000;

        private int _helperRuns;
        private int _helperUnavailable;
        private int _helperUnavailableLogged;
        private int _tradingLinkReads;

        public int HelperRuns { get { return Thread.VolatileRead(ref _helperRuns); } }
        public int HelperUnavailable { get { return Thread.VolatileRead(ref _helperUnavailable); } }
        public int TradingLinkReads { get { return Thread.VolatileRead(ref _tradingLinkReads); } }

        /// <summary>
        /// 需要服务器往返的读,能不能在交易连接上做:没开查询通道(read_channels=0)、或者
        /// 一条都还没连上过(启动的头几秒),或者显式打开了 read_spill_to_trading,才可以。
        /// 查询通道连上过之后一律不行——宁可这次读失败(后端保留上一次的数据),也不让一次
        /// 读把下单堵在锁后面。
        /// Whether a server read may run on the trading link: only without query
        /// channels, before any of them has ever connected, or with
        /// read_spill_to_trading. After that, never: a failed read (the backend keeps
        /// its last snapshot) beats a read that parks orders behind the lock.
        /// </summary>
        private bool TradingLinkReadAllowed()
        {
            return _reads == null || _reads.Count == 0 || !_reads.EverConnected || _cfg.ReadSpillToTrading;
        }

        /// <summary>
        /// 在辅助通道上跑一次服务器往返。fn 在那条通道的锁里执行,拿到的是那条通道的 manager。
        /// 辅助通道不可用时:允许走交易连接(见 TradingLinkReadAllowed)就在 _gate 里做,
        /// 否则回 MT_RET_ERR_NETWORK——调用方本来就要处理读失败。
        /// Runs one server round trip on the helper channel; fn runs under that
        /// channel's lock with its manager. Without a usable channel it runs under
        /// _gate only when TradingLinkReadAllowed, else returns MT_RET_ERR_NETWORK,
        /// which every caller already handles as a failed read.
        /// </summary>
        private MTRetCode OnHelper(string what, Func<CIMTManagerAPI, MTRetCode> fn)
        {
            ReadChannel rc = _reads != null ? _reads.AcquireHelper(HelperWaitMs) : null;

            if (rc == null)
            {
                if (TradingLinkReadAllowed())
                {
                    Interlocked.Increment(ref _tradingLinkReads);
                    using (EnterGate())
                        return fn(_manager);
                }

                Interlocked.Increment(ref _helperUnavailable);
                int n = Interlocked.Increment(ref _helperUnavailableLogged);
                if (n <= 20 || n % 100 == 0)
                    Log.Warn("辅助通道不可用,{0} 这次读不到(不改走交易连接,免得堵住下单;第 {1} 次)", what, n);
                return MTRetCode.MT_RET_ERR_NETWORK;
            }

            try
            {
                Interlocked.Increment(ref _helperRuns);
                MTRetCode r = fn(rc.Manager);
                if (IsLinkError(r))
                    rc.MarkBroken(r);
                return r;
            }
            catch (Exception ex)
            {
                Log.Warn("辅助通道执行 {0} 异常:{1}", what, ex.Message);
                rc.MarkBroken(MTRetCode.MT_RET_ERR_NETWORK);
                return MTRetCode.MT_RET_ERR_NETWORK;
            }
            finally
            {
                _reads.Release(rc);
            }
        }

        //+--------------------------------------------------------------+
        //| 被动存活判断 / passive liveness                               |
        //+--------------------------------------------------------------+

        private ulong _lastBytesRead;
        private volatile int _bytesChangedAt = Environment.TickCount - 3600 * 1000;
        private int _passiveSkips;

        public int PassiveProbeSkips { get { return Thread.VolatileRead(ref _passiveSkips); } }

        /// <summary>
        /// 最近 windowMs 内这条连接有没有"数据在进来":报价推送、或已收字节数在涨。有就算
        /// 活着,不必做那次要占锁的服务器往返。没有证据返回 false(不是判死,而是"该主动探了")。
        /// 读字节数只用 20ms 去试锁,锁忙就只看报价推送。
        /// Whether data has been arriving within windowMs (a tick push, or the bytes-read
        /// counter moving). Evidence means alive and the gate-holding round trip is skipped.
        /// No evidence returns false — "go probe actively", not "dead". The bytes counter
        /// is read with a 20ms try on the gate; when busy only ticks count.
        /// </summary>
        private bool PassiveAlive(int windowMs)
        {
            if (!_cfg.PassiveLiveness)
                return false;

            int now = Environment.TickCount;

            if (unchecked(now - _lastTickAt) < windowMs)
                return true;

            if (Monitor.TryEnter(_gate, 20))
            {
                NoteGateAcquired();
                try
                {
                    if (_manager != null)
                    {
                        ulong b = _manager.NetworkBytesRead();
                        if (b != _lastBytesRead)
                        {
                            _lastBytesRead = b;
                            _bytesChangedAt = now;
                        }
                    }
                }
                catch { }
                finally
                {
                    NoteGateReleasing();
                    Monitor.Exit(_gate);
                }
            }

            return unchecked(now - _bytesChangedAt) < windowMs;
        }

        //+--------------------------------------------------------------+
        //| 锁占用分级 / gate tiers                                       |
        //+--------------------------------------------------------------+

        private int _gateFailFasts;

        public int GateFailFasts { get { return Thread.VolatileRead(ref _gateFailFasts); } }
        public int GateHeldMs { get { return _gateTrace.HeldMs; } }
        public string GateHolder { get { return _gateTrace.Site; } }
        public int GateSlowHolds { get { return _gateTrace.SlowHolds; } }
        public int GateMaxHoldMs { get { return _gateTrace.MaxHoldMs; } }

        /// <summary>
        /// 交易入口的第一道检查:全局锁已被某个调用攥了 gate_fail_fast_ms(默认 3 秒)以上,
        /// 这笔单排进去也只会干等,直接回"通道繁忙、未发出"——什么都还没发往券商,后端按
        /// 普通拒绝处理,用户可以放心重下。null = 放行。
        /// First check at every trade entry: when the global lock has been held past
        /// gate_fail_fast_ms (3s by default), queueing would only wait, so answer "busy,
        /// not sent" at once. Nothing has reached the broker, so the backend records a
        /// plain rejection and the user may safely retry. null = go ahead.
        /// </summary>
        /// <summary>
        /// 这一次交易能忍锁被占多久。开仓按 gate_fail_fast_ms(3 秒);平仓、改单、撤单至少
        /// 10 秒——它们是保护性的,"等一会儿然后成功"远比"快速失败"好(2026-09 否决过一刀切
        /// 的 3 秒快速失败,理由就是这个)。由 Guarded 按动作设置,线程局部。
        /// How long this trade tolerates a held gate: opens use gate_fail_fast_ms (3s);
        /// closes/modifies/cancels at least 10s, since for protective actions "wait, then
        /// succeed" beats "fail fast" (why a blanket 3s fail-fast was rejected in 2026-09).
        /// </summary>
        [ThreadStatic]
        private static int _failFastOverrideMs;

        private const int ProtectiveFailFastMs = 10000;

        private int EffectiveFailFastMs
        {
            get
            {
                int limit = _cfg.GateFailFastMs;
                if (limit <= 0)
                    return 0;
                int o = _failFastOverrideMs;
                return o > limit ? o : limit;
            }
        }

        private TradeResult GateBusyGuard()
        {
            int limit = EffectiveFailFastMs;
            if (limit <= 0)
                return null;

            int held = _gateTrace.HeldMs;
            if (held < limit)
                return null;

            return GateBusyResult(held);
        }

        private TradeResult GateBusyResult(int heldMs)
        {
            Interlocked.Increment(ref _gateFailFasts);
            Log.Warn("交易通道被占用 {0} 毫秒({1}),新指令直接回繁忙、未发出", heldMs, _gateTrace.Describe());

            return TradeResult.Fail(GatewayBusyRetcode,
                "交易通道繁忙,本次指令未发往券商,请稍后重试 / trading link busy, nothing was sent to the broker");
        }

        /// <summary>网关自己的"繁忙、未发出"返回码。/ Gateway retcode for "busy, not sent".</summary>
        public const string GatewayBusyRetcode = "MT_RET_ERR_BUSY";

        /// <summary>
        /// 这些调用处攥锁久一点是正常的(重连、重开 dealer、关闭),自愈不按 20 秒算,仍按
        /// 原来的 180 秒。/ Call sites allowed to hold the lock longer (reconnect, dealer
        /// restart, shutdown): self-heal keeps the old 180s for them.
        /// </summary>
        private static bool IsSlowSiteAllowed(string site)
        {
            if (string.IsNullOrEmpty(site))
                return false;

            return site.StartsWith("ConnectOnce:", StringComparison.Ordinal)
                || site.StartsWith("WatchdogLoopCore:", StringComparison.Ordinal)
                || site.StartsWith("RestartDealer:", StringComparison.Ordinal)
                || site.StartsWith("TryStartDealer:", StringComparison.Ordinal)
                || site.StartsWith("OnLinkRestored:", StringComparison.Ordinal)
                || site.StartsWith("Dispose:", StringComparison.Ordinal);
        }
    }
}
