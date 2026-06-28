"""Pydantic 请求/响应模型 / Pydantic request & response schemas."""
from datetime import datetime

from pydantic import BaseModel, EmailStr


# ---------- 认证 / Auth ----------
class AuthRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: str


class AuthResponse(BaseModel):
    token: str
    user: UserOut


# ---------- EA 绑定 / EA binding ----------
class EATokenOut(BaseModel):
    apiToken: str
    boundAccount: str | None = None


class MT5AccountRequest(BaseModel):
    mt5Login: str
    mt5Server: str


class SymbolSuffixRequest(BaseModel):
    symbolSuffix: str


class EAStatusOut(BaseModel):
    online: bool
    mt5Login: str | None = None
    mt5Server: str | None = None
    symbolSuffix: str | None = None
    accountName: str | None = None
    accountCurrency: str | None = None
    balance: float | None = None
    equity: float | None = None
    leverage: int | None = None
    company: str | None = None
    lastHeartbeat: datetime | None = None


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
    login: str
    symbolSuffix: str


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
    signalId: str | None = None
    symbol: str
    side: str
    volume: float
    clientOrderId: str
    # 目标 MT5 账号 login（多账号时指定）/ target MT5 login (multi-account)
    mt5Login: str | None = None


class OrderOut(BaseModel):
    id: str
    clientOrderId: str
    signalId: str | None = None
    symbol: str
    side: str
    volume: float
    mt5Login: str | None = None
    status: str
    mt5Ticket: int | None = None
    filledPrice: float | None = None
    message: str | None = None
    createdAt: datetime
    updatedAt: datetime
