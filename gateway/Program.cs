//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 入口                                        |
//|                                                                  |
//| 两种运行模式:                                                    |
//|   selftest  一次性自检:连接 -> 读账号 -> (可选)下单 -> 退出       |
//|   serve     常驻:保持 MT5 长连接 + 提供 HTTP 接口                |
//|                                                                  |
//| 先用 selftest 确认链路,再用 serve 正式跑。                       |
//+------------------------------------------------------------------+
using System;
using System.IO;
using System.Reflection;
using System.Threading;
using MetaQuotes.MT5CommonAPI;

namespace Prismx.Mt5Gateway
{
    internal static class Program
    {
        private static readonly ManualResetEventSlim Quit = new ManualResetEventSlim(false);

        private static int Main(string[] args)
        {
            string baseDir = Path.GetDirectoryName(
                Assembly.GetExecutingAssembly().Location);

            Log.Init(baseDir);

            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "serve";

            if (mode == "-h" || mode == "--help" || mode == "help")
            {
                PrintUsage();
                return 0;
            }

            Config cfg;

            try
            {
                cfg = Config.Load(Path.Combine(baseDir, "gateway.ini"));
            }
            catch (Exception ex)
            {
                Log.Error("配置错误:{0}", ex.Message);
                Console.WriteLine();
                Console.WriteLine("请参考 gateway.ini.example 建立 gateway.ini");
                return 2;
            }

            switch (mode)
            {
                case "selftest":
                    return RunSelfTest(cfg, args);
                case "sym":
                    return RunSymSearch(cfg, args);
                case "closeall":
                    return RunCloseAll(cfg, args);
                case "serve":
                    return RunServe(cfg);
                default:
                    Log.Error("未知模式:{0}", mode);
                    PrintUsage();
                    return 2;
            }
        }

