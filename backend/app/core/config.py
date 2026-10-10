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
    # 跨进程共享状态的 Redis（如 redis://127.0.0.1:6379/0）。留空 = 单 worker，全部
    # 状态在进程内存里，行为与从前完全一致。配上之后：限流计数、登录 / MT5 验证
    # 锁定、回测并发闸门、/me 判定节流、后台循环只由一个 worker 跑（其余待命）、
    # WebSocket 推送跨 worker 转发、EA 喂进来的报价与 K 线——全部走 Redis，这时才
    # 可以开多个 worker（见 services/shared_state.py）。RATE_LIMIT_STORAGE_URI 单独
    # 配也行（老写法，只管 slowapi），两者都配以 REDIS_URL 为准。
    # Redis for cross-process shared state. Empty = single worker, everything
    # in-process exactly as before. Set it and rate limits, lockouts, the backtest
    # gate, the /me throttle, background-loop leadership, WebSocket fan-out and the
    # EA market stores all go through Redis — only then may several workers run
    # (see services/shared_state.py). RATE_LIMIT_STORAGE_URI alone still works for
    # slowapi only; REDIS_URL wins when both are set.
    REDIS_URL: str = ""
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
    # 找回密码比改密码严得多：这个端点匿名、会往用户邮箱发信，放宽等于把平台
    # 变成一个免费的邮件轰炸器（受害者是那个真实邮箱的主人，不是攻击者）。
    # Much stricter than changing a password: this endpoint is anonymous and
    # sends mail to a third party, so a loose limit turns the platform into a
    # free mail bomber aimed at whoever actually owns that address.
    RATE_LIMIT_PASSWORD_RESET: str = "3/minute"
    # 点验证链接：匿名端点，但令牌 256 位熵、猜不中，限流只为挡脚本刷库。比找回
    # 密码宽，因为邮件网关预抓取 + 用户再点一次就是两次请求。
    # Clicking the verification link: anonymous, but the token is unguessable;
    # the limit only stops scripted hammering. Looser than reset because a mail
    # gateway's prefetch plus the user's own click is already two requests.
    RATE_LIMIT_VERIFY_EMAIL: str = "10/minute"
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
    # 公开比赛页（未登录可读，设计 §3.1）：featured 与详情两个 GET 共用一个按 IP 的
    # 计数（shared_limit scope="comp-public"）。详情有 20 秒共享缓存，这个数字只挡
    # 病态刷量；放宽到 300 是因为广告落地时同一出口 IP（公司网、运营商 NAT）后面可能
    # 有很多真人。
    # Public competition pages (readable without login, design §3.1): featured and
    # detail share one per-IP counter (shared_limit scope="comp-public"). Detail is
    # cached for 20s, so this only stops pathological hammering; 300 because an ad
    # landing can put many real people behind one egress IP (office, carrier NAT).
    RATE_LIMIT_COMPETITION_PUBLIC: str = "300/minute"
    # 游客预览（未登录首页的带锁仪表盘）：两个 GET 共用一个按 IP 的计数。页面每 4 秒轮询
    # 一次（每人约 15 次 / 分钟），快照有 3 秒共享缓存，回源量与访客数无关；600 留给同一
    # 出口 IP 后面的几十个真人（广告落地、公司网、运营商 NAT）。
    # Guest preview (the locked logged-out dashboard): both GETs share one per-IP counter.
    # The page polls every 4s (~15/min per visitor) against a 3s shared cache, so origin load
    # doesn't grow with visitors; 600 leaves room for dozens of people behind one egress IP.
    RATE_LIMIT_GUEST_PREVIEW: str = "600/minute"
    # 工单图片上传：按用户。任何注册用户都能调这个端点往存储桶里写文件，日上限是为了
    # 别让一个账号把桶当网盘；正常提工单一天传不到十几张。
    # Ticket image uploads, per user. Any registered user can write to the bucket
    # through this endpoint; the daily cap keeps one account from treating it as free
    # file storage. Real tickets need a dozen images a day at most.
    RATE_LIMIT_TICKET_UPLOAD: str = "10/minute;60/day"
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

    # 看板统计切"天"的时区。后台人员在北京时间看数据，"今天"不该从早上 8 点开始。
    # 只在 services/stats_time.py 读取；其它地方一律用那里的 local_day()/today()。
    # Timezone for day bucketing on the admin dashboard. Read only by
    # services/stats_time.py; everything else goes through its helpers.
    STATS_TZ: str = "Asia/Shanghai"

    # 数据库 / Database（默认 SQLite，生产用环境变量 DATABASE_URL 覆盖为 Postgres）
    # Database (defaults to SQLite; override via DATABASE_URL env for Postgres in prod)
    DATABASE_URL: str = "sqlite:///./prismx.db"

    # 数据库连接池（仅 Postgres 生效；SQLite 忽略）。桥接高频轮询下，可用连接数
    # 直接决定并发上限。pool_size 是常驻连接，max_overflow 是峰值可临时新增的连接，
    # 二者之和 = 同时可用的最大连接数。这是**每个 worker 进程**的值：总连接数 =
    # (pool_size + max_overflow) × worker 数，必须低于 Supabase Session Pooler 的
    # "Pool Size"（当前 30）并给后台脚本、管理面板留余量。超出时多出的连接不是排队，
    # 而是在 Pooler 那边直接报错；池子小一点，请求只在本进程里排队几毫秒。
    # 生产 2 个 worker × (8 + 4) = 24 ≤ 30。加 worker 或换 Supabase 档位时同步调整。
    # DB connection pool (Postgres only; ignored for SQLite). pool_size = persistent
    # connections; max_overflow = extra connections at peak. These are PER WORKER:
    # total = (pool_size + max_overflow) × workers, which must stay below Supabase's
    # Session Pooler "Pool Size" (30 today) with headroom for scripts and the
    # dashboard. Past that limit the pooler rejects connections outright, whereas a
    # smaller local pool just queues requests for a few milliseconds.
    # Production: 2 workers × (8 + 4) = 24 ≤ 30. Revisit when adding workers or
    # changing the Supabase tier.
    DB_POOL_SIZE: int = 8
    DB_MAX_OVERFLOW: int = 4
    # 连接回收秒数：超过此空闲时长的连接下次使用前先重建，规避 Supabase Pooler
    # 主动断开空闲连接后拿到坏连接。/ recycle idle connections to avoid stale ones
    # dropped by the Supabase pooler.
    DB_POOL_RECYCLE: int = 1800
    # 取连接的最长等待秒数（默认 SQLAlchemy 是 30，恰与前端 30 秒请求超时同时到期）。
    # 库一慢，256 条同步线程会各在 pool.connect() 上挂 30 秒、整站卡半分钟后一片 500；
    # 改成 8 秒快速失败（main.py 把 TimeoutError 转成 503 + Retry-After），少数请求
    # 尽早失败，堆积的请求就少了 3/4。Supabase 跨区 pre_ping 重连本身可能占 1~2 秒，
    # 所以不取更小。
    # Max seconds to wait for a pooled connection (SQLAlchemy's default of 30 expires
    # together with the frontend's 30s request timeout). When the DB slows down, up to
    # 244 sync threads would each park 30s in pool.connect(); failing at 8s (main.py maps
    # the TimeoutError to 503 + Retry-After) sheds load early. Not lower: a cross-region
    # Supabase pre_ping reconnect can itself take 1-2s.
    DB_POOL_TIMEOUT: int = 8
    # 取连接前的探活（SELECT 1）只对空闲超过这么多秒的连接做（core/database.py 的
    # _ping_if_idle）。以前每次取连接都探一次：生产库在 3.7 ms 之外，等于每个请求多一个往返、
    # 多占一会儿连接，Supabase 那边多一条查询；忙的时候连接刚还回来就又被取走，探了也白探。
    # 闲置的连接照旧先探活再用（Pooler 断掉的空闲连接靠的就是这一步）。0 = 每次都探（旧行为）。
    # Ping (SELECT 1) only connections idle longer than this before handing them out
    # (core/database.py _ping_if_idle). Pinging on every checkout cost every request an extra
    # round trip to a database 3.7 ms away; a connection checked in a moment ago is alive.
    # Idle connections are still pinged first. 0 = ping on every checkout (old behaviour).
    DB_PING_IDLE_SECONDS: float = 10.0

    # 入口排队（core/admission.py）：每个 worker 同时在处理的 HTTP 请求数上限，超出的在
    # 门口排队——排队不占线程、不占数据库连接。2026-10-10 压测：过载时几百个请求同时挤进
    # 线程池去抢 12 条连接，等满 DB_POOL_TIMEOUT 一片 503，负载撤掉后后端还卡了一分多钟、
    # 最后被看门狗重启。在门口排，里面的请求就始终够快，排太久的直接回 503，不会堆积。
    # 正常负载下永远排不满，用户无感。ADMISSION_ENABLED=false 整个关掉（与改动前完全一致）。
    # Front-door admission (core/admission.py): per-worker cap on HTTP requests in flight;
    # the rest wait at the door, holding no thread and no DB connection. In the 2026-10-10
    # load test hundreds of requests piled into the thread pool for 12 connections, timed
    # out in a wave of 503s, and the backend stayed wedged for a minute after the load
    # stopped until the watchdog restarted it. Never reached at normal load.
    ADMISSION_ENABLED: bool = True
    HTTP_MAX_INFLIGHT: int = 96
    # 普通请求在门口最多等多久（秒），到点回 503 + Retry-After。前端请求超时是 30 秒。
    # How long an ordinary request may wait at the door before a 503 (the frontend times out at 30s).
    HTTP_QUEUE_TIMEOUT: float = 8.0
    # 交易指令单独一条道：同时最多这么多笔在处理（一笔约 0.2 秒，其中大半在等券商，所以
    # 48 笔的吞吐远高于 CPU 能处理的量），排不上的最多等 ORDER_QUEUE_TIMEOUT 秒，到点回
    # 503「指令未发出」——此时什么都没执行，用户可以放心重下。时限取得短：前端整笔交易只等
    # 160 秒（client.ts 的 TRADE_TIMEOUT_MS，按网关最坏 140 秒定的），排队不能把它吃掉；
    # 而且行情快的时候，早点告诉用户「没发出去」比让他干等更有用。
    # Trading commands get their own lane: at most this many in flight (each ~0.2s, mostly
    # waiting on the broker, so 48 far exceeds what the CPU can feed). A command that cannot
    # get a slot within ORDER_QUEUE_TIMEOUT gets a 503 "not sent" — nothing ran, safe to retry.
    # Kept short: the frontend waits 160s for a whole trade (TRADE_TIMEOUT_MS, sized for the
    # gateway's 140s worst case), and in a fast market "not sent" early beats a long wait.
    ORDER_MAX_INFLIGHT: int = 48
    ORDER_QUEUE_TIMEOUT: float = 6.0

    # MT5 Gateway（C# 程序，直接通过 Manager API 操作 MT5，不需要 bridge 轮询）。
    # Make Capital 用户的订单会走这条通道。
    #
    # ⚠️ 生产环境 gateway 跑在**另一台 Windows VPS** 上，不是后端同机——
    # GATEWAY_URL 必须填那台 Windows VPS 的地址，而不是券商 MT5 服务器的地址
    # （这两个 IP 曾被搞混，排查了很久）。默认值只适用于本地开发。
    # 走 WireGuard 隧道后填隧道内网地址 http://10.66.0.2:8800（见 gateway/WIREGUARD.md；
    # 2026-09-06 起生产就是这个），公网 8800 由云安全组封死。
    #
    # MT5 Gateway (C# app, talks to MT5 via Manager API directly — no bridge
    # needed). Make Capital users' orders are routed through this channel.
    # In production the gateway runs on a separate Windows VPS, so GATEWAY_URL
    # must point at that VPS — not at the broker's MT5 server. The default only
    # applies to local development. Over WireGuard this is the tunnel address
    # http://10.66.0.2:8800 (see gateway/WIREGUARD.md; production since 2026-09-06);
    # the cloud security group keeps port 8800 closed to the internet.
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

    # ---------- 邮件发送（Resend）/ outbound email (Resend) ----------
    #
    # 走 Resend 的 HTTP API，不引入任何新依赖——发信用的是仓库里已有的 httpx。
    # 这不是偏好问题：这个项目的部署流程是服务器上 git pull + 重启，新增 pip
    # 依赖会让某次部署在装包那步静默起不来（见《运维手册》）。
    #
    # Sent through Resend's HTTP API using the httpx already in the tree — no new
    # pip dependency, because the deploy flow is git pull + restart on the server
    # and a new requirement would silently break a deploy at the install step.
    RESEND_API_KEY: str = ""
    # 发信地址必须属于已在 Resend 验证过 DNS（SPF/DKIM）的域名，否则对方直接拒收。
    # The From address must be on a domain verified in Resend, or it bounces.
    MAIL_FROM: str = "noreply@prismxsignallab.com"
    MAIL_FROM_NAME: str = "PRISMX Signal Lab"
    # 邮件里那条链接指向的站点。**永远是网站，不是 App** —— 安卓 App 的 WebView
    # origin 是 https://localhost，写进邮件谁都打不开。
    # Where the emailed link points. Always the website: the Android WebView's
    # origin is https://localhost, which is meaningless in an email.
    PUBLIC_WEB_URL: str = "https://prismxsignallab.com"

    # 本地开发时把重置链接打进日志，省去配发信商。**默认关闭，且必须在 .env 里
    # 显式打开**——打开后任何拿到日志的人都能改任意账号的密码，生产绝不能开。
    # Logs the reset link instead of needing a mail provider, for local dev only.
    # Off by default and must be switched on explicitly: with it on, anyone who
    # can read the logs can reset any account.
    MAIL_DEBUG_LOG_LINKS: bool = False

    # 找回密码链接的有效期。短到让邮箱被短暂窥视的窗口不够用，长到用户从手机
    # 切到电脑再点开还来得及。
    # Reset-link lifetime: short enough that a brief peek at someone's inbox
    # isn't enough, long enough to switch from phone to desktop and click it.
    PASSWORD_RESET_TTL_MINUTES: int = 30

    # 注册验证邮件链接的有效期。比找回密码长得多：这个链接只证明「这个邮箱收得到
    # 信」，被别人点了也只是替你把邮箱验证掉，拿不到账号；而国内邮箱对境外发信
    # 常延迟、进垃圾箱，用户隔天才翻到很正常。过期了登录后点「重新发送」即可。
    # Lifetime of the sign-up verification link. Much longer than a reset link:
    # this one only proves the mailbox receives mail — someone else clicking it
    # merely verifies your address for you and grants no access — and mail from
    # overseas often lands late or in spam at Chinese providers.
    EMAIL_VERIFY_TTL_HOURS: int = 48

    # 群发邮件里退订链接指向的 API 地址（退订页由后端直接出 HTML，不经过前端）。
    # The API origin used for unsubscribe links in broadcasts; the unsubscribe
    # page is plain HTML served by the backend, not a frontend route.
    PUBLIC_API_URL: str = "https://api.prismxsignallab.com"

    # 群发每天（UTC 日）最多发多少封；0 = 不限。到了上限当天暂停、第二天自动接着发。
    # 2026-10-01 起账号是 Resend Pro：每月 5 万封、不限每天。1500 × 30 = 4.5 万，
    # 每月留出约 5000 封给找回密码——群发把月额度用光，忘了密码的人就收不到重置邮件。
    # 换套餐时按「月额度 ÷ 30 再留一成」重算。
    # Daily (UTC) cap on broadcast sends; 0 = unlimited. Hitting it pauses until the
    # next day. On Resend Pro (50k/month, no daily limit) since 2026-10-01: 1500 × 30
    # = 45k, leaving ~5k a month for password resets.
    BROADCAST_EMAIL_DAILY_CAP: int = 1500
    # 两封群发之间的间隔（秒）。Resend 默认限速每个团队每秒 10 次请求，且与找回密码
    # 共用；0.25 秒 = 每秒 4 次，给找回密码留足余量。1500 封约 6 分钟发完。
    # Gap between two broadcast sends. Resend allows 10 req/s per team, shared with
    # password resets; 0.25s (4/s) leaves them plenty of headroom.
    BROADCAST_EMAIL_INTERVAL_SECONDS: float = 0.25

    # 跨域 / CORS（本地开发 + 生产前端域名 / local dev + production frontend origins）
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://prismxsignallab.com",
        "https://www.prismxsignallab.com",
        # 备用域名（主域名在大陆被封时用），经香港边缘节点转发，见 ops/hk-edge。
        # Backup domain (for when the main one is blocked in mainland China), served via the HK edge.
        "https://pmxsl.com",
        "https://www.pmxsl.com",
        # Android App（Capacitor WebView）的页面 origin。App 出厂自带完整前端，
        # 不是加载线上网站，所以它对后端而言是一个独立的跨域来源；不放行则 App 内
        # 所有接口调用都会被 CORS 拦下。鉴权走 Bearer 头而非 cookie，放行不引入
        # 凭证跨域风险。
        # Origin of the Android app's Capacitor WebView. The app ships its own
        # frontend rather than loading the website, so to the backend it is a
        # distinct cross-origin caller; without this every API call from the app
        # is blocked by CORS. Auth is a Bearer header, not a cookie, so allowing
        # it adds no credentialed-cross-origin exposure.
        "https://localhost",
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
    # 它的取值直接绑着 bridge 的心跳周期（留 3 个周期容错），改这里改不动它。
    # 此处曾有一个 EA_OFFLINE_TIMEOUT_SECONDS = 30 无人读取，数值还和真正生效的 10
    # 对不上——两个数、一个假的，只会误导排障的人。
    # The liveness threshold does not live here: the only one in effect is
    # ONLINE_WINDOW in services/deps.py, whose value is tied to bridge's ~3s
    # heartbeat (three missed cycles of slack). An unread EA_OFFLINE_TIMEOUT_SECONDS =
    # 30 used to sit here, disagreeing with the 10 actually in force — two numbers,
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

    # FCM（App 端推送）：安卓 App 是 Capacitor WebView，里面没有 Web Push，只能
    # 走 FCM。App 内的桥接把自己伪装成一条订阅上报（endpoint = fcm://<token>），
    # 派发时改用 FCM HTTP v1 发送。**网页端 Web Push 完全不受影响**：不配这两项，
    # 后端行为与现在逐字节相同，fcm:// 行只会被跳过并打一行警告，绝不清理。
    #
    # FCM_SERVICE_ACCOUNT_FILE 是服务器上那份 Firebase 服务账号 JSON 的路径（只
    # 放路径不放内容：密钥不该进 .env、更不该进日志）。FCM_PROJECT_ID 留空时从该
    # JSON 的 project_id 读取，只有在同一份凭证要发往另一个项目时才需要显式配置。
    #
    # FCM (app-side push): the Android app is a Capacitor WebView with no Web
    # Push, so it has to go through FCM. Its bridge reports itself as an ordinary
    # subscription (endpoint = fcm://<token>) and dispatch sends those over FCM
    # HTTP v1 instead. The browser Web Push path is untouched: with neither value
    # set the backend behaves exactly as before and fcm:// rows are skipped with
    # a single warning, never pruned.
    #
    # FCM_SERVICE_ACCOUNT_FILE is a path to the Firebase service-account JSON on
    # the server (a path, not the contents — the key belongs in neither .env nor
    # any log). FCM_PROJECT_ID falls back to the JSON's own project_id and only
    # needs setting when one credential targets a different project.
    FCM_SERVICE_ACCOUNT_FILE: str | None = None
    FCM_PROJECT_ID: str | None = None

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

    # 曾经这里还有一个 vapid_private_key_pem 属性（把 VAPID_PRIVATE_KEY_B64 当成
    # base64 的 PEM 解码）。全仓零调用方，且对非 base64 的值会直接抛
    # binascii.Error——留着只会让人误以为它是另一条受支持的配置路径。私钥的唯一
    # 出口是上面的 vapid_private_key，它已经把 DER / base64 / PEM 三种写法收成一种。
    # There used to be a vapid_private_key_pem property here (decoding
    # VAPID_PRIVATE_KEY_B64 as a base64 PEM). It had no callers anywhere and threw
    # a bare binascii.Error on non-base64 input; keeping it only suggested a second
    # supported config path. vapid_private_key above is the single exit, and it
    # already normalises the DER / base64 / PEM spellings into one.

    # 订单回执超时（秒）：已下发但超时未回执的订单，允许重新下发。
    # Order ack timeout (seconds): delivered-but-unacked orders may be re-delivered.
    ORDER_ACK_TIMEOUT_SECONDS: int = 60

    # 订单待执行超时（秒）：落库后超过此时长仍未执行的 PENDING 指令自动作废为
    # FAILED，防止桥接离线期间的陈旧指令在很久之后按过时价格成交。
    # Pending-order timeout (seconds): PENDING commands not executed within this
    # window are voided to FAILED, so a stale command can't fill at an outdated
    # price after the bridge comes back online much later.
    ORDER_PENDING_TIMEOUT_SECONDS: int = 300

    # 操作日志 activity_events 表的保留天数（管理后台「操作日志」页的绑定、登录、密码等
    # 事件）。每天 K 线清扫时顺带按 created_at 分批删掉更早的行。一天几十行，两年约 10 MB，
    # 留得长一点方便事后追查；0 或负数 = 不清理。
    # Retention of activity_events (bind / login / password … rows behind the admin
    # activity log). The daily candle sweep deletes older rows in batches by
    # created_at. A few dozen rows a day is ~10 MB over two years, so keep it long
    # for after-the-fact investigations; 0 or negative disables the cleanup.
    ACTIVITY_RETENTION_DAYS: int = 730

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
    # 工单图片的存储桶：**私有**桶，与上面的公开插图桶分开。用户截图里常有账号、余额、
    # 付款凭证，公开桶靠「URL 猜不到」挡人不够——链接一旦外流谁都能打开。私有桶里的图
    # 只能凭后端签发、会过期的签名链接看，而签名只发给工单本人和管理员。
    # 桶不存在时后端第一次上传会自动建（private），不用去控制台手动建。
    # Bucket for ticket images: **private**, separate from the public illustration
    # bucket above. User screenshots often show account numbers, balances and payment
    # receipts, and "the URL can't be guessed" is not enough once a link leaks. Images
    # here are viewable only through expiring signed URLs the backend issues to the
    # ticket owner and admins. The backend creates the bucket (private) on first upload.
    TICKET_IMAGE_BUCKET: str = "ticket-images"
    # 签名链接有效期（秒）。进程内缓存到剩一半时长再重签，所以发出去的链接至少还有
    # 一半寿命——够把一条工单从头看到尾，又不会让外流的链接长期可用。
    # 2026-10-10 安全审计：6 小时 → 1 小时（发出去的链接 30–60 分钟有效），缩短外流窗口；
    # 页面开太久图片过期时重新打开工单即可重签。
    # Signed URL lifetime in seconds. URLs are cached per process until half of it is
    # left, so any URL handed out still has at least half its life — enough to read a
    # thread end to end without a leaked link staying usable for long. Cut from 6 h to
    # 1 h in the 2026-10-10 security audit (handed-out URLs live 30–60 min); reopening
    # the ticket re-signs if a long-open page outlives them.
    TICKET_IMAGE_URL_TTL_SECONDS: int = 3600

    # ---- 公告一键翻译 / Announcement one-click translation ----
    # 只给管理员后台用：把中文公告译成英文（或反向）。TRANSLATE_PROVIDER 是逗号分隔
    # 的候选链，按顺序尝试、首个成功者胜出：
    #   google_free  Google 翻译公开接口，不需要密钥（非官方，可能限流）
    #   mymemory     MyMemory 公开接口，不需要密钥（匿名每天约 5000 字符，兜底）
    #   deepl        DeepL API，需 DEEPL_API_KEY（官方，质量最好，免费档每月 50 万字符）
    #   anthropic    Anthropic Messages API，需 ANTHROPIC_API_KEY（可选）
    # 默认不配任何密钥按钮就能用；配了 DeepL 把它排到链首即可。见 services/translate.py。
    # Admin-only translation between Chinese and English. TRANSLATE_PROVIDER is a
    # comma-separated chain tried in order: google_free (public, no key, unofficial),
    # mymemory (public, no key, fallback), deepl (DEEPL_API_KEY; official, best
    # quality) and anthropic (ANTHROPIC_API_KEY). Works with no keys by default;
    # put deepl first once you have a key. See services/translate.py.
    TRANSLATE_PROVIDER: str = "google_free,mymemory"
    DEEPL_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    # anthropic 后端用的模型 / model for the anthropic provider
    TRANSLATE_MODEL: str = "claude-haiku-4-5-20251001"

    # pydantic-settings v2 写法；语义与旧的 `class Config` 完全一致（含默认
    # extra="forbid"——.env 里多一个未知键仍会拒绝启动，运维踩坑 #24 那条不变）。
    # pydantic-settings v2 form; identical semantics to the old inner Config class,
    # including the default extra="forbid" (an unknown .env key still refuses to start).
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()

