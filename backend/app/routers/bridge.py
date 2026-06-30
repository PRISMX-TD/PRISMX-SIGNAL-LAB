"""桥接程序路由：Python 桌面程序通过 REST + API Token 上报多账号并执行指令。
Bridge router: the Python desktop app reports multiple MT5 accounts and
executes order commands via REST + API token.
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.security import authenticate_api_token
from app.models import MT5Account, Order, Signal, User
from app.schemas import LOGIN_PATTERN, SUFFIX_PATTERN, AccountSuffixRequest, MT5AccountOut
from app.services.connection_manager import manager
from app.services.deps import get_current_user

router = APIRouter(prefix="/bridge", tags=["bridge"])

# 账号在线判定窗口（秒）：桥接每 2 秒轮询一次，留 3 个周期容错，
# 既能快速反映断线（约 6~7 秒内置灰），又不会因偶发丢包误判离线。
# Online window (s): bridge polls every 2s; allow ~3 missed cycles so a
# disconnect is reflected within ~6-7s without flapping on a single drop.
ONLINE_WINDOW = 7


def get_bridge_user(
    x_api_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """通过 API Token 鉴权桥接程序 / authenticate bridge app by API token."""
    user = authenticate_api_token(db, x_api_token)
    if not user:
        raise HTTPException(status_code=401, detail="API Token 无效 / Invalid API token")
    return user


# ---------- 桥接程序上报的单个账号 / one account reported by the bridge ----------
class BridgeAccount(BaseModel):
    login: str = Field(pattern=LOGIN_PATTERN)
    server: str | None = Field(default=None, max_length=64)
    accountName: str | None = Field(default=None, max_length=128)
    accountCurrency: str | None = Field(default=None, max_length=16)
    balance: float | None = None
    equity: float | None = None
    leverage: int | None = Field(default=None, ge=0, le=100000)
    company: str | None = Field(default=None, max_length=128)
    detectedSuffix: str | None = Field(default=None, pattern=SUFFIX_PATTERN)


class BridgePollRequest(BaseModel):
    accounts: list[BridgeAccount] = []


def _upsert_account(db: Session, user_id: str, acc: BridgeAccount) -> MT5Account:
    """插入或更新一个账号记录 / insert or update one account row."""
    row = (
        db.query(MT5Account)
        .filter(
            MT5Account.user_id == user_id,
            MT5Account.login == acc.login,
            MT5Account.server == (acc.server or None),
        )
        .first()
    )
    if row is None:
        row = MT5Account(user_id=user_id, login=acc.login, server=acc.server, source="bridge")
        db.add(row)
    if acc.accountName is not None:
        row.account_name = acc.accountName
    if acc.accountCurrency is not None:
        row.account_currency = acc.accountCurrency
    if acc.balance is not None:
        row.balance = acc.balance
    if acc.equity is not None:
        row.equity = acc.equity
    if acc.leverage is not None:
        row.leverage = acc.leverage
    if acc.company is not None:
        row.company = acc.company
    # 探测后缀仅作兜底（用户未手动设置时）/ detected suffix is fallback only
    if acc.detectedSuffix is not None and not (row.symbol_suffix or "").strip():
        row.symbol_suffix = acc.detectedSuffix
    row.online = True
    row.last_heartbeat = datetime.now(timezone.utc)
    return row


@router.post("/poll")
async def bridge_poll(
    req: BridgePollRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序轮询：上报本机所有账号 + 拉取这些账号的待执行指令。
    Bridge polling: report all local accounts + fetch pending commands for them.
    """
    # 1) upsert 本次上报的账号 / upsert reported accounts
    suffix_by_login: dict[str, str] = {}
    online_logins: set[str] = set()
    for acc in req.accounts:
        row = _upsert_account(db, user.id, acc)
        suffix_by_login[acc.login] = (row.symbol_suffix or "").strip()
        online_logins.add(acc.login)
    db.commit()

    # 2) 推送账号状态给前端 / push account status to the client
    await manager.push_to_client(
        user.id,
        {"type": "ACCOUNTS_STATUS", "data": {"onlineLogins": sorted(online_logins)}},
    )

    # 3) 取该用户、目标账号匹配的待执行订单 / fetch matching pending orders.
    #    包含两类：从未下发的；以及已下发但超时未回执的（可能回执丢失，需重发）。
    #    Includes: never-delivered orders, and delivered-but-unacked orders past
    #    the ack timeout (the ack may have been lost; safe to re-deliver because
    #    the bridge dedupes by clientOrderId).
    now = datetime.now(timezone.utc)
    ack_deadline = now - timedelta(seconds=settings.ORDER_ACK_TIMEOUT_SECONDS)
    pending = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.status == "PENDING")
        .order_by(Order.created_at.asc())
        .all()
    )
    commands = []
    for o in pending:
        # 跳过已下发且仍在等待回执窗口内的订单 / skip recently delivered, still within ack window
        if o.delivered and o.delivered_at is not None:
            last = o.delivered_at
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if last > ack_deadline:
                continue
        # 仅下发给目标账号在本机在线的指令 / only deliver to a locally-online target
        if o.mt5_login and o.mt5_login not in online_logins:
            continue
        # 若订单未指定账号且只有一个在线账号，则发给它 / single-account fallback
        target = o.mt5_login or (next(iter(online_logins)) if len(online_logins) == 1 else None)
        if target is None:
            continue
        entry = stop_loss = take_profit = 0.0
        if o.signal_id:
            sig = db.query(Signal).filter(Signal.id == o.signal_id).first()
            if sig:
                entry = sig.entry or 0.0
                stop_loss = sig.stop_loss or 0.0
                take_profit = sig.take_profit or 0.0
        # 订单自定义 SL/TP 优先于信号默认值 / order's custom SL·TP overrides signal defaults
        if o.sl is not None:
            stop_loss = o.sl
        if o.tp is not None:
            take_profit = o.tp
        suffix = suffix_by_login.get(target, "")
        commands.append({
            "clientOrderId": o.client_order_id,
            "action": o.action or "ORDER",
            "login": target,
            "symbol": o.symbol + suffix,
            "side": o.side,
            "volume": o.volume,
            "ticket": o.ticket or 0,
            "entry": entry,
            "stopLoss": stop_loss,
            "takeProfit": take_profit,
        })
        o.delivered = True
        o.delivered_at = now
    db.commit()

    return {"commands": commands}


