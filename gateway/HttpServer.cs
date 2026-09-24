//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - HTTP 服务层                                 |
//|                                                                  |
//| 对外提供 REST 接口给 FastAPI 后端调用。                          |
//|                                                                  |
//| 安全边界(重要):                                                 |
//|   1. 默认只监听 127.0.0.1,不暴露公网。                           |
//|   2. 除 /health 外,所有接口都要求 X-Gateway-Token 头。            |
//|   3. token 比较用固定时间算法,避免计时侧信道。                    |
//|   4. 交易接口会校验账号所属组在白名单内。                         |
//| 如果要让外网的后端访问,用 SSH 隧道或 WireGuard,不要直接把端口   |
//| 开到公网 —— 这个 token 等于全体客户的下单权限。                   |
//+------------------------------------------------------------------+
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using MetaQuotes.MT5CommonAPI;

namespace Prismx.Mt5Gateway
{
    internal sealed class HttpServer : IDisposable
    {
        private readonly Config _cfg;
        private readonly Mt5Link _link;
        private readonly HttpListener _listener = new HttpListener();
        private readonly byte[] _tokenBytes;
        private volatile bool _stopping;

        // 交易幂等缓存,见 Idempotency.cs。24 小时与桥接程序的 clientOrderId 缓存对齐,
        // 也远大于后端 GATEWAY_RECONCILE_TIMEOUT(75 秒)加网络余量。
        // **落盘**:部署方式是硬杀进程,内存缓存挡不住"重启后按同一 clientOrderId 重试"。
        // Trade idempotency cache; 24h matches the bridge and dwarfs the backend's 75s
        // reconcile timeout. Persisted, because deployment force-kills this process.
        private readonly IdempotencyCache _idem =
            new IdempotencyCache(TimeSpan.FromHours(24), IdempotencyStorePath());

        /// <summary>幂等缓存的落盘位置:与 exe 同目录的 state\ 下,和 logs\ 并列。
        /// Next to the exe under state\, alongside logs\.</summary>
        private static string IdempotencyStorePath()
        {
            string baseDir = Path.GetDirectoryName(
                System.Reflection.Assembly.GetExecutingAssembly().Location);

            return Path.Combine(baseDir ?? ".", "state", "idempotency.jsonl");
        }

        public HttpServer(Config cfg, Mt5Link link)
        {
            _cfg = cfg;
            _link = link;
            _tokenBytes = Encoding.UTF8.GetBytes(cfg.ApiToken);
            _listener.Prefixes.Add(cfg.ListenPrefix);
        }

        /// <summary>
        /// 带幂等保护地执行一次交易动作。clientOrderId 为空时退回旧行为(每次都执行)。
        ///
        /// 同一个 key 已经有结果 → 原样回,response 里 replayed=true;正在执行 → 等它
        /// 完成再回同一份结果(最多等 dealer 超时再加 5 秒,覆盖"后端超时重发时上一次
        /// 还没等到回执"的窗口);等不到 → 200 + ok:false + retcode IN_PROGRESS,后端
        /// 据此不把它当拒绝,而是稍后再问一次。
        ///
        /// Runs one trade action under idempotency. Empty clientOrderId keeps the
        /// old always-execute behaviour. A completed key replays its result; an
        /// in-flight key waits (dealer timeout + 5s) for the same result; if it
        /// still isn't done the response is ok:false / IN_PROGRESS, which the
        /// backend treats as "ask again", not as a rejection.
        /// </summary>
        private void ExecuteIdempotent(HttpListenerContext ctx, ulong login, string action,
            string clientOrderId, Func<TradeResult> run)
        {
            // 整笔耗时(含等锁、取价、dealer 回执、成交确认),每笔一行日志,用来看
            // 高峰时到底慢在网关里还是慢在券商那边(dealer 那一段另有 dealerMs)。
            // Whole-trade wall time, one line per trade; the dealer leg is logged
            // separately as dealerMs, so the rest is time spent inside the gateway.
            Func<TradeResult> timedRun = run;
            run = () =>
            {
                Stopwatch sw = Stopwatch.StartNew();
                TradeResult tr = timedRun();
                Log.Info("{0} 耗时 {1} 毫秒 login={2} -> {3} {4}", action, sw.ElapsedMilliseconds,
                    login, tr != null && tr.Ok ? "成功" : "失败", tr != null ? tr.Retcode : "");
                return tr;
            };

            if (clientOrderId.Length == 0)
            {
                WriteTradeResult(ctx, run(), false);
                return;
            }

            string key = IdempotencyCache.Key(login, action, clientOrderId);
            TradeResult existing;
            bool replayed;

            if (!_idem.TryBegin(key, _cfg.DealerTimeoutMs + 5000, out existing, out replayed))
            {
                if (existing == null)
                {
                    Log.Warn("{0} 重复请求仍在执行中 login={1} clientOrderId={2}", action, login, clientOrderId);
                    WriteTradeResult(ctx, TradeResult.Fail("IN_PROGRESS",
                        "同一 clientOrderId 的请求仍在执行,请稍后重新查询"), true);
                    return;
                }

                Log.Info("{0} 重复请求,回放缓存结果 login={1} clientOrderId={2} -> {3} {4}",
                    action, login, clientOrderId, existing.Ok ? "成功" : "失败", existing.Retcode);
                WriteTradeResult(ctx, existing, true);
                return;
            }

            TradeResult r;

            try
            {
                r = run();
            }
            catch (Exception ex)
            {
                // 记成失败而不是删条目:异常若发生在 dealer 请求发出之后,仓位可能已
                // 经开了,放重试再开一次比回"失败"危险(见 Idempotency.cs)。
                // Recorded as a failure, not dropped — see Idempotency.cs.
                _idem.Complete(key, TradeResult.Fail("exception", ex.Message));
                throw;
            }

            _idem.Complete(key, r);
            WriteTradeResult(ctx, r, false);
        }

        /// <summary>在途请求的名额。/health 不占名额。
        /// Slots for in-flight requests; /health never takes one.</summary>
        private SemaphoreSlim _slots;

