using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

namespace Prismx.Mt5Gateway
{
    /// <summary>
    /// 交易请求的幂等缓存:同一个 (login, clientOrderId, 动作) 只真正执行一次。
    ///
    /// 为什么需要:/trade/open 等 dealer 回执最长 60 秒(dealer_timeout_ms),后端那头
    /// 65 秒超时。网络一抖、或后端超时后再发一次同样的请求,旧实现会老老实实再开一
    /// 次仓——用户看到的是"下单失败",账户里却多了一笔真仓。桥接程序早就按
    /// clientOrderId 做了 24 小时结果缓存(~/.prismx_bridge_executed.json),这里是
    /// 网关版。
    ///
    /// 三种状态:
    ///   · 没见过 → 登记为"执行中",调用方去下单,完成后 Complete();
    ///   · 执行中 → 等它完成(最多 waitMs),拿同一份结果;等不到就告诉调用方
    ///     仍在执行,由后端决定怎么办;
    ///   · 已完成 → 直接回缓存结果,不碰 dealer。
    /// 抛异常也记成失败结果而不是删掉条目:异常发生在 dealer 请求发出之后的话,仓位
    /// 可能已经开了,让重试再开一次比让它拿到"失败"更危险。后端本来就按失败处理、
    /// 用户重下会换新的 clientOrderId。
    ///
    /// **落盘,重启后仍然有效。** 这里原来写的是"只在内存里:网关重启即空。重启期间
    /// dealer 连接本身也断了,不会有『上一进程还在执行』的请求,所以不需要落盘。"
    /// 这个前提是错的:网关的部署方式就是 install-service.ps1 里的
    /// `$proc | Stop-Process -Force`——进程被**硬杀**时,已经 DealerSend 出去的请求
    /// 在**券商侧照常执行**,只是本进程再也收不到回执。重启后内存缓存为空,后端按同
    /// 一个 clientOrderId 重试就会真的再开一仓。也就是说,那次手动部署恰好构造出了
    /// 这个缓存本该防住的那件事。
    ///
    /// 所以两类记录都要落盘,而且**"开始执行"必须在 dealer 请求发出之前就写下去**:
    ///   · begin —— 登记执行中。重启后看到 begin 没有对应的 done,就意味着"这笔可能
    ///     已经在券商那边执行了,而我们不知道结果"。这种 key 会被复原成一条**失败**
    ///     结果(PlacedUnconfirmed,后端据此落 FAILED 而不是 REJECTED),**绝不重新执
    ///     行**——重发一次的代价是重复开仓,回一个"未确认"只是要人工对一次账。
    ///   · done  —— 执行完成的结果,重启后原样回放。
    ///
    /// TTL 24 小时,与桥接对齐,远大于后端 GATEWAY_RECONCILE_TIMEOUT(75 秒)加上
    /// 任何合理的网络余量——重试窗口在分钟级,这里按天算,不会有"过期得太早"的问题。
    ///
    /// 文件是**追加**的 JSONL(一行一条记录):追加对"进程随时可能被硬杀"最友好,
    /// 最后一行写了一半的话,加载时跳过那一行即可,前面的记录一条都不会丢。整理
    /// (去掉过期行)只在启动时和清扫时做,用"写临时文件再替换"完成。
    ///
    /// Idempotency cache for trade requests: one real execution per
    /// (login, clientOrderId, action). **Persisted across restarts.** The old comment
    /// claimed memory-only was safe because a restart drops the dealer link too — but
    /// deployment is `Stop-Process -Force`, and a request already sent to the dealer
    /// still executes broker-side while this process dies without the answer. Both the
    /// begin marker (written *before* the dealer send) and the final result are
    /// appended to a JSONL file. A begin without a done is restored as a failed
    /// "unconfirmed" result and is never re-executed: a duplicate open costs real
    /// money, an unconfirmed answer costs one manual reconciliation.
    /// </summary>
    internal sealed class IdempotencyCache
    {
        private sealed class Entry
        {
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public TradeResult Result;
            public DateTime CompletedAt = DateTime.MaxValue;
            /// <summary>登记时刻。给"重启后发现 begin 没 done"的条目算过期用。
            /// When the key was registered; gives restored begin-only entries an age.</summary>
            public DateTime StartedAt = DateTime.UtcNow;
        }

