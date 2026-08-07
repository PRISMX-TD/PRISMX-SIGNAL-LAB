//+------------------------------------------------------------------+
//| 开仓请求携带 SL/TP 的可行性探针                                  |
//|                                                                  |
//| 一次性验证工具,不属于正式功能。要回答的问题只有一个:            |
//|                                                                  |
//|   TA_DEALER_POS_EXECUTE 请求里直接设 PriceSL/PriceTP,            |
//|   券商服务器会不会真的把止损止盈落到仓位上?                      |
//|                                                                  |
//| 为什么要验:Mt5Link.cs 现在是「先开仓,再补一次 POS_MODIFY」,     |
//| 也就是两轮完整的券商往返。注释说「官方示例开仓不带 SL/TP」——     |
//| 但那只是示例的写法,不是文档写明的 API 约束。查过 SDK:            |
//|   - IMTRequest 确实有 PriceSL/PriceTP (MT5APIRequest.h:128-132)   |
//|   - 但整个 SDK 找不到 POS_EXECUTE 带 SL/TP 的例子                 |
//| 即字段存在,该 action 下的语义未知。合并前必须实测。              |
//|                                                                  |
//| ⚠️ 这个探针**会真实下单**(与只读的 SinkProbe 不同)。            |
//|    安全措施:                                                     |
//|      - 必须显式传 --i-understand-this-places-a-real-order         |
//|      - 手数上限硬编码 0.01,传更大直接拒                          |
//|      - 无论验证结果如何,结束前都会尝试平掉这笔仓位               |
//|      - 只在 demo 账号上跑                                        |
//|                                                                  |
//| 用法(在 gateway 目录):                                         |
//|   .\build-sltp-probe.ps1                                         |
//|   .\SlTpProbe.exe <demo客户账号> EURUSD --i-understand-this-places-a-real-order
//+------------------------------------------------------------------+
using System;
using System.Globalization;
using System.IO;
using System.Threading;
using MetaQuotes.MT5CommonAPI;
using MetaQuotes.MT5ManagerAPI;

namespace Prismx.SlTpProbe
{
    /// <summary>dealer 回执接收。与 Mt5Link.cs 的 DealerSink 同构。</summary>
    internal sealed class DealerSink : CIMTDealerSink
    {
        private readonly CIMTRequest _result;
        private readonly ManualResetEventSlim _done = new ManualResetEventSlim(false);
        private readonly object _lock = new object();
        private MTRetCode _assign = MTRetCode.MT_RET_ERR_NOTFOUND;

        public DealerSink(CIMTRequest result)
        {
            _result = result;
        }

        // 回执从 OnDealerAnswer 的参数进来,必须在回调里 Assign 到自己的对象上,
        // 回调返回后那个 request 就不归我们管了。与 Mt5Link.cs 的 DealerSink 一致。
        public override void OnDealerAnswer(CIMTRequest request)
        {
            lock (_lock)
            {
                try
                {
                    _assign = _result.Assign(request);
                }
                catch (Exception ex)
                {
                    Console.WriteLine("拷贝 dealer 回执失败: " + ex.Message);
                }
            }
            _done.Set();
        }

        public MTRetCode Wait(int timeoutMs)
        {
            if (!_done.Wait(timeoutMs))
                return MTRetCode.MT_RET_REQUEST_TIMEOUT;

            lock (_lock)
            {
                if (_assign != MTRetCode.MT_RET_OK)
                    return _assign;

                return (MTRetCode)_result.ResultRetcode();
            }
        }
    }

    internal static class Program
    {
        private const double MaxLots = 0.01;
        private const string ConsentFlag = "--i-understand-this-places-a-real-order";

        private static int Main(string[] args)
        {
            if (args.Length < 3)
            {
                Console.WriteLine("用法: SlTpProbe.exe <客户账号> <品种> " + ConsentFlag);
                Console.WriteLine();
                Console.WriteLine("这个探针会真实下一笔 " +
                    MaxLots.ToString(CultureInfo.InvariantCulture) + " 手的市价单,");
                Console.WriteLine("验证完会尝试平掉。请只在 demo 账号上运行。");
                return 2;
            }

            ulong clientLogin;
            if (!ulong.TryParse(args[0], out clientLogin) || clientLogin == 0)
            {
                Console.WriteLine("客户账号无效: " + args[0]);
                return 2;
            }

            string symbol = args[1];

            bool consented = false;
            foreach (string a in args)
                if (a == ConsentFlag) consented = true;

            if (!consented)
            {
                Console.WriteLine("缺少确认参数。这个探针会真实下单,请显式加上:");
                Console.WriteLine("  " + ConsentFlag);
                return 2;
            }

            // ---- 读 gateway.ini(手工解析,不依赖 Config.cs) ----
            string iniPath = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "gateway.ini");
            if (!File.Exists(iniPath))
            {
                Console.WriteLine("找不到 gateway.ini,请在 gateway 目录下运行。");
                return 2;
            }