# 安全校验：生产环境（ENV=production）必须配置自定义强随机 JWT_SECRET，
# 否则用默认弱密钥签发的 token 可被任意伪造（等同认证绕过）。
# ENV=production 是主开关（「生产仍用 SQLite」也能覆盖到）；连 Postgres 的部署无论 ENV
# 写了什么也一并硬拒（见 jwt_secret_enforced）。
# Safety check: in production (ENV=production) a custom strong JWT_SECRET is
# mandatory; otherwise tokens signed with the default weak key are forgeable
# (equivalent to auth bypass). ENV=production is the main switch (it also covers
# a production still on SQLite); a Postgres DATABASE_URL triggers it regardless
# of ENV (see jwt_secret_enforced).
_DEFAULT_JWT_SECRET = "prismx-dev-secret-change-in-production"
# HS256 的安全性完全取决于这一个字符串的熵。只比对"是不是那个默认字面量"挡不住
# `JWT_SECRET=secret` 这类自己换过、但短到能离线爆破的值——签名一旦被还原，任何
# 人都能签出任意 sub 的 token，等同认证绕过。32 字符是下限而非建议值：
# `secrets.token_urlsafe(32)` 生成 43 个字符，照文档做就不会碰到这条。
# HS256's security rests entirely on this one string's entropy. Comparing against
# the default literal alone still lets `JWT_SECRET=secret` through — changed, but
# short enough to brute-force offline, and recovering it means anyone can sign a
# token for any sub (auth bypass). 32 chars is a floor, not a recommendation:
# `secrets.token_urlsafe(32)` yields 43, so following the docs never hits this.
_MIN_JWT_SECRET_LENGTH = 32


