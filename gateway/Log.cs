//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 日志                                        |
//|                                                                  |
//| 同时写控制台和按天滚动的文件。作为 Windows 服务跑的时候没有控制台, |
//| 文件日志是唯一的排查依据。                                        |
//+------------------------------------------------------------------+
using System;
using System.IO;
using System.Text;

namespace Prismx.Mt5Gateway
{
    internal static class Log
    {
        private static readonly object Gate = new object();
        private static string _dir;

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
                    string file = Path.Combine(_dir,
                        string.Format("gateway-{0:yyyyMMdd}.log", DateTime.Now));

                    File.AppendAllText(file, line + Environment.NewLine, Encoding.UTF8);
                }
                catch
                {
                    // 写日志失败不影响交易
                }
            }
        }
    }
}
