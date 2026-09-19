//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 日志                                        |
//|                                                                  |
//| 同时写控制台和按天滚动的文件。作为 Windows 服务跑的时候没有控制台, |
//| 文件日志是唯一的排查依据。                                        |
//|                                                                  |
//| 保留策略:超过 RetentionDays 天的日志在启动时和每次跨天时清理。    |
//| 单个文件超过 MaxFileBytes 后转写 .overflowN 文件。这台机器是       |
//| Windows VPS,磁盘写满会让 gateway 连同 MT5 连接一起停摆,而日志     |
//| 本身没有任何上限——异常刷屏一晚上就能把盘写爆。                    |
//|                                                                  |
//| 注意 logs\ 目录里有**两个**写入方,清理必须同时覆盖:              |
//|   gateway-YYYYMMDD.log   本类写的,约 0.03 MB/天                  |
//|   YYYYMMDD.log           MT5 Manager API 自己写的(见 Mt5Link.cs  |
//|                          的 SMTManagerAPIFactory.Initialize),    |
//|                          约 7-8 MB/天 —— **磁盘大头是这个**      |
//| 第一版只清了前者,漏掉了 99% 的量,部署验证时才发现。              |
//+------------------------------------------------------------------+
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Prismx.Mt5Gateway
{
    internal static class Log
    {
        // 保留天数。排查一次线上问题通常回看不超过两周。
        private const int RetentionDays = 14;

        // 单个日志文件上限。正常一天的日志远小于这个量级,触发它基本意味着
        // 出了异常刷屏——此时熔断到新文件,至少让当天的正常日志还能读。
        private const long MaxFileBytes = 100L * 1024 * 1024;

        private static readonly object Gate = new object();
        private static string _dir;

        // 当前正在写的文件及其已写字节数。
        //
        // 字节数在进程内累加而不是每次写前 stat 文件:写日志在交易路径上,
        // 每行一次 syscall 不划算。进程重启或跨天时会重新读一次真实大小,
        // 所以累加值不会长期偏离。
        private static DateTime _currentDate = DateTime.MinValue;
        private static string _currentFile;
        private static long _currentBytes;
        private static int _overflowIndex;
        private static StreamWriter _writer;

        public static void Init(string baseDir)
        {
            _dir = Path.Combine(baseDir, "logs");

            try
            {
                Directory.CreateDirectory(_dir);
            }
            catch
            {
                // 无法建目录就只写控制台,不让日志问题拖垮主流程
                _dir = null;
                return;
            }

            lock (Gate)
            {
                CleanupOldLogs();
            }
        }

        public static void Info(string format, params object[] args)
        {
            Write("INFO", format, args);
        }

        public static void Warn(string format, params object[] args)
        {
            Write("WARN", format, args);
        }

        public static void Error(string format, params object[] args)
        {
            Write("ERROR", format, args);
        }

        private static void Write(string level, string format, params object[] args)
        {
            string message = args.Length == 0 ? format : string.Format(format, args);
            string line = string.Format("{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}",
                DateTime.Now, level, message);

            lock (Gate)
            {
                Console.WriteLine(line);

                if (_dir == null)
                    return;

                try
                {
                    DateTime today = DateTime.Now.Date;
                    if (today != _currentDate)
                    {
                        CloseWriter();
                        // 跨天(或进程刚起来):换文件,顺便清理过期日志。
                        // 清理放在这里而不是单开一个定时器——服务是长驻的,
                        // 跨天是天然的每日触发点,不需要再引入一个线程。
                        _currentDate = today;
                        _overflowIndex = 0;
                        _currentFile = Path.Combine(_dir,
                            string.Format("gateway-{0:yyyyMMdd}.log", today));
                        _currentBytes = SafeFileLength(_currentFile);
                        CleanupOldLogs();
                    }

                    long lineBytes = Encoding.UTF8.GetByteCount(line) + Environment.NewLine.Length;

                    if (_currentBytes + lineBytes > MaxFileBytes)
                    {
                        CloseWriter();
                        _overflowIndex++;
                        _currentFile = Path.Combine(_dir,
                            string.Format("gateway-{0:yyyyMMdd}.overflow{1}.log", _currentDate, _overflowIndex));
                        _currentBytes = SafeFileLength(_currentFile);
                    }

                    // 常开的 StreamWriter,不再每行一次"开-写-关"。
                    //
                    // 为什么要改:这把 Gate 锁上会进来券商的回调线程(OnDealerAnswer /
                    // OnDealAdd 都写日志),每行一次 File.AppendAllText 就是每行三次
                    // syscall——行情/成交密集时会直接拖慢回调线程本身,而那是交易路径。
                    // AutoFlush 保留:进程随时可能被 Stop-Process -Force 硬杀,缓冲区里
                    // 的日志一旦丢掉,恰恰丢的是崩溃前最要紧的那几行。
                    // A kept-open writer instead of open-write-close per line: broker
                    // callback threads log under this same lock, and three syscalls per
                    // line slowed the callback path itself. AutoFlush stays, because the
                    // process is force-killed on deploy and the last lines matter most.
                    if (_writer == null)
                    {
                        _writer = new StreamWriter(
                            new FileStream(_currentFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
                            new UTF8Encoding(false));
                        _writer.AutoFlush = true;
                    }

                    _writer.WriteLine(line);
                    _currentBytes += lineBytes;
                }
                catch
                {
                    // 写日志失败不影响交易。句柄可能已经坏了,丢掉让下一行重开。
                    // A broken handle is dropped so the next line reopens it.
                    CloseWriter();
                }
            }
        }

        /// <summary>关掉当前的日志写入器。调用方持 Gate。
        /// Closes the current writer; caller holds Gate.</summary>
        private static void CloseWriter()
        {
            if (_writer == null)
                return;

            try { _writer.Dispose(); }
            catch { }

            _writer = null;
        }

        /// <summary>进程退出前把日志句柄收干净。
        /// Flush and release the log handle before exit.</summary>
        public static void Shutdown()
        {
            lock (Gate)
            {
                CloseWriter();
            }
        }

        private static long SafeFileLength(string path)
        {
            try
            {
                FileInfo fi = new FileInfo(path);
                return fi.Exists ? fi.Length : 0;
            }
            catch
            {
                return 0;
            }
        }

        // 认得的日志文件名。用白名单正则而不是宽松通配符:logs\ 目录里可能还有
        // 别的东西(排查时手工放的记录、将来别的组件的输出),绝不能误删。
        //   gateway-20260808.log / gateway-20260808.overflow1.log  本类写的
        //   20260808.log                                           MT5 SDK 写的
        private static readonly Regex OwnLogPattern =
            new Regex(@"^gateway-\d{8}(\.overflow\d+)?\.log$", RegexOptions.IgnoreCase);
        private static readonly Regex SdkLogPattern =
            new Regex(@"^\d{8}\.log$", RegexOptions.IgnoreCase);

        // 删除超过保留期的日志。调用方必须已持有 Gate。
        // 整体吞掉异常:清不掉旧日志顶多是占盘,不该让 gateway 起不来或写不了日志。
        private static void CleanupOldLogs()
        {
            if (_dir == null)
                return;

            try
            {
                DateTime cutoff = DateTime.UtcNow.AddDays(-RetentionDays);

                foreach (string path in Directory.GetFiles(_dir, "*.log"))
                {
                    try
                    {
                        string name = Path.GetFileName(path);
                        if (!OwnLogPattern.IsMatch(name) && !SdkLogPattern.IsMatch(name))
                            continue;

                        // 按最后写入时间判断,而不是从文件名解析日期:文件名格式
                        // 万一以后变了,这里不会跟着悄悄失效。
                        if (File.GetLastWriteTimeUtc(path) < cutoff)
                            File.Delete(path);
                    }
                    catch
                    {
                        // 单个文件删不掉(SDK 正占着当天那个、权限问题等)就跳过,
                        // 不影响其余文件
                    }
                }
            }
            catch
            {
                // 目录枚举失败也不致命
            }
        }
    }
}
