"""PRISMX Signal Lab - 应用配置 / Application configuration."""
import base64
import binascii
import functools
import logging
import os
import sys

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("prismx.config")


def _b64_any(value: str) -> bytes:
    """按标准与 urlsafe 两种字母表尝试 base64 解码，补齐 padding。
    解不出返回空 bytes。/ Try both standard and urlsafe base64 alphabets,
    restoring padding. Returns empty bytes when undecodable."""
    padded = value + "=" * (-len(value) % 4)
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            return decoder(padded)
        except (binascii.Error, ValueError):
            continue
    return b""


@functools.lru_cache(maxsize=8)
def _normalize_vapid_private_key(raw: str) -> str:
    """把任意常见格式的 VAPID 私钥统一成 urlsafe-base64 的 PKCS8 DER。

    支持的输入：PEM 文本（含 -----BEGIN 头，或被 base64 再包一层的 PEM）、
    已经是 urlsafe-base64 DER 的值、以及 32 字节的 RAW 私钥。识别不出时原样
    返回，交由 pywebpush 自己报错——配置层不该把一个"也许它认识"的值吞掉。

    之所以需要这个函数：py_vapid 的 from_string 只试 RAW 与 DER，PEM 一定失败
    （见 vapid_private_key 的说明）。生产与本地历史上配的是哪个字段、哪种格式
    并不一致，把差异收敛在这里，任一种配法都能推送成功。

    Normalize a VAPID private key in any common format to urlsafe-base64 PKCS8
    DER. Accepts PEM text (with the -----BEGIN header, or a PEM wrapped in
    another layer of base64), a value that is already urlsafe-base64 DER, and a
    32-byte RAW private key. Anything unrecognized is returned unchanged so
    pywebpush can raise on it — the config layer shouldn't swallow a value it
    merely fails to recognize.

    Why this exists: py_vapid's from_string only attempts RAW and DER, so PEM
    always fails (see vapid_private_key). Which field and which format got
    configured has differed between production and local over time; converging
    that here means any of them delivers push successfully.
    """
    from cryptography.hazmat.primitives import serialization

    def _to_urlsafe_der(key) -> str:
        der = key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        return base64.urlsafe_b64encode(der).decode().rstrip("=")

    decoded = _b64_any(raw)

    # ① PEM 文本，或 base64 再包一层的 PEM（旧 VAPID_PRIVATE_KEY_B64 的形态）
    # ① PEM text, or a PEM wrapped in another base64 layer (the legacy shape)
    pem_text = ""
    if "-----BEGIN" in raw:
        pem_text = raw
    elif decoded[:11] == b"-----BEGIN ":
        pem_text = decoded.decode("utf-8", "ignore")
    if pem_text:
        try:
            key = serialization.load_pem_private_key(pem_text.encode(), password=None)
            return _to_urlsafe_der(key)
        except Exception:
            logger.warning("[vapid] PEM private key present but unparseable")
            return raw

    # ② 已经是 DER：直接确认能加载，顺带把 padding/字母表统一掉
    # ② Already DER: confirm it loads, and normalize padding/alphabet en route
    if decoded:
        try:
            key = serialization.load_der_private_key(decoded, password=None)
            return _to_urlsafe_der(key)
        except Exception:
            pass

        # ③ 32 字节 RAW 私钥（部分生成工具的输出）/ 32-byte RAW private key
        if len(decoded) == 32:
            try:
                from cryptography.hazmat.primitives.asymmetric import ec

                key = ec.derive_private_key(int.from_bytes(decoded, "big"), ec.SECP256R1())
                return _to_urlsafe_der(key)
            except Exception:
                pass

    logger.warning("[vapid] private key format not recognized; passing through unchanged")
    return raw


