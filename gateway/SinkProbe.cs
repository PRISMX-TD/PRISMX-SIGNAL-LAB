//+------------------------------------------------------------------+
//| Sink 订阅可行性探针                                              |
//|                                                                  |
//| 一次性验证工具,不属于正式功能。目的是回答两个问题:              |
//|   1. 券商有没有开放订阅权限(看 PositionSubscribe 的返回码)      |
//|   2. 回调在哪个线程触发(决定正式实现要不要加锁、能不能发 HTTP)  |
//|                                                                  |
//| 只读:全程不下单、不改仓、不写任何数据。凭据从 gateway.ini 读,   |
//| 不需要手输密码。                                                 |
//|                                                                  |
//| 用法(在 gateway 目录):                                         |
//|   .\build-probe.ps1                                              |
//|   .\SinkProbe.exe 120                                            |
//| 然后在这 120 秒内手动开平一笔单,看有没有回调输出。              |
//+------------------------------------------------------------------+
using System;
using System.Globalization;
using System.IO;
using System.Threading;
using MetaQuotes.MT5CommonAPI;
using MetaQuotes.MT5ManagerAPI;

namespace Prismx.SinkProbe
{
    /// <summary>持仓变更回调。只打印,不做任何写操作。</summary>
    internal sealed class PositionSink : CIMTPositionSink
    {
        public static int MainThreadId;
        public static int CallbackCount;

        public override void OnPositionAdd(CIMTPosition p) { Report("ADD", p); }
        public override void OnPositionUpdate(CIMTPosition p) { Report("UPDATE", p); }
        public override void OnPositionDelete(CIMTPosition p) { Report("DELETE", p); }

        /// <summary>服务端推完初始快照时触发。收到它说明订阅真的建立了。</summary>
        public override void OnPositionSync()
        {
            Console.WriteLine("[SYNC] 持仓初始快照同步完成 (tid=" +
                Thread.CurrentThread.ManagedThreadId + ")");
        }

        private static void Report(string kind, CIMTPosition p)
        {
            if (p == null) return;

            Interlocked.Increment(ref CallbackCount);
            int tid = Thread.CurrentThread.ManagedThreadId;
            string where = tid == MainThreadId ? "主线程" : "后台线程";

            Console.WriteLine(
                "[持仓 {0}] tid={1}({2}) login={3} 仓位={4} {5} 手数={6} 浮盈={7} 现价={8}",
                kind, tid, where,
                p.Login(), p.Position(), p.Symbol(),
                (p.Volume() / 10000.0).ToString("0.00", CultureInfo.InvariantCulture),
                p.Profit().ToString("0.00", CultureInfo.InvariantCulture),
                p.PriceCurrent().ToString("0.00000", CultureInfo.InvariantCulture));
        }
    }

    /// <summary>成交回调。用于验证平仓明细能否即时拿到。</summary>
    internal sealed class DealSink : CIMTDealSink
    {
        public static int CallbackCount;

        public override void OnDealAdd(CIMTDeal d)
        {
            if (d == null) return;

            Interlocked.Increment(ref CallbackCount);
            Console.WriteLine(
                "[成交 ADD] tid={0} login={1} 成交号={2} 仓位={3} {4} entry={5} 盈亏={6}",
                Thread.CurrentThread.ManagedThreadId,
                d.Login(), d.Deal(), d.PositionID(), d.Symbol(),
                d.Entry(),
                d.Profit().ToString("0.00", CultureInfo.InvariantCulture));
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            int watchSeconds = 120;
            if (args.Length > 0)
                int.TryParse(args[0], out watchSeconds);
            if (watchSeconds < 10) watchSeconds = 10;

            PositionSink.MainThreadId = Thread.CurrentThread.ManagedThreadId;

            string iniPath = Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "gateway.ini");
            if (!File.Exists(iniPath))
            {
                Console.WriteLine("找不到 gateway.ini,请在 gateway 目录下运行。");
                return 2;
            }

            // 手工解析,避免依赖 Config.cs(它属于正式工程,探针要能独立编译)
            string server = "", password = "";
            ulong login = 0;
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
                else if (key == "manager_login") ulong.TryParse(val, out login);
                else if (key == "manager_password") password = val;
            }

            if (server.Length == 0 || login == 0 || password.Length == 0)
            {
                Console.WriteLine("gateway.ini 缺少 server / manager_login / manager_password。");
                return 2;
            }