        //+------------------------------------------------------------------+
        //| 自检:把三步验证做完                                             |
        //+------------------------------------------------------------------+
        private static int RunSelfTest(Config cfg, string[] args)
        {
            ulong clientLogin = 0;
            if (args.Length > 1)
                ulong.TryParse(args[1], out clientLogin);

            string symbol = args.Length > 2 ? args[2] : null;

            double lots = 0.01;
            if (args.Length > 3)
                double.TryParse(args[3], out lots);

            Console.WriteLine();
            Console.WriteLine("========== PRISMX MT5 网关自检 ==========");
            Console.WriteLine();

            using (Mt5Link link = new Mt5Link(cfg))
            {
                // ---------- 步骤1 ----------
                Console.WriteLine("--- 步骤1:连接 MT5 并启动 dealer 通道 ---");
                Console.WriteLine("  server = {0}", cfg.Server);
                Console.WriteLine("  login  = {0}", cfg.ManagerLogin);
                Console.WriteLine();

                try
                {
                    link.Start();
                }
                catch (Exception ex)
                {
                    Console.WriteLine();
                    Console.WriteLine("[X] {0}", ex.Message);
                    Console.WriteLine();
                    Console.WriteLine("    MT_RET_ERR_NETWORK     -> 端口不通或 IP 不在白名单");
                    Console.WriteLine("    MT_RET_AUTH_*          -> 账号或密码错误");
                    Console.WriteLine("    DealerStart 失败       -> 缺 RIGHT_TRADES_DEALER 权限");
                    return 1;
                }

                Console.WriteLine();
                Console.WriteLine("[OK] 步骤1 通过:连接正常,dealer 通道已开。");
                Console.WriteLine();

                if (clientLogin == 0)
                {
                    Console.WriteLine("未提供客户账号,跳过步骤2/3。");
                    Console.WriteLine("完整自检:mt5gateway.exe selftest <客户账号> [品种] [手数]");
                    return 0;
                }

                // ---------- 步骤2 ----------
                Console.WriteLine("--- 步骤2:读取客户 {0} 的资料 ---", clientLogin);

                MTRetCode res;
                AccountInfo info = link.GetAccount(clientLogin, out res);

                if (info == null)
                {
                    Console.WriteLine("[X] 读取失败:{0}", res);
                    Console.WriteLine("    MT_RET_ERR_PERMISSIONS -> 缺 RIGHT_ACC_READ 权限");
                    Console.WriteLine("    MT_RET_ERR_NOTFOUND    -> 账号不存在");
                    return 1;
                }

                Console.WriteLine("  姓名   : {0}", info.Name);
                Console.WriteLine("  组别   : {0}", info.Group);
                Console.WriteLine("  杠杆   : 1:{0}", info.Leverage);
                Console.WriteLine("  余额   : {0:F2}", info.Balance);
                Console.WriteLine("  净值   : {0:F2}", info.Equity);
                Console.WriteLine("  保证金 : {0:F2}(可用 {1:F2})", info.Margin, info.MarginFree);

                // 改密时间。平台靠它发现"用户改了密码"并撤销旧绑定(见 Models.cs
                // 的 LastPassChange 说明)。这里打出来是为了能**实测**两件事:
                //   1. 券商服务器到底填不填这个字段(打出「未填写」就是不填,
                //      撤销机制在这家券商上不生效,后端会保持不撤销)
                //   2. 只改投资者密码时它动不动(动 = 用户改投资者密码也会被
                //      要求重新验证一次)
                // 测法:读一次记下 → 只改投资者密码 → 再读 → 改主密码 → 再读。
                //
                // Printed so the revocation signal can actually be measured
                // against this broker: whether the server fills the field at all,
                // and whether an investor-password change also bumps it.
                if (info.LastPassChange > 0)
                {
                    DateTime when = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                        .AddSeconds(info.LastPassChange);
                    Console.WriteLine("  改密时间: {0} (UTC {1:yyyy-MM-dd HH:mm:ss})",
                        info.LastPassChange, when);
                }
                else
                {
                    Console.WriteLine("  改密时间: 未填写(该服务器不提供,改密撤销绑定的机制将不生效)");
                }

                bool groupAllowed = cfg.IsGroupAllowed(info.Group);
                Console.WriteLine("  组白名单: {0}", groupAllowed ? "通过" : "不通过(交易会被拒)");

                PositionInfo[] positions = link.GetPositions(clientLogin, out res);

                if (positions == null)
                {
                    Console.WriteLine("[X] 读持仓失败:{0}", res);

                    if (res == MTRetCode.MT_RET_ERR_PERMISSIONS)
                        Console.WriteLine("    缺 RIGHT_TRADES_READ 权限");

                    return 1;
                }

                Console.WriteLine("  持仓数 : {0}{1}", positions.Length,
                    positions.Length == 0 ? "(空仓)" : "");

                foreach (PositionInfo p in positions)
                {
                    Console.WriteLine(
                        "    #{0} {1} {2} {3:F2} 手 @ {4} SL={5} TP={6} 浮盈={7:F2} [{8}]",
                        p.Ticket, p.Symbol, p.Side, p.Volume, p.PriceOpen,
                        p.StopLoss, p.TakeProfit, p.Profit, p.Comment);
                }

                // 品种名后缀是最容易踩的坑:空仓时看不到,所以直接查品种表。
                if (positions.Length > 0)
                {
                    Console.WriteLine();
                    Console.WriteLine("  注意:上面持仓里的品种名就是下单时要用的名字(含后缀)。");
                }
                else
                {
                    MTRetCode sres;
                    Console.WriteLine();
                    Console.WriteLine("  品种表共 {0} 个", link.SymbolTotal());

                    string[] names = link.FindSymbols("EUR", 10, out sres);

                    // EUR 没匹配到就列前几个,总之要让用户看到真实命名形式
                    if (names.Length == 0)
                        names = link.FindSymbols(null, 10, out sres);

                    if (names.Length > 0)
                    {
                        Console.WriteLine("  品种名示例(下单要用这里的完整名字):");
                        foreach (string s in names)
                            Console.WriteLine("    {0}", s);
                    }
                    else
                    {
                        Console.WriteLine("  品种表为空:可能是品种数据还没同步完。");
                        Console.WriteLine("  不影响下单,直接在步骤3传品种名试即可。");
                    }
                }

                Console.WriteLine();
                Console.WriteLine("[OK] 步骤2 通过:能读到客户资料与持仓。");
                Console.WriteLine();

                if (string.IsNullOrEmpty(symbol))
                {
                    Console.WriteLine("未提供品种,跳过步骤3(下单)。");
                    Console.WriteLine("要测下单:mt5gateway.exe selftest {0} EURUSD 0.01", clientLogin);
                    return 0;
                }

                // ---------- 步骤3 ----------
                Console.WriteLine("--- 步骤3:代客下单 ---");

                if (!groupAllowed)
                {
                    Console.WriteLine("[X] 该账号的组不在 allowed_groups 白名单内,已阻止。");
                    Console.WriteLine("    如确认要测试,请把 {0} 加进 gateway.ini", info.Group);
                    return 1;
                }

                // 自动补后缀
                symbol = link.ResolveSymbol(clientLogin, symbol);

                double bid, ask;
                if (link.GetQuote(symbol, out bid, out ask, out res))
                {
                    Console.WriteLine("  当前报价 : bid={0} ask={1}", bid, ask);
                }
                else
                {
                    // 取不到价就别下单了:多半是品种名不对或该品种没行情,
                    // 硬下只会拿到一个难解释的拒绝码。
                    Console.WriteLine("[X] 取价失败:{0}", res);
                    Console.WriteLine();
                    Console.WriteLine("    可能原因:");
                    Console.WriteLine("      1. 品种名不对(注意后缀,用步骤2列出的名字)");
                    Console.WriteLine("      2. 该品种当前无行情(周末休市,或未配置报价源)");
                    Console.WriteLine("    已中止,未下单。");
                    return 1;
                }

                Console.WriteLine();
                Console.WriteLine("  即将下单:{0} BUY {1:F2} 手,账号 {2}", symbol, lots, clientLogin);
                Console.WriteLine("  这会产生真实成交。确认是 demo 账号后输入 Y 继续:");
                Console.Write("  > ");

                string answer = Console.ReadLine();
                if (!string.Equals(answer, "Y", StringComparison.OrdinalIgnoreCase))
                {
                    Console.WriteLine("已取消。步骤1、2 已通过。");
                    return 0;
                }

                Console.WriteLine();
                Console.WriteLine("  已发出请求,等待服务器答复...");
                Console.WriteLine("  (最长等 {0} 秒;卡住不动就是服务器没答复)",
                    cfg.DealerTimeoutMs / 1000);

                TradeResult r = link.OpenPosition(clientLogin, symbol, true, lots, 0, 0, "selftest");

                Console.WriteLine();

                if (!r.Ok)
                {
                    Console.WriteLine("[X] 下单失败:{0}", r.Retcode);
                    Console.WriteLine("    {0}", r.Message);
                    return 1;
                }

                Console.WriteLine("[OK] 步骤3 通过:成交了。");
                Console.WriteLine("  Deal   #{0}", r.Deal);
                Console.WriteLine("  Order  #{0}", r.Order);
                Console.WriteLine("  成交价 : {0}", r.Price);
                Console.WriteLine();
                Console.WriteLine("三步全部通过。可以用 serve 模式正式运行了。");
                Console.WriteLine();
                Console.WriteLine("提示:这笔测试仓位还开着,记得手动平掉,");
                Console.WriteLine("      或用 /trade/close 接口平仓(ticket={0})。", r.Order);

                return 0;
            }
        }