class Settings(BaseSettings):
    # 应用基础 / App basics
    APP_NAME: str = "PRISMX Signal Lab"
    API_PREFIX: str = "/api"

    # 运行环境 / Runtime environment：production 时强制安全配置。
    # When ENV=production, security-sensitive configs are enforced.
    ENV: str = "development"

    # 安全 / Security
    JWT_SECRET: str = "prismx-dev-secret-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    # 30 天；deps.get_current_user 在剩余不到一半（15 天）时通过
    # X-Refreshed-Token 自动续期，因此只要用户每 30 天内打开过一次就永不登出。
    #
    # 之所以是 30 天而不是更短：装成 PWA 的主屏应用会被手机系统冻结甚至杀掉
    # 进程，滑动续期依附在业务请求上，进程不跑就没有请求可搭。取值为 2 小时
    # 时，用户隔一晚再打开，回到前台的第一个请求（live.tsx 的账号轮询）必然
    # 401，client.ts 随即清掉 token、路由守卫弹回登录页——这正是"PWA 老是被
    # 登出"的来源。没有独立的 refresh token，能覆盖这段冻结期的只有访问
    # token 本身的有效期。
    #
    # 代价：token 一旦泄露（如 XSS 读取 localStorage），可用窗口同样变成
    # 30 天。目前唯一的撤销手段是改密码——见 security.create_access_token 的
    # "tv" 声明，它会让改密码前签发的所有 token 立即失效。
    #
    # 30 days; deps.get_current_user auto-renews via X-Refreshed-Token once
    # less than half the lifetime (15 days) remains, so a user who opens the
    # app at least once every 30 days is never logged out.
    #
    # Why 30 days and not something shorter: an installed PWA gets frozen or
    # outright killed by the phone's OS, and sliding renewal rides on business
    # requests — no process, no request to ride. At 2 hours, coming back the
    # next morning meant the first foreground request (live.tsx's account
    # poll) was guaranteed to 401, after which client.ts cleared the token and
    # the route guard bounced the user to the login page. That was the whole
    # "the PWA keeps logging me out" complaint. With no separate refresh
    # token, the access token's own lifetime is the only thing that can span
    # that frozen period.
    #
    # The cost: a leaked token (e.g. XSS reading localStorage) stays usable
    # for 30 days too. The only revocation path today is a password change —
    # see the "tv" claim in security.create_access_token, which invalidates
    # every token issued before it.
    JWT_EXPIRE_MINUTES: int = 60 * 24 * 30

    # Google 登录 / Google Sign-In：在 Google Cloud Console 创建的 OAuth Web Client ID。
    # 留空则关闭 Google 登录端点。 / OAuth Web Client ID from Google Cloud Console;
    # empty disables the Google login endpoint.
    GOOGLE_CLIENT_ID: str = ""

    # 限流 / Rate limiting（默认值，可用环境变量覆盖）。
    # Rate limits (defaults; overridable via env).
    # 限流计数的存储后端。留空 = 进程内内存，单实例部署适用。多实例部署必须指向
    # Redis（如 redis://127.0.0.1:6379/0），否则每个实例各算各的，限流被实例数
    # 等比稀释。/ Storage backend for rate-limit counters. Empty = in-process
    # memory (single instance only); multi-instance deployments must point this
    # at Redis or the effective limit is multiplied by the instance count.
    RATE_LIMIT_STORAGE_URI: str = ""
    RATE_LIMIT_LOGIN: str = "10/minute"
    RATE_LIMIT_REGISTER: str = "5/minute"
    RATE_LIMIT_GOOGLE: str = "10/minute"
    # 邀请链接点击打点限流：公开无鉴权端点，只挡病态刷量。点击数本就是参考值
    # （见 routers/invite.py 模型注释），真实指标是注册数。按客户端 IP 计。
    # Invite-click counter limit: public unauthenticated endpoint; only stops
    # pathological hammering. Clicks are indicative anyway — registrations are
    # the real number. Keyed by client IP.
    RATE_LIMIT_INVITE_CLICK: str = "30/minute"
    # 交易端点限流（下单/平仓/改单/撤单）。刻意设得很宽——每秒 2 笔，远超任何
    # 正常手动交易节奏，只拦住病态刷接口的行为，不影响真实用户。按客户端 IP 计。
    # Rate limit for trading endpoints (place/close/modify/cancel). Deliberately
    # generous — 2/sec, well above any real manual pace — so it only stops
    # pathological hammering without touching real users. Keyed by client IP.
    RATE_LIMIT_ORDER: str = "120/minute"
    # MT5 账号验证限流。这个端点与其它端点性质不同：它把用户提交的「账号+密码」
    # 转发给券商 Manager API 去验证，任何登录用户都能借此把平台当成对券商撞库的
    # 代理。此前它复用 RATE_LIMIT_ORDER 的 120/分钟——那是为下单节奏设的，用在这
    # 里等于每分钟 120 次免费的账号密码试探。绑定账号是低频动作（正常用户一辈子
    # 也就几次），所以设得很紧；配合 rate_limit 里按 login 的失败锁定，IP 与账号
    # 两个维度都堵住。按客户端 IP 计。
    # Rate limit for MT5 account verification. Unlike every other endpoint, this
    # one forwards the submitted login+password to the broker's Manager API, so
    # any logged-in user could use the platform as a brute-force proxy against
    # the broker. It previously reused RATE_LIMIT_ORDER (120/min), a figure meant
    # for trading pace — here that is 120 free credential guesses a minute.
    # Binding an account is rare, so this is tight; combined with the per-login
    # lockout in rate_limit.py it closes both the IP and the account dimension.
    RATE_LIMIT_GATEWAY_VERIFY: str = "6/minute"
    # 改密码/设置密码限流：已有密码时每次都要校验旧密码，若 token 泄露，攻击者
    # 可借此暴力猜旧密码——限流把这条路堵上。按客户端 IP 计。
    # Rate limit for change/set-password: with an existing password every call
    # verifies the old one, so a leaked token could be used to brute-force it —
    # this throttle closes that path. Keyed by client IP.
    RATE_LIMIT_PASSWORD: str = "10/minute"
    # 创建支付订单限流：每次都会真实调用一次 NOWPayments 接口并插一条 Payment
    # 记录，不限流则登录用户可反复刷、把第三方调用成本与数据库写入转嫁给我们。
    # 正常用户一分钟内不会创建很多支付单，设得足够宽。按客户端 IP 计。
    # Rate limit for creating a payment: each call hits NOWPayments for real and
    # inserts a Payment row, so without a limit a logged-in user could hammer it,
    # offloading third-party cost and DB writes onto us. Real users don't create
    # many payments per minute; kept generous. Keyed by client IP.
    RATE_LIMIT_PAYMENT: str = "5/minute"
    # 单用户未完成（PENDING/PROCESSING）支付订单上限：超过则先复用旧订单，
    # 避免刷接口在库里堆积大量悬而未决的支付记录。
    # Cap on a single user's unfinished (PENDING/PROCESSING) payments: beyond
    # this the user must reuse an existing one, so hammering can't pile up stale
    # pending rows.
    MAX_OPEN_PAYMENTS_PER_USER: int = 3

    # 策略回测限流：按用户维度（不是 IP），双窗口并存。回测是重 CPU 操作——单次
    # 请求要拉至多 5000 行、跑纯 Python 指标循环；按 IP 限流不足，同一用户换 IP
    # 即可绕过，而共享出口 IP 的多个用户又会互相挤占。短窗口挡突发，长窗口挡
    # 慢速持续消耗。
    # Strategy-backtest limits, keyed by user rather than IP, with two windows.
    # A backtest is CPU-heavy (up to 5000 rows and a pure-Python indicator loop
    # per request); IP keying is both bypassable by rotating IPs and unfair to
    # users behind a shared egress IP. The short window stops bursts, the long
    # one stops slow sustained draining.
    RATE_LIMIT_BACKTEST_SHORT: str = "6/minute"
    RATE_LIMIT_BACKTEST_LONG: str = "60/hour"
    # 策略写操作（创建/更新/删除信号）限流，同样按用户维度。
    # Strategy write endpoints (create/update/clear signals), also per user.
    RATE_LIMIT_STRATEGY_WRITE: str = "30/minute"
    # 游戏化 /me：每次请求都可能触发单人判定查询，限流兜底防刷。
    # Gamification /me: each hit can trigger a per-user judging pass; rate-limit
    # as a backstop against abuse.
    RATE_LIMIT_GAMIFICATION: str = "30/minute"
    # 排行榜查询：比 /me 更轻（无判定），但仍是需要打码/批量取用户的读查询。
    # Leaderboard reads: lighter than /me (no judging pass), but still a
    # masking + batch-user-load query worth a backstop.
    RATE_LIMIT_LEADERBOARD: str = "60/minute"
    # 比赛报名：写操作，节奏与其它写端点（策略/密码）同一量级。
    # Competition registration: a write endpoint, same order of magnitude as
    # the other write endpoints (strategy/password).
    RATE_LIMIT_COMPETITION: str = "30/minute"
    # 单次回测的成本上限：bars 数 × 规则条件数。纯速率限制无法阻止"一次请求就
    # 占满 CPU 很久"，这一层直接把单次请求的工作量封顶。默认 60000 = 5000 根 ×
    # 12 条，恰好容纳滥用上限下的最坏合法情况。
    # Per-request cost cap: bars x rule conditions. Rate limits alone can't stop
    # one request from saturating a core for a long time; this caps the work of a
    # single request. The default 60000 = 5000 bars x 12 conditions, exactly the
    # worst legitimate case allowed by the abuse limits.
    MAX_BACKTEST_COST_UNITS: int = 60_000
    # 回测结果缓存：同一 (AST, 品种, 周期, 天数, 成本版本) 的重复请求直接返回
    # 缓存。TTL 短，因为新 K 线会不断进来。
    # Backtest result cache: repeat requests for the same (AST, symbol,
    # interval, days, cost version) return the cached result. Short TTL, since
    # new bars keep arriving.
    BACKTEST_CACHE_TTL_SECONDS: int = 300
    BACKTEST_CACHE_MAX_ENTRIES: int = 64

    # 应用日志级别。排查后台循环时可临时设 DEBUG（会打出被过滤掉的成交诊断）。
    # App log level. Set to DEBUG temporarily when diagnosing background loops.
    LOG_LEVEL: str = "INFO"

    # 数据库 / Database（默认 SQLite，生产用环境变量 DATABASE_URL 覆盖为 Postgres）
    # Database (defaults to SQLite; override via DATABASE_URL env for Postgres in prod)
    DATABASE_URL: str = "sqlite:///./prismx.db"

    # 数据库连接池（仅 Postgres 生效；SQLite 忽略）。桥接高频轮询下，可用连接数
    # 直接决定并发上限。pool_size 是常驻连接，max_overflow 是峰值可临时新增的连接，
    # 二者之和 = 同时可用的最大连接数。务必与 Supabase Pooler 的 "Pool Size" 上限对齐，
    # 设得比 Pooler 上限还大不会有额外收益（会话模式下多出的连接只会排队）。
    # DB connection pool (Postgres only; ignored for SQLite). Under the bridge's
    # high-frequency polling, the number of usable connections is the direct cap
    # on concurrency. pool_size = persistent connections; max_overflow = extra
    # connections spun up at peak; their sum is the max concurrent connections.
    # Keep this aligned with Supabase Pooler's "Pool Size" — setting it larger
    # than the pooler's limit gains nothing (extra sessions just queue).
    DB_POOL_SIZE: int = 15
    DB_MAX_OVERFLOW: int = 15
    # 连接回收秒数：超过此空闲时长的连接下次使用前先重建，规避 Supabase Pooler
    # 主动断开空闲连接后拿到坏连接。/ recycle idle connections to avoid stale ones
    # dropped by the Supabase pooler.
    DB_POOL_RECYCLE: int = 1800

    # MT5 Gateway（C# 程序，直接通过 Manager API 操作 MT5，不需要 bridge 轮询）。
    # Make Capital 用户的订单会走这条通道。
    #
    # ⚠️ 生产环境 gateway 跑在**另一台 Windows VPS** 上，不是后端同机——
    # GATEWAY_URL 必须填那台 Windows VPS 的地址，而不是券商 MT5 服务器的地址
    # （这两个 IP 曾被搞混，排查了很久）。默认值只适用于本地开发。
    #
    # MT5 Gateway (C# app, talks to MT5 via Manager API directly — no bridge
    # needed). Make Capital users' orders are routed through this channel.
    # In production the gateway runs on a separate Windows VPS, so GATEWAY_URL
    # must point at that VPS — not at the broker's MT5 server. The default only
    # applies to local development.
    GATEWAY_URL: str = "http://127.0.0.1:8800"
    GATEWAY_TOKEN: str = ""

    # Gateway 下单时写入 MT5 comment 的前缀，必须与 gateway.ini 的
    # comment_prefix 一致。Manager API 的请求没有 magic 字段，只能靠 comment
    # 识别"哪些仓位是本平台开的"——平仓明细入库时据此过滤（见
    # routers/gateway.py 的 _save_closed_trades）。留空 = 不过滤（会把用户在
    # MT5 客户端自己开的仓位也记进来）。
    # Prefix written into the MT5 comment on gateway orders; must match
    # gateway.ini's comment_prefix. Manager API requests have no magic field, so
    # the comment is the only marker of platform-opened positions — used to
    # filter closed-trade recording. Empty = no filtering.
    GATEWAY_COMMENT_PREFIX: str = "PRISMX"

    # 反向代理信任列表：应用挂在同机 Nginx 反代后面，客户端真实 IP 在
    # X-Forwarded-For 头里。只有当直连对端（即 Nginx，本机 127.0.0.1）在此
    # 列表内时才采信该头，把 request.client.host 改写成真实客户端 IP——否则
    # slowapi 会把所有请求都算成 Nginx 的本机 IP，按 IP 的限流与按邮箱的登录
    # 锁定全部形同虚设（大家共用同一个桶）。列表外的对端一律不采信，攻击者
    # 直连或伪造 X-Forwarded-For 都无法借此绕过限流。设为 "*" 表示信任所有
    # 对端（仅当上游一定是可信代理时才用）；留空则彻底关闭该改写（回到只认
    # 直连 IP 的行为）。多个用逗号分隔。
    # Trusted reverse-proxy list: the app runs behind a same-host Nginx, so the
    # real client IP lives in X-Forwarded-For. Only when the immediate peer (the
    # local Nginx, 127.0.0.1) is in this list is that header honored to rewrite
    # request.client.host to the real client IP — otherwise slowapi keys every
    # request on Nginx's loopback IP, collapsing the per-IP rate limit and
    # per-email login lockout into one shared bucket. A peer not in the list is
    # never trusted, so a direct connection or a forged X-Forwarded-For can't use
    # this to dodge limits. "*" trusts every peer (only if the upstream is always
    # a trusted proxy); empty disables the rewrite entirely (back to the raw peer
    # IP). Comma-separated.
    TRUSTED_PROXY_IPS: str = "127.0.0.1"

    # 跨域 / CORS（本地开发 + 生产前端域名 / local dev + production frontend origins）
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://prismxsignallab.com",
        "https://www.prismxsignallab.com",
    ]
    # 额外放行的精确预览域名（如某个固定 Vercel 部署）。默认空；按需在 .env 配置。
    # 不再用通配正则放行所有 *.vercel.app，避免任意人部署前端即可携带凭证跨域。
    # Extra exact preview origins (e.g. a fixed Vercel deploy). Empty by default;
    # configure in .env as needed. We no longer allow all *.vercel.app via regex,
    # which would let anyone deploy a frontend and make credentialed cross-origin calls.
    CORS_ORIGIN_REGEX: str | None = None

    # 信号引擎 / Signal engine
    SIGNAL_INTERVAL_SECONDS: int = 15  # 信号生成节拍 / signal tick interval
    # 信号有效期（分钟）：webhook 信号超过此时长自动置为 EXPIRED。
    # Signal lifetime (minutes): webhook signals older than this become EXPIRED.
    SIGNAL_EXPIRE_MINUTES: int = 10
    # 是否启用内置模拟信号引擎（本地测试用，接入 TradingView 后设为 false）。
    # Enable the built-in mock signal engine (for local testing; set false once
    # TradingView webhooks feed real signals).
    ENABLE_MOCK_SIGNAL_ENGINE: bool = True

    # 信号胜负判定的"数据源中断"保险丝（天）：一个信号追踪不到任何行情更新超过
    # 这么久，就判定为 STALE（不计入胜率），纯粹是防御 TradingView/网络中断导致
    # 信号永远悬而未决，不是"信号最多追多久"的业务规则。
    # Safety-net timeout (days) for signal win/loss resolution: if a signal gets
    # zero price updates for this long, mark it STALE (excluded from win-rate
    # stats). This purely guards against a TradingView/network outage leaving
    # signals unresolved forever — it is not a business rule capping how long a
    # signal is allowed to run.
    #
    # 2026-08-07 从 10 天降到 5 天，动机是 Supabase Egress：这个值同时是
    # resolve_signals_with_price 的判定窗口（cutoff 已下推进 WHERE），而库里
    # 5327 条 PENDING 让那条查询成了最大的 Egress 单项（占 55%）。实测 7 天内
    # 3362 条、5 天约 2401 条，降到 5 天可去掉约 55% 的行。
    #
    # 5 而不是更小：它要能盖住"周五收盘 → 周一开盘"这段没有任何行情更新的空窗
    # （最长约 2.5 天），再留一倍余量给连休的长假。取 3 天会让"周五生成的信号在
    # 下周一之前"这种正常情形擦着边界，一旦碰上周一是假日就会把还在正常追踪的
    # 信号误判成 STALE。
    #
    # 注意这个常量同时被策略信号的清扫复用（strategy/resolution.py），改动会
    # 一并缩短策略信号的 STALE 窗口；两者共用一个口径是刻意的（平台胜率与策略
    # 胜率因此可直接对比），不要为了单独调一个而拆成两个值。
    #
    # Lowered from 10 to 5 days on 2026-08-07, driven by Supabase Egress: this
    # value doubles as resolve_signals_with_price's resolution window (the
    # cutoff is pushed into its WHERE clause), and the 5327 PENDING rows in the
    # database made that query the single largest Egress item (55%). Measured:
    # 3362 rows within 7 days, ~2401 within 5, so 5 days drops ~55% of them.
    #
    # 5 rather than lower: it has to span the Friday-close-to-Monday-open gap
    # with no price updates at all (~2.5 days), plus roughly the same again as
    # headroom for a long holiday weekend. At 3 days, a signal created Friday
    # would sit right on the boundary before Monday, and a Monday holiday would
    # flip still-tracking signals to STALE.
    #
    # Note this constant is also reused by the strategy-signal sweep
    # (strategy/resolution.py), so changing it shortens that window too. The
    # shared value is deliberate (it keeps platform and strategy win rates
    # directly comparable) — don't split it into two just to tune one side.
    SIGNAL_STALE_DAYS: int = 5

    # TradingView Webhook：警报推送时在 JSON body 内携带的密钥，服务器据此校验来源。
    # TradingView 的 webhook 不支持自定义请求头，故密钥放在 body 的 "secret" 字段。
    # 生产环境（ENV=production）必须设置为强随机值，留空将拒绝所有 webhook 请求。
    # TradingView webhook secret carried inside the JSON body (TradingView cannot
    # send custom headers). The server validates the "secret" field against this.
    # In production a strong random value is mandatory; empty rejects all webhooks.
    WEBHOOK_SECRET: str = ""

    # EA 行情鉴权：MT5 EA（ea/PRISMX_MarketFeed.mq5）用 X-EA-Token 头推送
    # K 线（/feed/candles）、报价（/feed/quotes）与多周期趋势（/webhook/trend，
    # 作为 WEBHOOK_SECRET 的替代校验值）。留空则拒绝所有 EA 写入（图表/报价/
    # 趋势将没有数据，不影响交易主链路），因此不像 JWT_SECRET/WEBHOOK_SECRET
    # 那样强制校验。
    # EA market-data auth: the MT5 EA (ea/PRISMX_MarketFeed.mq5) pushes candles
    # (/feed/candles), quotes (/feed/quotes) and multi-timeframe trend
    # (/webhook/trend, accepted as an alternate to WEBHOOK_SECRET) via the
    # X-EA-Token header. Empty rejects all EA writes (charts/quotes/trend show
    # no data, but the trading path is unaffected), so — unlike JWT_SECRET/
    # WEBHOOK_SECRET — this is not enforced as mandatory in production.
    EA_TOKEN: str = ""

    # NOWPayments 加密货币支付 / Crypto payment gateway
    # API Key + IPN Secret（IPN 密钥仅在 NOWPayments 后台生成时展示一次!!）
    # API Key + IPN Secret (IPN secret shown ONLY ONCE in the NOWPayments dashboard!)
    NOWPAYMENTS_API_KEY: str = ""
    NOWPAYMENTS_IPN_SECRET: str = ""
    # 是否使用 Sandbox 测试环境 / Whether to use the sandbox test environment
    NOWPAYMENTS_SANDBOX: bool = True
    # 本站基础 URL（用于构造 IPN 回调地址）/ site base URL (used to build IPN callback URL)
    SITE_BASE_URL: str = "https://prismxsignallab.com"
    # PRO 订阅价格不在这里：定价已迁到数据库，由管理后台维护，读取入口是
    # services/settings_store.get_pricing_settings()。此处曾有两个 PRO_*_PRICE_USD
    # 默认值，迁移后再没有任何代码读过它们——留着只会让人以为改这里能改价。
    # PRO pricing does not live here: it moved to the database and is edited from
    # the admin panel, read via services/settings_store.get_pricing_settings().
    # Two PRO_*_PRICE_USD defaults sat here after that migration with no reader
    # left, which only invited someone to "change the price" in the wrong place.

    # 风控 / Risk control
    MAX_VOLUME_PER_ORDER: float = 10.0  # 单笔最大手数 / max lots per order
    MIN_VOLUME_PER_ORDER: float = 0.01  # 单笔最小手数 / min lots per order
    # 按账户净值粗估的手数上限：每手所需净值（账户币种）。净值/该值 = 允许的最大手数。
    # Rough equity-based lot cap: required equity per lot (account currency).
    EQUITY_PER_LOT: float = 200.0

    # 在线判定窗口不在这里：唯一生效的阈值是 services/deps.py 的 ONLINE_WINDOW，
    # 它的取值直接绑着 bridge 1.5 秒的轮询周期（留 3 个周期容错），改这里改不动它。
    # 此处曾有一个 EA_OFFLINE_TIMEOUT_SECONDS = 30 无人读取，数值还和真正生效的 7
    # 对不上——两个数、一个假的，只会误导排障的人。
    # The liveness threshold does not live here: the only one in effect is
    # ONLINE_WINDOW in services/deps.py, whose value is tied to bridge's 1.5s
    # poll (three missed cycles of slack). An unread EA_OFFLINE_TIMEOUT_SECONDS =
    # 30 used to sit here, disagreeing with the 7 actually in force — two numbers,
    # one of them fiction, is worse for whoever is debugging than none.

    # Web Push / VAPID：私钥以 urlsafe-base64 编码的 DER（PKCS8）存储，直接交给
    # pywebpush（py_vapid 的 from_string 走 urlsafe-base64 解码，不能用标准 PEM）。
    # 旧字段 VAPID_PRIVATE_KEY_B64（标准 base64 PEM）仍保留作兼容，但 from_der 会解析失败，
    # 故优先使用 VAPID_PRIVATE_KEY_DER。公钥与 subject 用于推送订阅。
    # VAPID: private key stored as urlsafe-base64-encoded DER (PKCS8) and passed
    # straight to pywebpush (py_vapid.from_string decodes via urlsafe-base64, so a
    # standard PEM does not work). Public key and subject are used for push.
    # 允许作为推送订阅 endpoint 的主机后缀（逗号分隔）。服务端会主动向订阅
    # endpoint 发起 HTTP 请求，而该地址来自客户端上报——不限制就等于开放一个
    # 服务端代发请求的入口（SSRF）。这里列的是各浏览器厂商的推送服务域：
    # FCM（Chrome/Edge/Opera 等 Chromium 系）、Mozilla（Firefox）、
    # Apple（Safari/iOS）、Windows 通知服务（旧版 Edge）。
    # Host suffixes accepted as push-subscription endpoints (comma-separated).
    # The server issues HTTP requests to the endpoint, and the endpoint comes
    # from the client — unrestricted, that is an open server-side request relay
    # (SSRF). These are the browser vendors' push services: FCM (Chromium-based
    # browsers), Mozilla (Firefox), Apple (Safari/iOS), WNS (legacy Edge).
    PUSH_ENDPOINT_HOST_SUFFIXES: str = (
        "fcm.googleapis.com,"
        "android.googleapis.com,"
        "updates.push.services.mozilla.com,"
        "web.push.apple.com,"
        "notify.windows.com"
    )

    VAPID_PRIVATE_KEY_DER: str = ""
    VAPID_PRIVATE_KEY_B64: str = ""
    VAPID_PUBLIC_KEY: str = ""
    VAPID_SUBJECT: str = "mailto:admin@prismxsignallab.com"

    @property
    def vapid_private_key(self) -> str:
        """返回可直接传给 pywebpush 的私钥（urlsafe-base64 的 PKCS8 DER）。
        两个配置字段任填其一都可用，格式不对也会被就地转换。

        这里必须做归一化，而不是把配的值原样返回：pywebpush 内部走
        py_vapid.Vapid.from_string，而它只尝试 RAW 与 DER 两种解析，从不尝试
        PEM。于是只配了 VAPID_PRIVATE_KEY_B64（base64 包着的 PEM 文本，本项目
        早期的格式）时，签名阶段就抛 ValueError："Could not deserialize key
        data ... ASN.1 parsing error"。这个异常发生在 webpush() 之前，不是
        WebPushException，push_dispatch 里按订阅的错误处理根本接不到它，只会被
        最外层的 except Exception 兜住写一行日志——表现为安卓与 iOS 一条通知都
        收不到，而接口全部返回成功、测试全绿（测试把 webpush 整个 mock 掉了，
        真实签名路径从未被执行）。排查成本极高，所以在配置层一次性消化掉。

        Return a private key pywebpush can actually use (urlsafe-base64 PKCS8
        DER). Either config field works, and a wrong-format value is converted
        in place.

        Normalizing here rather than returning the configured value as-is is
        required: pywebpush goes through py_vapid.Vapid.from_string, which only
        ever attempts RAW and DER parsing and never PEM. So configuring only
        VAPID_PRIVATE_KEY_B64 (base64-wrapped PEM text, this project's earlier
        format) raises ValueError at signing time: "Could not deserialize key
        data ... ASN.1 parsing error". That happens before webpush() and isn't
        a WebPushException, so push_dispatch's per-subscription error handling
        never sees it — only the outermost except Exception logs a line. The
        symptom is zero notifications on both Android and iOS while every
        endpoint reports success and the suite stays green (the tests mock
        webpush wholesale, so the real signing path is never exercised). That
        is expensive to diagnose, hence absorbing it once, here.
        """
        raw = (self.VAPID_PRIVATE_KEY_DER or self.VAPID_PRIVATE_KEY_B64 or "").strip()
        if not raw:
            return ""
        return _normalize_vapid_private_key(raw)

    @property
    def vapid_private_key_pem(self) -> str:
        """将 base64 编码的私钥解码为 PEM 文本（旧配置）。/ Decode legacy base64 PEM."""
        import base64
        if not self.VAPID_PRIVATE_KEY_B64:
            return ""
        return base64.b64decode(self.VAPID_PRIVATE_KEY_B64).decode("utf-8")

    # 订单回执超时（秒）：已下发但超时未回执的订单，允许重新下发。
    # Order ack timeout (seconds): delivered-but-unacked orders may be re-delivered.
    ORDER_ACK_TIMEOUT_SECONDS: int = 60

    # 订单待执行超时（秒）：落库后超过此时长仍未执行的 PENDING 指令自动作废为
    # FAILED，防止桥接离线期间的陈旧指令在很久之后按过时价格成交。
    # Pending-order timeout (seconds): PENDING commands not executed within this
    # window are voided to FAILED, so a stale command can't fill at an outdated
    # price after the bridge comes back online much later.
    ORDER_PENDING_TIMEOUT_SECONDS: int = 300

    # ---- 图片上传 / Image uploads（Supabase Storage）----
    # 只用于管理员上传策略介绍配图，走后端代理：浏览器只把文件交给自家后端，
    # service_role key 永不下发到前端。三项留空 = 上传功能关闭（端点返回 503），
    # 管理员仍可手填外链图片 URL。
    # Admin-only uploads for strategy illustrations, proxied through the backend:
    # the browser hands the file to our own API and the service_role key never
    # reaches the frontend. Leaving these empty disables uploading (the endpoint
    # returns 503); admins can still paste an external image URL.
    SUPABASE_URL: str = ""
    # service_role key。必须只存在于后端 .env——它能绕过所有 RLS 策略。
    # service_role key. Must live only in the backend .env: it bypasses every RLS policy.
    SUPABASE_SERVICE_KEY: str = ""
    # 存储桶名。需要在 Supabase 控制台建为 public 桶，否则返回的公开 URL 打不开。
    # Bucket name. Create it as a public bucket in the Supabase dashboard, or the
    # returned public URL won't load.
    SUPABASE_STORAGE_BUCKET: str = "strategy-images"
    # 单张图片大小上限（字节）。默认 4MB：策略配图是页面插图，不需要原图画质，
    # 而后端要把整个文件读进内存再转发，上限过大会让并发上传吃掉内存。
    # Per-image size cap in bytes. Default 4MB: these are page illustrations, not
    # originals, and the backend buffers the whole file in memory before
    # forwarding — a high cap would let concurrent uploads eat RAM.
    UPLOAD_MAX_BYTES: int = 4 * 1024 * 1024

    # pydantic-settings v2 写法；语义与旧的 `class Config` 完全一致（含默认
    # extra="forbid"——.env 里多一个未知键仍会拒绝启动，运维踩坑 #24 那条不变）。
    # pydantic-settings v2 form; identical semantics to the old inner Config class,
    # including the default extra="forbid" (an unknown .env key still refuses to start).
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()

