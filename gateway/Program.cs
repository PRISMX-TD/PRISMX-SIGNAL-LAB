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
                case "diag":
                    return RunDiag(cfg, args);
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
        //| 诊断模式:排查 DealerSend 被拒的原因                               |
        //|                                                                  |
        //| 用法:mt5gateway.exe diag <客户账号> <品种>                       |
        //|                                                                  |
        //| 关键假设:官方 SimpleManager 从未调用 DealerStart 就直接下单,     |
        //| 所以先测不带 DealerStart 的情况,再对比带 DealerStart 的差异。     |
        //+------------------------------------------------------------------+
        private static int RunDiag(Config cfg, string[] args)
        {
            ulong clientLogin = 0;
            if (args.Length > 1)
                ulong.TryParse(args[1], out clientLogin);

            string symbol = args.Length > 2 ? args[2] : "EURUSD";

            double lots = 0.01;
            if (args.Length > 3)
                double.TryParse(args[3], out lots);

            if (clientLogin == 0)
            {
                Console.WriteLine("用法:mt5gateway.exe diag <客户账号> [品种] [手数]");
                return 1;
            }

            Console.WriteLine();
            Console.WriteLine("========== MT5 DealerSend 诊断 ==========");
            Console.WriteLine("  客户账号: {0}", clientLogin);
            Console.WriteLine("  品种    : {0}", symbol);
            Console.WriteLine("  手数    : {0}", lots);
            Console.WriteLine();

            using (Mt5Link link = new Mt5Link(cfg))
            {
                // ===================== 步骤A:连接(不带 DealerStart) =====================
                Console.WriteLine("--- [A] 连接 MT5(不启动 dealer 通道) ---");

                try
                {
                    link.ConnectOnly();
                }
                catch (Exception ex)
                {
                    Console.WriteLine("[X] {0}", ex.Message);
                    return 1;
                }

                Console.WriteLine("[OK] 已连接");
                Console.WriteLine();

                // ===================== 步骤B:Manager 权限 =====================
                Console.WriteLine("--- [B] Manager 权限 ---");
                Console.WriteLine("  {0}", link.DiagManagerRights());
                Console.WriteLine();

                // ===================== 步骤C:用户信息 =====================
                Console.WriteLine("--- [C] 客户账号信息 ---");

                MTRetCode res;
                AccountInfo info = link.GetAccount(clientLogin, out res);

                if (info == null)
                {
                    Console.WriteLine("[X] 读取失败:{0}", res);
                    return 1;
                }

                Console.WriteLine("  姓名 : {0}", info.Name);
                Console.WriteLine("  组别 : {0}", info.Group);
                Console.WriteLine("  杠杆 : 1:{0}", info.Leverage);
                Console.WriteLine("  余额 : {0:F2}", info.Balance);
                Console.WriteLine("  权限 : {0}", link.DiagUserRights(clientLogin));
                Console.WriteLine();

                // ===================== 步骤D:组级别的交易设置 =====================
                Console.WriteLine("--- [D] 组交易设置 ---");
                Console.WriteLine("  {0}", link.DiagGroupTradeInfo(info.Group));
                Console.WriteLine();

                // ===================== 步骤E:品种属性(全局) =====================
                Console.WriteLine("--- [E] 品种属性(全局) ---");
                Console.WriteLine("  {0}: {1}", symbol, link.DiagSymbolInfo(symbol));
                Console.WriteLine();

                // ===================== 步骤F:品种属性(对该组) =====================
                Console.WriteLine("--- [F] 品种属性(对组 {0}) ---", info.Group);
                Console.WriteLine("  {0}", link.DiagSymbolGroupInfo(symbol, info.Group));
                Console.WriteLine();

                // ===================== 步骤G:报价 =====================
                Console.WriteLine("--- [G] 当前报价 ---");
                double bid, ask;

                if (link.GetQuote(symbol, out bid, out ask, out res))
                {
                    Console.WriteLine("  bid={0} ask={1}", bid, ask);
                }
                else
                {
                    Console.WriteLine("[X] 取价失败:{0}", res);
                    // 取不到价也继续:用假价格测 DealerSend 结构是否被接受
                    Console.WriteLine("  取不到行情,用假价格继续测 DealerSend 流程");
                    bid = 1.0;
                    ask = 1.0;
                }

                Console.WriteLine();

                // ===================== 步骤H0:DealerBalance 通道测试 =====================
                Console.WriteLine("--- [H0] DealerBalance 通道测试(确认 dealer 权限是否真的生效) ---");
                Console.WriteLine("  测试 +$0 入金(不影响余额)");
                string balResult = link.DiagDealerBalance(clientLogin, 0, "diag-test");
                Console.WriteLine("  -> {0}", balResult);
                Console.WriteLine();

                // ===================== 步骤H:DealerSend(不带 DealerStart!) =====================
                Console.WriteLine("--- [H] DealerSend 测试 ---");
                Console.WriteLine("  dealer 通道状态:未启动(和官方 SimpleManager 一致)");
                Console.WriteLine();

                // H1: 基准(无 comment, 和官方示例完全一致)
                Console.WriteLine("  [H1] BUY {0} {1:F2} 手, price=ask({2}), 无comment", symbol, lots, ask);
                string r1 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, null, null, null, null, null);
                Console.WriteLine("  -> {0}", r1);
                Console.WriteLine();

                // H2: 带 comment "diag" (测 comment 是否导致 INVALID)
                Console.WriteLine("  [H2] BUY {0} {1:F2} 手, price=ask({2}), comment=diag", symbol, lots, ask);
                string r2 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    "diag", null, null, null, null, null);
                Console.WriteLine("  -> {0}", r2);
                Console.WriteLine();

                // H3: Test TypeFill=FOK (Fill or Kill)
                Console.WriteLine("  [H3] BUY {0} {1:F2} 手, TypeFill=FOK", symbol, lots);
                string r3 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, CIMTOrder.EnOrderFilling.ORDER_FILL_FOK, null, null, null, null);
                Console.WriteLine("  -> {0}", r3);
                Console.WriteLine();

                // H4: SELL, TypeFill=IOC
                Console.WriteLine("  [H4] SELL {0} {1:F2} 手, price=bid({2}), TypeFill=IOC", symbol, lots, bid);
                string r4 = link.DiagDealerSend(clientLogin, symbol, false, lots, bid,
                    null, CIMTOrder.EnOrderFilling.ORDER_FILL_IOC, null, null, null, null);
                Console.WriteLine("  -> {0}", r4);
                Console.WriteLine();

                // H5: PriceOrder=0 (server pricing)
                Console.WriteLine("  [H5] BUY {0} {1:F2} 手, PriceOrder=0(让服务器定价)", symbol, lots);
                string r5 = link.DiagDealerSend(clientLogin, symbol, true, lots, 0,
                    null, null, null, null, null, null);
                Console.WriteLine("  -> {0}", r5);
                Console.WriteLine();

                // H6: TA_MARKET action (instead of TA_DEALER_POS_EXECUTE)
                Console.WriteLine("  [H6] BUY {0} {1:F2} 手, Action=TA_MARKET(不是TA_DEALER_POS_EXECUTE)", symbol, lots);
                string r6 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, null, null, null, null, null,
                    CIMTRequest.EnTradeActions.TA_MARKET);
                Console.WriteLine("  -> {0}", r6);
                Console.WriteLine();

                // H7: TA_DEALER_BALANCE action with trade params
                Console.WriteLine("  [H7] BUY {0} {1:F2} 手, Action=TA_DEALER_BALANCE(看是否通)", symbol, lots);
                string r7 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, null, null, null, null, null,
                    CIMTRequest.EnTradeActions.TA_DEALER_BALANCE);
                Console.WriteLine("  -> {0}", r7);
                Console.WriteLine();

                // H8: Reason=DEAL_REASON_DEALER (2)
                Console.WriteLine("  [H8] BUY {0} {1:F2} 手, Reason=DEAL_REASON_DEALER(2)", symbol, lots);
                string r8 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, null, null, null, null, null,
                    CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE,
                    reason: 2, sourceLogin: null);
                Console.WriteLine("  -> {0}", r8);
                Console.WriteLine();

                // H9: SourceLogin=Manager login
                Console.WriteLine("  [H9] BUY {0} {1:F2} 手, SourceLogin={2}(Manager)", symbol, lots, cfg.ManagerLogin);
                string r9 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, null, null, null, null, null,
                    CIMTRequest.EnTradeActions.TA_DEALER_POS_EXECUTE,
                    reason: 2, sourceLogin: cfg.ManagerLogin);
                Console.WriteLine("  -> {0}", r9);
                Console.WriteLine();

                // H10: TA_FLAG_SKIP_MARGIN_CHECK (0x400)
                Console.WriteLine("  [H10] BUY {0} {1:F2} 手, Flags=SKIP_MARGIN_CHECK", symbol, lots);
                string r10 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                    null, null, 0x400, null, null, null);
                Console.WriteLine("  -> {0}", r10);
                Console.WriteLine();

                // ===================== 步骤I:启动 DealerStart 后重测 =====================
                Console.WriteLine("--- [I] 启动 DealerStart 后重测 ---");

                MTRetCode dsr = link.DealerStartDiag();
                Console.WriteLine("  DealerStart 返回:{0}", dsr);

                if (dsr == MTRetCode.MT_RET_OK)
                {
                    // 只重测最关键的几个
                    Console.WriteLine();

                    Console.WriteLine("  [I1] BUY {0} {1:F2} 手(DealerStart + 无comment)", symbol, lots);
                    string i1 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                        null, null, null, null, null, null);
                    Console.WriteLine("  -> {0}", i1);

                    Console.WriteLine("  [I2] BUY {0} {1:F2} 手(DealerStart + TypeFill=FOK)", symbol, lots);
                    string i2 = link.DiagDealerSend(clientLogin, symbol, true, lots, ask,
                        null, CIMTOrder.EnOrderFilling.ORDER_FILL_FOK, null, null, null, null);
                    Console.WriteLine("  -> {0}", i2);
                }
                else
                {
                    Console.WriteLine("[X] DealerStart 失败,可能缺 RIGHT_TRADES_DEALER 权限");
                }

                Console.WriteLine();
                Console.WriteLine("========== 诊断完成 ==========");

                // 最后检查:有没有意外产生的持仓或成交?
                Console.WriteLine();
                Console.WriteLine("--- 最终检查:持仓和最近成交 ---");
                PositionInfo[] positions = link.GetPositions(clientLogin, out res);
                if (positions == null)
                {
                    Console.WriteLine("  读持仓失败:{0}", res);
                }
                else if (positions.Length == 0)
                {
                    Console.WriteLine("  无持仓 (所有 DealerSend 确实没成交)");
                }
                else
                {
                    Console.WriteLine("  *** 有 {0} 个持仓! 某个请求可能成交了:", positions.Length);
                    foreach (PositionInfo p in positions)
                        Console.WriteLine("    #{0} {1} {2} {3:F2}手 @ {4} [comment={5}]",
                            p.Ticket, p.Symbol, p.Side, p.Volume, p.PriceOpen, p.Comment);
                }

                // 查最近挂单
                 OrderInfo[] orders = link.GetOrders(clientLogin, out res);
                 if (orders != null)
                 {
                     Console.WriteLine("  挂单数: {0}", orders.Length);
                     foreach (OrderInfo o in orders)
                         Console.WriteLine("    #{0} {1} type={2} {3:F2}手 @ {4} [{5}]",
                             o.Ticket, o.Symbol, o.Type, o.Volume, o.PriceOrder, o.Comment);
                 }

                Console.WriteLine();

                // 关键结论
                Console.WriteLine();
                Console.WriteLine("--- 关键结论 ---");
                Console.WriteLine();

                if (dsr != MTRetCode.MT_RET_OK)
                {
                    Console.WriteLine("  *** DealerStart 失败 -> Manager 账号缺 RIGHT_TRADES_DEALER 权限");
                    Console.WriteLine("  *** 请在 MT5 Admin 中给 Manager 1034 加上该权限。");
                }
                else
                {
                    Console.WriteLine("  对比 [H] 和 [I] 的结果:");
                    Console.WriteLine("  - 如果 [H] 失败而 [I] 成功 -> 说明 DealerStart 是必须的");
                    Console.WriteLine("  - 如果 [H] 和 [I] 都失败 -> 问题不在 DealerStart,而是品种/组/权限");
                    Console.WriteLine("  - 如果 [H] 成功 -> 说明和官方示例一致,之前 selftest 被拒另有原因");
                }

                return 0;
            }
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