        public void Start()
        {
            _slots = new SemaphoreSlim(_cfg.HttpMaxConcurrent, _cfg.HttpMaxConcurrent);

            // 线程池默认按每秒一两条的速度慢慢加线程。在途请求大多是在睡着等 dealer
            // 回执,一波行情同时进来几十笔时,慢速扩容本身就会变成排队。所以把下限直接
            // 抬到并发上限:这些线程平时不存在,要用时立刻有。
            // The pool normally grows by a thread or two per second; with most requests
            // asleep on the dealer, a burst would queue on that ramp. Raise the floor to
            // the cap so threads are there the moment they're needed.
            int minWorker, minIo;
            ThreadPool.GetMinThreads(out minWorker, out minIo);
            ThreadPool.SetMinThreads(Math.Max(minWorker, _cfg.HttpMaxConcurrent + _cfg.HttpThreads), minIo);

            _listener.Start();
            Log.Info("HTTP 服务已启动:{0}(接收线程 {1},并发上限 {2})",
                _cfg.ListenPrefix, _cfg.HttpThreads, _cfg.HttpMaxConcurrent);

            // 这些线程只 accept:接到请求就交给线程池,自己马上回去接下一个。以前每条线程
            // 要把一个请求处理完(最坏等 dealer 60 秒)才回来,线程数就是并发上限。
            // These threads only accept and hand off; they used to serve each request to
            // completion (up to the 60s dealer wait), which made their count the ceiling.
            for (int i = 0; i < _cfg.HttpThreads; i++)
            {
                Thread t = new Thread(AcceptLoop);
                t.IsBackground = true;
                t.Name = "http-accept-" + i;
                t.Start();
            }
        }

        private void AcceptLoop()
        {
            // 连续接收失败的次数。listener 进入持续报错状态(不是停止)时,以前这里是
            // 无退避的 continue——HttpThreads(默认 16)条线程一起空转把 CPU 打满,
            // 而且一条日志都不留。现在按次数线性退避到 1 秒,并在第 1 次和之后每
            // 100 次记一条错误。
            // Consecutive accept failures. When the listener is in a persistent error
            // state (not stopping) this used to `continue` with no back-off, so all
            // HttpThreads (16 by default) spun the CPU flat out and logged nothing.
            // Now back off linearly up to 1s and log the 1st and every 100th failure.
            int consecutiveErrors = 0;

            while (!_stopping)
            {
                HttpListenerContext ctx;

                try
                {
                    ctx = _listener.GetContext();
                    consecutiveErrors = 0;
                }
                catch (Exception ex)
                {
                    if (_stopping)
                        break;

                    consecutiveErrors++;
                    if (consecutiveErrors == 1 || consecutiveErrors % 100 == 0)
                        Log.Error("接收连接失败(连续 {0} 次):{1}", consecutiveErrors, ex.Message);

                    Thread.Sleep(Math.Min(1000, 50 * consecutiveErrors));
                    continue;
                }

                // 接收线程上的一切都要兜住:这是普通线程,异常漏出去就是整个进程退出,
                // 而这里还在鉴权之前——一个畸形请求就能把网关打挂。
                // Everything on the accept thread is guarded: it's a plain thread, so an
                // escaping exception ends the process, and this runs before auth.
                try
                {
                    // /health 就地回答,不占名额也不进线程池:网关再忙,监控也要能立刻
                    // 得到答复,否则会被误判成失联而去重启。
                    // /health is answered inline, outside the slots and the pool, so a
                    // busy gateway never looks dead to monitoring.
                    if (IsHealth(ctx))
                    {
                        Serve(ctx);
                        continue;
                    }

                    // 接收线程从不等名额,接到就派出去、马上回去接下一个。等名额的是
                    // 派出去的那个工作项——否则名额满时接收线程全堵在这里,连 /health
                    // 都没人去接。
                    // The acceptor never waits for a slot; the work item does. Otherwise a
                    // full house parks every acceptor here and nobody picks up /health.
                    ThreadPool.QueueUserWorkItem(ServeQueued, ctx);
                }
                catch (Exception ex)
                {
                    Log.Error("接收后处理异常:{0}", ex.Message);

                    try { ctx.Response.Abort(); }
                    catch { }
                }
            }
        }

        /// <summary>排队等名额的上限。到点还没轮到就回 503,让后端按"未执行"处理重试,
        /// 而不是无限期挂着。此时请求还没碰 MT5,回 503 是安全的。
        /// How long a queued request waits for a slot before a 503. Nothing has touched
        /// MT5 yet, so the 503 is safe.</summary>
        private const int SlotWaitMs = 30000;

        private static bool IsLiveReadPath(string path)
        {
            switch (path)
            {
                case "/verify":
                case "/account":
                case "/positions":
                case "/orders":
                case "/deals":
                case "/quote":
                    return true;
                default:
                    return false;
            }
        }

        private static bool IsHealth(HttpListenerContext ctx)
        {
            Uri url = ctx.Request.Url;
            if (url == null)
                return false;

            string path = (url.AbsolutePath ?? "").TrimEnd('/');
            return path.Equals("/health", StringComparison.OrdinalIgnoreCase);
        }

        private void ServeQueued(object state)
        {
            HttpListenerContext ctx = (HttpListenerContext)state;

            if (!_slots.Wait(SlotWaitMs))
            {
                Log.Warn("并发已满 {0} 秒仍未轮到,回 503", SlotWaitMs / 1000);

                try { WriteError(ctx, 503, "busy", "网关繁忙,本次请求未执行,请稍后重试"); }
                catch { }
                return;
            }

            try
            {
                Serve(ctx);
            }
            finally
            {
                _slots.Release();
            }
        }

        private void Serve(HttpListenerContext ctx)
        {
            try
            {
                Handle(ctx);
            }
            catch (Exception ex)
            {
                Log.Error("处理请求异常:{0}", ex.Message);

                try
                {
                    WriteError(ctx, 500, "internal_error", ex.Message);
                }
                catch
                {
                    // 连接可能已断,忽略
                }
            }
        }