# 安全校验：生产环境（ENV=production）必须配置自定义强随机 JWT_SECRET，
# 否则用默认弱密钥签发的 token 可被任意伪造（等同认证绕过）。
# 不再以数据库类型推断是否为生产，避免「生产仍用 SQLite」时漏判。
# Safety check: in production (ENV=production) a custom strong JWT_SECRET is
# mandatory; otherwise tokens signed with the default weak key are forgeable
# (equivalent to auth bypass). We no longer infer "production" from the DB type.
_DEFAULT_JWT_SECRET = "prismx-dev-secret-change-in-production"
if settings.ENV.lower() == "production" and settings.JWT_SECRET == _DEFAULT_JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET 仍为默认值，生产环境（ENV=production）必须在 .env 中设置强随机密钥。"
        " / JWT_SECRET is still the default; set a strong random secret in .env when ENV=production."
    )

# Webhook 密钥校验：生产环境必须配置，否则 TradingView 信号来源无法验证，
# 任何人猜到接口地址即可伪造信号。/ Webhook secret is mandatory in production;
# without it webhook signals are unauthenticated and forgeable.
if settings.ENV.lower() == "production" and not settings.WEBHOOK_SECRET:
    raise RuntimeError(
        "WEBHOOK_SECRET 未设置，生产环境（ENV=production）必须在 .env 中配置强随机密钥。"
        " / WEBHOOK_SECRET is empty; set a strong random secret in .env when ENV=production."
    )