class BridgeResultRequest(BaseModel):
    clientOrderId: str
    success: bool
    mt5Ticket: int | None = None
    filledPrice: float | None = None
    message: str | None = None


@router.post("/result")
async def bridge_result(
    req: BridgeResultRequest,
    user: User = Depends(get_bridge_user),
    db: Session = Depends(get_db),
):
    """桥接程序回报执行结果 / bridge reports execution result."""
    order = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在 / Order not found")

    # 幂等：订单已处于终态则直接确认，不被迟到的重复回执覆盖。
    # Idempotent: if already in a terminal state, just ack; don't let a late
    # duplicate result overwrite it.
    if order.status in ("FILLED", "REJECTED"):
        return {"ok": True, "duplicate": True}

    order.status = "FILLED" if req.success else "REJECTED"
    order.mt5_ticket = req.mt5Ticket
    order.filled_price = req.filledPrice
    order.message = req.message
    db.commit()
    db.refresh(order)

    await manager.push_to_client(user.id, {
        "type": "ORDER_UPDATE",
        "data": {
            "id": order.id,
            "clientOrderId": order.client_order_id,
            "signalId": order.signal_id,
            "symbol": order.symbol,
            "side": order.side,
            "volume": order.volume,
            "mt5Login": order.mt5_login,
            "status": order.status,
            "mt5Ticket": order.mt5_ticket,
            "filledPrice": order.filled_price,
            "message": order.message,
            "createdAt": order.created_at.isoformat(),
            "updatedAt": order.updated_at.isoformat(),
        },
    })
    return {"ok": True}


class BridgePositionsRequest(BaseModel):
    data: list = []


@router.post("/positions")
async def bridge_positions(
    req: BridgePositionsRequest,
    user: User = Depends(get_bridge_user),
):
    """桥接程序上报持仓 / bridge reports open positions."""
    manager.set_positions(user.id, req.data)
    await manager.push_to_client(user.id, {"type": "POSITIONS", "data": req.data})
    return {"ok": True}


