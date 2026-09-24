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

        // 启动与重连后立即选中的品种(券商真实品种名,含后缀)。Manager 只收"已选中"
        // 品种的行情,没选中的品种第一笔单要先选中再等首个 tick 推过来;这里点名的
        // 品种把这一步提前到启动时做。留空 = 不预选,只靠下过单的品种自动记住。
        // Symbols selected right after connect/reconnect (broker names, suffix
        // included). The manager only receives ticks for selected symbols, so the
        // first order on an unselected symbol waits for its first tick; listing them
        // here moves that wait to startup. Empty = rely on remembering traded symbols.
        public List<string> PreselectSymbols = new List<string>();

        // 下单时写入 comment 的前缀。Manager API 没有 magic 字段,
        // 只能靠 comment 认"哪些仓位是本平台开的"。
        public string CommentPrefix = "PRISMX";

        // --- 额外的防线 ---
        // 允许调用的来源 IP(逗号分隔,精确匹配)。留空 = 不限制。
        //
        // 生产上 listen 常写成 http://+:8800/(见 gateway.ini.example 里绑隧道 IP 会
        // 503 那段),等于把「读全体客户资料 + 代客下单」的接口绑在所有网卡上,唯一
        // 的防线是云安全组。安全组一次误配、或换机迁移忘了带规则,这个接口就直接
        // 到公网上了。填上后端那台机器的隧道地址(如 10.66.0.1),等于在网关自己这层
        // 再加一道,不必把唯一防线放在云控制台里。
        // Source-IP allowlist (exact match, empty = no restriction). Production often
        // binds to all interfaces, leaving a cloud security group as the only barrier;
        // listing the backend's tunnel address adds a second one inside the gateway.
        public List<string> AllowedIps = new List<string>();

        // HTTP 处理线程数。一次平仓最坏 = dealer 超时(默认 60 秒)+ 两次确认重读,
        // 而每个线程处理完一个请求才回去 accept 下一个——线程数就是并发上限。
        // 原来写死 4:四笔卡住的慢单就能把**所有**接口(含不鉴权的 /health)排到队尾,
        // 监控于是把网关判成「完全失联」,运维按失联处置去重启,反而撞上重启期间的
        // 重复下单风险。调大不是根治(根治要改异步 I/O),但把「监控误判」的门槛从
        // 4 笔抬到这个数,代价只是几个空闲线程。
        // Handler threads: each serves one request to completion before accepting the
        // next, so this is the concurrency ceiling. It was hard-coded to 4, and four
        // stuck closes queued every endpoint including the unauthenticated /health.
        public int HttpThreads = 16;

        // 同时在处理中的请求上限。HttpThreads 条线程现在只负责 accept,接到请求就交给
        // 线程池去处理,自己立刻回去接下一个——所以 16 笔在等 dealer 回执的慢单不会再
        // 把第 17 笔(以及 /health)堵在门外。每笔在途请求大部分时间是在等券商,只占一条
        // 睡着的线程,几百条的代价很小。到上限后新请求排队等空位,不会被拒绝。
        // Requests in flight at once. HttpThreads now only accept and hand each request
        // to the pool, so 16 slow closes waiting on the dealer no longer lock out the
        // 17th (or /health). An in-flight request mostly sleeps on the broker, so a few
        // hundred cost little. At the cap new requests wait for a slot, not rejected.
        public int HttpMaxConcurrent = 256;

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
                        // 上限 2 分钟:幂等缓存把执行超过 5 分钟的条目当成"已中断"收尾,
                        // dealer 超时比这还长,就会在交易还在跑时放出重复请求。
                        // Capped at 2 min: the idempotency cache closes out entries older
                        // than 5 min, so a longer dealer wait would release a duplicate
                        // while the trade is still running.
                        if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out ms) && ms > 0)
                            cfg.DealerTimeoutMs = Math.Min(ms, 120000);
                        break;
                    case "comment_prefix":
                        cfg.CommentPrefix = val;
                        break;
                    case "allowed_ips":
                        cfg.AllowedIps.Clear();
                        foreach (string ip in val.Split(','))
                        {
                            string t = ip.Trim();
                            if (t.Length > 0)
                                cfg.AllowedIps.Add(t);
                        }
                        break;
                    case "http_threads":
                        int threads;
                        if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out threads)
                            && threads > 0 && threads <= 256)
                            cfg.HttpThreads = threads;
                        break;
                    case "http_max_concurrent":
                        int maxc;
                        if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out maxc)
                            && maxc > 0 && maxc <= 2048)
                            cfg.HttpMaxConcurrent = maxc;
                        break;
                    case "i_know_what_im_doing":
                        cfg.IKnowWhatImDoing = val.Equals("true", StringComparison.OrdinalIgnoreCase)
                            || val == "1";
                        break;
                    case "preselect_symbols":
                        cfg.PreselectSymbols.Clear();
                        foreach (string s in val.Split(','))
                        {
                            string t = s.Trim();
                            if (t.Length > 0)
                                cfg.PreselectSymbols.Add(t);
                        }
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

            // 下面两条以前只在 Program 里打一条 Warn——日志刷过去就没人看见,而它们
            // 各自都是"最后一道闸"。改成启动时直接拒绝,除非配置里明确写了
            // i_know_what_im_doing = true,让「我知道我在做什么」成为一次显式选择。
            // These two used to be a startup warning that scrolled past in the log,
            // though each is a last line of defence. They now refuse to start unless
            // the config says so explicitly.
            if (!IKnowWhatImDoing)
            {
                // 空白名单 = 这家券商**所有**账号都能被代客下单。
                if (AllowedGroups.Count == 0)
                    throw new Exception(
                        "allowed_groups 为空,等于允许对这家券商的所有账号代客下单。"
                        + "请填上允许的组前缀;确实要不限制就在 gateway.ini 里写 i_know_what_im_doing = true");

                // 绑全网卡 + 没有来源 IP 白名单 = 只剩云安全组一道防线。
                bool bindsAll = ListenPrefix.Contains("//+:")
                    || ListenPrefix.Contains("//*:")
                    || ListenPrefix.Contains("//0.0.0.0:");

                if (bindsAll && AllowedIps.Count == 0)
                    throw new Exception(
                        "listen 绑在所有网卡上却没有配 allowed_ips,下单接口的唯一防线就只剩云安全组了。"
                        + "请填 allowed_ips(如后端的隧道地址),或改成只绑具体 IP;"
                        + "确实要这样就在 gateway.ini 里写 i_know_what_im_doing = true");
            }
        }

        /// <summary>显式解除上面两条启动检查。只应在临时排障时打开。
        /// Explicitly waives the two startup checks above; for temporary triage only.</summary>
        public bool IKnowWhatImDoing;

        /// <summary>来源 IP 是否被允许。列表为空表示不限制。
        /// Whether a caller's IP is allowed; an empty list means no restriction.</summary>
        public bool IsIpAllowed(string ip)
        {
            if (AllowedIps.Count == 0)
                return true;

            if (string.IsNullOrEmpty(ip))
                return false;

            // IPv6 映射写法 ::ffff:10.66.0.1 要能匹配上 10.66.0.1。
            // Accept the IPv4-mapped IPv6 spelling of the same address.
            string bare = ip.StartsWith("::ffff:", StringComparison.OrdinalIgnoreCase)
                ? ip.Substring(7)
                : ip;

            foreach (string allowed in AllowedIps)
            {
                if (string.Equals(allowed, ip, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(allowed, bare, StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            return false;
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