        //+------------------------------------------------------------------+
        //| 搜索品种后缀:列出含关键词的品种并尝试报价                         |
        //+------------------------------------------------------------------+
        private static int RunSymSearch(Config cfg, string[] args)
        {
            string keyword = args.Length > 1 ? args[1] : "EURUSD";

            using (Mt5Link link = new Mt5Link(cfg))
            {
                link.ConnectOnly();

                Console.WriteLine();
                Console.WriteLine("========== 品种搜索: {0} ==========", keyword);
                Console.WriteLine("  品种表共 {0} 个", link.SymbolTotal());
                Console.WriteLine();

                MTRetCode res;
                string[] names = link.FindSymbols(keyword, 50, out res);

                if (names.Length == 0)
                {
                    Console.WriteLine("  无匹配品种。");
                    return 1;
                }

                Console.WriteLine("  找到 {0} 个匹配品种:", names.Length);

                foreach (string s in names)
                {
                    double bid, ask;
                    bool hasQuote = link.GetQuote(s, out bid, out ask, out res);

                    string quoteStr = hasQuote
                        ? string.Format("bid={0} ask={1}", bid, ask)
                        : string.Format("无报价({0})", res);

                    Console.WriteLine("    {0,-30} {1}", s, quoteStr);
                }

                Console.WriteLine();
                Console.WriteLine("  提示: 用 diag 测试具体品种:");
                Console.WriteLine("    mt5gateway.exe diag 100039 <品种名>");
            }

            return 0;
        }