def jwt_secret_enforced(env: str, database_url: str) -> bool:
    """要不要对 JWT_SECRET 做强度硬拒。

    ENV=production 一定要；另外**只要连的是 Postgres**也要，不管 ENV 写的是什么：
    真实部署全是 Postgres，而 ENV 是一行最容易漏配的 .env——漏了它，默认密钥就会悄悄
    带上线，任何人都能签出任意用户的 token。本地开发与测试用 SQLite，不受影响。
    Whether the JWT_SECRET strength checks apply: always with ENV=production, and
    also whenever DATABASE_URL points at Postgres regardless of ENV — every real
    deployment runs Postgres, while ENV is the easiest .env line to forget, and
    forgetting it would ship the default secret (anyone could mint any user's
    token). Local dev and the test suite run on SQLite and are unaffected."""
    return env.lower() == "production" or (database_url or "").lower().startswith("postgres")


_JWT_ENFORCED = jwt_secret_enforced(settings.ENV, settings.DATABASE_URL)

if _JWT_ENFORCED and settings.JWT_SECRET == _DEFAULT_JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET 仍为默认值，生产环境（ENV=production 或 DATABASE_URL 为 Postgres）必须在 .env 中"
        "设置强随机密钥。"
        " / JWT_SECRET is still the default; set a strong random secret in .env when ENV=production"
        " or DATABASE_URL is Postgres."
    )

