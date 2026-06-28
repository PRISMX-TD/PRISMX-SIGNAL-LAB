"""PRISMX Signal Lab - 应用配置 / Application configuration."""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 应用基础 / App basics
    APP_NAME: str = "PRISMX Signal Lab"
    API_PREFIX: str = "/api"

    # 安全 / Security
    JWT_SECRET: str = "prismx-dev-secret-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 天 / 7 days

    # 数据库 / Database（本地阶段使用 SQLite / SQLite for local stage）
    DATABASE_URL: str = "sqlite:///./prismx.db"

    # 跨域 / CORS（本地前端地址 / local frontend origins）
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    # 信号引擎 / Signal engine
    SIGNAL_INTERVAL_SECONDS: int = 15  # 信号生成节拍 / signal tick interval

    # 风控 / Risk control
    MAX_VOLUME_PER_ORDER: float = 10.0  # 单笔最大手数 / max lots per order
    MIN_VOLUME_PER_ORDER: float = 0.01  # 单笔最小手数 / min lots per order
    # 按账户净值粗估的手数上限：每手所需净值（账户币种）。净值/该值 = 允许的最大手数。
    # Rough equity-based lot cap: required equity per lot (account currency).
    EQUITY_PER_LOT: float = 200.0

    # EA 心跳 / EA heartbeat
    EA_OFFLINE_TIMEOUT_SECONDS: int = 30

    # 订单回执超时（秒）：已下发但超时未回执的订单，允许重新下发。
    # Order ack timeout (seconds): delivered-but-unacked orders may be re-delivered.
    ORDER_ACK_TIMEOUT_SECONDS: int = 60

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