        private void Handle(HttpListenerContext ctx)
        {
            string path = (ctx.Request.Url.AbsolutePath ?? "").TrimEnd('/').ToLowerInvariant();
            string method = ctx.Request.HttpMethod.ToUpperInvariant();

            if (path.Length == 0)
                path = "/";

            // /health 不鉴权:供监控探活。只暴露连接状态,不含敏感信息。
            if (path == "/health")
            {
                JsonWriter j = new JsonWriter();
                j.BeginObject()
                    .Field("ok", true)
                    .Field("mt5Connected", _link.IsConnected)
                    // false = 连接正常但代客下单拿不到成交回执。与 mt5Connected 分开
                    // 报,是因为这两件事会独立失效:重连之后 DealerStart 可能失败而连接
                    // 本身完好,此时查持仓/查余额照常可用、只有下单不行。
                    // false = connected but orders get no confirmation. Reported apart
                    // from mt5Connected because the two fail independently.
                    .Field("dealerActive", _link.IsDealerActive)
                    .Field("positionSubscribed", _link.PositionSubscribed)
                    .Field("positionEventBacklog", (uint)_link.PositionEventBacklog)
                    // 成交订阅：后端据此决定平仓兜底扫描用 3 秒还是 15 秒。
                    // false 不是故障，只是退回改造前的纯轮询节奏。
                    // Deal subscription: the backend picks a 3s or 15s fallback scan
                    // from this. False isn't a fault — it's the pre-change polling pace.
                    .Field("dealSubscribed", _link.DealSubscribed)
                    .Field("dealEventBacklog", (uint)_link.DealEventBacklog)
                    // 服务器推过来的持仓 UPDATE 事件数。平仓/改单先读本地 pump 快照,
                    // 这个数一直是 0 就说明快照跟不上部分平仓/改 SL·TP,只能靠手数被拒后
                    // 的服务器重读兜底(见 Mt5Link.ClosePosition)。
                    // Count of position UPDATE events pushed by the server. Close/modify
                    // read the local pump snapshot first; a permanent 0 here means the
                    // snapshot cannot track partial closes / SL·TP edits and the
                    // server-reread fallback in ClosePosition is what keeps closes working.
                    .Field("positionUpdateEvents", (uint)_link.PositionUpdateEvents)
                    // 自愈用的两个计时:全局锁多久没拿到、连续多久不能交易。到阈值
                    // (180 秒 / 15 分钟)网关会自己退出重启,见 Mt5Link.CheckSelfHeal。
                    // Self-heal timers; past 180s / 15min the gateway restarts itself.
                    .Field("gateBlockedSec", (uint)_link.GateBlockedSec)
                    .Field("degradedSec", (uint)_link.DegradedSec)
                 .EndObject();
                // 这里刻意不报 server 与 managerLogin。/health 是唯一不鉴权的接口,
                // 而那两个字段恰好是攻击 manager 账号所需的两个前提(接入地址 + 登录号),
                // 等于把侦察素材白送给任何能连到端口的人。运维要查这两项,看启动日志
                // (Program.cs 的 selftest)或 gateway.ini 本身,不必走公开接口。
                // Deliberately omits server and managerLogin: /health is the one
                // unauthenticated endpoint, and those two fields are exactly the
                // prerequisites for attacking the manager account (endpoint + login).
                // Ops can read both from the startup log or gateway.ini instead.

                WriteJson(ctx, 200, j.ToString());
                return;
            }

            // 来源 IP 白名单(配了才生效)。排在 token 校验之前:不在白名单里的来源
            // 连"试 token"的机会都不该有。/health 不受限,监控探活可能来自别处。
            // Source-IP allowlist, checked before the token so a disallowed source
            // never gets to guess it. /health is exempt so probes still work.
            if (!_cfg.IsIpAllowed(RemoteIp(ctx)))
            {
                Log.Warn("来源 IP 不在白名单:{0} {1} 来自 {2}", method, path, RemoteIp(ctx));
                WriteError(ctx, 403, "forbidden", "来源地址不被允许");
                return;
            }

            if (!Authorized(ctx))
            {
                Log.Warn("鉴权失败:{0} {1} 来自 {2}", method, path,
                    ctx.Request.RemoteEndPoint);

                WriteError(ctx, 401, "unauthorized", "缺少或错误的 X-Gateway-Token");
                return;
            }

            // 请求体上限。HttpListener 自己不限制,而 ReadBody 会把整个 body 读进内存、
            // JsonObject.Parse 再复制一份——一次大 POST 就能把进程 OOM,而这个进程一崩,
            // 全体 Gateway 直连用户同时掉线。真实请求都是几百字节量级。
            // HttpListener imposes no limit and ReadBody buffers the whole body; one
            // large POST could OOM the process and drop every direct-connect user at
            // once. Real requests are a few hundred bytes.
            if (ctx.Request.ContentLength64 > MaxRequestBodyBytes)
            {
                Log.Warn("请求体过大已拒绝:{0} {1} {2} 字节 来自 {3}",
                    method, path, ctx.Request.ContentLength64, RemoteIp(ctx));

                WriteError(ctx, 413, "payload_too_large",
                    "请求体超过 " + MaxRequestBodyBytes + " 字节上限");
                return;
            }

            // 断线时读接口不再拿本地缓存冒充实时数据。持仓/资金/挂单/成交在断线后
            // 仍能从 pump 缓存读出来,原来照样回 ok,后端就把断线前的旧余额旧持仓当
            // 成最新的推给用户。现在回 503:后端对读失败本来就是"保留上一次、不覆盖"。
            // 事件队列(/position-events、/deal-events)不在此列,那是取走已收到的事件。
            // While disconnected, reads stop passing the local cache off as live data.
            // The pump cache still answers after a drop, and used to return ok, so the
            // backend pushed pre-drop balances and positions as current. 503 instead —
            // the backend already keeps its last snapshot on a failed read. The event
            // queues are exempt: they hand over events already received.
            if (!_link.IsConnected && IsLiveReadPath(path))
            {
                WriteError(ctx, 503, "mt5_disconnected", "与 MT5 的连接已断开,数据暂不可用");
                return;
            }

            switch (path)
            {
                case "/verify":
                    RequirePost(ctx, method, HandleVerify);
                    return;
                case "/account":
                    RequirePost(ctx, method, HandleAccount);
                    return;
                case "/positions":
                    RequirePost(ctx, method, HandlePositions);
                    return;
                case "/position-events":
                    HandlePositionEvents(ctx, method);
                    return;
                case "/orders":
                    RequirePost(ctx, method, HandleOrders);
                    return;
                case "/deals":
                    RequirePost(ctx, method, HandleDeals);
                    return;
                case "/deal-events":
                    HandleDealEvents(ctx, method);
                    return;
                case "/quote":
                    RequirePost(ctx, method, HandleQuote);
                    return;
                case "/trade/open":
                    RequirePost(ctx, method, HandleOpen);
                    return;
                case "/trade/close":
                    RequirePost(ctx, method, HandleClose);
                    return;
                case "/trade/modify":
                    RequirePost(ctx, method, HandleModify);
                    return;
                case "/trade/pending":
                    RequirePost(ctx, method, HandlePending);
                    return;
                case "/trade/cancel":
                    RequirePost(ctx, method, HandleCancel);
                    return;
                case "/trade/modify-pending":
                    RequirePost(ctx, method, HandleModifyPending);
                    return;
                default:
                    WriteError(ctx, 404, "not_found", "未知接口:" + path);
                    return;
            }
        }

