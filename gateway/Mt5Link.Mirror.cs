//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 本地镜像读(2026-11-11 架构优化阶段 2)        |
//|                                                                  |
//| 下单专线本来就订阅着仓位/挂单(pump),内存里有一份实时副本。验证   |
//| 过它和服务器一致后,查挂单/查持仓就直接读内存(微秒级),不再跟券商 |
//| 往返,查询通道也省下来。                                           |
//|                                                                  |
//|   挂单:local_orders=true 直接用;否则已有的影子比对(/orders 每次 |
//|         都比)累计 ≥100 次且 0 差异后自动启用;启用后仍每 50 次抽查 |
//|         一次服务器,一有差异就停用 5 分钟。                         |
//|   持仓:只在 local_positions=true 时用本地(浮盈由服务器推送,各家  |
//|         券商刷新频率不同,不自动启用)。不开时每 50 次服务器读抽一次 |
//|         和本地比(票号、手数、止损止盈),给出能不能开的依据。       |
//|   订阅刚建立 30 秒内、连接断开时,一律走服务器。                    |
//|                                                                  |
//| Phase 2: serve pending orders and positions from the local pump   |
//| once it has been shown to match the server. Orders auto-enable    |
//| after ≥100 clean shadow comparisons (or local_orders=true) and    |
//| keep a 1-in-50 server spot check that suspends local reads for 5  |
//| minutes on any mismatch. Positions are local only with            |
//| local_positions=true (floating profit refresh varies by broker);  |
//| otherwise 1 in 50 server reads is compared to build the evidence. |
//+------------------------------------------------------------------+
using System;
using System.Collections.Generic;
using System.Threading;
using MetaQuotes.MT5CommonAPI;

namespace Prismx.Mt5Gateway
{
    internal sealed partial class Mt5Link
    {
        private const int MirrorWarmupMs = 30000;
        private const int MirrorSpotCheckEvery = 50;
        private const int MirrorSuspendMs = 300000;
        private const int OrdersTrustAfter = 100;

        private int _mirrorSuspendedUntil;
        private bool _mirrorSuspended;
        private int _mirrorSuspensions;

        private int _localOrderReads;
        private int _localPositionReads;
        private int _orderReadCounter;
        private int _positionReadCounter;

        private int _posCompared;
        private int _posMismatch;
        private int _posMismatchLogged;

        /// <summary>本线程上一次 GetOrders 是不是读的本地(本地对本地的比对不该计入)。
        /// Whether this thread's last GetOrders was local (local-vs-local must not count).</summary>
        [ThreadStatic]
        private static bool _lastOrdersLocal;

        private bool MirrorSuspended
        {
            get
            {
                if (!_mirrorSuspended)
                    return false;

                if (unchecked(Environment.TickCount - _mirrorSuspendedUntil) >= 0)
                {
                    _mirrorSuspended = false;
                    Log.Info("本地镜像停用期满,恢复本地读");
                    return false;
                }

                return true;
            }
        }

        private void SuspendMirror(string why)
        {
            _mirrorSuspendedUntil = unchecked(Environment.TickCount + MirrorSuspendMs);
            _mirrorSuspended = true;
            Interlocked.Increment(ref _mirrorSuspensions);
            Log.Warn("本地镜像与服务器不一致({0}),停用本地读 5 分钟", why);
        }

        private bool MirrorReady
        {
            get
            {
                return _connected && _ordSubscribed
                    && unchecked(Environment.TickCount - _ordSubscribedAt) >= MirrorWarmupMs
                    && !MirrorSuspended;
            }
        }

        /// <summary>挂单能否读本地。/ Whether pending orders may be read locally.</summary>
        private bool LocalOrdersTrusted
        {
            get
            {
                if (!MirrorReady)
                    return false;

                if (_cfg.LocalOrders)
                    return true;

                return OrdersCompared >= OrdersTrustAfter
                    && OrdersSetMismatch == 0 && OrdersFieldMismatch == 0;
            }
        }

        private bool LocalPositionsTrusted
        {
            get { return _cfg.LocalPositions && _posSubscribed && MirrorReady; }
        }

        public int LocalOrderReads { get { return Thread.VolatileRead(ref _localOrderReads); } }
        public int LocalPositionReads { get { return Thread.VolatileRead(ref _localPositionReads); } }
        public int PositionsCompared { get { return Thread.VolatileRead(ref _posCompared); } }
        public int PositionsMismatch { get { return Thread.VolatileRead(ref _posMismatch); } }

        //+--------------------------------------------------------------+
        //| 挂单 / pending orders                                          |
        //+--------------------------------------------------------------+

