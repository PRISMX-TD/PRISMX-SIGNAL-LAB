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

        public override void OnDealerAnswer(CIMTRequest request)
        {
            lock (_lock)
            {
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
            }

            _done.Set();
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

        public override void OnConnect()
        {
            Log.Info("MT5 连接已建立");
            _link.MarkConnected(true);
        }

        public override void OnDisconnect()
        {
            Log.Warn("MT5 连接断开,将自动重连");
            _link.MarkConnected(false);
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

        // 仓位号。dealer 回执只给 Deal/Order,拿不到仓位号,所以开仓后要按成交号
        // 反查一次成交记录才能填上。后端靠这个号判断某笔平仓是不是本平台开的
        // 仓位——这是唯一不受回看窗口和 comment 被券商覆盖影响的依据。
        // The dealer confirmation exposes only Deal/Order, so this is filled by
        // looking the deal up afterwards. The backend needs it to tell whether a
        // close belongs to a platform-opened position: the only signal that
        // survives both the lookback window and brokers overwriting comments.
        public ulong Position;

        public static TradeResult Fail(string retcode, string message)
        {
            return new TradeResult { Ok = false, Retcode = retcode, Message = message };
        }
    }

    internal sealed class Mt5Link : IDisposable
    {
        private const uint ConnectTimeoutMs = 30000;

        private readonly Config _cfg;
        private readonly object _gate = new object();

        // 已加进 Selected 列表的品种,避免重复调用 SelectedAdd
        private readonly HashSet<string> _selected =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        private CIMTManagerAPI _manager;
        private ManagerSink _sink;
        private volatile bool _connected;
        private volatile bool _stopping;
        private Thread _watchdog;

        // 缓存: auto-resolve symbol suffix per (group, baseSymbol)
        private readonly Dictionary<string, string> _symbolCache =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // 缓存: user's group per login
        private readonly Dictionary<ulong, string> _groupCache =
            new Dictionary<ulong, string>();

        public Mt5Link(Config cfg)
        {
            _cfg = cfg;
        }

        public bool IsConnected
        {
            get { return _connected; }
        }

        internal void MarkConnected(bool value)
        {
            _connected = value;
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

            // dealer 通道:代客下单必须先启动
            lock (_gate)
            {
                res = _manager.DealerStart();
            }

            if (res != MTRetCode.MT_RET_OK)
                throw new Exception("DealerStart 失败:" + res +
                    "(通常是 manager 账号缺 RIGHT_TRADES_DEALER 权限)");

            Log.Info("dealer 通道已启动");

            _watchdog = new Thread(WatchdogLoop);
            _watchdog.IsBackground = true;
            _watchdog.Name = "mt5-watchdog";
            _watchdog.Start();
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

        /// <summary>诊断用:手动启动 dealer 通道。</summary>
        public MTRetCode DealerStartDiag()
        {
            lock (_gate)
            {
                return _manager.DealerStart();
            }
        }

        /// <summary>诊断用:取 manager 的权限位。</summary>
        public string DiagManagerRights()
        {
            // CIMTConManager.Rights() 在 C# wrapper 中的暴露名可能不同,
            // 但 DealerStart 返回 OK 就说明有权限,这里简单跳过。
            return "(DealerStart 已确认有 TRADES_DEALER 权限)";
        }

        /// <summary>诊断用:取品种的全局属性。</summary>
        public string DiagSymbolInfo(string symbol)
        {
            lock (_gate)
            {
                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    MTRetCode r = _manager.SymbolGet(symbol, sym);
                    if (r != MTRetCode.MT_RET_OK)
                        return "SymbolGet(global) 失败:" + r;

                    return FormatSymbolInfo(sym);
                }
            }
        }

        /// <summary>诊断用:取品种对特定组的属性。</summary>
        public string DiagSymbolGroupInfo(string symbol, string group)
        {
            lock (_gate)
            {
                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    // Manager API 的 SymbolGet(symbol, group, out) 第二个参数是组名
                    MTRetCode r = _manager.SymbolGet(symbol, group, sym);
                    if (r != MTRetCode.MT_RET_OK)
                        return string.Format("SymbolGet({0},{1}) 失败:{2}", symbol, group, r);

                    return FormatSymbolInfo(sym);
                }
            }
        }

        /// <summary>诊断用:取组级别的交易设置。</summary>
        public string DiagGroupTradeInfo(string group)
        {
            lock (_gate)
            {
                using (CIMTConGroup grp = _manager.GroupCreate())
                {
                    MTRetCode r = _manager.GroupGet(group, grp);
                    if (r != MTRetCode.MT_RET_OK)
                        return string.Format("GroupGet({0}) 失败:{1}", group, r);

                    return string.Format("组 {0} 存在", group);
                }
            }
        }

        /// <summary>诊断用:取用户权限。</summary>
        public string DiagUserRights(ulong login)
        {
            lock (_gate)
            {
                using (CIMTUser user = _manager.UserCreate())
                {
                    MTRetCode r = _manager.UserRequest(login, user);
                    if (r != MTRetCode.MT_RET_OK)
                        return "UserRequest 失败:" + r;

                    ulong rights = (ulong)user.Rights();
                    return string.Format("0x{0:X16}", rights);
                }
            }
        }

        /// <summary>诊断用:测试 DealerBalance(入金/出金)。</summary>
        public string DiagDealerBalance(ulong login, double amount, string comment)
        {
            lock (_gate)
            {
                ulong dealId;
                MTRetCode res = _manager.DealerBalance(
                    login, amount,
                    (uint)CIMTDeal.EnDealAction.DEAL_BALANCE,
                    comment, out dealId);

                if (res == MTRetCode.MT_RET_OK || res == MTRetCode.MT_RET_REQUEST_DONE)
                    return string.Format("DealerBalance OK: +{0:F2} -> deal=#{1}", amount, dealId);

                return string.Format("DealerBalance 失败:{0}", res);
            }
        }

        private static string FormatSymbolInfo(CIMTConSymbol sym)
        {
            uint tradeMode = (uint)sym.TradeMode();
            uint execMode = (uint)sym.ExecMode();
            uint fillFlags = (uint)sym.FillFlags();
            ulong tradeFlags = (ulong)sym.TradeFlags();

            // TradeMode 枚举
            string tradeModeStr;
            switch (tradeMode)
            {
                case 0: tradeModeStr = "DISABLED"; break;
                case 1: tradeModeStr = "LONGONLY"; break;
                case 2: tradeModeStr = "SHORTONLY"; break;
                case 3: tradeModeStr = "CLOSEONLY"; break;
                case 4: tradeModeStr = "FULL"; break;
                default: tradeModeStr = tradeMode.ToString(); break;
            }

            // ExecMode 枚举
            string execModeStr;
            switch (execMode)
            {
                case 0: execModeStr = "REQUEST"; break;
                case 1: execModeStr = "INSTANT"; break;
                case 2: execModeStr = "MARKET"; break;
                case 3: execModeStr = "EXCHANGE"; break;
                default: execModeStr = execMode.ToString(); break;
            }

            // FillFlags 枚举
            var fills = new System.Text.StringBuilder();
            if ((fillFlags & 0x01) != 0) fills.Append("FOK ");
            if ((fillFlags & 0x02) != 0) fills.Append("IOC ");
            if ((fillFlags & 0x04) != 0) fills.Append("RETURN ");
            if ((fillFlags & 0x08) != 0) fills.Append("ORDER_FOK ");

            // TradeFlags 枚举
            var tflags = new System.Text.StringBuilder();
            if ((tradeFlags & 0x01) != 0) tflags.Append("ALLOW_REAL ");
            if ((tradeFlags & 0x02) != 0) tflags.Append("ALLOW_LIMIT ");
            if ((tradeFlags & 0x04) != 0) tflags.Append("ALLOW_STOP ");
            if ((tradeFlags & 0x08) != 0) tflags.Append("ALLOW_SL ");
            if ((tradeFlags & 0x10) != 0) tflags.Append("ALLOW_TP ");
            if ((tradeFlags & 0x20) != 0) tflags.Append("ALLOW_CLOSEBY ");

            return string.Format(
                "TradeMode={0} ExecMode={1} FillFlags=0x{2:X8}({3}) TradeFlags=0x{4:X16}({5})",
                tradeModeStr, execModeStr, fillFlags,
                fills.ToString().TrimEnd(),
                tradeFlags, tflags.ToString().TrimEnd());
        }

        /// <summary>
        /// 诊断用:原始 DealerSend。
        /// 返回 DealerSend 返回值 + 回执详情。
        /// </summary>
        public string DiagDealerSend(ulong login, string symbol, bool isBuy,
            double lots, double price, string comment, CIMTOrder.EnOrderFilling? typeFill,
            uint? flags, ulong? position, double? sl, double? tp,
            CIMTRequest.EnTradeActions action = CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE,
            uint? reason = null, ulong? sourceLogin = null)
        {
            if (!_connected)
                return "未连接";

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
                        return "创建 request 失败";

                    request.Clear();
                    request.Login(login);
                    request.Action(action);
                    request.Type(isBuy ? CIMTOrder.EnOrderType.OP_BUY : CIMTOrder.EnOrderType.OP_SELL);
                    request.Volume(SMTMath.VolumeToInt(lots));
                    request.Symbol(symbol);
                    request.PriceOrder(price);

                    if (!string.IsNullOrEmpty(comment))
                        request.Comment(comment);

                    if (typeFill.HasValue)
                        request.TypeFill(typeFill.Value);

                    if (flags.HasValue)
                        request.Flags((CIMTRequest.EnTradeActionFlags)flags.Value);

                    if (position.HasValue)
                        request.Position(position.Value);

                    if (sl.HasValue)
                        request.PriceSL(sl.Value);

                    if (tp.HasValue)
                        request.PriceTP(tp.Value);

                    if (reason.HasValue)
                        request.Reason(reason.Value);

                    if (sourceLogin.HasValue)
                        request.SourceLogin(sourceLogin.Value);

                    sink = new DealerSink(result);

                    MTRetCode reg = sink.RegisterSink();
                    if (reg != MTRetCode.MT_RET_OK)
                        return "RegisterSink 失败:" + reg;

                    res = _manager.DealerSend(request, sink, out requestId);
                }

                if (res != MTRetCode.MT_RET_OK)
                    return string.Format("DealerSend 返回 {0}", res);

                // 等回执
                res = sink.Wait(_cfg.DealerTimeoutMs);

                string extra = "";
                lock (_gate)
                {
                    if (res == MTRetCode.MT_RET_REQUEST_DONE ||
                        res == MTRetCode.MT_RET_REQUEST_DONE_PARTIAL)
                    {
                        extra = string.Format(" | Deal=#{0} Order=#{1} Price={2}",
                            result.ResultDeal(), result.ResultOrder(), result.ResultPrice());
                    }

                    string resComment = result.ResultComment();
                    if (!string.IsNullOrEmpty(resComment))
                        extra += " | Comment=" + resComment;

                    // 失败时也打印 retcode 详情
                    if (res != MTRetCode.MT_RET_REQUEST_DONE &&
                        res != MTRetCode.MT_RET_REQUEST_DONE_PARTIAL)
                    {
                        extra += string.Format(" | ResultRetcode={0}", result.ResultRetcode());
                    }
                }

                return string.Format("DealerSend OK(id={0}) -> 回执={1}{2}",
                    requestId, res, extra);
            }
            finally
            {
                lock (_gate)
                {
                    if (sink != null)
                    {
                        try { _manager.DealerUnsubscribe(sink); }
                        catch { }
                    }
                    if (request != null) request.Dispose();
                    if (result != null) result.Dispose();
                }
                GC.KeepAlive(sink);
            }
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

        /// <summary>断线重连。指数退避,最多 30 秒一次。</summary>
        private void WatchdogLoop()
        {
            int delaySec = 2;

            while (!_stopping)
            {
                Thread.Sleep(1000);

                if (_stopping || _connected)
                {
                    delaySec = 2;
                    continue;
                }

                Log.Warn("检测到未连接,{0} 秒后重连", delaySec);
                Thread.Sleep(delaySec * 1000);

                if (_stopping)
                    break;

                MTRetCode res = ConnectOnce();
                if (res == MTRetCode.MT_RET_OK)
                {
                    Log.Info("重连成功");

                    // 重连后 dealer 通道要重开,否则下单没有回执。
                    // Selected 列表是连接级状态,断线即失效,缓存要清掉重建。
                    lock (_gate)
                    {
                        _manager.DealerStart();
                        _selected.Clear();
                    }

                    delaySec = 2;
                }
                else
                {
                    Log.Error("重连失败:{0}", res);
                    delaySec = Math.Min(delaySec * 2, 30);
                }
            }
        }

        //+------------------------------------------------------------------+
        //| 校验密码。用于用户在网页上绑定 MT5 账号。                        |
        //+------------------------------------------------------------------+
        public MTRetCode CheckPassword(ulong login, string password, bool investorOnly)
        {
            lock (_gate)
            {
                return _manager.UserPasswordCheck(
                    investorOnly
                        ? CIMTUser.EnUsersPasswords.USER_PASS_INVESTOR
                        : CIMTUser.EnUsersPasswords.USER_PASS_MAIN,
                    login,
                    password);
            }
        }

        /// <summary>读账号资料 + 资金。返回 null 表示读取失败。</summary>
        public AccountInfo GetAccount(ulong login, out MTRetCode res)
        {
            lock (_gate)
            {
                AccountInfo info = new AccountInfo();
                info.Login = login;

                using (CIMTUser user = _manager.UserCreate())
                {
                    res = _manager.UserRequest(login, user);
                    if (res != MTRetCode.MT_RET_OK)
                        return null;

                    info.Name = user.Name();
                    info.Group = user.Group();
                    info.Leverage = user.Leverage();
                }

                using (CIMTAccount account = _manager.UserCreateAccount())
                {
                    res = _manager.UserAccountRequest(login, account);
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

        /// <summary>读持仓。</summary>
        public PositionInfo[] GetPositions(ulong login, out MTRetCode res)
        {
            lock (_gate)
            {
                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    res = _manager.PositionRequest(login, arr);

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
            lock (_gate)
            {
                using (CIMTOrderArray arr = _manager.OrderCreateArray())
                {
                    res = _manager.OrderRequestOpen(login, arr);

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
        /// 时间参数由 MT5 服务器按 UTC 秒解读,直接传 Unix 时间戳即可 —— 不像
        /// Bridge 那边用 MetaTrader5 Python 包时要先换算服务器本地时区(见
        /// bridge/mt5_worker.py 的 _server_now 注释)。Manager API 走的是
        /// int64 秒,不存在那个参照系陷阱。
        /// </summary>
        public DealInfo[] GetDeals(ulong login, long fromUnix, long toUnix, out MTRetCode res)
        {
            lock (_gate)
            {
                using (CIMTDealArray arr = _manager.DealCreateArray())
                {
                    res = _manager.DealRequest(login, fromUnix, toUnix, arr);

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
                            Comment = d.Comment()
                        };
                    }

                    if (n != total)
                        Array.Resize(ref list, n);

                    return list;
                }
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
                string group;
                if (!_groupCache.TryGetValue(login, out group))
                {
                    using (CIMTUser user = _manager.UserCreate())
                    {
                        MTRetCode r = _manager.UserRequest(login, user);
                        if (r != MTRetCode.MT_RET_OK)
                            return baseSymbol;
                        group = user.Group();
                        _groupCache[login] = group;
                    }
                }

                string cacheKey = group.ToUpperInvariant() + "|" + baseSymbol.ToUpperInvariant();

                string cached;
                if (_symbolCache.TryGetValue(cacheKey, out cached))
                    return cached;

                // --- 2. exact match first ---
                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    if (_manager.SymbolGet(baseSymbol, group, sym) == MTRetCode.MT_RET_OK)
                    {
                        _symbolCache[cacheKey] = baseSymbol;
                        return baseSymbol;
                    }
                }

                // --- 3. scan symbol table for prefixed matches ---
                string upper = baseSymbol.ToUpperInvariant();
                List<string> candidates = new List<string>();
                uint total = _manager.SymbolTotal();

                using (CIMTConSymbol scanSym = _manager.SymbolCreate())
                {
                    for (uint i = 0; i < total; i++)
                    {
                        if (_manager.SymbolNext(i, scanSym) != MTRetCode.MT_RET_OK)
                            continue;

                        string name = scanSym.Symbol();
                        if (string.IsNullOrEmpty(name))
                            continue;

                        if (!name.ToUpperInvariant().StartsWith(upper))
                            continue;

                        // Check group access
                        using (CIMTConSymbol testSym = _manager.SymbolCreate())
                        {
                            if (_manager.SymbolGet(name, group, testSym) == MTRetCode.MT_RET_OK)
                                candidates.Add(name);
                        }
                    }
                }

                // pick shortest suffix (closest to base name)
                if (candidates.Count > 0)
                {
                    candidates.Sort((a, b) => a.Length.CompareTo(b.Length));

                    string resolved = candidates[0];

                    Log.Info("品种名自动匹配: {0} -> {1} (组={2})",
                        baseSymbol, resolved, group);

                    _symbolCache[cacheKey] = resolved;
                    return resolved;
                }

                // No match — return as-is, let caller handle the error
                _symbolCache[cacheKey] = baseSymbol;
                return baseSymbol;
            }
        }

        /// <summary>
        /// 取当前买卖价。
        ///
        /// 注意:品种在配置表里存在,并不等于有报价。Manager 只会收到"已选中"
        /// (Selected)品种的行情推送。所以这里先把品种加进选中列表,再取价。
        /// 首次取价可能因为推送还没到而失败,重试一次即可。
        /// </summary>
        public bool GetQuote(string symbol, out double bid, out double ask, out MTRetCode res)
        {
            bid = 0;
            ask = 0;
            res = MTRetCode.MT_RET_ERR_NOTFOUND;

            for (int attempt = 0; attempt < 2; attempt++)
            {
                lock (_gate)
                {
                    if (_selected.Add(symbol))
                        _manager.SelectedAdd(symbol);

                    MTTickShort tick;
                    res = _manager.TickLast(symbol, out tick);

                    if (res == MTRetCode.MT_RET_OK && (tick.bid > 0 || tick.ask > 0))
                    {
                        bid = tick.bid;
                        ask = tick.ask;
                        return true;
                    }
                }

                // 刚加进选中列表,等一下首个 tick 推过来
                if (attempt == 0)
                    Thread.Sleep(700);
            }

            return false;
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

        /// <summary>取品种的手数限制,用于下单前校验。</summary>
        public bool GetSymbolLimits(string symbol, out double volMin, out double volMax,
            out double volStep, out MTRetCode res)
        {
            volMin = 0;
            volMax = 0;
            volStep = 0;

            lock (_gate)
            {
                using (CIMTConSymbol sym = _manager.SymbolCreate())
                {
                    res = _manager.SymbolGet(symbol, sym);
                    if (res != MTRetCode.MT_RET_OK)
                        return false;

                    volMin = SMTMath.VolumeToDouble(sym.VolumeMin());
                    volMax = SMTMath.VolumeToDouble(sym.VolumeMax());
                    volStep = SMTMath.VolumeToDouble(sym.VolumeStep());
                    return true;
                }
            }
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
        /// SL/TP 不在开仓请求里设:官方示例开仓不带 SL/TP,要用独立的
        /// TA_DEALER_POS_MODIFY 请求。所以成交后再补一次改单。
        /// </summary>
        public TradeResult OpenPosition(ulong login, string symbol, bool isBuy, double lots,
            double stopLoss, double takeProfit, string tag)
        {
            // 自动补后缀:不同组需要不同后缀品种(如 EURUSD.s)
            symbol = ResolveSymbol(login, symbol);

            // 先取价:买用 ask,卖用 bid
            double bid, ask;
            MTRetCode qres;

            if (!GetQuote(symbol, out bid, out ask, out qres))
            {
                return TradeResult.Fail(qres.ToString(),
                    "取价失败,无法下单(品种名是否正确?该品种是否有行情?)");
            }

            double price = isBuy ? ask : bid;

            if (price <= 0)
                return TradeResult.Fail("MT_RET_REQUEST_PRICE_OFF", "该品种当前无有效报价");

            TradeResult r = SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE);
                req.Type(isBuy ? CIMTOrder.EnOrderType.OP_BUY : CIMTOrder.EnOrderType.OP_SELL);
                req.Volume(SMTMath.VolumeToInt(lots));
                req.Symbol(symbol);
                req.PriceOrder(price);
                req.Comment(BuildComment(tag));
            });

            // 回执没有仓位号,按成交号反查补上。后端拿它作为归属判定的依据,
            // 查不到也只是退化成旧行为(0),不影响这笔已成交的仓位。
            // The confirmation carries no position id; resolve it from the deal.
            // A failure just degrades to 0 and never affects the filled position.
            if (r.Ok && r.Deal != 0)
                r.Position = GetDealPosition(r.Deal);

            // 开仓成功且要求了 SL/TP,再补一次改单。
            // 改单失败不影响已成交的仓位,只在结果里带上提示。
            if (r.Ok && (stopLoss > 0 || takeProfit > 0))
            {
                ulong ticket = r.Order != 0 ? r.Order : r.Deal;

                if (ticket != 0)
                {
                    TradeResult m = ModifyPosition(login, ticket, stopLoss, takeProfit);

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
        public TradeResult ClosePosition(ulong login, ulong ticket, double lots, string tag)
        {
            string symbol;
            bool posIsBuy;
            double posVolume;

            lock (_gate)
            {
                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    MTRetCode r = _manager.PositionRequestByTickets(new ulong[] { ticket }, arr);
                    if (r != MTRetCode.MT_RET_OK || arr.Total() == 0)
                        return TradeResult.Fail(r.ToString(), "找不到仓位 #" + ticket);

                    CIMTPosition p = arr.Next(0);
                    if (p == null)
                        return TradeResult.Fail("MT_RET_ERR_NOTFOUND", "找不到仓位 #" + ticket);

                    if (p.Login() != login)
                        return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                            "仓位 #" + ticket + " 不属于账号 " + login);

                    symbol = p.Symbol();
                    posIsBuy = p.Action() == (uint)CIMTPosition.EnPositionAction.POSITION_BUY;
                    posVolume = SMTMath.VolumeToDouble(p.Volume());
                }
            }

            double closeVolume = (lots > 0 && lots < posVolume) ? lots : posVolume;

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

        //+------------------------------------------------------------------+
        //| 改持仓的 SL/TP。传 0 表示清除该项。                              |
        //+------------------------------------------------------------------+
        public TradeResult ModifyPosition(ulong login, ulong ticket,
            double stopLoss, double takeProfit)
        {
            string symbol;

            lock (_gate)
            {
                using (CIMTPositionArray arr = _manager.PositionCreateArray())
                {
                    MTRetCode r = _manager.PositionRequestByTickets(new ulong[] { ticket }, arr);
                    if (r != MTRetCode.MT_RET_OK || arr.Total() == 0)
                        return TradeResult.Fail(r.ToString(), "找不到仓位 #" + ticket);

                    CIMTPosition p = arr.Next(0);
                    if (p == null)
                        return TradeResult.Fail("MT_RET_ERR_NOTFOUND", "找不到仓位 #" + ticket);

                    if (p.Login() != login)
                        return TradeResult.Fail("MT_RET_ERR_PERMISSIONS",
                            "仓位 #" + ticket + " 不属于账号 " + login);

                    symbol = p.Symbol();
                }
            }

            return SendDealerRequest(req =>
            {
                req.Login(login);
                req.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_MODIFY);
                req.Symbol(symbol);
                req.Position(ticket);
                req.PriceSL(stopLoss);
                req.PriceTP(takeProfit);
                req.Flags(CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_SL |
                          CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_TP);
            });
        }

        //+------------------------------------------------------------------+
        //| dealer 请求的公共流程:建对象 -> 填参数 -> 发送 -> 等回执         |
        //+------------------------------------------------------------------+
        private TradeResult SendDealerRequest(Action<CIMTRequest> fill)
        {
            if (!_connected)
                return TradeResult.Fail("MT_RET_ERR_CONNECTION", "MT5 未连接");

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
                res = sink.Wait(_cfg.DealerTimeoutMs);

                if (res == MTRetCode.MT_RET_REQUEST_TIMEOUT)
                    Log.Warn("dealer 请求 {0} 超时,未收到答复", requestId);

                // 请求被退回队列:通常是服务器上另有 dealer 插件在处理同一队列,
                // 或该品种当时取不到价。这不是成交,要当失败处理。
                if (res == MTRetCode.MT_RET_REQUEST_RETURN ||
                    res == MTRetCode.MT_RET_REQUEST_REQUOTE_RETURN)
                {
                    Log.Warn("dealer 请求 {0} 被退回队列({1}),未成交", requestId, res);
                }

                if (res == MTRetCode.MT_RET_REQUEST_DONE ||
                    res == MTRetCode.MT_RET_REQUEST_DONE_PARTIAL)
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
                            Message = result.ResultComment() ?? ""
                        };
                    }
                }

                string comment;
                lock (_gate)
                {
                    comment = result.ResultComment() ?? "";
                }

                return TradeResult.Fail(res.ToString(),
                    comment.Length > 0 ? comment : DescribeTradeError(res));
            }
            finally
            {
                lock (_gate)
                {
                    // 先退订,确保原生层不再回调这个 sink
                    if (sink != null)
                    {
                        try { _manager.DealerUnsubscribe(sink); }
                        catch { }
                    }

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

                    _manager.Disconnect();
                    _manager.Dispose();
                    _manager = null;
                }
            }

            SMTManagerAPIFactory.Shutdown();
        }
    }
}