        private readonly Dictionary<string, Entry> _entries =
            new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly object _lock = new object();
        private readonly TimeSpan _ttl;
        private DateTime _lastSweep = DateTime.UtcNow;

        /// <summary>落盘文件路径;null = 只在内存里(单元测试 / CLI 工具)。
        /// Persistence file; null means memory-only (tests and CLI tools).</summary>
        private readonly string _storePath;
        private bool _storeBroken;

        /// <summary>常开的追加句柄。以前每笔交易 File.AppendAllText 一次=开文件、写、
        /// 关文件,而这是在 _lock 里做的,高峰时所有交易都要排这个队。整理文件前关掉,
        /// 下次追加再开。持 _lock 访问。
        /// Kept-open append handle. AppendAllText opened and closed the file per trade
        /// under _lock, so a burst queued on it. Closed before a rewrite, reopened on
        /// the next append. Accessed under _lock.</summary>
        private StreamWriter _writer;

        /// <summary>
        /// 重启时复原出来的"可能已在券商侧执行、结果未知"的回复。
        ///
        /// 复用 Mt5Link.PlacedUnconfirmed 而不是再发明一个新码,是为了不需要改后端:
        /// 后端已经认得这个码并落成 FAILED(既不是成交也不是拒绝),语义正是这里要的。
        /// Reuses the retcode the backend already maps to FAILED, so no backend change
        /// is needed for this to land.
        /// </summary>
        private static TradeResult InterruptedResult()
        {
            return TradeResult.Fail(Mt5Link.PlacedUnconfirmed,
                "网关在处理这笔请求的过程中被重启,该请求可能已经发到券商并执行,但本次无法确认结果。"
                + "请不要用同一笔指令重复提交,先核对持仓与成交记录。");
        }

        public IdempotencyCache(TimeSpan ttl, string storePath = null)
        {
            _ttl = ttl;
            _storePath = string.IsNullOrEmpty(storePath) ? null : storePath;
            LoadFromDisk();
        }

        public static string Key(ulong login, string action, string clientOrderId)
        {
            return login.ToString() + "|" + action + "|" + clientOrderId;
        }

        /// <summary>
        /// 尝试开始执行。返回 true = 由调用方执行(之后必须 Complete);返回 false 且
        /// existing 非空 = 已有结果(或等到了结果),直接回它;返回 false 且 existing
        /// 为空 = 另一个请求还在执行且等超时了。
        /// </summary>
        public bool TryBegin(string key, int waitMs, out TradeResult existing, out bool replayed)
        {
            Entry entry;
            bool created = false;

            lock (_lock)
            {
                SweepLocked();

                if (!_entries.TryGetValue(key, out entry))
                {
                    entry = new Entry();
                    _entries[key] = entry;
                    created = true;

                    // 必须在放行调用方(也就是在 dealer 请求发出)**之前**落盘:
                    // 这条记录的全部意义就是"万一下一刻进程被杀,重启后还知道这笔
                    // 请求曾经出去过"。写在之后就等于没写。
                    // Written before the caller is released to the dealer: the whole
                    // point is surviving a kill that happens in the next instant.
                    AppendLocked(BeginRecord(key, entry.StartedAt));
                }
            }

            if (created)
            {
                existing = null;
                replayed = false;
                return true;
            }

            replayed = true;

            // 等待在 _lock 之外做:等待期可长达 dealer 超时,不能把整张表锁住。
            // entry.Done 只在 SweepLocked 摘除条目后才可能被弃用,而那里已经改成
            // 不 Dispose(见 SweepLocked 的注释),所以这里不会吃 ObjectDisposedException。
            // Waiting happens outside the lock; Sweep no longer disposes the handle.
            if (entry.Done.Wait(waitMs))
            {
                existing = entry.Result;
                return false;
            }

            existing = null;
            return false;
        }

