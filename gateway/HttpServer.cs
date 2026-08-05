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

        public HttpServer(Config cfg, Mt5Link link)
        {
            _cfg = cfg;
            _link = link;
            _tokenBytes = Encoding.UTF8.GetBytes(cfg.ApiToken);
            _listener.Prefixes.Add(cfg.ListenPrefix);
        }

        public void Start()
        {
            _listener.Start();
            Log.Info("HTTP 服务已启动:{0}", _cfg.ListenPrefix);

            // 几个并发处理线程就够:MT5 调用本身是串行的
            for (int i = 0; i < 4; i++)
            {
                Thread t = new Thread(AcceptLoop);
                t.IsBackground = true;
                t.Name = "http-" + i;
                t.Start();
            }
        }

        private void AcceptLoop()
        {
            while (!_stopping)
            {
                HttpListenerContext ctx;

                try
                {
                    ctx = _listener.GetContext();
                }
                catch (Exception)
                {
                    if (_stopping)
                        break;

                    continue;
                }

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
                    .Field("server", _cfg.Server)
                    .Field("managerLogin", _cfg.ManagerLogin)
                 .EndObject();

                WriteJson(ctx, 200, j.ToString());
                return;
            }

            if (!Authorized(ctx))
            {
                Log.Warn("鉴权失败:{0} {1} 来自 {2}", method, path,
                    ctx.Request.RemoteEndPoint);

                WriteError(ctx, 401, "unauthorized", "缺少或错误的 X-Gateway-Token");
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
                case "/orders":
                    RequirePost(ctx, method, HandleOrders);
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
        //| POST /verify  校验 MT5 账号密码(用户绑定账号时用)               |
        //| { "login": 500123, "password": "...", "investorOnly": false }     |
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

            MTRetCode check = _link.CheckPassword(login, password,
                body.GetBool("investorOnly"));

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
                 .Field("equity", info.Equity);
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

            // 手数合法性交给服务器最终裁决,但先做一次本地校验,
            // 可以把明显错误的请求挡在成交之前,错误信息也更清楚。
            double volMin, volMax, volStep;
            MTRetCode sres;

            if (_link.GetSymbolLimits(symbol, out volMin, out volMax, out volStep, out sres))
            {
                if (volume < volMin || volume > volMax)
                {
                    WriteError(ctx, 400, "bad_volume", string.Format(
                        "手数超出范围:{0} 允许 {1} ~ {2}", symbol, volMin, volMax));
                    return;
                }
            }

            TradeResult r = _link.OpenPosition(login, symbol, side == "BUY", volume,
                body.GetDouble("stopLoss"), body.GetDouble("takeProfit"),
                body.GetString("tag"));

            Log.Info("开仓 login={0} {1} {2} {3} 手 -> {4} {5}",
                login, symbol, side, volume, r.Ok ? "成交" : "失败", r.Retcode);

            WriteTradeResult(ctx, r);
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

            TradeResult r = _link.ClosePosition(login, ticket,
                body.GetDouble("volume"), body.GetString("tag"));

            Log.Info("平仓 login={0} ticket={1} -> {2} {3}",
                login, ticket, r.Ok ? "成交" : "失败", r.Retcode);

            WriteTradeResult(ctx, r);
        }

        //+------------------------------------------------------------------+
        //| POST /trade/modify  改 SL/TP(传 0 = 清除该项)                   |
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

            TradeResult r = _link.ModifyPosition(login, ticket,
                body.GetDouble("stopLoss"), body.GetDouble("takeProfit"));

            Log.Info("改单 login={0} ticket={1} SL={2} TP={3} -> {4} {5}",
                login, ticket, body.GetDouble("stopLoss"), body.GetDouble("takeProfit"),
                r.Ok ? "成功" : "失败", r.Retcode);

            WriteTradeResult(ctx, r);
        }

        /// <summary>交易前确认账号存在且组在白名单内。</summary>
        private bool EnsureTradableAccount(HttpListenerContext ctx, ulong login)
        {
            MTRetCode res;
            AccountInfo info = _link.GetAccount(login, out res);

            if (info == null)
            {
                WriteError(ctx, 404, res.ToString(), "账号不存在或无法读取");
                return false;
            }

            if (!_cfg.IsGroupAllowed(info.Group))
            {
                Log.Warn("拒绝交易:账号 {0} 的组 {1} 不在白名单", login, info.Group);
                WriteError(ctx, 403, "group_not_allowed",
                    "该账号所属组不允许交易(检查 gateway.ini 的 allowed_groups)");
                return false;
            }

            return true;
        }

        private void WriteTradeResult(HttpListenerContext ctx, TradeResult r)
        {
            JsonWriter j = new JsonWriter();
            j.BeginObject()
                .Field("ok", r.Ok)
                .Field("retcode", r.Retcode)
                .Field("message", r.Message)
                .Field("deal", r.Deal)
                .Field("order", r.Order)
                .Field("price", r.Price)
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

        private static string ReadBody(HttpListenerContext ctx)
        {
            using (Stream s = ctx.Request.InputStream)
            using (StreamReader reader = new StreamReader(s, Encoding.UTF8))
            {
                return reader.ReadToEnd();
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