        private void RequirePost(HttpListenerContext ctx, string method,
            Action<HttpListenerContext, JsonObject> handler)
        {
            if (method != "POST")
            {
                WriteError(ctx, 405, "method_not_allowed", "只接受 POST");
                return;
            }

            JsonObject body;

            try
            {
                body = JsonObject.Parse(ReadBody(ctx));
            }
            catch (Exception ex)
            {
                WriteError(ctx, 400, "bad_json", ex.Message);
                return;
            }

            handler(ctx, body);
        }

        //+------------------------------------------------------------------+
        //| POST /verify  校验 MT5 账号主密码(用户绑定账号时用)             |
        //| { "login": 500123, "password": "..." }                            |
        //| 成功时额外回 lastPassChange(改密时间,后端用它撤销失效绑定)。     |
        //+------------------------------------------------------------------+
        private void HandleVerify(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            string password = body.GetString("password");

            if (login == 0 || password.Length == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 与 password 必填");
                return;
            }

            // 先确认账号存在且组在白名单内,再验密码
            MTRetCode res;
            AccountInfo info = _link.GetAccount(login, out res);

            if (info == null)
            {
                WriteError(ctx, 404, res.ToString(), "账号不存在或无法读取");
                return;
            }

            if (!_cfg.IsGroupAllowed(info.Group))
            {
                Log.Warn("拒绝绑定:账号 {0} 的组 {1} 不在白名单", login, info.Group);
                WriteError(ctx, 403, "group_not_allowed", "该账号所属组不允许接入");
                return;
            }

            // investorOnly 已废弃:只认主密码(理由见 Mt5Link.CheckPassword)。
            // 后端不再发这个字段;仍然读一次,只为在有人直接打网关时留下痕迹。
            // 不报错、静默降级成主密码校验——拿投资者密码来的调用方会得到
            // valid:false,与密码填错完全一样,问不出"这个账号有没有投资者密码"。
            // investorOnly is dead: main password only (see Mt5Link.CheckPassword).
            // The backend no longer sends it; it's still read so a caller hitting
            // the gateway directly leaves a trace. No error — it silently falls
            // back to a main-password check, so such a caller sees the same
            // valid:false as a wrong password and learns nothing.
            if (body.GetBool("investorOnly"))
                Log.Warn("忽略 investorOnly:账号 {0} 只用主密码校验", login);

            MTRetCode check = _link.CheckPassword(login, password);

            bool ok = check == MTRetCode.MT_RET_OK;

            // 密码错误是正常业务结果,用 200 + valid:false 表达,
            // 避免后端把它和"网关故障"混在一起处理。
            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", true)
                .Field("valid", ok)
                .Field("retcode", check.ToString());

            if (ok)
            {
                j.Field("login", info.Login)
                 .Field("name", info.Name)
                 .Field("group", info.Group)
                 .Field("leverage", info.Leverage)
                 .Field("balance", info.Balance)
                 .Field("equity", info.Equity)
                 .Field("lastPassChange", UnixSeconds(info.LastPassChange));
            }

            j.EndObject();

            Log.Info("验证账号 {0}:{1}", login, ok ? "通过" : check.ToString());
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| POST /account  读账号资料与资金                                  |
        //+------------------------------------------------------------------+
        private void HandleAccount(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            if (login == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 必填");
                return;
            }

            MTRetCode res;
            AccountInfo info = _link.GetAccount(login, out res);

            if (info == null)
            {
                WriteError(ctx, 404, res.ToString(), "读取账号失败");
                return;
            }

            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", true)
                .Field("login", info.Login)
                .Field("name", info.Name)
                .Field("group", info.Group)
                .Field("leverage", info.Leverage)
                .Field("balance", info.Balance)
                .Field("equity", info.Equity)
                .Field("margin", info.Margin)
                .Field("marginFree", info.MarginFree)
                .Field("lastPassChange", UnixSeconds(info.LastPassChange))
             .EndObject();

            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| POST /positions  读持仓                                          |
        //+------------------------------------------------------------------+
        private void HandlePositions(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            if (login == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 必填");
                return;
            }

            MTRetCode res;
            PositionInfo[] list = _link.GetPositions(login, out res);

            if (list == null)
            {
                WriteError(ctx, 502, res.ToString(), "读取持仓失败");
                return;
            }

            JsonWriter j = new JsonWriter();
            j.BeginObject().Field("ok", true).BeginArray("positions");

            foreach (PositionInfo p in list)
            {
                j.BeginObject()
                    .Field("ticket", p.Ticket)
                    .Field("symbol", p.Symbol)
                    .Field("side", p.Side)
                    .Field("volume", p.Volume)
                    .Field("priceOpen", p.PriceOpen)
                    .Field("priceCurrent", p.PriceCurrent)
                    .Field("stopLoss", p.StopLoss)
                    .Field("takeProfit", p.TakeProfit)
                    .Field("profit", p.Profit)
                    .Field("comment", p.Comment)
                 .EndObject();
            }

            j.EndArray().EndObject();
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| GET /position-events  取走订阅积压的开/平仓事件                  |
        //|                                                                  |
        //| 这是「开平仓要等 2 秒轮询才被发现」的解法:MT5 服务器在仓位建立/  |
        //| 关闭的瞬间就回调过来,事件进队列,后端取到即推前端。              |
        //|                                                                  |
        //| 语义是「取走」而不是「查看」:一次调用把队列清空,同一个事件不会  |
        //| 返回两次。所以只能有一个消费者(后端那一个循环),这与现状相符。  |
        //|                                                                  |
        //| 用 GET 而不是 POST:没有请求体,而且这个接口是幂等消费,GET 更直  |
        //| 白。鉴权仍走 X-Gateway-Token,与其他接口一致。                    |
        //|                                                                  |
        //| 券商只推 ADD/DELETE,不推 UPDATE(已用探针确认),所以浮盈仍靠    |
        //| 轮询。subscribed=false 时后端会退回纯轮询,行为与改动前一致。     |
        //+------------------------------------------------------------------+
        private void HandlePositionEvents(HttpListenerContext ctx, string method)
        {
            if (method != "GET")
            {
                WriteError(ctx, 405, "method_not_allowed", "只接受 GET");
                return;
            }

            PositionEvent[] events = _link.DrainPositionEvents();

            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", true)
                .Field("subscribed", _link.PositionSubscribed)
                .BeginArray("events");

            foreach (PositionEvent e in events)
            {
                j.BeginObject()
                    .Field("login", e.Login)
                    .Field("ticket", e.Ticket)
                    .Field("action", e.Action)
                 .EndObject();
            }

            j.EndArray().EndObject();
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| GET /deal-events  取走订阅积压的成交事件                          |
        //|                                                                  |
        //| 与 /position-events 同构:破坏性读取,取走即从队列移除。            |
        //| 事件本身只是"该去查了"的门铃,后端拿到 login 后触发它自己那套平仓   |
        //| 扫描(带 15 分钟回看窗与归因逻辑),明细不从这里走。                  |
        //|                                                                  |
        //| Mirrors /position-events: a destructive drain. The events are a   |
        //| doorbell, not a data channel — the backend uses the login to fire |
        //| its own closed-trade scan, which owns the lookback and attribution.|
        //+------------------------------------------------------------------+
        private void HandleDealEvents(HttpListenerContext ctx, string method)
        {
            if (method != "GET")
            {
                WriteError(ctx, 405, "method_not_allowed", "只接受 GET");
                return;
            }

            DealEvent[] events = _link.DrainDealEvents();

            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", true)
                .Field("subscribed", _link.DealSubscribed)
                .BeginArray("events");

            foreach (DealEvent e in events)
            {
                j.BeginObject()
                    .Field("login", e.Login)
                    .Field("deal", e.Deal)
                    .Field("position", e.Position)
                 .EndObject();
            }

            j.EndArray().EndObject();
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| POST /orders  读挂单                                             |
        //+------------------------------------------------------------------+
        private void HandleOrders(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            if (login == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 必填");
                return;
            }

            MTRetCode res;
            OrderInfo[] list = _link.GetOrders(login, out res);

            if (list == null)
            {
                WriteError(ctx, 502, res.ToString(), "读取挂单失败");
                return;
            }

            JsonWriter j = new JsonWriter();
            j.BeginObject().Field("ok", true).BeginArray("orders");

            foreach (OrderInfo o in list)
            {
                j.BeginObject()
                    .Field("ticket", o.Ticket)
                    .Field("symbol", o.Symbol)
                    .Field("type", o.Type)
                    .Field("volume", o.Volume)
                    .Field("priceOrder", o.PriceOrder)
                    .Field("stopLoss", o.StopLoss)
                    .Field("takeProfit", o.TakeProfit)
                    .Field("comment", o.Comment)
                 .EndObject();
            }

            j.EndArray().EndObject();
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| POST /deals  读成交历史(后端补平仓明细用)                        |
        //| { "login": 500123, "from": 1730000000, "to": 1730001000 }         |
        //|                                                                  |
        //| from/to 为 Unix 秒。Bridge 账号的平仓明细由桥接程序自己扫历史后   |
        //| POST /api/bridge/trade-history 上报;Gateway 账号没有桥接,由后端 |
        //| 轮询这个接口补齐同一条链路。                                     |
        //+------------------------------------------------------------------+
        private void HandleDeals(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            if (login == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 必填");
                return;
            }

            long from = (long)body.GetUlong("from");
            long to = (long)body.GetUlong("to");

            if (from <= 0 || to <= 0 || to < from)
            {
                WriteError(ctx, 400, "bad_request", "from/to 必填且 to 不得早于 from(Unix 秒)");
                return;
            }

            MTRetCode res;
            DealInfo[] list = _link.GetDeals(login, from, to, out res);

            if (list == null)
            {
                WriteError(ctx, 502, res.ToString(), "读取成交历史失败");
                return;
            }

            JsonWriter j = new JsonWriter();
            j.BeginObject().Field("ok", true).BeginArray("deals");

            foreach (DealInfo d in list)
            {
                j.BeginObject()
                    .Field("ticket", d.Ticket)
                    .Field("positionId", d.PositionId)
                    .Field("symbol", d.Symbol)
                    .Field("action", d.Action)
                    .Field("entry", d.Entry)
                    .Field("volume", d.Volume)
                    .Field("price", d.Price)
                    .Field("profit", d.Profit)
                    .Field("commission", d.Commission)
                    .Field("storage", d.Storage)
                    .Field("time", (ulong)d.Time)
                    .Field("comment", d.Comment)
                    .Field("reason", d.Reason)
                    .Field("sl", d.PriceSL)
                    .Field("tp", d.PriceTP)
                 .EndObject();
            }

            j.EndArray().EndObject();
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| POST /quote  取当前买卖价                                        |
        //+------------------------------------------------------------------+
        private void HandleQuote(HttpListenerContext ctx, JsonObject body)
        {
            string symbol = body.GetString("symbol");
            if (symbol.Length == 0)
            {
                WriteError(ctx, 400, "bad_request", "symbol 必填");
                return;
            }

            double bid, ask;
            MTRetCode res;

            if (!_link.GetQuote(symbol, out bid, out ask, out res))
            {
                WriteError(ctx, 404, res.ToString(), "取价失败,确认品种名是否正确(注意后缀)");
                return;
            }

            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", true)
                .Field("symbol", symbol)
                .Field("bid", bid)
                .Field("ask", ask)
             .EndObject();

            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| POST /trade/open  市价开仓                                       |
        //| { login, symbol, side:"BUY"|"SELL", volume, stopLoss, takeProfit,|
        //|   tag }                                                          |
        //+------------------------------------------------------------------+
        private void HandleOpen(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            string symbol = body.GetString("symbol");
            string side = body.GetString("side").ToUpperInvariant();
            double volume = body.GetDouble("volume");

            if (login == 0 || symbol.Length == 0 || volume <= 0)
            {
                WriteError(ctx, 400, "bad_request", "login/symbol/volume 必填且 volume>0");
                return;
            }

            if (side != "BUY" && side != "SELL")
            {
                WriteError(ctx, 400, "bad_request", "side 只能是 BUY 或 SELL");
                return;
            }

            if (!EnsureTradableAccount(ctx, login))
                return;

            // 手数校验搬进 Mt5Link.OpenPositionCore 了。这里查不到带后缀的真实品种
            // (请求里是基础名 XAUUSD,券商是 XAUUSD.s),SymbolGet 必然落空,这段校验
            // 对本券商从来没生效过;补后缀发生在 ResolveSymbol,只能在那之后校验。
            // Volume validation moved into Mt5Link.OpenPositionCore: here the symbol is
            // still the unsuffixed base name, so SymbolGet always missed and this check
            // never ran. Suffix resolution happens inside, so validation must too.

            double stopLoss = body.GetDouble("stopLoss");
            double takeProfit = body.GetDouble("takeProfit");
            string tag = body.GetString("tag");

            ExecuteIdempotent(ctx, login, "open", body.GetString("clientOrderId"), delegate
            {
                TradeResult r = _link.OpenPosition(login, symbol, side == "BUY", volume,
                    stopLoss, takeProfit, tag);

                // 两个耗时并排打:总耗时减 dealer 等待就是网关自己花的时间(取价、
                // 反查、核对),一眼能看出"慢"在哪一侧。
                // Both timings side by side: total minus dealer wait is the gateway's
                // own share (quote, lookups), so the log shows which side is slow.
                Log.Info("开仓 login={0} {1} {2} {3} 手 -> {4} {5} 耗时 {6}ms(其中 dealer {7}ms)",
                    login, symbol, side, volume, r.Ok ? "成交" : "失败", r.Retcode,
                    r.ElapsedMs, r.DealerMs);

                return r;
            });
        }

        //+------------------------------------------------------------------+
        //| POST /trade/close  平仓(volume 省略或 0 = 全平)                 |
        //+------------------------------------------------------------------+
        private void HandleClose(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            ulong ticket = body.GetUlong("ticket");

            if (login == 0 || ticket == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 与 ticket 必填");
                return;
            }

            if (!EnsureTradableAccount(ctx, login))
                return;

            double closeVolume = body.GetDouble("volume");
            string closeTag = body.GetString("tag");

            // 平仓同样要幂等:部分平仓重复执行等于平两次。
            // Closes are guarded too: a duplicated partial close closes twice.
            ExecuteIdempotent(ctx, login, "close", body.GetString("clientOrderId"), delegate
            {
                TradeResult r = _link.ClosePosition(login, ticket, closeVolume, closeTag);

                Log.Info("平仓 login={0} ticket={1} -> {2} {3} 耗时 {4}ms(其中 dealer {5}ms)",
                    login, ticket, r.Ok ? "成交" : "失败", r.Retcode, r.ElapsedMs, r.DealerMs);

                return r;
            });
        }

        //+------------------------------------------------------------------+
        //| POST /trade/modify  改 SL/TP                                     |
        //|   传 0 = 清除该项;不传 / 传 null = 保留仓位上的现值。            |
        //|   两者必须分开:自动仓管移动止损时只带 stopLoss,若把缺省当 0,   |
        //|   一条「把止损挪到保本」的指令会顺手把用户的止盈抹掉。            |
        //|   0 clears; missing/null keeps the position's current value.     |
        //+------------------------------------------------------------------+
        private void HandleModify(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            ulong ticket = body.GetUlong("ticket");

            if (login == 0 || ticket == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 与 ticket 必填");
                return;
            }

            if (!EnsureTradableAccount(ctx, login))
                return;

            // 不能用 GetDouble:它对缺省字段回 0,而 0 在 MT5 里是「清除」。以前这里就是
            // GetDouble,于是只带 stopLoss 的改单会把止盈清掉——后端 gateway_execute 给
            // 网关账号发的自动仓管改单正是这种形状。
            // Not GetDouble: it yields 0 for a missing field, and 0 means "clear" to MT5.
            // That is exactly how a stop-only modify used to wipe the take-profit.
            double? stopLoss = body.GetNullableDouble("stopLoss");
            double? takeProfit = body.GetNullableDouble("takeProfit");

            TradeResult r = _link.ModifyPosition(login, ticket, stopLoss, takeProfit);

            Log.Info("改单 login={0} ticket={1} SL={2} TP={3} -> {4} {5} 耗时 {6}ms(其中 dealer {7}ms)",
                login, ticket,
                stopLoss.HasValue ? stopLoss.Value.ToString(CultureInfo.InvariantCulture) : "keep",
                takeProfit.HasValue ? takeProfit.Value.ToString(CultureInfo.InvariantCulture) : "keep",
                r.Ok ? "成功" : "失败", r.Retcode, r.ElapsedMs, r.DealerMs);

            // 改单天然幂等(同样的 SL/TP 设两次结果一样),不走缓存。
            // Modify is naturally idempotent; no cache needed.
            WriteTradeResult(ctx, r, false);
        }

        //+------------------------------------------------------------------+
        //| POST /trade/pending  挂单(限价 / 止损)                           |
        //| { login, symbol, type:"BUY_LIMIT"|"SELL_LIMIT"|"BUY_STOP"|       |
        //|   "SELL_STOP", volume, price, stopLoss, takeProfit, tag,         |
        //|   clientOrderId }                                                |
        //|                                                                  |
        //| price 是触发价,必填——与 /trade/open 最大的区别就在这里:开仓由    |
        //| 网关取市价,挂单由用户指定。                                      |
        //| price is the trigger price and is required: unlike /trade/open,  |
        //| where the gateway reads the market, the user names it here.      |
        //+------------------------------------------------------------------+
        private void HandlePending(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            string symbol = body.GetString("symbol");
            double volume = body.GetDouble("volume");
            double price = body.GetDouble("price");

            if (login == 0 || symbol.Length == 0 || volume <= 0 || price <= 0)
            {
                WriteError(ctx, 400, "bad_request", "login/symbol/volume/price 必填且 volume>0、price>0");
                return;
            }

            CIMTOrder.EnOrderType orderType;

            if (!Mt5Link.TryParsePendingType(body.GetString("type"), out orderType))
            {
                WriteError(ctx, 400, "bad_request",
                    "type 只能是 BUY_LIMIT / SELL_LIMIT / BUY_STOP / SELL_STOP");
                return;
            }

            if (!EnsureTradableAccount(ctx, login))
                return;

            double stopLoss = body.GetDouble("stopLoss");
            double takeProfit = body.GetDouble("takeProfit");
            string tag = body.GetString("tag");

            // 挂单同样要幂等:重复请求等于在券商那边挂出两张一模一样的单,而这种
            // 重复远比重复开仓难发现——它不会立刻变成仓位,要等触发那一刻才双倍。
            // Pending orders are guarded too: a duplicate leaves two identical orders
            // at the broker, which is harder to notice than a duplicate position —
            // nothing looks wrong until the moment they both trigger.
            ExecuteIdempotent(ctx, login, "pending", body.GetString("clientOrderId"), delegate
            {
                TradeResult r = _link.PlacePending(login, symbol, orderType, volume, price,
                    stopLoss, takeProfit, tag);

                Log.Info("挂单 login={0} {1} {2} {3} 手 @ {4} -> {5} {6} 耗时 {7}ms(其中 dealer {8}ms)",
                    login, symbol, orderType, volume, price, r.Ok ? "已挂" : "失败", r.Retcode,
                    r.ElapsedMs, r.DealerMs);

                return r;
            });
        }

        //+------------------------------------------------------------------+
        //| POST /trade/cancel  撤挂单                                       |
        //| { login, ticket, clientOrderId }                                 |
        //+------------------------------------------------------------------+
        private void HandleCancel(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            ulong ticket = body.GetUlong("ticket");

            if (login == 0 || ticket == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 与 ticket 必填");
                return;
            }

            if (!EnsureTradableAccount(ctx, login))
                return;

            // 撤单本身天然幂等(撤两次的结果一样是"这张单没了"),但仍走缓存:第二次
            // 会因为挂单已不存在而回"找不到挂单",把一次成功的撤单说成失败。
            // Cancelling twice ends in the same state, but the second call answers
            // "order not found" — which would report a successful cancel as a failure.
            // The cache replays the real outcome instead.
            ExecuteIdempotent(ctx, login, "cancel", body.GetString("clientOrderId"), delegate
            {
                TradeResult r = _link.CancelPending(login, ticket);

                Log.Info("撤挂单 login={0} ticket={1} -> {2} {3} 耗时 {4}ms(其中 dealer {5}ms)",
                    login, ticket, r.Ok ? "已撤" : "失败", r.Retcode, r.ElapsedMs, r.DealerMs);

                return r;
            });
        }

        //+------------------------------------------------------------------+
        //| POST /trade/modify-pending  改挂单(触发价 / SL / TP)            |
        //| { login, ticket, price, stopLoss, takeProfit }                    |
        //|                                                                  |
        //| 三项都是「不传 / null = 保留现值」,SL/TP 传 0 = 清除。与          |
        //| /trade/modify 同一套语义,理由见那边的注释。                      |
        //| All three are "missing/null = keep"; 0 clears SL/TP. Same         |
        //| semantics as /trade/modify — see the note there.                  |
        //+------------------------------------------------------------------+
        private void HandleModifyPending(HttpListenerContext ctx, JsonObject body)
        {
            ulong login = body.GetUlong("login");
            ulong ticket = body.GetUlong("ticket");

            if (login == 0 || ticket == 0)
            {
                WriteError(ctx, 400, "bad_request", "login 与 ticket 必填");
                return;
            }

            if (!EnsureTradableAccount(ctx, login))
                return;

            // 同 /trade/modify:绝不能用 GetDouble,它对缺省字段回 0,而 0 在 SL/TP 上
            // 是「清除」。触发价那一项 0 也不能当成「改成 0」——挂单没有 0 这个价。
            // As in /trade/modify: GetDouble yields 0 for a missing field and 0 means
            // "clear" for SL/TP. A 0 trigger price is likewise never a real request.
            double? price = body.GetNullableDouble("price");
            double? stopLoss = body.GetNullableDouble("stopLoss");
            double? takeProfit = body.GetNullableDouble("takeProfit");

            // 改单天然幂等(同样的价位改两次结果一样),但仍走缓存:第二次会因为挂单
            // 的现值已经等于目标值而…… 不,服务器照样会答成功。真正的理由与撤单不同——
            // 这里走缓存只是为了让「超时后后端用同一 clientOrderId 再问一次」拿到
            // 首次的结果,而不是再发一个 dealer 请求。
            // Idempotent by nature, but still cached so the backend's post-timeout
            // re-ask replays the first result instead of spending another dealer slot.
            ExecuteIdempotent(ctx, login, "modify-pending", body.GetString("clientOrderId"), delegate
            {
                TradeResult r = _link.ModifyPending(login, ticket, price, stopLoss, takeProfit);

                Log.Info("改挂单 login={0} ticket={1} price={2} SL={3} TP={4} -> {5} {6} 耗时 {7}ms(其中 dealer {8}ms)",
                    login, ticket,
                    price.HasValue ? price.Value.ToString(CultureInfo.InvariantCulture) : "keep",
                    stopLoss.HasValue ? stopLoss.Value.ToString(CultureInfo.InvariantCulture) : "keep",
                    takeProfit.HasValue ? takeProfit.Value.ToString(CultureInfo.InvariantCulture) : "keep",
                    r.Ok ? "成功" : "失败", r.Retcode, r.ElapsedMs, r.DealerMs);

                return r;
            });
        }

        /// <summary>
        /// 交易前确认账号存在且组在白名单内。
        ///
        /// 走 CheckAccountGroup 而不是 GetAccount:后者会多发一次资金查询
        /// (UserAccountRequest),而这里只需要 group。结果带 60 秒 TTL 缓存。
        /// </summary>
        private bool EnsureTradableAccount(HttpListenerContext ctx, ulong login)
        {
            MTRetCode res;
            string group;

            // 账号检查缓存过期时要向服务器查一次,慢了单独记一行(与开仓分段计时对照看)。
            // A cache miss here costs a server round-trip; log it when slow.
            Stopwatch checkSw = Stopwatch.StartNew();
            bool allowed = _link.CheckAccountGroup(login, out group, out res);

            if (checkSw.ElapsedMilliseconds >= Mt5Link.PrepSlowLogMs)
                Log.Warn("账号可交易检查偏慢 {0}ms(login={1})", checkSw.ElapsedMilliseconds, login);

            if (!allowed)
            {
                WriteError(ctx, 404, res.ToString(), "账号不存在或无法读取");
                return false;
            }

            if (!_cfg.IsGroupAllowed(group))
            {
                Log.Warn("拒绝交易:账号 {0} 的组 {1} 不在白名单", login, group);
                WriteError(ctx, 403, "group_not_allowed",
                    "该账号所属组不允许交易(检查 gateway.ini 的 allowed_groups)");
                return false;
            }

            return true;
        }

        private void WriteTradeResult(HttpListenerContext ctx, TradeResult r, bool replayed)
        {
            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", r.Ok)
                .Field("retcode", r.Retcode)
                .Field("message", r.Message)
                .Field("deal", r.Deal)
                .Field("order", r.Order)
                // 仓位号:开仓时反查得到,平仓/改单为 0。后端存进 orders 表,
                // 之后用它判断平仓明细的归属。
                // Position id, resolved on open (0 for close/modify). The backend
                // stores it and later uses it to attribute closed trades.
                .Field("position", r.Position)
                .Field("price", r.Price)
                // 这次回复是不是同一 clientOrderId 的缓存回放(见 ExecuteIdempotent)。
                // Whether this is a replay for a previously seen clientOrderId.
                .Field("replayed", replayed)
                // 耗时(毫秒):网关这一侧的总耗时,以及其中等券商 dealer 回执的部分。
                // 后端把它们记进日志,"下单慢"就能拆成网关内 / 券商侧两段看。回放的
                // 缓存结果带的是首次执行时的数字。
                // Timings in ms: the gateway's total and the dealer wait within it, so
                // the backend can split "slow orders" into gateway vs broker. A replayed
                // result carries the numbers from the original execution.
                .Field("elapsedMs", (ulong)Math.Max(0, r.ElapsedMs))
                .Field("dealerMs", (ulong)Math.Max(0, r.DealerMs))
             .EndObject();

            // 交易被拒是业务结果而非服务故障,统一用 200 返回,
            // 让后端只看 ok 字段做判断。
            WriteJson(ctx, 200, j.ToString());
        }

        //+------------------------------------------------------------------+
        //| 鉴权:固定时间比较,避免用字符串相等泄漏 token 前缀               |
        //+------------------------------------------------------------------+
        private bool Authorized(HttpListenerContext ctx)
        {
            string provided = ctx.Request.Headers["X-Gateway-Token"];
            if (string.IsNullOrEmpty(provided))
                return false;

            byte[] given = Encoding.UTF8.GetBytes(provided);

            if (given.Length != _tokenBytes.Length)
                return false;

            int diff = 0;
            for (int i = 0; i < given.Length; i++)
                diff |= given[i] ^ _tokenBytes[i];

            return diff == 0;
        }

        /// <summary>
        /// Unix 秒时间戳转成 JSON 能写的无符号数。负值与 0 一律归零。
        ///
        /// MT5 的时间字段是 int64,理论上可以是负数(1970 之前)或 0(没填)。
        /// JsonWriter 只有 ulong 重载,直接强转会把负数变成天文数字,后端拿它当
        /// "密码改过了"就会误撤销绑定。归零则落进后端的"没有信号"分支,不撤销。
        ///
        /// Unix seconds to a JSON-writable unsigned value; negatives and 0 both
        /// become 0. MT5 time fields are int64 and may be 0 (unset). JsonWriter
        /// only has a ulong overload, and casting a negative would produce an
        /// astronomical number that the backend would read as "password changed"
        /// and wrongly revoke the binding. 0 lands in its "no signal" branch.
        /// </summary>
        private static ulong UnixSeconds(long value)
        {
            return value > 0 ? (ulong)value : 0UL;
        }

        /// <summary>请求体上限(字节)。真实请求是几百字节量级,64 KB 留了两个数量级余量。
        /// Request body cap; real requests are a few hundred bytes.</summary>
        private const int MaxRequestBodyBytes = 64 * 1024;

        /// <summary>调用方 IP。取不到时返回空串(会被白名单当成不允许)。
        /// The caller's IP; "" when unavailable, which the allowlist treats as denied.</summary>
        private static string RemoteIp(HttpListenerContext ctx)
        {
            try
            {
                System.Net.IPEndPoint ep = ctx.Request.RemoteEndPoint;
                return ep == null || ep.Address == null ? "" : ep.Address.ToString();
            }
            catch (Exception)
            {
                return "";
            }
        }

        private static string ReadBody(HttpListenerContext ctx)
        {
            using (Stream s = ctx.Request.InputStream)
            using (StreamReader reader = new StreamReader(s, Encoding.UTF8))
            {
                // 即使 Content-Length 说得小(或分块传输时压根没有这个头),也只读到
                // 上限为止:上面那次 ContentLength64 检查挡不住撒谎的头。
                // Even with a small (or absent, on chunked transfers) Content-Length,
                // read no more than the cap: that header can lie.
                //
                // 缓冲区从小开始、不够再翻倍。以前每个请求一上来就分配 64K 字符(128KB,
                // 落在大对象堆上),而真实请求只有几百字节——几百笔并发时就是频繁的完整
                // GC 停顿,所有请求一起卡一下。
                // Start small and double as needed. Each request used to allocate 64K
                // chars (128KB, on the large object heap) for a few hundred bytes, which
                // under hundreds of concurrent requests meant frequent full-GC pauses.
                char[] buf = new char[1024];
                int total = 0;

                while (true)
                {
                    if (total == buf.Length)
                    {
                        if (buf.Length > MaxRequestBodyBytes)
                            break;

                        Array.Resize(ref buf, Math.Min(buf.Length * 2, MaxRequestBodyBytes + 1));
                    }

                    int n = reader.Read(buf, total, buf.Length - total);

                    if (n <= 0)
                        break;

                    total += n;
                }

                if (total > MaxRequestBodyBytes)
                    throw new FormatException("请求体超过 " + MaxRequestBodyBytes + " 字节上限");

                return new string(buf, 0, total);
            }
        }

        private static void WriteJson(HttpListenerContext ctx, int status, string json)
        {
            byte[] buffer = Encoding.UTF8.GetBytes(json);

            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentLength64 = buffer.Length;
            ctx.Response.OutputStream.Write(buffer, 0, buffer.Length);
            ctx.Response.OutputStream.Close();
        }

        private static void WriteError(HttpListenerContext ctx, int status,
            string code, string message)
        {
            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", false)
                .Field("error", code)
                .Field("message", message)
             .EndObject();

            WriteJson(ctx, status, j.ToString());
        }

        public void Dispose()
        {
            _stopping = true;

            // 等在途请求做完再关。紧接着 Program 会释放 Mt5Link(销毁 SDK 对象),还在
            // 跑的请求若这时调进 SDK,就是访问已释放的原生对象——catch 不住的崩溃。
            // 把名额全部收回来就说明没有在途请求了;最多等一次 dealer 超时再加余量。
            // Drain before closing: Program disposes Mt5Link next, and a request still
            // calling into the SDK then touches freed native objects — an uncatchable
            // crash. Holding every slot means nothing is in flight.
            if (_slots != null)
            {
                int deadline = unchecked(Environment.TickCount + _cfg.DealerTimeoutMs + 10000);
                int drained = 0;

                while (drained < _cfg.HttpMaxConcurrent)
                {
                    int left = unchecked(deadline - Environment.TickCount);
                    if (left <= 0 || !_slots.Wait(left))
                        break;
                    drained++;
                }

                if (drained < _cfg.HttpMaxConcurrent)
                    Log.Warn("关闭时仍有 {0} 个请求未完成", _cfg.HttpMaxConcurrent - drained);
            }

            try
            {
                _listener.Stop();
                _listener.Close();
            }
            catch
            {
                // 关闭期异常无意义
            }
        }
    }
}
