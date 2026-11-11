//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 结果未知的单子事后核对(2026-11-11 阶段 4)    |
//|                                                                  |
//| 发出去却没等到回执(超时、等待中断线)的开仓/平仓,在后台按 comment|
//| 末尾的短码到服务器的成交记录里找:                                 |
//|   找到 → 记为"已成交",带上成交号、仓位号、价格;                   |
//|   连接正常、查询成功、过了 60 秒还找不到 → 记为"未成交";           |
//|   10 分钟还没结论 → 放弃,保持"结果未知"让人工核对。               |
//| 有结论时发 trade_resolved 事件,并通知 HttpServer 把幂等记录改写成 |
//| 这个结论——后端拿同一个 clientOrderId 重试,就拿到真实结果,不会再 |
//| 重下一张。                                                       |
//|                                                                  |
//| Orders that were sent but never answered are reconciled in the   |
//| background by the comment code: found → filled; link healthy,    |
//| queries succeeding and still nothing after 60s → not filled; no  |
//| verdict in 10 minutes → give up and leave it unknown. A verdict  |
//| publishes trade_resolved and rewrites the idempotency record, so |
//| a backend retry with the same clientOrderId gets the real answer.|
//+------------------------------------------------------------------+
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using MetaQuotes.MT5CommonAPI;

namespace Prismx.Mt5Gateway
{
    internal sealed partial class Mt5Link
    {
        private sealed class ReconcileJob
        {
            public ulong Login;
            public string Kind;
            public string ClientOrderId;
            public string Code;
            public ulong Ticket;
            public int CreatedAt;
            public int NextAt;
            public int Attempts;
            public int CleanMisses;   // 连接正常且查询成功、但没找到的次数 / clean "not found" rounds
        }

        private readonly ConcurrentDictionary<string, ReconcileJob> _reconciles =
            new ConcurrentDictionary<string, ReconcileJob>();

        private Thread _reconcileThread;
        private readonly object _reconcileStartLock = new object();

        private int _reconcileFilled;
        private int _reconcileNotFilled;
        private int _reconcileGaveUp;

        private const int ReconcileNotFilledAfterMs = 60000;
        private const int ReconcileGiveUpMs = 600000;

        /// <summary>事件环:成交、仓位、挂单、连接起落、核对结论。/ The event ring.</summary>
        public readonly EventRing Events = new EventRing(10000);

        /// <summary>核对出结论时触发(login, kind, clientOrderId, result)。HttpServer 用它改写幂等记录。
        /// Raised with a verdict; HttpServer rewrites the idempotency record with it.</summary>
        public event Action<ulong, string, string, TradeResult> TradeResolved;

        public int PendingReconciles { get { return _reconciles.Count; } }
        public int ReconcileFilled { get { return Thread.VolatileRead(ref _reconcileFilled); } }
        public int ReconcileNotFilled { get { return Thread.VolatileRead(ref _reconcileNotFilled); } }
        public int ReconcileGaveUp { get { return Thread.VolatileRead(ref _reconcileGaveUp); } }

        private void ScheduleReconcile(ulong login, string kind, string clientOrderId, string code,
            ulong ticket, TradeResult r)
        {
            // 只有开仓和平仓能按成交记录核对;改单/撤单/挂单没有成交可找。
            // Only opens and closes leave deals to find.
            if (kind != "open" && kind != "close")
                return;

            int now = Environment.TickCount;
            ReconcileJob job = new ReconcileJob
            {
                Login = login,
                Kind = kind,
                ClientOrderId = clientOrderId,
                Code = code,
                Ticket = ticket,
                CreatedAt = now,
                NextAt = unchecked(now + 2000)
            };

            _reconciles[login + "|" + kind + "|" + clientOrderId] = job;
            Log.Warn("{0} 结果未知,已排入后台核对(login={1} 短码 {2})", kind == "open" ? "开仓" : "平仓", login, code);

            EnsureReconcileThread();
        }

        private void EnsureReconcileThread()
        {
            if (_reconcileThread != null)
                return;

            lock (_reconcileStartLock)
            {
                if (_reconcileThread != null)
                    return;

                _reconcileThread = new Thread(ReconcileLoop)
                {
                    IsBackground = true,
                    Name = "reconcile"
                };
                _reconcileThread.Start();
            }
        }

        private void ReconcileLoop()
        {
            while (!_stopping)
            {
                try
                {
                    Thread.Sleep(500);

                    if (_reconciles.IsEmpty || !_connected)
                        continue;

                    foreach (KeyValuePair<string, ReconcileJob> kv in _reconciles)
                    {
                        ReconcileJob job = kv.Value;
                        int now = Environment.TickCount;

                        if (unchecked(now - job.NextAt) < 0)
                            continue;

                        ReconcileOne(kv.Key, job);
                    }
                }
                catch (Exception ex)
                {
                    Log.Warn("后台核对循环异常:{0}", ex.Message);
                }
            }
        }

