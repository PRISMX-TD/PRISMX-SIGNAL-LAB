//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 配置                                        |
//|                                                                  |
//| 配置从 gateway.ini 读取(与 exe 同目录)。凭据不写死在代码里,      |
//| 也不进 git。                                                     |
//+------------------------------------------------------------------+
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;

namespace Prismx.Mt5Gateway
{
    internal sealed class Config
    {
        // --- MT5 连接 ---
        public string Server = "";
        public ulong ManagerLogin;
        public string ManagerPassword = "";

        // --- HTTP 服务 ---
        // 默认只监听 127.0.0.1:接口不暴露到公网,由后端通过隧道/内网访问。
        // 默认只听本机、端口与 install-service.ps1 的兜底和 README 的生产写法一致
        // (8800)。以前这里是 8788,三处各写一个数字,有 ini 时无影响、没 ini 时自检
        // 与安装脚本会各猜各的。
        // Loopback-only by default; the port matches install-service.ps1's fallback
        // and the README (8800). It used to be 8788 here, a third number nobody used.
        public string ListenPrefix = "http://127.0.0.1:8800/";

        // 调用方必须带 X-Gateway-Token 头,值与此一致。
        public string ApiToken = "";

        // --- 交易行为 ---
        // 只允许操作这些组的账号(逗号分隔,前缀匹配,大小写不敏感)。
        // 留空 = 不限制。测试阶段强烈建议填 demo 组,防止误碰真实资金。
        public List<string> AllowedGroups = new List<string>();

        // 成交回执等待上限
        public int DealerTimeoutMs = 60000;

        // 下单时写入 comment 的前缀。Manager API 没有 magic 字段,
        // 只能靠 comment 认"哪些仓位是本平台开的"。
        public string CommentPrefix = "PRISMX";

        public static Config Load(string path)
        {
            if (!File.Exists(path))
                throw new FileNotFoundException("找不到配置文件:" + path);

            Config cfg = new Config();

            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();

                // 跳过空行与注释
                if (line.Length == 0 || line[0] == '#' || line[0] == ';' || line[0] == '[')
                    continue;

                int eq = line.IndexOf('=');
                if (eq <= 0)
                    continue;

                string key = line.Substring(0, eq).Trim().ToLowerInvariant();
                string val = line.Substring(eq + 1).Trim();

                switch (key)
                {
                    case "server":
                        cfg.Server = val;
                        break;
                    case "manager_login":
                        ulong login;
                        if (ulong.TryParse(val, out login))
                            cfg.ManagerLogin = login;
                        break;
                    case "manager_password":
                        cfg.ManagerPassword = val;
                        break;
                    case "listen":
                        // 容错:补上结尾的斜杠,HttpListener 要求必须有
                        cfg.ListenPrefix = val.EndsWith("/") ? val : val + "/";
                        break;
                    case "api_token":
                        cfg.ApiToken = val;
                        break;
                    case "allowed_groups":
                        cfg.AllowedGroups.Clear();
                        foreach (string g in val.Split(','))
                        {
                            string t = g.Trim();
                            if (t.Length > 0)
                                cfg.AllowedGroups.Add(t);
                        }
                        break;
                    case "dealer_timeout_ms":
                        int ms;
                        if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out ms) && ms > 0)
                            cfg.DealerTimeoutMs = ms;
                        break;
                    case "comment_prefix":
                        cfg.CommentPrefix = val;
                        break;
                }
            }

            cfg.Validate();
            return cfg;
        }

        private void Validate()
        {
            if (string.IsNullOrEmpty(Server))
                throw new Exception("配置缺少 server");

            if (ManagerLogin == 0)
                throw new Exception("配置缺少 manager_login");

            if (string.IsNullOrEmpty(ManagerPassword))
                throw new Exception("配置缺少 manager_password");

            // 空 token 等于任何能访问端口的人都能下单,必须拦住。
            if (string.IsNullOrEmpty(ApiToken) || ApiToken.Length < 16)
                throw new Exception("api_token 缺失或太短(至少 16 位)。这是下单接口的唯一鉴权,不能留空。");
        }

        /// <summary>组是否在白名单内。白名单为空表示不限制。</summary>
        public bool IsGroupAllowed(string group)
        {
            if (AllowedGroups.Count == 0)
                return true;

            if (string.IsNullOrEmpty(group))
                return false;

            foreach (string prefix in AllowedGroups)
            {
                if (group.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            return false;
        }
    }
}