class BridgeQuote(BaseModel):
    symbol: str = Field(max_length=32)
    bid: float
    ask: float
    ts: str | None = Field(default=None, max_length=40)


class BridgeQuotesRequest(BaseModel):
    data: list[BridgeQuote] = []


@router.post("/quotes")
async def bridge_quotes(
    req: BridgeQuotesRequest,
    user: User = Depends(get_bridge_user),
):
    """桥接程序上报实时报价（bid/ask）。仅把发生变化的条目推给前端，
    控制 WebSocket 流量。
    Bridge reports live bid/ask quotes. Only changed entries are pushed to
    clients to keep WebSocket traffic minimal.
    """
    incoming = [q.model_dump() for q in req.data]
    changed = manager.update_quotes(user.id, incoming)
    if changed:
        await manager.push_to_client(user.id, {"type": "QUOTES", "data": changed})
    return {"ok": True}


# ---------- 用户面向：账号列表与后缀设置 / user-facing: account list & suffix ----------
def _is_online(row: MT5Account) -> bool:
    if not row.last_heartbeat:
        return False
    last = row.last_heartbeat
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - last).total_seconds() < ONLINE_WINDOW


@router.get("/accounts", response_model=dict)
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """列出当前用户的所有 MT5 账号 / list all MT5 accounts of the user."""
    rows = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id)
        .order_by(MT5Account.login.asc())
        .all()
    )
    accounts = [
        MT5AccountOut(
            login=r.login,
            server=r.server,
            source=r.source,
            accountName=r.account_name,
            accountCurrency=r.account_currency,
            balance=r.balance,
            equity=r.equity,
            leverage=r.leverage,
            company=r.company,
            symbolSuffix=r.symbol_suffix or "",
            online=_is_online(r),
            lastHeartbeat=r.last_heartbeat,
        )
        for r in rows
    ]
    return {"accounts": [a.model_dump(mode="json") for a in accounts]}


@router.post("/accounts/suffix")
def set_account_suffix(
    req: AccountSuffixRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """为指定账号设置品种后缀 / set symbol suffix for a specific account."""
    row = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id, MT5Account.login == req.login)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    row.symbol_suffix = (req.symbolSuffix or "").strip()
    db.commit()
    return {"ok": True, "login": req.login, "symbolSuffix": row.symbol_suffix}


# ---------- 离线检测后台任务 / offline-detection background task ----------
async def offline_monitor_loop() -> None:
    """周期性检测账号从在线转离线并推送给前端。

    桥接停止轮询时不会再发 ACCOUNTS_STATUS，仅靠 last_heartbeat 过期，
    前端要等下次主动刷新才知道。此任务每 2 秒扫描一次，发现某用户的在线
    账号集合发生变化（尤其是变空）就主动推送，使断线在数秒内反映到前端。

    Periodically detect accounts that transitioned online->offline and push to
    clients. When the bridge stops polling it no longer sends ACCOUNTS_STATUS,
    so without this the UI only updates on the next manual refresh. Scanning
    every 2s and pushing on change makes a disconnect show up within seconds.
    """
    import asyncio

    from app.core.database import SessionLocal

    # user_id -> 上次推送的在线账号集合 / last pushed online-login set per user
    last_online: dict[str, set[str]] = {}
    while True:
        await asyncio.sleep(2)
        try:
            db = SessionLocal()
            try:
                rows = db.query(MT5Account).all()
                current: dict[str, set[str]] = {}
                for r in rows:
                    if _is_online(r):
                        current.setdefault(r.user_id, set()).add(r.login)
                # 合并历史里出现过的用户，确保「全部离线」也能被检测到。
                # Include users seen before so an all-offline transition is caught.
                for uid in set(last_online) | set(current):
                    now_set = current.get(uid, set())
                    if now_set != last_online.get(uid, set()):
                        await manager.push_to_client(
                            uid,
                            {"type": "ACCOUNTS_STATUS", "data": {"onlineLogins": sorted(now_set)}},
                        )
                        last_online[uid] = now_set
            finally:
                db.close()
        except Exception:
            # 后台任务不因单次异常退出 / never let the loop die on a transient error
            pass
