"""Gateway 账号管理路由：绑定/验证/解绑 Make Capital 用户的 MT5 账号。

与 bridge 不同：gateway 账号不需要用户运行本地桥接程序，由后端直接通过
gateway HTTP 操作 MT5 Manager API。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import MT5Account, User
from app.schemas import SUFFIX_PATTERN
from app.services.deps import get_current_user
from app.services.gateway_client import (
    get_account as gw_get_account,
    get_positions as gw_get_positions,
    verify_account as gw_verify,
)
from app.services.plans import max_mt5_accounts

logger = logging.getLogger("prismx.gateway.router")

router = APIRouter(prefix="/gateway", tags=["gateway"])


# ---------- 请求/响应模型 ----------


class GatewayVerifyRequest(BaseModel):
    login: int = Field(..., gt=0, description="MT5 账号")
    password: str = Field(..., min_length=1, description="MT5 密码（主密码或投资者密码）")
    investorOnly: bool = Field(default=False, description="是否仅用投资者密码验证")


class GatewayVerifyResponse(BaseModel):
    ok: bool
    valid: bool
    retcode: str = ""
    login: int = 0
    name: str = ""
    group: str = ""
    leverage: int = 0
    balance: float = 0.0
    equity: float = 0.0


class GatewayAccountOut(BaseModel):
    login: str
    server: str = ""
    source: str = "gateway"
    accountName: str = ""
    accountCurrency: str = ""
    balance: float = 0.0
    equity: float = 0.0
    leverage: int = 0
    group: str = ""
    symbolSuffix: str = ""


# ---------- 端点 ----------


@router.post("/verify", response_model=GatewayVerifyResponse)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def gateway_verify(
    request: Request,
    req: GatewayVerifyRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """验证 MT5 账号密码，成功后自动绑定到当前用户。
    与 bridge 绑定不同：这里直接调用 gateway HTTP 验证，不需要用户安装桥接程序。

    Verify MT5 credentials via the gateway. On success the account is
    automatically bound to the current user (unlike bridge, no local app needed).
    """
    import asyncio

    # 1) 调 gateway 验证
    rsp = asyncio.run(gw_verify(req.login, req.password, req.investorOnly))

    if not rsp.ok:
        raise HTTPException(status_code=502, detail=f"Gateway 不可用: {rsp.retcode}")

    # 2) 检查账户数上限
    account_limit = max_mt5_accounts(user.plan)
    existing_count = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id)
        .count()
    )
    if account_limit is not None and existing_count >= account_limit and not rsp.valid:
        # 密码不对而且已达上限——但返回验证结果，不创建账号
        pass
    elif account_limit is not None and existing_count >= account_limit:
        raise HTTPException(
            status_code=403,
            detail=f"已达到账户数上限（{account_limit}），请升级或删除旧账号",
        )

    # 3) 验证通过则创建/更新 MT5Account
    if rsp.valid:
        login_str = str(req.login)
        existing = (
            db.query(MT5Account)
            .filter(
                MT5Account.user_id == user.id,
                MT5Account.login == login_str,
                MT5Account.source == "gateway",
            )
            .first()
        )
        if existing is None:
            existing = MT5Account(
                user_id=user.id,
                login=login_str,
                server="",  # gateway 不区分 server
                source="gateway",
            )
            db.add(existing)

        existing.account_name = rsp.name
        existing.leverage = rsp.leverage
        existing.balance = rsp.balance
        existing.equity = rsp.equity

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="该账号已绑定")

        logger.info("Gateway 绑定成功: user=%s login=%s group=%s", user.id, login_str, rsp.group)
    else:
        logger.info("Gateway 验证失败: user=%s login=%s retcode=%s", user.id, req.login, rsp.retcode)

    return GatewayVerifyResponse(
        ok=True,
        valid=rsp.valid,
        retcode=rsp.retcode,
        login=rsp.login,
        name=rsp.name,
        group=rsp.group,
        leverage=rsp.leverage,
        balance=rsp.balance,
        equity=rsp.equity,
    )


@router.get("/accounts", response_model=list[GatewayAccountOut])
def list_gateway_accounts(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """列出当前用户的所有 Gateway 绑定账号。"""
    rows = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id, MT5Account.source == "gateway")
        .all()
    )
    return [
        GatewayAccountOut(
            login=row.login,
            server=row.server or "",
            source=row.source or "gateway",
            accountName=row.account_name or "",
            accountCurrency=row.account_currency or "",
            balance=row.balance or 0.0,
            equity=row.equity or 0.0,
            leverage=row.leverage or 0,
            group="",
            symbolSuffix=row.symbol_suffix or "",
        )
        for row in rows
    ]


@router.post("/account/{login}/refresh", response_model=GatewayAccountOut)
@limiter.limit("10/minute")
def refresh_gateway_account(
    request: Request,
    login: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """从 gateway 刷新某个绑定账号的最新资金信息。"""
    import asyncio

    row = (
        db.query(MT5Account)
        .filter(
            MT5Account.user_id == user.id,
            MT5Account.login == login,
            MT5Account.source == "gateway",
        )
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Gateway 账号不存在")

    rsp = asyncio.run(gw_get_account(int(login)))
    if rsp is None:
        raise HTTPException(status_code=502, detail="Gateway 查询账号失败")

    row.balance = rsp.balance
    row.equity = rsp.equity
    row.leverage = rsp.leverage
    row.account_name = rsp.name
    db.commit()

    return GatewayAccountOut(
        login=row.login,
        server=row.server or "",
        source=row.source or "gateway",
        accountName=row.account_name or "",
        accountCurrency=row.account_currency or "",
        balance=row.balance or 0.0,
        equity=row.equity or 0.0,
        leverage=row.leverage or 0,
        group="",
        symbolSuffix=row.symbol_suffix or "",
    )


@router.delete("/account/{login}")
def unbind_gateway_account(
    login: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """解绑一个 Gateway 账号。"""
    row = (
        db.query(MT5Account)
        .filter(
            MT5Account.user_id == user.id,
            MT5Account.login == login,
            MT5Account.source == "gateway",
        )
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Gateway 账号不存在")

    db.delete(row)
    db.commit()

    logger.info("Gateway 解绑: user=%s login=%s", user.id, login)
    return {"ok": True}


# ---------- 持仓轮询 ----------
# Bridge 账号的持仓由桥接每 1.5 秒 POST /bridge/positions 上报，前端的持仓列表、
# 图表标记、自动仓管都挂在那条链路上。Gateway 账号没有桥接，所以这里由后端主动
# 轮询 gateway 补上同一条链路，推送的消息格式与 /bridge/positions 完全一致。
#
# Bridge accounts report positions via POST /bridge/positions every 1.5s, which
# is what feeds the UI position list, chart markers and auto-manage. Gateway
# accounts have no bridge, so the backend polls the gateway itself and emits the
# exact same payload to keep those features working.
GATEWAY_POSITIONS_INTERVAL = 2.0


async def gateway_positions_loop() -> None:
    """周期性拉取 gateway 账号持仓并推送给前端。"""
    import asyncio

    from starlette.concurrency import run_in_threadpool

    from app.core.database import SessionLocal
    from app.services.auto_manage import evaluate_positions
    from app.services.connection_manager import manager
    from app.services.trade_performance import mark_positions_seen

    def _gateway_accounts() -> list[tuple[str, str]]:
        """(user_id, login) 列表。只取有 WS 连接的用户，避免空转。"""
        db = SessionLocal()
        try:
            rows = (
                db.query(MT5Account.user_id, MT5Account.login)
                .filter(MT5Account.source == "gateway")
                .all()
            )
            return [(r[0], r[1]) for r in rows]
        finally:
            db.close()

    while True:
        try:
            pairs = await run_in_threadpool(_gateway_accounts)

            # 按用户聚合：一个用户可能绑了多个 gateway 账号，前端的 POSITIONS
            # 消息是"该用户全部持仓"的快照，必须一次推完而不是每账号推一次。
            by_user: dict[str, list[str]] = {}
            for user_id, login in pairs:
                by_user.setdefault(user_id, []).append(login)

            # 没有前端连着的用户不必去打扰 gateway
            connected = set(manager.connected_user_ids())

            for user_id, logins in by_user.items():
                if user_id not in connected:
                    continue

                data: list[dict] = []
                for login in logins:
                    positions, err = await gw_get_positions(int(login))
                    if err:
                        logger.warning("Gateway 持仓读取失败 login=%s: %s", login, err)
                        continue
                    for p in positions:
                        data.append({
                            "ticket": p.ticket,
                            "symbol": p.symbol,
                            "side": p.side,
                            "volume": p.volume,
                            "profit": p.profit,
                            "entryPrice": p.price_open,
                            "currentPrice": p.price_current,
                            "stopLoss": p.stop_loss,
                            "takeProfit": p.take_profit,
                            "login": login,
                            "comment": p.comment,
                        })

                manager.set_positions(user_id, data)
                await manager.push_to_client(user_id, {"type": "POSITIONS", "data": data})

                # 与 /bridge/positions 保持一致：驱动胜率对账与自动仓管。
                # 任一步失败都不影响持仓推送本身。
                db = SessionLocal()
                try:
                    try:
                        await run_in_threadpool(mark_positions_seen, db, user_id, data)
                    except Exception:
                        logger.exception("gateway position reconciliation failed (user=%s)", user_id)
                    try:
                        await run_in_threadpool(evaluate_positions, db, user_id, data)
                    except Exception:
                        logger.exception("gateway auto_manage failed (user=%s)", user_id)
                finally:
                    db.close()

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("gateway_positions_loop 异常")

        await asyncio.sleep(GATEWAY_POSITIONS_INTERVAL)