        /// <summary>
        /// 能读本地就读本地并返回 true。每 50 次里有 1 次故意返回 false 去问服务器,
        /// 那次的结果由 /orders 已有的 CompareLocalOrders 比对。
        /// Serve locally when trusted. One call in 50 deliberately goes to the server so
        /// the existing CompareLocalOrders keeps checking.
        /// </summary>
        private bool TryLocalOrders(ulong login, out OrderInfo[] list)
        {
            list = null;
            _lastOrdersLocal = false;

            if (!LocalOrdersTrusted)
                return false;

            if (Interlocked.Increment(ref _orderReadCounter) % MirrorSpotCheckEvery == 0)
                return false;

            if (!Monitor.TryEnter(_gate, 50))
                return false;

            NoteGateAcquired();
            try
            {
                using (CIMTOrderArray arr = _manager.OrderCreateArray())
                {
                    MTRetCode r = _manager.OrderGetOpen(login, arr);

                    if (r == MTRetCode.MT_RET_ERR_NOTFOUND)
                    {
                        list = new OrderInfo[0];
                    }
                    else if (r != MTRetCode.MT_RET_OK)
                    {
                        return false;
                    }
                    else
                    {
                        List<OrderInfo> l = new List<OrderInfo>();
                        uint total = arr.Total();
                        for (uint i = 0; i < total; i++)
                        {
                            CIMTOrder o = arr.Next(i);
                            if (o != null)
                                l.Add(ToOrderInfo(o));
                        }
                        list = l.ToArray();
                    }
                }
            }
            finally
            {
                NoteGateReleasing();
                Monitor.Exit(_gate);
            }

            Interlocked.Increment(ref _localOrderReads);
            _lastOrdersLocal = true;
            return true;
        }

        //+--------------------------------------------------------------+
        //| 持仓 / positions                                               |
        //+--------------------------------------------------------------+

        private bool TryLocalPositions(ulong login, out PositionInfo[] list)
        {
            list = null;

            if (!LocalPositionsTrusted)
                return false;

            if (Interlocked.Increment(ref _positionReadCounter) % MirrorSpotCheckEvery == 0)
                return false;   // 这一次去服务器,由 ShadowComparePositions 比对 / spot check

            PositionInfo[] local;
            if (!ReadLocalPositions(login, 50, out local))
                return false;

            Interlocked.Increment(ref _localPositionReads);
            list = local;
            return true;
        }

        /// <summary>读本地 pump 的持仓;拿不到锁或出错返回 false。/ Pump positions, false when unavailable.</summary>
        private bool ReadLocalPositions(ulong login, int lockWaitMs, out PositionInfo[] list)
        {
            list = null;

            if (!Monitor.TryEnter(_gate, lockWaitMs))
                return false;

            NoteGateAcquired();
            try
            {
                if (_manager == null)
                    return false;

                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    MTRetCode r = _manager.PositionGet(login, arr);

                    if (r == MTRetCode.MT_RET_ERR_NOTFOUND)
                    {
                        list = new PositionInfo[0];
                        return true;
                    }

                    if (r != MTRetCode.MT_RET_OK)
                        return false;

                    List<PositionInfo> l = new List<PositionInfo>();
                    uint total = arr.Total();
                    for (uint i = 0; i < total; i++)
                    {
                        CIMTPosition p = arr.Next(i);
                        if (p == null)
                            continue;

                        l.Add(new PositionInfo
                        {
                            Ticket = p.Position(),
                            Symbol = p.Symbol(),
                            Side = p.Action() == (uint)CIMTPosition.EnPositionAction.POSITION_BUY ? "BUY" : "SELL",
                            Volume = SMTMath.VolumeToDouble(p.Volume()),
                            PriceOpen = p.PriceOpen(),
                            PriceCurrent = p.PriceCurrent(),
                            StopLoss = p.PriceSL(),
                            TakeProfit = p.PriceTP(),
                            Profit = p.Profit(),
                            Comment = p.Comment()
                        });
                    }

                    list = l.ToArray();
                    return true;
                }
            }
            catch
            {
                return false;
            }
            finally
            {
                NoteGateReleasing();
                Monitor.Exit(_gate);
            }
        }