            string server = "", password = "";
            ulong managerLogin = 0;
            int dealerTimeoutMs = 30000;

            foreach (string raw in File.ReadAllLines(iniPath))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == '#' || line[0] == ';' || line[0] == '[')
                    continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;

                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();
                if (key == "server") server = val;
                else if (key == "manager_login") ulong.TryParse(val, out managerLogin);
                else if (key == "manager_password") password = val;
                else if (key == "dealer_timeout_ms") int.TryParse(val, out dealerTimeoutMs);
            }

            if (server.Length == 0 || managerLogin == 0 || password.Length == 0)
            {
                Console.WriteLine("gateway.ini 缺少 server / manager_login / manager_password。");
                return 2;
            }

            Console.WriteLine("=== 开仓携带 SL/TP 探针 ===");
            Console.WriteLine("服务器  : " + server);
            Console.WriteLine("Manager : " + managerLogin);
            Console.WriteLine("客户账号: " + clientLogin);
            Console.WriteLine("品种    : " + symbol);
            Console.WriteLine("手数    : " + MaxLots.ToString(CultureInfo.InvariantCulture));
            Console.WriteLine();

            MTRetCode res = SMTManagerAPIFactory.Initialize(null);
            if (res != MTRetCode.MT_RET_OK)
            {
                Console.WriteLine("Initialize 失败: " + res);
                return 1;
            }

            CIMTManagerAPI manager = SMTManagerAPIFactory.CreateManager(
                SMTManagerAPIFactory.ManagerAPIVersion, out res);
            if (manager == null || res != MTRetCode.MT_RET_OK)
            {
                Console.WriteLine("CreateManager 失败: " + res);
                SMTManagerAPIFactory.Shutdown();
                return 1;
            }

            try
            {
                res = manager.Connect(server, managerLogin, password, null,
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_USERS |
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_ORDERS |
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_POSITIONS |
                    CIMTManagerAPI.EnPumpModes.PUMP_MODE_SYMBOLS,
                    30000);

                if (res != MTRetCode.MT_RET_OK)
                {
                    Console.WriteLine("Connect 失败: " + res);
                    return 1;
                }
                Console.WriteLine("已连接。");

                res = manager.DealerStart();
                Console.WriteLine("DealerStart -> " + res);
                if (res != MTRetCode.MT_RET_OK)
                {
                    Console.WriteLine(">>> dealer 通道没开,拿不到回执,无法验证。");
                    return 1;
                }
                Console.WriteLine();

                return RunProbe(manager, clientLogin, symbol, dealerTimeoutMs);
            }
            catch (Exception ex)
            {
                Console.WriteLine("异常: " + ex);
                return 1;
            }
            finally
            {
                try { manager.Disconnect(); } catch { }
                manager.Release();
                SMTManagerAPIFactory.Shutdown();
            }
        }

        private static int RunProbe(CIMTManagerAPI manager, ulong login,
            string symbol, int dealerTimeoutMs)
        {
            // ---- 取价:dealer 请求必须带明确成交价 ----
            manager.SelectedAdd(symbol);
            Thread.Sleep(800);

            MTTickShort tick;
            MTRetCode res = manager.TickLast(symbol, out tick);
            if (res != MTRetCode.MT_RET_OK || tick.ask <= 0)
            {
                Console.WriteLine("取价失败: " + res + " (品种名对吗?有行情吗?)");
                return 1;
            }

            double ask = tick.ask;
            Console.WriteLine("当前 ask = " + ask.ToString("0.00000", CultureInfo.InvariantCulture));

            // 止损放在下方 100 点、止盈上方 100 点。用 ask 的相对偏移,
            // 避免不同品种的点值差异导致被服务器判为无效价位。
            double digitsGuess = ask > 1000 ? 1.0 : 0.0010;
            double sl = ask - digitsGuess * 100;
            double tp = ask + digitsGuess * 100;

            if (sl <= 0)
            {
                Console.WriteLine("算出的止损价 <= 0,换个品种再试。");
                return 1;
            }

            Console.WriteLine("计划 SL = " + sl.ToString("0.00000", CultureInfo.InvariantCulture));
            Console.WriteLine("计划 TP = " + tp.ToString("0.00000", CultureInfo.InvariantCulture));
            Console.WriteLine();

            // ---- 开仓:一次请求同时带 SL/TP ----
            Console.WriteLine("--- 发送 POS_EXECUTE(携带 PriceSL/PriceTP) ---");

            CIMTRequest request = manager.RequestCreate();
            CIMTRequest result = manager.RequestCreate();
            if (request == null || result == null)
            {
                Console.WriteLine("RequestCreate 失败。");
                return 1;
            }

            DealerSink sink = new DealerSink(result);
            MTRetCode reg = sink.RegisterSink();
            Console.WriteLine("RegisterSink -> " + reg);
            if (reg != MTRetCode.MT_RET_OK)
            {
                Console.WriteLine(">>> 注册回调失败,无法继续。");
                return 1;
            }

            request.Clear();
            request.Login(login);
            request.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE);
            request.Type(CIMTOrder.EnOrderType.OP_BUY);
            request.Volume(SMTMath.VolumeToInt(MaxLots));
            request.Symbol(symbol);
            request.PriceOrder(ask);
            request.Comment("PRISMX-SLTP-PROBE");

            // ↓↓↓ 这三行就是本次要验证的东西 ↓↓↓
            request.PriceSL(sl);
            request.PriceTP(tp);
            request.Flags(CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_SL |
                          CIMTRequest.EnTradeActionFlags.TA_FLAG_CHANGED_TP);

            uint requestId;
            res = manager.DealerSend(request, sink, out requestId);
            Console.WriteLine("DealerSend -> " + res + " (id=" + requestId + ")");

            if (res != MTRetCode.MT_RET_OK)
            {
                Console.WriteLine();
                Console.WriteLine(">>> 结论:DealerSend 直接被拒。");
                Console.WriteLine(">>> POS_EXECUTE 不接受 SL/TP 字段,合并方案不可行。");
                Cleanup(manager, sink, request, result);
                return 0;
            }

            MTRetCode confirm = sink.Wait(dealerTimeoutMs);
            Console.WriteLine("回执 -> " + confirm);

            bool filled = confirm == MTRetCode.MT_RET_REQUEST_DONE ||
                          confirm == MTRetCode.MT_RET_REQUEST_DONE_PARTIAL;

            if (!filled)
            {
                Console.WriteLine();
                Console.WriteLine(">>> 结论:请求没有成交(" + confirm + ")。");
                Console.WriteLine(">>> 注意:这可能是行情/权限问题,不一定是 SL/TP 导致的。");
                Console.WriteLine(">>> 建议去掉 PriceSL/PriceTP 再跑一次做对照。");
                Cleanup(manager, sink, request, result);
                return 0;
            }

            ulong deal = result.ResultDeal();
            ulong order = result.ResultOrder();
            double price = result.ResultPrice();

            Console.WriteLine("已成交: deal=" + deal + " order=" + order +
                " price=" + price.ToString("0.00000", CultureInfo.InvariantCulture));
            Console.WriteLine();

            Cleanup(manager, sink, request, result);

            // ---- 关键一步:回查仓位,确认 SL/TP 是否真的生效 ----
            Console.WriteLine("--- 回查仓位,核对 SL/TP ---");
            Thread.Sleep(1500);   // 等服务器把仓位状态推过来

            ulong positionTicket = 0;
            double actualSl = 0, actualTp = 0;

            using (CIMTPositionArray arr = manager.PositionCreateArray())
            {
                res = manager.PositionRequest(login, arr);
                if (res != MTRetCode.MT_RET_OK)
                {
                    Console.WriteLine("查持仓失败: " + res);
                    Console.WriteLine(">>> 仓位可能还在,请手动检查并平掉!");
                    return 1;
                }

                for (uint i = 0; i < arr.Total(); i++)
                {
                    CIMTPosition p = arr.Next(i);
                    if (p == null) continue;
                    string c = p.Comment() ?? "";
                    if (c.IndexOf("PRISMX-SLTP-PROBE", StringComparison.OrdinalIgnoreCase) < 0)
                        continue;

                    positionTicket = p.Position();
                    actualSl = p.PriceSL();
                    actualTp = p.PriceTP();
                    break;
                }
            }

            if (positionTicket == 0)
            {
                Console.WriteLine("没找到本次开的仓位(comment 匹配失败)。");
                Console.WriteLine(">>> 请手动检查账号 " + login + " 有没有遗留仓位!");
                return 1;
            }

            Console.WriteLine("仓位号  : " + positionTicket);
            Console.WriteLine("实际 SL : " + actualSl.ToString("0.00000", CultureInfo.InvariantCulture));
            Console.WriteLine("实际 TP : " + actualTp.ToString("0.00000", CultureInfo.InvariantCulture));
            Console.WriteLine();

            bool slOk = Math.Abs(actualSl - sl) < digitsGuess * 20;
            bool tpOk = Math.Abs(actualTp - tp) < digitsGuess * 20;

            Console.WriteLine("=== 结论 ===");
            if (slOk && tpOk)
            {
                Console.WriteLine(">>> 可行。POS_EXECUTE 携带的 SL/TP 已落到仓位上。");
                Console.WriteLine(">>> 可以把 OpenPosition 的两轮 DealerSend 合并成一轮。");
            }
            else if (actualSl == 0 && actualTp == 0)
            {
                Console.WriteLine(">>> 不可行。请求成交了,但 SL/TP 被**静默忽略**(都是 0)。");
                Console.WriteLine(">>> 必须保留现在的「开仓后补一次 POS_MODIFY」写法。");
                Console.WriteLine(">>> 这正是不做实测就直接改会踩的坑:止损静默丢失。");
            }
            else
            {
                Console.WriteLine(">>> 结果不明确:落到仓位上的值与请求值不一致。");
                Console.WriteLine("    请求 SL=" + sl.ToString("0.00000", CultureInfo.InvariantCulture) +
                    " 实际 SL=" + actualSl.ToString("0.00000", CultureInfo.InvariantCulture));
                Console.WriteLine("    请求 TP=" + tp.ToString("0.00000", CultureInfo.InvariantCulture) +
                    " 实际 TP=" + actualTp.ToString("0.00000", CultureInfo.InvariantCulture));
                Console.WriteLine(">>> 可能是券商对止损距离做了调整。把这段输出发回再判断。");
            }
            Console.WriteLine();

            ClosePosition(manager, login, symbol, positionTicket, dealerTimeoutMs);
            return 0;
        }

        /// <summary>把探针开的仓位平掉。无论验证结果如何都要执行。</summary>
        private static void ClosePosition(CIMTManagerAPI manager, ulong login,
            string symbol, ulong ticket, int dealerTimeoutMs)
        {
            Console.WriteLine("--- 清理:平掉探针仓位 #" + ticket + " ---");

            // 平仓方向要反,而且必须带 TA_FLAG_CLOSE
            double volume = 0;
            bool wasBuy = true;

            using (CIMTPositionArray arr = manager.PositionCreateArray())
            {
                if (manager.PositionRequestByTickets(new ulong[] { ticket }, arr)
                        == MTRetCode.MT_RET_OK && arr.Total() > 0)
                {
                    CIMTPosition p = arr.Next(0);
                    if (p != null)
                    {
                        volume = p.Volume() / 10000.0;
                        wasBuy = p.Action() ==
                            (uint)CIMTPosition.EnPositionAction.POSITION_BUY;
                    }
                }
            }

            if (volume <= 0)
            {
                Console.WriteLine("读不到仓位手数,请手动平掉 #" + ticket);
                return;
            }

            MTTickShort tick;
            if (manager.TickLast(symbol, out tick) != MTRetCode.MT_RET_OK)
            {
                Console.WriteLine("取价失败,请手动平掉 #" + ticket);
                return;
            }

            double closePrice = wasBuy ? tick.bid : tick.ask;

            CIMTRequest request = manager.RequestCreate();
            CIMTRequest result = manager.RequestCreate();
            if (request == null || result == null)
            {
                Console.WriteLine("RequestCreate 失败,请手动平掉 #" + ticket);
                return;
            }

            DealerSink sink = new DealerSink(result);
            if (sink.RegisterSink() != MTRetCode.MT_RET_OK)
            {
                Console.WriteLine("注册回调失败,请手动平掉 #" + ticket);
                Cleanup(manager, sink, request, result);
                return;
            }

            request.Clear();
            request.Login(login);
            request.Action(CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE);
            request.Type(wasBuy ? CIMTOrder.EnOrderType.OP_SELL : CIMTOrder.EnOrderType.OP_BUY);
            request.Volume(SMTMath.VolumeToInt(volume));
            request.Symbol(symbol);
            request.PriceOrder(closePrice);
            request.Position(ticket);
            request.Flags(CIMTRequest.EnTradeActionFlags.TA_FLAG_CLOSE);
            request.Comment("PRISMX-SLTP-PROBE-CLOSE");

            uint requestId;
            MTRetCode res = manager.DealerSend(request, sink, out requestId);

            if (res == MTRetCode.MT_RET_OK)
            {
                MTRetCode confirm = sink.Wait(dealerTimeoutMs);
                if (confirm == MTRetCode.MT_RET_REQUEST_DONE ||
                    confirm == MTRetCode.MT_RET_REQUEST_DONE_PARTIAL)
                    Console.WriteLine("已平仓。");
                else
                    Console.WriteLine("平仓回执 " + confirm + " —— 请手动确认 #" + ticket);
            }
            else
            {
                Console.WriteLine("平仓 DealerSend 失败 " + res + " —— 请手动平掉 #" + ticket);
            }

            Cleanup(manager, sink, request, result);
        }

        private static void Cleanup(CIMTManagerAPI manager, DealerSink sink,
            CIMTRequest request, CIMTRequest result)
        {
            if (sink != null)
            {
                try { manager.DealerUnsubscribe(sink); } catch { }
            }
            if (request != null) request.Dispose();
            if (result != null) result.Dispose();
            GC.KeepAlive(sink);
        }
    }
}