        //+------------------------------------------------------------------+
        //| 平掉某账号所有持仓                                                |
        //+------------------------------------------------------------------+
        private static int RunCloseAll(Config cfg, string[] args)
        {
            ulong clientLogin = 0;
            if (args.Length > 1)
                ulong.TryParse(args[1], out clientLogin);

            string symbol = args.Length > 2 ? args[2] : null;

            if (clientLogin == 0)
            {
                Console.WriteLine("用法: mt5gateway.exe closeall <账号> [品种(可选)]");
                return 1;
            }

            using (Mt5Link link = new Mt5Link(cfg))
            {
                link.ConnectOnly();

                MTRetCode res;
                PositionInfo[] positions = link.GetPositions(clientLogin, out res);

                if (positions == null || positions.Length == 0)
                {
                    Console.WriteLine("无持仓。");
                    return 0;
                }

                int closed = 0, failed = 0;

                foreach (PositionInfo p in positions)
                {
                    if (!string.IsNullOrEmpty(symbol) &&
                        !string.Equals(p.Symbol, symbol, StringComparison.OrdinalIgnoreCase))
                        continue;

                    Console.Write("  平 #{0} {1} {2} {3:F2}手 ... ", p.Ticket, p.Symbol, p.Side, p.Volume);

                    TradeResult r = link.ClosePosition(clientLogin, (ulong)p.Ticket, p.Volume, "closeall");

                    if (r.Ok)
                    {
                        Console.WriteLine("OK");
                        closed++;
                    }
                    else
                    {
                        Console.WriteLine("失败:{0}", r.Retcode);
                        failed++;
                    }
                }

                Console.WriteLine();
                Console.WriteLine("已平 {0} 笔, 失败 {1} 笔。", closed, failed);
            }

            return 0;
        }

        //+------------------------------------------------------------------+
        //| 常驻服务                                                         |
        //+------------------------------------------------------------------+
        private static int RunServe(Config cfg)
        {
            Log.Info("========== PRISMX MT5 网关启动 ==========");

            Mt5Link link = null;
            HttpServer http = null;

            try
            {
                link = new Mt5Link(cfg);
                link.Start();

                http = new HttpServer(cfg, link);
                http.Start();

                if (cfg.AllowedGroups.Count == 0)
                {
                    Log.Warn("allowed_groups 为空:任何账号都可交易。");
                    Log.Warn("测试阶段建议在 gateway.ini 里限定 demo 组。");
                }

                Log.Info("网关就绪。Ctrl+C 停止。");

                // Ctrl+C 优雅退出
                Console.CancelKeyPress += (s, e) =>
                {
                    e.Cancel = true;
                    Log.Info("收到停止信号");
                    Quit.Set();
                };

                Quit.Wait();

                Log.Info("正在停止...");
                return 0;
            }
            catch (Exception ex)
            {
                Log.Error("启动失败:{0}", ex.Message);
                return 1;
            }
            finally
            {
                if (http != null) http.Dispose();
                if (link != null) link.Dispose();

                Log.Info("已停止");
            }
        }

        private static void PrintUsage()
        {
            Console.WriteLine();
            Console.WriteLine("PRISMX MT5 Gateway");
            Console.WriteLine();
            Console.WriteLine("用法:");
            Console.WriteLine("  mt5gateway.exe selftest [客户账号] [品种] [手数]   自检");
            Console.WriteLine("  mt5gateway.exe serve                              常驻服务");
            Console.WriteLine();
            Console.WriteLine("配置来自同目录的 gateway.ini。");
            Console.WriteLine();
            Console.WriteLine("自检建议按顺序:");
            Console.WriteLine("  mt5gateway.exe selftest                    只验连接");
            Console.WriteLine("  mt5gateway.exe selftest 500123             验连接+读资料");
            Console.WriteLine("  mt5gateway.exe selftest 500123 EURUSD 0.01 全验(含下单)");
            Console.WriteLine();
        }
    }
}