# 模拟信号引擎：本地测试用的随机游走假信号会像真信号一样推给 PRO 用户、可被
# 一键下单到真实 MT5 账户。生产环境（ENV=production）必须显式关闭，否则漏配
# 一行 .env 就会让用户照着随机数下真单——与 JWT_SECRET/WEBHOOK_SECRET 同等
# 危险，故同样在启动时硬性拒绝，绝不放行"默认开着"。
# Mock signal engine: its random-walk fake signals are pushed to PRO users just
# like real ones and can be one-click-traded into a live MT5 account. It must be
# explicitly disabled in production (ENV=production); otherwise a single missing
# .env line has users trading real money off random numbers — as dangerous as a
# default JWT_SECRET/WEBHOOK_SECRET, so it's refused at startup the same way
# rather than silently left on.
if settings.ENV.lower() == "production" and settings.ENABLE_MOCK_SIGNAL_ENGINE:
    raise RuntimeError(
        "ENABLE_MOCK_SIGNAL_ENGINE 仍为开启，生产环境（ENV=production）必须在 .env 中设为 false，"
        "否则会向用户推送随机生成的假信号。"
        " / ENABLE_MOCK_SIGNAL_ENGINE is on; set it to false in .env when ENV=production,"
        " or users will be shown randomly-generated fake signals."
    )