if _JWT_ENFORCED and len(settings.JWT_SECRET) < _MIN_JWT_SECRET_LENGTH:
    raise RuntimeError(
        f"JWT_SECRET 过短（{len(settings.JWT_SECRET)} 字符），生产环境（ENV=production 或 Postgres）"
        f"至少需要 {_MIN_JWT_SECRET_LENGTH} 字符的强随机密钥；建议用 `python -c \"import secrets;"
        " print(secrets.token_urlsafe(32))\"` 生成。"
        f" / JWT_SECRET is too short ({len(settings.JWT_SECRET)} chars); ENV=production or a Postgres"
        f" DATABASE_URL requires at least {_MIN_JWT_SECRET_LENGTH}. Generate one with"
        " `python -c \"import secrets; print(secrets.token_urlsafe(32))\"`."
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

# 重置链接打日志：打开后 services/password_reset.py 会把完整的找回密码链接写进
# 日志，任何能读到 journald 的人（运维、日志收集、误贴进工单的人）都能改任意账号
# 的密码。它和上面四项是同一类——「漏配一行 .env 就出事」的危险开关，之前却只靠
# 字段注释提醒，没有任何机制挡着。生产同样硬拒启动。
# Logging reset links: with this on, services/password_reset.py writes the full
# password-reset URL to the log, so anyone who can read journald (ops, a log
# shipper, whoever pastes it into a ticket) can take over any account. It belongs
# to the same class as the four above — one missing .env line and it's live — but
# was guarded only by a comment on the field. Production refuses to start too.
if settings.ENV.lower() == "production" and settings.MAIL_DEBUG_LOG_LINKS:
    raise RuntimeError(
        "MAIL_DEBUG_LOG_LINKS 仍为开启，生产环境（ENV=production）必须在 .env 中设为 false，"
        "否则找回密码链接会被写进日志，拿到日志即可接管任意账号。"
        " / MAIL_DEBUG_LOG_LINKS is on; set it to false in .env when ENV=production,"
        " or password-reset links land in the logs and anyone who reads them can take over any account."
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

# 2026-09-06 起：配了 REDIS_URL 就全部走 Redis（见 services/shared_state.py），多
# worker 才是受支持的部署；只配 RATE_LIMIT_STORAGE_URI（老写法）仍只覆盖 slowapi，
# 锁定 / 闸门 / 循环 / 推送 / 行情还在进程内，多 worker 照样拒绝。
# Since 2026-09-06 REDIS_URL moves every piece of shared state to Redis and makes
# multi-worker a supported deployment; RATE_LIMIT_STORAGE_URI alone (the older
# form) covers slowapi only, so multi-worker is still refused.
if (
    settings.ENV.lower() == "production"
    and _WORKER_COUNT is not None
    and _WORKER_COUNT > 1
    and not settings.REDIS_URL.strip()
):
    raise RuntimeError(
        f"检测到 {_WORKER_COUNT} 个 worker，但 REDIS_URL 为空——限流、登录 / MT5 验证锁定、回测"
        "闸门、后台循环、WebSocket 推送、EA 行情缓存都是进程内状态，多进程下每个 worker 各算各的："
        "防护静默除以 worker 数、循环跑 N 遍、推送只到达连在本进程的用户、图表在别的 worker 上没数据。"
        "请改回单 worker，或在 .env 配置 REDIS_URL（如 redis://127.0.0.1:6379/0）。"
        f" / Detected {_WORKER_COUNT} workers with an empty REDIS_URL: rate limits, lockouts, the"
        " backtest gate, background loops, WebSocket pushes and the EA market stores are per-process,"
        " so every protection silently divides by the worker count, loops run N times, pushes only"
        " reach users connected to this process and charts are empty on the other workers. Go back"
        " to a single worker, or set REDIS_URL (e.g. redis://127.0.0.1:6379/0)."
    )