        public void Complete(string key, TradeResult result)
        {
            Entry entry;

            lock (_lock)
            {
                if (!_entries.TryGetValue(key, out entry))
                    return;

                entry.Result = result;
                entry.CompletedAt = DateTime.UtcNow;

                AppendLocked(DoneRecord(key, entry.CompletedAt, result));
            }

            entry.Done.Set();
        }

        public int Count
        {
            get { lock (_lock) { return _entries.Count; } }
        }

        //+------------------------------------------------------------------+
        //| 过期清扫                                                        |
        //+------------------------------------------------------------------+

        // 每分钟最多扫一次。
        //
        // 执行中的条目原来永不过期:run() 一旦挂住(dealer 不答且超时逻辑也没兜住),
        // 这个 key 就永久停在 IN_PROGRESS,条目本身也永远泄漏。现在给它一个硬上限
        // ——超过 InFlightHardLimit 就当成"结果未知"收尾并放它过期,与重启复原出来
        // 的那种条目同一个语义。
        // In-flight entries used to never expire, so a stuck run() pinned its key at
        // IN_PROGRESS forever and leaked the entry. They now get a hard ceiling and
        // are closed out as "unknown", the same shape as a restart-restored entry.
        private void SweepLocked()
        {
            DateTime now = DateTime.UtcNow;

            if (now - _lastSweep < TimeSpan.FromMinutes(1))
                return;

            _lastSweep = now;
            List<string> dead = null;

            foreach (KeyValuePair<string, Entry> kv in _entries)
            {
                Entry e = kv.Value;

                if (e.CompletedAt == DateTime.MaxValue)
                {
                    if (now - e.StartedAt > InFlightHardLimit)
                    {
                        // 就地收尾:等在它上面的请求会立刻拿到这份"未确认"结果,
                        // 而不是一直等到 waitMs 超时再收到 IN_PROGRESS。
                        // Close it out in place so waiters get an answer immediately.
                        e.Result = InterruptedResult();
                        e.CompletedAt = now;
                        e.Done.Set();
                        Log.Warn("幂等条目执行超时,按结果未知收尾:{0}", kv.Key);
                    }

                    continue;
                }

                if (now - e.CompletedAt > _ttl)
                {
                    if (dead == null)
                        dead = new List<string>();
                    dead.Add(kv.Key);
                }
            }

            if (dead == null)
                return;

            foreach (string k in dead)
            {
                // 不再 Dispose 这个句柄。原来这里 Dispose 了,而 TryBegin 是在 _lock
                // 之外调用 entry.Done.Wait() 的:条目恰好在那一刻被清掉的话,等待方
                // 会吃一个 ObjectDisposedException 变成 500。交给 GC 回收即可——
                // ManualResetEventSlim 在没有被 Wait 升级成内核事件时并不持有句柄。
                // No Dispose: TryBegin waits on this handle outside the lock, so
                // disposing it under the lock could throw ObjectDisposedException at
                // the waiter and turn a duplicate request into a 500.
                _entries.Remove(k);
            }

            // 表里删掉了东西,顺手把文件也整理一遍,否则它只会一直变长。
            // Compact the file too, or it only ever grows.
            RewriteLocked();
        }

        /// <summary>执行中条目的硬上限。dealer 超时最长 60 秒,加一倍余量足够宽松。
        /// Hard ceiling for in-flight entries; the dealer timeout caps at 60s.</summary>
        private static readonly TimeSpan InFlightHardLimit = TimeSpan.FromMinutes(5);

        //+------------------------------------------------------------------+
        //| 落盘                                                            |
        //+------------------------------------------------------------------+

