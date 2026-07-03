"""Pydantic 请求/响应模型 / Pydantic request & response schemas."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

# 共用校验规则 / shared validation rules
# 品种：大写字母/数字/点，长度 1-20（含券商后缀）/ symbol: upper-alnum + dot
SYMBOL_PATTERN = r"^[A-Za-z0-9._-]{1,20}$"
# 券商后缀：可空，仅限有限字符集 / broker suffix: optional, limited charset
SUFFIX_PATTERN = r"^[A-Za-z0-9._-]{0,10}$"
# MT5 登录号：纯数字 / MT5 login: digits only
LOGIN_PATTERN = r"^[0-9]{1,20}$"


# ---------- 认证 / Auth ----------
class AuthRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class GoogleAuthRequest(BaseModel):
    # 前端 Google Identity Services 返回的 ID Token / ID token from Google Identity Services
    credential: str = Field(min_length=1, max_length=4096)


class UserOut(BaseModel):
    id: str
    email: str


class AuthResponse(BaseModel):
    token: str
    user: UserOut


# ---------- API Token / MT5 连接凭证 ----------
class EATokenOut(BaseModel):
    # 明文 token 仅在重置（生成）响应中出现一次；查询时为 None（库中只存哈希）。
    # The plaintext token appears only once in the reset response; None on
    # reads (the DB stores just the hash).
    apiToken: str | None = None
    boundAccount: str | None = None


# ---------- 多账号 / Multi-account ----------
class MT5AccountOut(BaseModel):
    login: str
    server: str | None = None
    source: str | None = None
    accountName: str | None = None
    accountCurrency: str | None = None
    balance: float | None = None
    equity: float | None = None
    leverage: int | None = None
    company: str | None = None
    symbolSuffix: str | None = None
    online: bool = False
    lastHeartbeat: datetime | None = None


class AccountSuffixRequest(BaseModel):
    login: str = Field(pattern=LOGIN_PATTERN)
    symbolSuffix: str = Field(default="", pattern=SUFFIX_PATTERN)


# ---------- 信号 / Signal ----------
class SignalOut(BaseModel):
    id: str
    symbol: str
    side: str
    entry: float | None = None
    stopLoss: float | None = None
    takeProfit: float | None = None
    indicator: str | None = None
    status: str
    createdAt: datetime
    expireAt: datetime | None = None


# ---------- 下单 / Order ----------
class OrderRequest(BaseModel):
    signalId: str | None = Field(default=None, max_length=64)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL"]
    volume: float = Field(gt=0, le=10000)
    clientOrderId: str = Field(min_length=1, max_length=64)
    # 目标 MT5 账号 login（多账号时指定）/ target MT5 login (multi-account)
    mt5Login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    # 自定义止损止盈（绝对价，省略则用信号默认值）/ custom SL·TP (absolute; falls back to signal)
    stopLoss: float | None = Field(default=None, ge=0)
    takeProfit: float | None = Field(default=None, ge=0)


class ClosePositionRequest(BaseModel):
    clientOrderId: str = Field(min_length=1, max_length=64)
    ticket: int = Field(gt=0)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL"]
    mt5Login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    # 平仓手数；省略或为 0 表示全平 / volume to close; omit or 0 means full close
    volume: float | None = Field(default=None, ge=0, le=10000)


class ModifyPositionRequest(BaseModel):
    clientOrderId: str = Field(min_length=1, max_length=64)
    ticket: int = Field(gt=0)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL"]
    mt5Login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    # 新的止损止盈（绝对价，0 表示清除）/ new SL·TP (absolute; 0 clears)
    stopLoss: float = Field(default=0.0, ge=0)
    takeProfit: float = Field(default=0.0, ge=0)


class OrderOut(BaseModel):
    id: str
    clientOrderId: str
    signalId: str | None = None
    action: str = "ORDER"
    symbol: str
    side: str
    volume: float
    ticket: int | None = None
    mt5Login: str | None = None
    status: str
    mt5Ticket: int | None = None
    filledPrice: float | None = None
    message: str | None = None
    createdAt: datetime
    updatedAt: datetime
