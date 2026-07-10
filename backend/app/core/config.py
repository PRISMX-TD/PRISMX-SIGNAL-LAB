"""PRISMX Signal Lab - 应用配置 / Application configuration."""
from pydantic_settings import BaseSettings


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
    JWT_EXPIRE_MINUTES: int = 60 * 24  # 1 天 / 1 day

    # Google 登录 / Google Sign-In：在 Google Cloud Console 创建的 OAuth Web Client ID。
    # 留空则关闭 Google 登录端点。 / OAuth Web Client ID from Google Cloud Console;
    # empty disables the Google login endpoint.
    GOOGLE_CLIENT_ID: str = ""

    # 限流 / Rate limiting（默认值，可用环境变量覆盖）。
    # Rate limits (defaults; overridable via env).
    RATE_LIMIT_LOGIN: str = "10/minute"
    RATE_LIMIT_REGISTER: str = "5/minute"
    RATE_LIMIT_GOOGLE: str = "10/minute"

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
    SIGNAL_STALE_DAYS: int = 10

    # TradingView Webhook：警报推送时在 JSON body 内携带的密钥，服务器据此校验来源。
    # TradingView 的 webhook 不支持自定义请求头，故密钥放在 body 的 "secret" 字段。
    # 生产环境（ENV=production）必须设置为强随机值，留空将拒绝所有 webhook 请求。
    # TradingView webhook secret carried inside the JSON body (TradingView cannot
    # send custom headers). The server validates the "secret" field against this.
    # In production a strong random value is mandatory; empty rejects all webhooks.
    WEBHOOK_SECRET: str = ""

    # 图表喂价器鉴权：独立的 Windows 喂价程序（feeder/chart_feeder.py）用
    # X-Feed-Token 头写入 K 线数据。留空则拒绝所有喂价写入（图表将没有数据，
    # 不影响交易主链路），因此不像 JWT_SECRET/WEBHOOK_SECRET 那样强制校验。
    # Chart feeder auth: the standalone Windows feeder program writes candles
    # via the X-Feed-Token header. Empty rejects all feed writes (charts show
    # no data, but the trading path is unaffected), so — unlike JWT_SECRET/
    # WEBHOOK_SECRET — this is not enforced as mandatory in production.
    FEED_TOKEN: str = ""

    # NOWPayments 加密货币支付 / Crypto payment gateway
    # API Key + IPN Secret（IPN 密钥仅在 NOWPayments 后台生成时展示一次!!）
    # API Key + IPN Secret (IPN secret shown ONLY ONCE in the NOWPayments dashboard!)
    NOWPAYMENTS_API_KEY: str = ""
    NOWPAYMENTS_IPN_SECRET: str = ""
    # 是否使用 Sandbox 测试环境 / Whether to use the sandbox test environment
    NOWPAYMENTS_SANDBOX: bool = True
    # 本站基础 URL（用于构造 IPN 回调地址）/ site base URL (used to build IPN callback URL)
    SITE_BASE_URL: str = "https://prismxsignallab.com"
    # PRO 订阅价格（美元）/ PRO subscription pricing (USD)
    PRO_MONTHLY_PRICE_USD: float = 49.0
    PRO_YEARLY_PRICE_USD: float = 470.0

    # 风控 / Risk control
    MAX_VOLUME_PER_ORDER: float = 10.0  # 单笔最大手数 / max lots per order
    MIN_VOLUME_PER_ORDER: float = 0.01  # 单笔最小手数 / min lots per order
    # 按账户净值粗估的手数上限：每手所需净值（账户币种）。净值/该值 = 允许的最大手数。
    # Rough equity-based lot cap: required equity per lot (account currency).
    EQUITY_PER_LOT: float = 200.0

    # EA 心跳 / EA heartbeat
    EA_OFFLINE_TIMEOUT_SECONDS: int = 30

    # Web Push / VAPID：私钥以 urlsafe-base64 编码的 DER（PKCS8）存储，直接交给
    # pywebpush（py_vapid 的 from_string 走 urlsafe-base64 解码，不能用标准 PEM）。
    # 旧字段 VAPID_PRIVATE_KEY_B64（标准 base64 PEM）仍保留作兼容，但 from_der 会解析失败，
    # 故优先使用 VAPID_PRIVATE_KEY_DER。公钥与 subject 用于推送订阅。
    # VAPID: private key stored as urlsafe-base64-encoded DER (PKCS8) and passed
    # straight to pywebpush (py_vapid.from_string decodes via urlsafe-base64, so a
    # standard PEM does not work). Public key and subject are used for push.
    VAPID_PRIVATE_KEY_DER: str = ""
    VAPID_PRIVATE_KEY_B64: str = ""
    VAPID_PUBLIC_KEY: str = ""
    VAPID_SUBJECT: str = "mailto:admin@prismxsignallab.com"

    @property
    def vapid_private_key(self) -> str:
        """返回可直接传给 pywebpush 的私钥字符串：优先 urlsafe-DER；否则回退到
        base64 PEM 解码后的 PEM 文本（旧配置）。/ Private key string for pywebpush:
        prefer urlsafe-DER; fall back to decoded PEM text (legacy)."""
        if self.VAPID_PRIVATE_KEY_DER:
            return self.VAPID_PRIVATE_KEY_DER
        return self.vapid_private_key_pem

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

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


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