        private static string BeginRecord(string key, DateTime at)
        {
            return new JsonWriter()
                .BeginObject()
                .Field("k", key)
                .Field("t", ToUnixMs(at))
                .Field("s", "begin")
                .EndObject()
                .ToString();
        }

        private static string DoneRecord(string key, DateTime at, TradeResult r)
        {
            JsonWriter w = new JsonWriter()
                .BeginObject()
                .Field("k", key)
                .Field("t", ToUnixMs(at))
                .Field("s", "done")
                .Field("ok", r != null && r.Ok);

            if (r != null)
            {
                w.Field("rc", r.Retcode ?? "")
                 .Field("msg", r.Message ?? "")
                 .Field("deal", r.Deal)
                 .Field("order", r.Order)
                 .Field("pos", r.Position)
                 .Field("price", r.Price)
                 .Field("placed", r.Placed);
            }

            return w.EndObject().ToString();
        }

        private static ulong ToUnixMs(DateTime utc)
        {
            return (ulong)(utc - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static DateTime FromUnixMs(ulong ms)
        {
            return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms);
        }

        /// <summary>追加一行。调用方持 _lock。写盘失败绝不让交易失败——只记日志。
        /// Appends one line (caller holds _lock). A write failure never fails a trade.</summary>
        private void AppendLocked(string line)
        {
            if (_storePath == null)
                return;

            try
            {
                if (_writer == null)
                {
                    string dir = Path.GetDirectoryName(_storePath);

                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                        Directory.CreateDirectory(dir);

                    FileStream fs = new FileStream(_storePath, FileMode.Append, FileAccess.Write,
                        FileShare.ReadWrite | FileShare.Delete);
                    _writer = new StreamWriter(fs, new UTF8Encoding(false));
                }

                // Flush 把这一行交给操作系统,与原来 AppendAllText 关文件时的保证相同:
                // 进程被硬杀也不会丢(操作系统还在)。
                // Flush hands the line to the OS — the same guarantee AppendAllText gave
                // on close, which is what survives a process kill.
                _writer.Write(line);
                _writer.Write(Environment.NewLine);
                _writer.Flush();
                _storeBroken = false;
            }
            catch (Exception ex)
            {
                CloseWriterLocked();

                // 磁盘满/权限问题不该挡住下单,但必须吵一次:这时候幂等保护退化回
                // 了"只在内存里",也就是重启后会丢。
                // A broken store must not block trading, but it does mean the
                // protection has silently degraded to memory-only.
                if (!_storeBroken)
                {
                    _storeBroken = true;
                    Log.Error("幂等缓存写盘失败,重启后将无法识别重复请求:{0}", ex.Message);
                }
            }
        }

        private void CloseWriterLocked()
        {
            if (_writer == null)
                return;

            try { _writer.Dispose(); }
            catch { }

            _writer = null;
        }

        /// <summary>把当前表整个写回文件(去掉已过期的行)。调用方持 _lock。
        /// Rewrites the file from the live table (caller holds _lock).</summary>
        private void RewriteLocked()
        {
            if (_storePath == null)
                return;

            try
            {
                StringBuilder sb = new StringBuilder();

                foreach (KeyValuePair<string, Entry> kv in _entries)
                {
                    Entry e = kv.Value;

                    if (e.CompletedAt == DateTime.MaxValue)
                        sb.AppendLine(BeginRecord(kv.Key, e.StartedAt));
                    else
                        sb.AppendLine(DoneRecord(kv.Key, e.CompletedAt, e.Result));
                }

                // 先写临时文件再替换:整理过程中被硬杀时,原文件仍然是完整的那一份。
                // Temp file then replace, so a kill mid-rewrite leaves the original intact.
                CloseWriterLocked();

                string tmp = _storePath + ".tmp";
                File.WriteAllText(tmp, sb.ToString(), Encoding.UTF8);

                // File.Replace 是一步完成的替换。原来先删再移:两步之间被硬杀,或者 Move
                // 失败(杀毒软件、索引服务正开着旧文件),就会一个文件都不剩,重启后过去
                // 24 小时的防重记录全丢。
                // File.Replace swaps in one step. Delete-then-move could leave no file at
                // all if killed in between or if Move failed (antivirus holding the old
                // file), losing 24h of duplicate protection on the next restart.
                if (File.Exists(_storePath))
                    File.Replace(tmp, _storePath, null);
                else
                    File.Move(tmp, _storePath);
            }
            catch (Exception ex)
            {
                Log.Warn("幂等缓存整理失败(不影响本次运行):{0}", ex.Message);
            }
        }

        /// <summary>启动时把文件读回内存。构造函数里调用,此时还没有别的线程。
        /// Replays the file at construction time; no other thread exists yet.</summary>
        private void LoadFromDisk()
        {
            if (_storePath == null || !File.Exists(_storePath))
                return;

            DateTime now = DateTime.UtcNow;
            int restored = 0;
            int interrupted = 0;

            try
            {
                foreach (string raw in File.ReadAllLines(_storePath, Encoding.UTF8))
                {
                    string line = raw.Trim();

                    if (line.Length == 0)
                        continue;

                    JsonObject o;

                    try
                    {
                        o = JsonObject.Parse(line);
                    }
                    catch (Exception)
                    {
                        // 进程被硬杀时最后一行可能只写了一半。跳过它,前面的都还在。
                        // A kill can tear the last line; skip it, the rest survive.
                        Log.Warn("幂等缓存有一行无法解析,已跳过(通常是上次被强杀时写了一半)");
                        continue;
                    }

                    string key = o.GetString("k");

                    if (key.Length == 0)
                        continue;

                    DateTime at = FromUnixMs(o.GetUlong("t"));

                    if (now - at > _ttl)
                        continue;

                    Entry e;

                    if (!_entries.TryGetValue(key, out e))
                    {
                        e = new Entry();
                        _entries[key] = e;
                    }

                    if (o.GetString("s") == "done")
                    {
                        TradeResult r = new TradeResult
                        {
                            Ok = o.GetBool("ok"),
                            Retcode = o.GetString("rc"),
                            Message = o.GetString("msg"),
                            Deal = o.GetUlong("deal"),
                            Order = o.GetUlong("order"),
                            Position = o.GetUlong("pos"),
                            Price = o.GetDouble("price"),
                            Placed = o.GetBool("placed")
                        };

                        e.Result = r;
                        e.CompletedAt = at;
                        e.Done.Set();
                    }
                    else
                    {
                        e.StartedAt = at;
                    }
                }

                // begin 有、done 没有 = 上一个进程在处理这笔请求时被杀了。它可能已经
                // 发到券商并执行,所以**不能**让后端用同一个 clientOrderId 重新执行一遍。
                // A begin without a done means the previous process died mid-request.
                List<string> pending = new List<string>();

                foreach (KeyValuePair<string, Entry> kv in _entries)
                {
                    if (kv.Value.CompletedAt == DateTime.MaxValue)
                        pending.Add(kv.Key);
                }

                foreach (string k in pending)
                {
                    Entry e = _entries[k];
                    e.Result = InterruptedResult();
                    e.CompletedAt = e.StartedAt;
                    e.Done.Set();
                    interrupted++;
                }

                restored = _entries.Count;
            }
            catch (Exception ex)
            {
                Log.Error("幂等缓存加载失败,本次按空缓存运行:{0}", ex.Message);
            }

            if (restored > 0)
            {
                Log.Info("幂等缓存已从磁盘恢复 {0} 条,其中 {1} 条是上次被中断、结果未知的请求",
                    restored, interrupted);
            }

            // 顺手整理掉过期行 / drop the expired lines we just skipped
            lock (_lock)
            {
                RewriteLocked();
            }
        }
    }
}
