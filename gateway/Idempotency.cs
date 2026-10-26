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

        /// <summary>只保护内存里的 _entries。文件相关的一切走 _fileLock。
        /// Guards the in-memory table only; everything on disk is under _fileLock.</summary>
        private readonly object _lock = new object();
        private readonly TimeSpan _ttl;

        /// <summary>落盘文件路径;null = 只在内存里(单元测试 / CLI 工具)。
        /// Persistence file; null means memory-only (tests and CLI tools).</summary>
        private readonly string _storePath;

        /// <summary>
        /// 只保护文件句柄与文件本身(_writer、_storeBroken、_rewriteBacklog、替换那一步)。
        /// 与 _lock 分开:以前追加和 24 小时整份重写都在 _lock 里,每分钟有一笔下单要在
        /// 自己的路径上把整份文件同步写一遍,同一时刻的其它下单全排在后面。现在重写的
        /// 重活(拼内容、写临时文件)两把锁都不占。两把锁需要同时持有时,顺序一律是先
        /// _lock 后 _fileLock——实际上没有任何地方同时持有两把。
        /// Guards the file handle and the file itself. Separate from _lock: appends and the
        /// full 24h rewrite used to run under _lock, so once a minute some order rewrote the
        /// whole file on its own path with every concurrent order queued behind it. The heavy
        /// part of a rewrite now holds neither lock. Lock order, were both ever needed, is
        /// _lock then _fileLock; nothing currently holds both.
        /// </summary>
        private readonly object _fileLock = new object();
        private bool _storeBroken;

        /// <summary>常开的追加句柄。以前每笔交易 File.AppendAllText 一次=开文件、写、
        /// 关文件,高峰时所有交易都要排这个队。替换文件前关掉,下次追加再开。持 _fileLock 访问。
        /// Kept-open append handle; closed before the file is replaced, reopened on the
        /// next append. Accessed under _fileLock.</summary>
        private StreamWriter _writer;

        /// <summary>
        /// 重写进行中时追加的行。重写用的是某一刻的快照,快照之后追加的行照常写进旧文件
        /// (万一重写失败或进程被杀,旧文件仍然完整),同时记在这里;新文件换上之后立刻
        /// 补写进去,一行都不会丢。null = 当前没有重写。持 _fileLock 访问。
        /// Lines appended while a rewrite is in progress. They still go to the old file (so
        /// a failed rewrite or a kill loses nothing) and are also kept here, then written to
        /// the new file right after it is swapped in. null = no rewrite running.
        /// </summary>
        private List<string> _rewriteBacklog;

        /// <summary>后台清扫定时器,每分钟一次。持有引用防止被 GC 回收。
        /// Background sweep timer, once a minute; referenced so the GC keeps it.</summary>
        private readonly Timer _sweepTimer;
        private int _sweeping;

        /// <summary>
        /// 内存条目上限。TTL 24 小时、key 由调用方给,不设上限的话一个调用方换着
        /// clientOrderId 打就能把内存(和落盘文件)撑到没边。20 万条远超正常一天的交易量;
        /// 超了就一次淘汰最旧的十分之一**已完成**条目(执行中的绝不淘汰——那正是防重复
        /// 下单的关键),排序的代价摊到之后的两万次登记上。
        /// In-memory cap. Keys are caller-supplied with a 24h TTL; unbounded, one caller
        /// cycling clientOrderIds could grow memory and the file without limit. 200k is far
        /// beyond a normal day. On overflow the oldest tenth of *completed* entries is evicted
        /// in one go (in-flight entries never are), amortising the sort.
        /// </summary>
        private const int MaxEntries = 200000;
        private const int EvictBatch = MaxEntries / 10;

        /// <summary>有条目被淘汰、文件待整理;由清扫定时器消费。/ Set after an eviction; the sweep compacts.</summary>
        private int _compactPending;

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

            // 清扫与文件整理不再挂在下单路径上(原来在 TryBegin 里、持 _lock 做),改由
            // 这个后台定时器每分钟做一次。
            // Sweeping and compaction moved off the order path (it ran inside TryBegin
            // under _lock) onto this once-a-minute background timer.
            _sweepTimer = new Timer(OnSweepTimer, null, SweepEvery, SweepEvery);
        }

        private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(1);

        /// <summary>
        /// 定时器回调。跑在线程池上:异常漏出去就是整个进程退出,所以整段兜住;上一轮
        /// 还没做完(磁盘慢)就跳过这一轮,不叠着跑。
        /// Timer callback on the thread pool: an escaping exception ends the process, so it
        /// is wrapped whole; a round still running (slow disk) makes this one skip.
        /// </summary>
        private void OnSweepTimer(object state)
        {
            if (Interlocked.Exchange(ref _sweeping, 1) != 0)
                return;

            try
            {
                Sweep();
            }
            catch (Exception ex)
            {
                try { Log.Warn("幂等缓存清扫异常(不影响交易):{0}", ex.Message); }
                catch { }
            }
            finally
            {
                Interlocked.Exchange(ref _sweeping, 0);
            }
        }

        /// <summary>
        /// 只看不登记:这个 key 有没有记录。有且已完成 → completed 为那份结果;有但仍在
        /// 执行 → 返回 true、completed 为 null。给"交易连接不在时先回放已有结果、没有才
        /// 直接拒绝"用(见 HttpServer.RejectWhileLinkDown)。
        /// Look without registering: true if the key is known, with its result when done
        /// (null while still in flight). Used to replay known keys before refusing a trade
        /// while the link is down (see HttpServer.RejectWhileLinkDown).
        /// </summary>
        public bool TryPeek(string key, out TradeResult completed)
        {
            completed = null;

            lock (_lock)
            {
                Entry entry;
                if (!_entries.TryGetValue(key, out entry))
                    return false;

                if (entry.CompletedAt != DateTime.MaxValue)
                    completed = entry.Result;

                return true;
            }
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
            int evicted = 0;

            lock (_lock)
            {
                if (!_entries.TryGetValue(key, out entry))
                {
                    if (_entries.Count >= MaxEntries)
                        evicted = EvictOldestLocked();

                    entry = new Entry();
                    _entries[key] = entry;
                    created = true;
                }
            }

            if (evicted > 0)
            {
                Interlocked.Exchange(ref _compactPending, 1);
                Log.Warn("幂等缓存达到上限 {0} 条,已淘汰最旧的 {1} 条已完成记录", MaxEntries, evicted);
            }

            if (created)
            {
                // 必须在放行调用方(也就是在 dealer 请求发出)**之前**落盘:
                // 这条记录的全部意义就是"万一下一刻进程被杀,重启后还知道这笔
                // 请求曾经出去过"。写在之后就等于没写。写盘在 _lock 之外做(只占
                // _fileLock),别的 key 查表、登记不必等这一次磁盘写。
                // Written before the caller is released to the dealer: the whole
                // point is surviving a kill that happens in the next instant. Done
                // outside _lock (only _fileLock), so other keys never wait on this write.
                Append(BeginRecord(key, entry.StartedAt));

                existing = null;
                replayed = false;
                return true;
            }

            replayed = true;

            // 等待在 _lock 之外做:等待期可长达 dealer 超时,不能把整张表锁住。
            // entry.Done 只在 Sweep 摘除条目后才可能被弃用,而那里已经改成
            // 不 Dispose(见 Sweep 的注释),所以这里不会吃 ObjectDisposedException。
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
            string line;

            lock (_lock)
            {
                if (!_entries.TryGetValue(key, out entry))
                    return;

                entry.Result = result;
                entry.CompletedAt = DateTime.UtcNow;
                line = DoneRecord(key, entry.CompletedAt, result);
            }

            // 先落盘再叫醒等待方,与原来的顺序一致。/ Persist, then wake waiters, as before.
            Append(line);
            entry.Done.Set();
        }

        public int Count
        {
            get { lock (_lock) { return _entries.Count; } }
        }

        /// <summary>
        /// 淘汰最旧的已完成条目,把表压回 MaxEntries - EvictBatch。调用方持有 _lock
        /// (或在构造期,没有别的线程)。返回淘汰条数。
        /// Evicts the oldest completed entries down to MaxEntries - EvictBatch. Caller
        /// holds _lock (or is the constructor). Returns how many were removed.
        /// </summary>
        private int EvictOldestLocked()
        {
            int need = _entries.Count - (MaxEntries - EvictBatch);
            if (need <= 0)
                return 0;

            List<KeyValuePair<string, Entry>> done = new List<KeyValuePair<string, Entry>>(_entries.Count);

            foreach (KeyValuePair<string, Entry> kv in _entries)
            {
                if (kv.Value.CompletedAt != DateTime.MaxValue)
                    done.Add(kv);
            }

            done.Sort((a, b) => a.Value.CompletedAt.CompareTo(b.Value.CompletedAt));

            int n = Math.Min(need, done.Count);
            for (int i = 0; i < n; i++)
                _entries.Remove(done[i].Key);   // 不 Dispose,理由同 Sweep / no Dispose, see Sweep

            return n;
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
        //
        // 由后台定时器调用(见构造函数),不在任何下单路径上。_lock 里只做内存操作,
        // 文件整理放到锁外的 Rewrite。
        // Called from the background timer, never on an order path. Only memory work
        // happens under _lock; compaction runs outside it in Rewrite.
        private void Sweep()
        {
            DateTime now = DateTime.UtcNow;
            List<string> dead = null;
            List<string> closedOut = null;

            lock (_lock)
            {
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

                            if (closedOut == null)
                                closedOut = new List<string>();
                            closedOut.Add(kv.Key);
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

                if (dead != null)
                {
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
                }
            }

            if (closedOut != null)
            {
                foreach (string k in closedOut)
                    Log.Warn("幂等条目执行超时,按结果未知收尾:{0}", k);
            }

            // 表里删掉了东西(过期或超上限淘汰),顺手把文件也整理一遍,否则它只会一直变长。
            // Compact the file too (expired or evicted entries), or it only ever grows.
            if (Interlocked.Exchange(ref _compactPending, 0) != 0 || dead != null)
                Rewrite();
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

        /// <summary>追加一行,只占 _fileLock(调用方不要持 _lock)。写盘失败绝不让交易失败——只记日志。
        /// Appends one line under _fileLock only (callers don't hold _lock). A write
        /// failure never fails a trade.</summary>
        private void Append(string line)
        {
            if (_storePath == null)
                return;

            lock (_fileLock)
            {
                // 重写进行中:这一行照常写进旧文件,同时记下来,新文件换上后补写。
                // Rewrite in progress: still write to the old file, and keep the line
                // for the new file.
                if (_rewriteBacklog != null)
                    _rewriteBacklog.Add(line);

                WriteLineFileLocked(line);
            }
        }

        /// <summary>把一行写进当前文件。调用方持 _fileLock。
        /// Writes one line to the current file; caller holds _fileLock.</summary>
        private void WriteLineFileLocked(string line)
        {
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
                CloseWriterFileLocked();

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

        private void CloseWriterFileLocked()
        {
            if (_writer == null)
                return;

            try { _writer.Dispose(); }
            catch { }

            _writer = null;
        }

        /// <summary>
        /// 把当前表整个写回文件(去掉已过期的行)。调用方**不要**持 _lock 或 _fileLock。
        ///
        /// 三步:① _lock 里只拍快照(拼成字符串)——在这之前先在 _fileLock 里打开
        /// _rewriteBacklog,保证快照之后的每一次追加都被记下;② 两把锁都不占,把快照写进
        /// 临时文件(整份 24 小时记录,真正慢的就是这一步);③ _fileLock 里一步替换,再把
        /// 重写期间追加的行补写进新文件。第 ③ 步只有一次改名加几行写,追加最多等这么久。
        ///
        /// 为什么不会丢行:backlog 在拍快照**之前**就打开了。追加总是跟在内存改动之后,
        /// 所以任何一次追加,要么发生在 backlog 打开之前(那它对应的改动更早,已在快照里),
        /// 要么被 backlog 记下(替换后补写)。两边都有的只会多出一行重复记录,加载时后一行
        /// 覆盖前一行,结果相同。
        ///
        /// Rewrites the file from the live table; callers hold neither lock. ① Snapshot
        /// under _lock — after opening _rewriteBacklog under _fileLock so every append from
        /// then on is captured; ② write the snapshot to a temp file holding no lock (the
        /// slow part); ③ under _fileLock, swap it in and replay the backlog. No line is
        /// lost: an append always follows its memory change, so it either precedes the
        /// backlog (and its change is in the snapshot) or lands in the backlog. Overlap only
        /// produces a harmless duplicate line.
        /// </summary>
        private void Rewrite()
        {
            if (_storePath == null)
                return;

            lock (_fileLock)
            {
                _rewriteBacklog = new List<string>();
            }

            string tmp = _storePath + ".tmp";
            bool swapped = false;

            try
            {
                StringBuilder sb = new StringBuilder();

                lock (_lock)
                {
                    foreach (KeyValuePair<string, Entry> kv in _entries)
                    {
                        Entry e = kv.Value;

                        if (e.CompletedAt == DateTime.MaxValue)
                            sb.AppendLine(BeginRecord(kv.Key, e.StartedAt));
                        else
                            sb.AppendLine(DoneRecord(kv.Key, e.CompletedAt, e.Result));
                    }
                }

                // 先写临时文件再替换:整理过程中被硬杀时,原文件仍然是完整的那一份。
                // 不带 BOM,与追加句柄(UTF8Encoding(false))一致。
                // Temp file then replace, so a kill mid-rewrite leaves the original intact.
                // No BOM, matching the append handle.
                File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));

                lock (_fileLock)
                {
                    try
                    {
                        CloseWriterFileLocked();

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

                        swapped = true;

                        // 新文件换上了:补写重写期间追加的行。替换失败的话这些行本来就在
                        // 旧文件里,不用补。
                        // Swapped in: replay what was appended meanwhile. On failure these
                        // lines are already in the old file.
                        foreach (string line in _rewriteBacklog)
                            WriteLineFileLocked(line);
                    }
                    finally
                    {
                        _rewriteBacklog = null;
                    }
                }
            }
            catch (Exception ex)
            {
                lock (_fileLock)
                {
                    _rewriteBacklog = null;
                }

                Log.Warn("幂等缓存整理失败(不影响本次运行):{0}", ex.Message);
            }

            if (!swapped)
            {
                try
                {
                    if (File.Exists(tmp))
                        File.Delete(tmp);
                }
                catch { }
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

                // 文件里超过上限的部分同样淘汰(随后的 Rewrite 一并整理掉)。
                // Enforce the cap on what the file held too; the Rewrite below compacts.
                int evicted = _entries.Count > MaxEntries ? EvictOldestLocked() : 0;
                if (evicted > 0)
                    Log.Warn("幂等缓存恢复时超过上限 {0} 条,已淘汰最旧的 {1} 条", MaxEntries, evicted);

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
            Rewrite();
        }
    }
}
