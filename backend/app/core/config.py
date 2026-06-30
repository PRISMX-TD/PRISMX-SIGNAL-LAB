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

    # TradingView Webhook：警报推送时在 JSON body 内携带的密钥，服务器据此校验来源。
    # TradingView 的 webhook 不支持自定义请求头，故密钥放在 body 的 "secret" 字段。
    # 生产环境（ENV=production）必须设置为强随机值，留空将拒绝所有 webhook 请求。
    # TradingView webhook secret carried inside the JSON body (TradingView cannot
    # send custom headers). The server validates the "secret" field against this.
    # In production a strong random value is mandatory; empty rejects all webhooks.
    WEBHOOK_SECRET: str = ""

    # 风控 / Risk control
    MAX_VOLUME_PER_ORDER: float = 10.0  # 单笔最大手数 / max lots per order
    MIN_VOLUME_PER_ORDER: float = 0.01  # 单笔最小手数 / min lots per order
    # 按账户净值粗估的手数上限：每手所需净值（账户币种）。净值/该值 = 允许的最大手数。
    # Rough equity-based lot cap: required equity per lot (account currency).
    EQUITY_PER_LOT: float = 200.0

    # EA 心跳 / EA heartbeat
    EA_OFFLINE_TIMEOUT_SECONDS: int = 30

    # Web Push / VAPID：私钥以 base64 编码的 PEM 存储（避免 .env 多行问题），
    # 通过 vapid_private_key_pem 解码为原始 PEM。公钥与 subject 用于推送订阅。
    # VAPID config: private key stored as base64-encoded PEM (avoids multiline .env
    # issues); decode via vapid_private_key_pem. Public key and subject for push.
    VAPID_PRIVATE_KEY_B64: str = ""
    VAPID_PUBLIC_KEY: str = ""
    VAPID_SUBJECT: str = "mailto:admin@prismxsignallab.com"

    @property
    def vapid_private_key_pem(self) -> str:
        """将 base64 编码的私钥解码为 PEM 文本。/ Decode base64 private key to PEM text."""
        import base64
        if not self.VAPID_PRIVATE_KEY_B64:
            return ""
        return base64.b64decode(self.VAPID_PRIVATE_KEY_B64).decode("utf-8")

    # 订单回执超时（秒）：已下发但超时未回执的订单，允许重新下发。
    # Order ack timeout (seconds): delivered-but-unacked orders may be re-delivered.
    ORDER_ACK_TIMEOUT_SECONDS: int = 60

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