        /// <summary>
        /// 服务器持仓结果出来后,每 50 次抽 1 次和本地比(票号、手数、止损止盈;浮盈不比)。
        /// 只观测;本地读开着时一有差异就停用 5 分钟。
        /// Every 50th server result is compared with the pump (tickets, volume, SL/TP; not
        /// profit). Observation only, except that it suspends local reads on a mismatch.
        /// </summary>
        private void ShadowComparePositions(ulong login, PositionInfo[] server)
        {
            try
            {
                if (server == null || !_posSubscribed || !_connected)
                    return;

                if (unchecked(Environment.TickCount - _ordSubscribedAt) < MirrorWarmupMs)
                    return;

                if (!LocalPositionsTrusted
                    && Interlocked.Increment(ref _positionReadCounter) % MirrorSpotCheckEvery != 0)
                    return;

                PositionInfo[] local;
                if (!ReadLocalPositions(login, 0, out local))
                    return;

                Interlocked.Increment(ref _posCompared);

                string diff = DiffPositions(server, local);
                if (diff == null)
                    return;

                Interlocked.Increment(ref _posMismatch);

                if (Interlocked.Increment(ref _posMismatchLogged) <= 20)
                    Log.Warn("持仓本地镜像与服务器不一致 login={0}:{1}", login, diff);

                if (LocalPositionsTrusted)
                    SuspendMirror("持仓 " + diff);
            }
            catch
            {
            }
        }

        private static string DiffPositions(PositionInfo[] server, PositionInfo[] local)
        {
            if (server.Length != local.Length)
                return "数量 " + server.Length + " vs 本地 " + local.Length;

            Dictionary<ulong, PositionInfo> byTicket = new Dictionary<ulong, PositionInfo>();
            foreach (PositionInfo p in local)
                byTicket[p.Ticket] = p;

            foreach (PositionInfo s in server)
            {
                PositionInfo l;
                if (!byTicket.TryGetValue(s.Ticket, out l))
                    return "本地缺仓位 #" + s.Ticket;

                if (Math.Abs(s.Volume - l.Volume) > 1e-9)
                    return "#" + s.Ticket + " 手数 " + s.Volume + " vs " + l.Volume;

                if (Math.Abs(s.StopLoss - l.StopLoss) > 1e-9 || Math.Abs(s.TakeProfit - l.TakeProfit) > 1e-9)
                    return "#" + s.Ticket + " 止损止盈不同";
            }

            return null;
        }

        /// <summary>
        /// 成交回执顺带的持仓(本地 pump 内存读)。只有确定已经反映这笔成交时才返回:
        /// mustHave(开仓的新仓位号)必须在、mustLack(全平的仓位号)必须不在;否则 null,
        /// 后端照旧自己去读——宁可不带,也不带一份会把新仓位"闪掉"的旧表。
        /// Positions for the trade reply, from the local pump. Returned only when they
        /// already reflect this fill (mustHave present, mustLack absent); otherwise null
        /// and the backend reads as before — better nothing than a stale table.
        /// </summary>
        public PositionInfo[] PositionsForReply(ulong login, ulong mustHave, ulong mustLack)
        {
            try
            {
                if (!_posSubscribed || !_connected)
                    return null;

                // 仓位事件可能比成交事件晚到一点,最多再等 150ms。/ Allow 150ms for the pump.
                for (int attempt = 0; attempt < 4; attempt++)
                {
                    if (attempt > 0)
                        Thread.Sleep(50);

                    PositionInfo[] list;
                    if (!ReadLocalPositions(login, 50, out list))
                        return null;

                    bool hasNew = mustHave == 0, lacksOld = true;
                    foreach (PositionInfo p in list)
                    {
                        if (p.Ticket == mustHave) hasNew = true;
                        if (mustLack != 0 && p.Ticket == mustLack) lacksOld = false;
                    }

                    if (hasNew && lacksOld)
                    {
                        Interlocked.Increment(ref _replyPositionsAttached);
                        return list;
                    }
                }
            }
            catch
            {
            }

            Interlocked.Increment(ref _replyPositionsSkipped);
            return null;
        }

        private int _replyPositionsAttached;
        private int _replyPositionsSkipped;

        /// <summary>/health 的镜像部分。/ The mirror block of /health.</summary>
        private void DescribeMirror(JsonWriter j)
        {
            j.BeginObject("mirror")
                .Field("ordersLocal", LocalOrdersTrusted)
                .Field("positionsLocal", LocalPositionsTrusted)
                .Field("suspended", MirrorSuspended)
                .FieldLong("suspensions", Thread.VolatileRead(ref _mirrorSuspensions))
                .FieldLong("localOrderReads", LocalOrderReads)
                .FieldLong("localPositionReads", LocalPositionReads)
                .FieldLong("ordersCompared", OrdersCompared)
                .FieldLong("ordersMismatch", OrdersSetMismatch + OrdersFieldMismatch)
                .FieldLong("positionsCompared", PositionsCompared)
                .FieldLong("positionsMismatch", PositionsMismatch)
                .FieldLong("replyPositionsAttached", Thread.VolatileRead(ref _replyPositionsAttached))
                .FieldLong("replyPositionsSkipped", Thread.VolatileRead(ref _replyPositionsSkipped))
                .EndObject();
        }
    }
}
