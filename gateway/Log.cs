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
//+------------------------------------------------------------------+
using System;
using System.IO;
using System.Text;

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
                        _overflowIndex++;
                        _currentFile = Path.Combine(_dir,
                            string.Format("gateway-{0:yyyyMMdd}.overflow{1}.log", _currentDate, _overflowIndex));
                        _currentBytes = SafeFileLength(_currentFile);
                    }

                    File.AppendAllText(_currentFile, line + Environment.NewLine, Encoding.UTF8);
                    _currentBytes += lineBytes;
                }
                catch
                {
                    // 写日志失败不影响交易
                }
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

        // 删除超过保留期的日志。调用方必须已持有 Gate。
        // 整体吞掉异常:清不掉旧日志顶多是占盘,不该让 gateway 起不来或写不了日志。
        private static void CleanupOldLogs()
        {
            if (_dir == null)
                return;

            try
            {
                DateTime cutoff = DateTime.UtcNow.AddDays(-RetentionDays);

                // 通配符同时覆盖 gateway-YYYYMMDD.log 与 gateway-YYYYMMDD.overflowN.log
                foreach (string path in Directory.GetFiles(_dir, "gateway-*.log"))
                {
                    try
                    {
                        // 按最后写入时间判断,而不是从文件名解析日期:文件名格式
                        // 万一以后变了,这里不会跟着悄悄失效。
                        if (File.GetLastWriteTimeUtc(path) < cutoff)
                            File.Delete(path);
                    }
                    catch
                    {
                        // 单个文件删不掉(被占用等)就跳过,不影响其余文件
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