        private void ReconcileOne(string key, ReconcileJob job)
        {
            job.Attempts++;
            int age = unchecked(Environment.TickCount - job.CreatedAt);

            // 往后逐次放慢:2s、3s、5s、10s、之后每 30s。/ Back off: 2s, 3s, 5s, 10s, then 30s.
            int[] steps = { 3000, 5000, 10000, 30000 };
            job.NextAt = unchecked(Environment.TickCount + steps[Math.Min(job.Attempts - 1, steps.Length - 1)]);

            // 时间按服务器时区不确定,左右各放宽两天,再用短码精确匹配。
            // Server time zone is unknown here; take ±2 days and match by the code.
            long nowUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            MTRetCode res;
            bool readBusy;
            DealInfo[] deals = GetDeals(job.Login, nowUnix - 2 * 86400, nowUnix + 2 * 86400,
                out res, out readBusy, false);

            if (deals == null || res != MTRetCode.MT_RET_OK)
            {
                if (age > ReconcileGiveUpMs)
                    GiveUp(key, job, "查询一直失败(" + res + ")");
                return;
            }

            string suffix = "-" + job.Code;
            DealInfo hit = null;

            foreach (DealInfo d in deals)
            {
                if (d == null || string.IsNullOrEmpty(d.Comment) || !d.Comment.EndsWith(suffix, StringComparison.Ordinal))
                    continue;

                bool entryOk = job.Kind == "open" ? d.Entry == 0 : (d.Entry == 1 || d.Entry == 3);
                if (!entryOk)
                    continue;

                if (job.Kind == "close" && job.Ticket != 0 && d.PositionId != job.Ticket)
                    continue;

                hit = d;
                break;
            }

            if (hit != null)
            {
                TradeResult r = new TradeResult
                {
                    Ok = true,
                    Retcode = MTRetCode.MT_RET_REQUEST_DONE.ToString(),
                    Message = "事后核对:这笔指令已经成交 / reconciled: filled",
                    Deal = hit.Ticket,
                    Position = hit.PositionId,
                    Price = hit.Price,
                    Resolved = "filled"
                };

                Interlocked.Increment(ref _reconcileFilled);
                Resolve(key, job, r);
                return;
            }

            // 平仓还可以看仓位还在不在:券商若改写了 comment,短码会丢,但仓位没了说明平掉了。
            // For a close, a vanished position also settles it (brokers may rewrite comments).
            if (job.Kind == "close" && job.Ticket != 0)
            {
                PositionSnapshot snap;
                bool fromPump;
                MTRetCode pres;
                bool exists = ReadPosition(job.Ticket, true, out snap, out fromPump, out pres);

                if (!exists && pres == MTRetCode.MT_RET_ERR_NOTFOUND)
                {
                    TradeResult r = new TradeResult
                    {
                        Ok = true,
                        Retcode = MTRetCode.MT_RET_REQUEST_DONE.ToString(),
                        Message = "事后核对:仓位已不存在,按已平仓处理 / reconciled: position gone",
                        Position = job.Ticket,
                        Resolved = "filled"
                    };

                    Interlocked.Increment(ref _reconcileFilled);
                    Resolve(key, job, r);
                    return;
                }
            }

            job.CleanMisses++;

            if (age >= ReconcileNotFilledAfterMs && job.CleanMisses >= 3)
            {
                TradeResult r = TradeResult.Fail("MT_RET_REQUEST_REJECT",
                    "事后核对:服务器上没有这笔成交,指令未执行 / reconciled: not filled");
                r.Resolved = "not_filled";

                Interlocked.Increment(ref _reconcileNotFilled);
                Resolve(key, job, r);
                return;
            }

            if (age > ReconcileGiveUpMs)
                GiveUp(key, job, "十分钟内没有结论");
        }

        private void Resolve(string key, ReconcileJob job, TradeResult r)
        {
            ReconcileJob ignored;
            _reconciles.TryRemove(key, out ignored);

            Log.Info("后台核对出结论:login={0} {1} clientOrderId={2} → {3}(成交 {4} 仓位 {5})",
                job.Login, job.Kind, job.ClientOrderId, r.Resolved, r.Deal, r.Position);

            Events.Publish("trade_resolved", job.Login, j => j
                .Field("kind", job.Kind)
                .Field("clientOrderId", job.ClientOrderId)
                .Field("resolved", r.Resolved)
                .Field("ok", r.Ok)
                .Field("retcode", r.Retcode)
                .Field("deal", r.Deal)
                .Field("position", r.Position)
                .Field("price", r.Price));

            Action<ulong, string, string, TradeResult> h = TradeResolved;
            if (h != null)
            {
                try { h(job.Login, job.Kind, job.ClientOrderId, r); }
                catch (Exception ex) { Log.Warn("核对结论回写失败:{0}", ex.Message); }
            }
        }

        private void GiveUp(string key, ReconcileJob job, string why)
        {
            ReconcileJob ignored;
            _reconciles.TryRemove(key, out ignored);
            Interlocked.Increment(ref _reconcileGaveUp);

            Log.Warn("后台核对放弃:login={0} {1} clientOrderId={2},{3},需人工核对",
                job.Login, job.Kind, job.ClientOrderId, why);
        }
    }
}