# 支付沙盒：沙盒模式打到 NOWPayments 测试域名，且创建支付时自动带 case=success
# 模拟"支付成功"（见 services/nowpayments.py）。生产环境若忘了关，真实付款无法
# 到账、测试流程还可能把人误升成 PRO。生产强制要求关闭。
# Payment sandbox: sandbox mode targets NOWPayments' test host and auto-sends
# case=success to simulate a successful payment (see services/nowpayments.py).
# Left on in production, real payments never settle and the test flow can wrongly
# upgrade users to PRO. Mandatory to disable in production.
if settings.ENV.lower() == "production" and settings.NOWPAYMENTS_SANDBOX:
    raise RuntimeError(
        "NOWPAYMENTS_SANDBOX 仍为开启，生产环境（ENV=production）必须在 .env 中设为 false，"
        "否则支付走的是沙盒测试环境。"
        " / NOWPAYMENTS_SANDBOX is on; set it to false in .env when ENV=production,"
        " or payments run against the sandbox test environment."
    )


# ---------------------------------------------------------------------------
# 多进程部署与进程内状态的冲突 / multi-process deployment vs in-process state
# ---------------------------------------------------------------------------

def detect_worker_count(argv: list[str], env: dict) -> int | None:
    """从启动命令与环境变量里读出 worker 数；读不出来返回 None。

    只认三种明确写法：uvicorn/gunicorn 的 `--workers N`、`--workers=N`、`-w N`，
    以及 uvicorn 与 gunicorn 都认的 WEB_CONCURRENCY。刻意不去猜——例如靠
    os.getppid() 判断"是不是子进程"，systemd 与 Docker 下同样成立，会把单 worker
    的正常部署误判成多进程而拒绝启动。宁可返回 None（判不出来就不拦），也不能让
    一个猜测把线上服务拦在门外。

    Read the worker count from the launch command and environment; None when it
    can't be told. Only three explicit forms are recognised: uvicorn/gunicorn's
    `--workers N`, `--workers=N`, `-w N`, plus WEB_CONCURRENCY, which both honour.
    Guessing is deliberately avoided — inferring "am I a child process" from
    os.getppid() is equally true under systemd and Docker and would refuse to
    start a perfectly normal single-worker deployment. Returning None (can't
    tell, so don't block) is always preferable to a guess that locks the service
    out.
    """
    for i, arg in enumerate(argv):
        if arg.startswith("--workers="):
            try:
                return int(arg.split("=", 1)[1])
            except ValueError:
                continue
        if arg in ("--workers", "-w") and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                continue
    raw = (env.get("WEB_CONCURRENCY") or "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            return None
    return None


# 限流、登录锁定、MT5 验证锁定、回测并发闸门与回测缓存全部是进程内状态
# （core/rate_limit.py 的 _failures、core/strategy_limits.py 的 _running 与
# _cache，以及 slowapi 在 RATE_LIMIT_STORAGE_URI 为空时的内存计数）。多开一个
# worker，这些防护就各自独立计数：配置成 8 次/5 分钟的登录失败锁定，在 4 个
# worker 下实际要打满 32 次才锁——而且不会报错、不会有日志，防护静默减半到某个
# 分数，没有任何人会发现。
#
# 所以在能明确读出「多 worker + 进程内计数」这个组合时直接拒绝启动。判不出来
# （detect_worker_count 返回 None）一律放行：这条检查的意义是把静默降级换成当场
# 说话，不是替不确定的情况做决定。
#
# Rate limits, the login lockout, the MT5-verify lockout, the backtest
# concurrency gate and the backtest cache are all in-process state
# (_failures in core/rate_limit.py, _running and _cache in
# core/strategy_limits.py, and slowapi's in-memory counters when
# RATE_LIMIT_STORAGE_URI is empty). Add a worker and each of these counts
# independently: a lockout configured as 8 failures per 5 minutes really takes 32
# across 4 workers — with no error and nothing logged, the protection silently
# divides by the worker count and no one finds out.
#
# So startup is refused when "multiple workers + in-process counters" can be read
# off positively. An indeterminate reading (detect_worker_count returns None)
# always passes: the point of this check is to turn a silent degradation into a
# loud one, not to decide on the ambiguous cases.
_WORKER_COUNT = detect_worker_count(sys.argv, os.environ)

if (
    settings.ENV.lower() == "production"
    and _WORKER_COUNT is not None
    and _WORKER_COUNT > 1
    and not settings.RATE_LIMIT_STORAGE_URI.strip()
):
    raise RuntimeError(
        f"检测到 {_WORKER_COUNT} 个 worker，但 RATE_LIMIT_STORAGE_URI 为空——限流与登录锁定"
        "是进程内计数，多进程下每个 worker 各算各的，防护会静默除以 worker 数。"
        "请改回单 worker，或配置 RATE_LIMIT_STORAGE_URI 指向 Redis。"
        "注意：即便配了 Redis，登录/MT5 验证的失败锁定与回测并发闸门仍是进程内状态"
        "（见 core/rate_limit.py 与 core/strategy_limits.py），需要一并迁移才算真正支持多进程。"
        f" / Detected {_WORKER_COUNT} workers with an empty RATE_LIMIT_STORAGE_URI: rate limits"
        " and the login lockout are per-process counters, so each worker counts separately and"
        " every protection silently divides by the worker count. Go back to a single worker, or"
        " point RATE_LIMIT_STORAGE_URI at Redis. Note that even with Redis the login/MT5-verify"
        " lockouts and the backtest gate remain in-process (see core/rate_limit.py and"
        " core/strategy_limits.py) and must be migrated too before multi-process is truly supported."
    )