            Console.WriteLine("=== Sink 订阅探针 ===");
            Console.WriteLine("服务器: " + server);
            Console.WriteLine("Manager: " + login);
            Console.WriteLine("主线程 tid=" + PositionSink.MainThreadId);
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

            PositionSink posSink = null;
            DealSink dealSink = null;

            try
            {
                // 与正式 gateway 用同一组 pump 模式
                res = manager.Connect(server, login, password, null,
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
                Console.WriteLine();

                // 托管 sink 内部持有原生对象指针,构造后必须先 RegisterSink()
                // 创建它,否则传进去的是空指针,订阅会返回 MT_RET_ERR_PARAMS。
                // 与 Mt5Link.cs 里 DealerSink 的用法一致。
                posSink = new PositionSink();
                MTRetCode regPos = posSink.RegisterSink();
                Console.WriteLine("PositionSink.RegisterSink -> " + regPos);

                dealSink = new DealSink();
                MTRetCode regDeal = dealSink.RegisterSink();
                Console.WriteLine("DealSink.RegisterSink     -> " + regDeal);
                Console.WriteLine();

                if (regPos != MTRetCode.MT_RET_OK || regDeal != MTRetCode.MT_RET_OK)
                {
                    Console.WriteLine(">>> RegisterSink 失败,无法继续。请把这段输出发回。");
                    return 1;
                }

                // ---- 这两个返回码是「券商是否开放订阅」的答案 ----
                MTRetCode rp = manager.PositionSubscribe(posSink);
                Console.WriteLine("PositionSubscribe -> " + rp +
                    (rp == MTRetCode.MT_RET_OK ? "   [OK 有权限]" : "   [失败]"));

                MTRetCode rd = manager.DealSubscribe(dealSink);
                Console.WriteLine("DealSubscribe     -> " + rd +
                    (rd == MTRetCode.MT_RET_OK ? "   [OK 有权限]" : "   [失败]"));
                Console.WriteLine();

                if (rp != MTRetCode.MT_RET_OK && rd != MTRetCode.MT_RET_OK)
                {
                    Console.WriteLine(">>> 两个订阅都失败了。");
                    if (rp == MTRetCode.MT_RET_ERR_PERMISSIONS ||
                        rd == MTRetCode.MT_RET_ERR_PERMISSIONS)
                        Console.WriteLine(">>> 返回码是权限错误,需要联系券商开放订阅权限。");
                    else
                        Console.WriteLine(">>> 返回码不是权限错误,可能是用法问题,请把输出发回。");
                    return 1;
                }

                Console.WriteLine(">>> 订阅已建立,监听 " + watchSeconds + " 秒。");
                Console.WriteLine(">>> 请现在手动开一笔单,等几秒,再平掉。");
                Console.WriteLine(">>> (有持仓时行情跳动也会触发 UPDATE)");
                Console.WriteLine();

                // sink 在订阅期间必须存活,否则回调会丢
                for (int i = 0; i < watchSeconds; i++)
                {
                    Thread.Sleep(1000);
                    GC.KeepAlive(posSink);
                    GC.KeepAlive(dealSink);
                }

                Console.WriteLine();
                Console.WriteLine("=== 结果 ===");
                Console.WriteLine("持仓回调次数: " + PositionSink.CallbackCount);
                Console.WriteLine("成交回调次数: " + DealSink.CallbackCount);

                if (PositionSink.CallbackCount == 0 && DealSink.CallbackCount == 0)
                {
                    Console.WriteLine();
                    Console.WriteLine(">>> 订阅成功但没收到任何回调。可能原因:");
                    Console.WriteLine("    - 监听期间确实没有持仓变动(重跑并确保开平一笔)");
                    Console.WriteLine("    - 订阅生效但事件不覆盖该账号组");
                }
                else
                {
                    Console.WriteLine();
                    Console.WriteLine(">>> 订阅可用。请把上面的输出发给我,");
                    Console.WriteLine("    我需要看 tid 是主线程还是后台线程。");
                }

                manager.PositionUnsubscribe(posSink);
                manager.DealUnsubscribe(dealSink);
                manager.Disconnect();
                return 0;
            }
            catch (Exception ex)
            {
                Console.WriteLine("异常: " + ex.Message);
                return 1;
            }
            finally
            {
                manager.Release();
                SMTManagerAPIFactory.Shutdown();
            }
        }
    }
}
