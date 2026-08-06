"""Gateway 账号管理路由：绑定/验证/解绑 Make Capital 用户的 MT5 账号。

与 bridge 不同：gateway 账号不需要用户运行本地桥接程序，由后端直接通过
gateway HTTP 操作 MT5 Manager API。
"""
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import ClosedTrade, MT5Account, Order, User
from app.schemas import SUFFIX_PATTERN
from app.services.deps import get_current_user
from app.services.gateway_client import (
    get_account as gw_get_account,
    get_deals as gw_get_deals,
    get_positions as gw_get_positions,
    verify_account as gw_verify,
)
from app.services.plans import max_mt5_accounts
# 余额推送与 bridge 共用同一份去重状态（_last_pushed_balances），所以直接复用
# bridge 里的函数，而不是各自维护一套——两套状态会互相覆盖对方的余额。
# bridge 不导入 gateway，这个方向不会形成循环导入。
# Balance pushes share bridge's de-duplication state (_last_pushed_balances), so
# reuse its helper instead of keeping a second copy that would clobber the other
# side's balances. bridge doesn't import gateway, so this direction is safe.
from app.routers.bridge import push_balances_if_changed

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
# 同一个循环还顺带补了另外两条 Bridge 独有的链路（都是"Bridge 主动上报、
# Gateway 没有对应实现"造成的功能缺口）：
#   1. 账号资金刷新——Bridge 走 POST /bridge/poll 每轮 upsert balance/equity，
#      Gateway 此前只在绑定时和手动 refresh 时写一次，账号卡片上的余额/净值
#      永远是绑定那一刻的旧值。
#   2. 平仓明细落库——Bridge 自己扫 MT5 历史后 POST /bridge/trade-history，
#      Gateway 此前完全没有写入口，导致「已平仓交易明细」和交易表现永远为空。
#
# Bridge accounts report positions via POST /bridge/positions every 1.5s, which
# is what feeds the UI position list, chart markers and auto-manage. Gateway
# accounts have no bridge, so the backend polls the gateway itself and emits the
# exact same payload to keep those features working. The same loop also fills in
# two other bridge-only pipelines: account balance/equity refresh and
# closed-trade recording.
GATEWAY_POSITIONS_INTERVAL = 2.0

# 开/平仓事件的拉取间隔。
#
# 这一拍只做一件事：GET /position-events，把 gateway 订阅积压的开平仓事件取走。
# 它不碰 MT5 —— gateway 那端只是从内存队列里取，所以这个调用的成本与用户数、
# 账号数都无关，是个常数。正因为便宜，才敢用远小于持仓轮询的间隔。
#
# 取 0.25 秒：开平仓的端到端延迟 = 这个间隔 + 一次持仓读取，体感上是「按下就
# 出现」。再压到 0.1 秒收益已经看不出来，只是白白多三倍请求。
#
# 券商不推 UPDATE（探针实测），所以浮盈变化拿不到事件，仍由上面那个 2 秒轮询
# 负责。这里快的是「仓位出现/消失」，不是「浮盈跳动」。
GATEWAY_EVENT_POLL_INTERVAL = 0.25

# 账号资金刷新间隔。资金变化不像持仓那样需要秒级跟随，而每次刷新都是一次
# Manager API 往返，按每个账号独立计时，避免 2 秒一轮把 gateway 打满。
# Account funds don't need sub-second freshness and each refresh is a Manager
# API round-trip, so throttle per account instead of hitting it every 2s.
GATEWAY_ACCOUNT_REFRESH_INTERVAL = 15.0

# 一轮里同时处理的用户数上限。
#
# 每轮要为每个在线用户各做几次 Manager API 往返。串行时一轮耗时随用户数线性
# 增长，用户一多就会超过轮询间隔，持仓延迟跟着一起涨。
#
# 但也不能无上限并发：gateway 那端是单条 Manager API 连接，几十个请求一起压过去
# 只会让它排队甚至超时，比串行更糟。取 8 是个折中 —— 足以让一轮的耗时不随用户数
# 明显增长，又不会把 gateway 打满。
#
# Max users processed concurrently per tick. Serial processing made a tick scale
# linearly with user count, eventually exceeding the poll interval. Unbounded
# concurrency is worse though: the gateway side is a single Manager API
# connection, so flooding it just causes queueing and timeouts. 8 is the
# compromise.
GATEWAY_MAX_CONCURRENT_USERS = 8

# 平仓明细扫描间隔与回看窗口。
#
# 回看窗口的取值理由与 bridge/mt5_worker.py 的 _closed_trades_payload 一致：
# 宁可反复查到同一笔成交（后端按 (user, deal_ticket) 唯一约束去重，重复上报
# 无副作用），也不要因为窗口太窄漏掉一笔。但这里不需要 Bridge 那套服务器时区
# 换算——Manager API 的 DealRequest 直接按 UTC 秒解读，传 Unix 时间戳即可。
#
# 扫描间隔决定「平仓后多久能在明细里看到」：入库后会立刻推 CLOSED_TRADE_NEW，
# 前端不必等自己的 45 秒轮询，所以端到端延迟基本就是这个间隔。取 3 秒而非更
# 短，是因为每轮都是一次 Manager API 往返，且与持仓轮询共用同一条连接。
GATEWAY_DEALS_SCAN_INTERVAL = 3.0
GATEWAY_DEALS_LOOKBACK_SECONDS = 15 * 60

# 每个账号第一次扫描时用的宽窗口。这个循环只扫「当前有 WS 连接」的用户，所以
# 后端重启、或用户关掉页面期间发生的平仓，都不在任何一次常规窗口里。首扫补一个
# 长回看把这段空档捞回来，之后回到窄窗口。重复查到的成交由唯一约束去重。
# Wider window for a login's first scan. This loop only covers users with a live
# WS connection, so closes that happen during a backend restart — or while the
# user has the page closed — fall outside every regular window. The first scan
# after (re)connecting backfills that gap; later scans use the narrow window.
# Re-reading the same deals is harmless: the unique constraint dedupes.
GATEWAY_DEALS_CATCHUP_SECONDS = 7 * 24 * 60 * 60

# MT5 成交类型/进出方向常量（对应 SDK 的 EnDealAction / EnDealEntry）
_DEAL_ACTION_BUY = 0
_DEAL_ACTION_SELL = 1
_DEAL_ENTRY_OUT = 1
_DEAL_ENTRY_INOUT = 2
_DEAL_ENTRY_OUT_BY = 3


def build_closed_trade_legs(
    deals: list,
    comment_prefix: str,
    known_position_tickets: set[int] | None = None,
) -> list[dict]:
    """从成交历史里挑出「本平台开的仓位的平仓腿」，算好净盈亏后返回待入库记录。

    与 POST /bridge/trade-history 收到的载荷同构，只是判断归属的依据不同。
    Bridge 侧靠魔术号码，且能对每个仓位单独调 history_deals_get(position=...)
    拿到**完整**历史；Manager API 既没有 magic 字段、也没有「按仓位查成交」的
    方法，只能拿回看窗口内的成交来判断。这就带来一个坑：

        只要开仓时刻早于回看窗口起点（开仓和平仓间隔略长就会发生），窗口里就
        只有平仓腿、没有开仓腿。若只看「开仓腿 comment 是否带前缀」，归属判定
        必然失败，仓位被静默丢弃、明细永远是空的。

    所以归属改成三个信号取并集，任一命中即认定为本平台的仓位：

      1. `known_position_tickets` 命中——orders 表里有 mt5_position 等于该仓位号
         的 FILLED 开仓记录。这是主依据：不受回看窗口影响，也不依赖 comment。
      2. 窗口内有带前缀的开仓腿——只在仓位刚开不久时才可能命中，作为 1 的兜底
         （例如 gateway 当时没返回仓位号）。
      3. 平仓腿自己的 comment 带前缀——只有「本平台主动发起的平仓」才带，
         **TP/SL 触发时不带**：那种平仓由服务器写 comment，实测会变成
         `[tp 4177.62]` 或空串。所以这条只能作为补充信号，不能当主依据。

    手续费与隔夜利息按这笔平仓手数占该仓位总平仓手数的比例分摊，与
    bridge/mt5_worker.py 的 fee_share 算法保持一致——否则同一笔交易在两条通道
    下会算出不同的净盈亏。注意窗口里可能缺开仓腿，那笔手续费就分摊不到；宁可
    少算费用，也不能因此丢掉整条平仓记录。

    纯函数，不碰数据库，便于单独验证。

    Picks the closing legs of platform-opened positions out of a deal history
    and computes each leg's net P&L. Mirrors POST /bridge/trade-history's
    payload. Ownership can't use the bridge's magic number (Manager API has no
    magic field) nor a per-position history lookup (no such call), so it unions
    three signals: a prefixed opening leg, a prefixed closing leg, and a match
    against known platform-opened position tickets from the orders table. The
    third is what makes this work when the opening deal predates the lookback
    window. Pure function, no DB.
    """
    prefix = (comment_prefix or "").strip().upper()
    known = known_position_tickets or set()

    # 先按仓位归组，才能判断归属并分摊费用
    by_position: dict[int, list] = {}
    for d in deals:
        if d.position_id:
            by_position.setdefault(int(d.position_id), []).append(d)

    legs_out: list[dict] = []
    for pos_id, legs in by_position.items():
        # 归属判定。前缀为空且没有已知仓位号时不过滤（等同于 gateway.ini 没配
        # comment_prefix），会把用户自己在 MT5 客户端开的仓位也记进来。
        if prefix or known:
            is_ours = pos_id in known or any(
                (d.comment or "").upper().startswith(prefix)
                for d in legs
                if prefix
            )
            if not is_ours:
                continue

        out_legs = [
            d for d in legs
            if d.entry in (_DEAL_ENTRY_OUT, _DEAL_ENTRY_INOUT, _DEAL_ENTRY_OUT_BY)
            and d.action in (_DEAL_ACTION_BUY, _DEAL_ACTION_SELL)
            and d.volume > 0
        ]
        if not out_legs:
            continue

        total_fees = sum((d.commission or 0.0) + (d.storage or 0.0) for d in legs)
        total_out_volume = sum(d.volume for d in out_legs)
        if total_out_volume <= 0:
            continue

        for d in out_legs:
            legs_out.append({
                "symbol": d.symbol,
                # 平仓成交方向与原仓位相反：SELL 平的是多单，BUY 平的是空单
                "side": "BUY" if d.action == _DEAL_ACTION_SELL else "SELL",
                "closeVolume": d.volume,
                "closePrice": d.price,
                "profit": (d.profit or 0.0) + total_fees * (d.volume / total_out_volume),
                "positionTicket": pos_id,
                "dealTicket": int(d.ticket),
                "closedAt": datetime.fromtimestamp(d.time, tz=timezone.utc),
            })

    return legs_out


async def gateway_positions_loop() -> None:
    """周期性拉取 gateway 账号持仓并推送给前端，同时刷新资金与平仓明细。

    分为两个拍子：
      1. 快拍（0.25秒）：GET /position-events 取订阅事件，收到就立刻推。
         开仓 ADD → 读该账号持仓 → 立刻推前端（< 500ms）
         平仓 DELETE → 立刻推空列表 + 余额（< 300ms）
      2. 慢拍（2秒）：轮询全部有持仓的账号，刷新浮盈。券商不推 UPDATE，
         浮盈仍靠轮询，但已经不用为了「检测开平仓」去轮每个账号了。

    订阅不可用时快拍返回空事件，这时慢拍负责全部逻辑，行为与改动前一致。
    """
    import asyncio

    from starlette.concurrency import run_in_threadpool

    from app.core.database import SessionLocal
    from app.services.auto_manage import evaluate_positions
    from app.services.connection_manager import manager
    from app.services.trade_performance import mark_positions_seen
    from app.services.gateway_client import drain_position_events

    # ----- 共享状态与辅助函数 -----

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

    def _save_account_funds(user_id: str, login: str, rsp) -> float | None:
        """把 gateway 读回的资金写进 MT5Account，等价于 Bridge 的 /bridge/poll upsert。

        返回写入后的余额，供调用方决定是否推送；账号不存在时返回 None。
        Returns the persisted balance so the caller can decide whether to push;
        None when the account row doesn't exist.
        """
        db = SessionLocal()
        try:
            row = (
                db.query(MT5Account)
                .filter(
                    MT5Account.user_id == user_id,
                    MT5Account.login == login,
                    MT5Account.source == "gateway",
                )
                .first()
            )
            if row is None:
                return None
            row.balance = rsp.balance
            row.equity = rsp.equity
            row.leverage = rsp.leverage
            if rsp.name:
                row.account_name = rsp.name
            db.commit()
            return float(row.balance or 0.0)
        finally:
            db.close()

    def _save_closed_trades(user_id: str, login: str, deals: list) -> int:
        """把平仓成交写进 ClosedTrade，与 POST /bridge/trade-history 同一套语义。

        归属判定与费用分摊在 build_closed_trade_legs 里；这里只负责查出本平台
        开过的仓位号、落库、去重。回看窗口会反复查到同一笔成交，靠
        (user_id, deal_ticket) 唯一约束挡掉。
        """
        db = SessionLocal()
        try:
            # 本平台在该账号开过的仓位号。这是归属判定里唯一不受回看窗口影响的
            # 依据——开仓腿早已滑出窗口时，只能靠它认出这笔平仓是我们的。
            # 用 mt5_position（真实仓位号），不是 mt5_ticket——后者存的是订单号
            # 或成交号，和平仓成交的 position_id 不是同一套编号，拿来比对永远不中。
            # Match on mt5_position (the real position id). mt5_ticket holds an
            # order or deal ticket — a different numbering space from a closing
            # deal's position_id, so comparing against it never matches.
            known = {
                int(t) for (t,) in db.query(Order.mt5_position).filter(
                    Order.user_id == user_id,
                    Order.mt5_login == login,
                    Order.action == "ORDER",
                    Order.status == "FILLED",
                    Order.mt5_position.isnot(None),
                ).all()
            }
        finally:
            db.close()

        legs = build_closed_trade_legs(deals, settings.GATEWAY_COMMENT_PREFIX, known)
        if not legs:
            return 0

        inserted = 0
        db = SessionLocal()
        try:
            for leg in legs:
                db.add(ClosedTrade(
                    user_id=user_id,
                    mt5_login=login,
                    symbol=leg["symbol"],
                    side=leg["side"],
                    close_volume=leg["closeVolume"],
                    close_price=leg["closePrice"],
                    profit=leg["profit"],
                    position_ticket=leg["positionTicket"],
                    deal_ticket=leg["dealTicket"],
                    closed_at=leg["closedAt"],
                ))
                try:
                    db.commit()
                    inserted += 1
                except IntegrityError:
                    # 已上报过这笔成交（回看窗口重叠导致），跳过
                    db.rollback()
        finally:
            db.close()
        return inserted

    # login -> 上次刷新/扫描的 monotonic 时间戳
    last_account_refresh: dict[str, float] = {}
    last_deals_scan: dict[str, float] = {}
    # login -> 最近一次读到的余额。资金 15 秒才刷一次，而推送判断每拍都要做，
    # 所以必须跨拍留着；只用本拍刷到的会让没轮到刷新的账号余额忽然消失。
    # login -> last known balance. Funds refresh every 15s but the push check runs
    # every tick, so balances must persist across ticks; using only this tick's
    # refreshed values would make un-refreshed accounts drop out.
    known_balances: dict[str, float] = {}
    # 本进程内已做过首次补扫的账号 / logins whose catch-up scan already ran
    scanned_once: set[str] = set()

    # 已确认空仓的账号。只有真的轮询到空列表才会加进来，收到 ADD 事件就移除。
    # 慢拍靠它跳过没有持仓的账号——大多数账号大多数时候都是空仓的，这能省掉
    # 绝大部分无效的 MT5 往返。判断里还要求订阅活着，见 _process_user 里的注释。
    # Logins confirmed flat. Only an actual empty poll adds one; an ADD event
    # removes it. Lets the slow tick skip accounts with nothing to refresh.
    known_flat: set[str] = set()

    # 订阅是否活着。快拍每次调用都会更新它：
    #   - True：可以信任事件，慢拍能安全跳过空仓账号
    #   - False：gateway 重启/断线/券商收回权限，清空 known_flat 退回全量轮询
    # 用列表包一层是因为闭包里要改它（Python 的 nonlocal 在嵌套函数里更啰嗦）。
    subscription_state = {"alive": False}

    # 一轮内限制同时在飞的用户数，避免把 gateway 的单连接打满。
    # Cap in-flight users per tick so we don't saturate the gateway's single link.
    sem = asyncio.Semaphore(GATEWAY_MAX_CONCURRENT_USERS)

    async def _read_positions(login: str) -> tuple[list[dict], bool]:
        """读一个账号的持仓，转成前端格式。返回 (列表, 是否成功)。"""
        positions, err = await gw_get_positions(int(login))
        if err:
            logger.warning("Gateway 持仓读取失败 login=%s: %s", login, err)
            return [], False

        return [
            {
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
            }
            for p in positions
        ], True

    async def _push_user_snapshot(user_id: str, logins: list[str]) -> None:
        """读该用户全部 gateway 账号的持仓并推一次完整快照。

        必须推「全部账号」而不是只推出事件的那个：POSITIONS 消息的语义是该用户
        的完整持仓快照，只推一个账号会让前端把其他账号的持仓行清掉。
        Must push all accounts, not just the one that fired: the POSITIONS message
        is a whole-user snapshot, so a partial push would wipe the other accounts.
        """
        data: list[dict] = []
        for lg in logins:
            rows, ok = await _read_positions(lg)
            if not ok:
                # 某个账号读失败：放弃这次即时推送，交给慢拍。
                # 硬推一个不完整的快照会让前端短暂丢行，比晚一点更糟。
                return
            if rows:
                known_flat.discard(lg)
            else:
                known_flat.add(lg)
            data.extend(rows)

        await manager.push_positions(user_id, data)

        # 平仓那一刻余额已经变了。这里顺手把已知余额再推一次，让账户卡片的
        # 余额和持仓表的浮盈在同一条消息序列里更新，不会出现「新浮盈 + 旧余额」。
        # 余额的真实刷新仍由慢拍的 15 秒节流负责，这里只是不让它落后于持仓。
        mine = {lg: known_balances[lg] for lg in logins if lg in known_balances}
        if mine:
            await push_balances_if_changed(user_id, mine)

    async def _process_user(user_id: str, logins: list[str]) -> None:
        """处理单个用户：刷资金、扫平仓、拉持仓、推送。

        Handle one user: refresh funds, scan closes, fetch positions, push.

        用户之间互不相关，所以这一层可以并发跑；但单个用户内部仍保持串行 ——
        资金刷新和平仓扫描共用节流时间戳，并发会让节流失效。
        Users are independent so this runs concurrently, but a single user's steps
        stay serial: the funds refresh and close scan share throttle timestamps.
        """
        async with sem:
            now = time.monotonic()
            data: list[dict] = []
            for login in logins:
                # --- 账号资金刷新（低频）---
                if now - last_account_refresh.get(login, 0.0) >= GATEWAY_ACCOUNT_REFRESH_INTERVAL:
                    last_account_refresh[login] = now
                    try:
                        acc_rsp = await gw_get_account(int(login))
                        if acc_rsp is not None:
                            bal = await run_in_threadpool(
                                _save_account_funds, user_id, login, acc_rsp
                            )
                            if bal is not None:
                                known_balances[login] = bal
                        else:
                            logger.warning("Gateway 账号资金读取失败 login=%s", login)
                    except Exception:
                        logger.exception("gateway account refresh failed (login=%s)", login)

                # --- 平仓明细扫描（低频）---
                if now - last_deals_scan.get(login, 0.0) >= GATEWAY_DEALS_SCAN_INTERVAL:
                    last_deals_scan[login] = now
                    first_scan = login not in scanned_once
                    scanned_once.add(login)
                    try:
                        # to 往后留一天余量：MT5 服务器时区常领先 UTC，按
                        # 「现在」截断会把刚成交的记录切掉。
                        # Pad `to` by a day: MT5 server time often runs ahead
                        # of UTC, and cutting at "now" would drop fresh deals.
                        to_unix = int(time.time()) + 86400
                        from_unix = int(time.time()) - (
                            GATEWAY_DEALS_CATCHUP_SECONDS if first_scan
                            else GATEWAY_DEALS_LOOKBACK_SECONDS
                        )
                        deals, derr = await gw_get_deals(int(login), from_unix, to_unix)
                        if derr:
                            logger.warning("Gateway 成交历史读取失败 login=%s: %s", login, derr)
                        elif deals:
                            n = await run_in_threadpool(
                                _save_closed_trades, user_id, login, deals
                            )
                            if n:
                                logger.info(
                                    "Gateway 平仓明细入库 login=%s 新增=%d", login, n
                                )
                                # 立刻通知前端重拉，别等它自己的 45 秒轮询
                                await manager.push_to_client(
                                    user_id, {"type": "CLOSED_TRADE_NEW"}
                                )
                            else:
                                # 窗口里有成交却一条都没入库，通常是归属判定
                                # 没认出来（comment 前缀与 gateway.ini 不一致，
                                # 或该仓位不是本平台开的）。debug 级别以免刷屏，
                                # 但排查时能一眼看出是"读到了但被过滤掉"。
                                logger.debug(
                                    "Gateway 成交 %d 条但无新增平仓明细 login=%s"
                                    "（已去重或归属不匹配）", len(deals), login,
                                )
                    except Exception:
                        logger.exception("gateway closed-trade scan failed (login=%s)", login)

                # 已确认空仓的账号跳过：没有持仓就没有浮盈要刷，这一次 MT5 往返
                # 纯属浪费。安全性靠两点保证：
                #   1. 只有真的轮询到空列表才会进这个集合（不是猜的）
                #   2. 只在订阅活着时才敢跳过 —— 仓位再出现时会有 ADD 事件把它
                #      移出集合。订阅挂了就把集合清空，退回全量轮询。
                # 所以最坏情况是多轮询几次，不会漏掉持仓。
                #
                # Skip accounts known to be flat: no positions means no P/L to
                # refresh. Safe because entries come only from an actual empty
                # poll, and only while the subscription is alive to re-add them
                # via ADD events. Worst case is redundant polling, never a miss.
                if subscription_state["alive"] and login in known_flat:
                    continue

                rows, ok = await _read_positions(login)
                if not ok:
                    continue

                # 标记空仓：下轮慢拍可以跳过（前提是订阅活着）
                if rows:
                    known_flat.discard(login)
                else:
                    known_flat.add(login)

                data.extend(rows)

            # 与 /bridge/positions 走同一个方法：缓存快照 + 附带按 login 汇总的
            # 浮动盈亏 + 跳过重复推送。gateway 的资金刷新是 15 秒一次，光靠它
            # 账户卡片会明显滞后于持仓表。
            # Same path as /bridge/positions: cache the snapshot, attach per-login
            # floating P/L, skip unchanged ticks. The gateway funds refresh runs
            # every 15s, which would leave the account card behind.
            await manager.push_positions(user_id, data)

            # 余额变化时推 ACCOUNTS_STATUS，让账户卡片不必等前端 5 秒轮询。
            # 用只管余额的那个函数：gateway 账号没有心跳，不能参与在线状态判定。
            # Push ACCOUNTS_STATUS on balance changes so the account card doesn't
            # wait for the frontend's 5s poll. Uses the balance-only helper since
            # gateway accounts have no heartbeat and must not affect liveness.
            mine = {lg: known_balances[lg] for lg in logins if lg in known_balances}
            if mine:
                await push_balances_if_changed(user_id, mine)

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

    def _accounts_by_user(pairs: list[tuple[str, str]]) -> dict[str, list[str]]:
        """(user_id, login) 列表聚合成 user_id -> [login]。

        前端的 POSITIONS 消息是「该用户全部持仓」的快照，所以必须按用户聚合后
        一次推完，不能每账号推一次。
        """
        out: dict[str, list[str]] = {}
        for user_id, login in pairs:
            out.setdefault(user_id, []).append(login)
        return out

    async def _event_pump() -> None:
        """快拍：把 gateway 订阅积压的开平仓事件取走并立即推送。

        这个循环与慢拍并行跑。它每 0.25 秒只发一个 HTTP 请求（GET
        /position-events），成本与用户数无关 —— gateway 那端只是读内存队列。
        只有真的收到事件时才会去读持仓，所以空闲时的开销就是一个空响应。

        The fast tick, running alongside the slow one. One HTTP call every 250ms
        regardless of user count: the gateway just drains an in-memory queue.
        Positions are only read when an event actually arrives.
        """
        while True:
            try:
                # 没有人在看就不必拉。事件会积在 gateway 的队列里（满了丢最老的），
                # 但那不影响正确性：事件只是「去读一次持仓」的触发器，重新有人
                # 连上时拉到积压事件，照样会推一次完整快照。
                # Nobody watching means nothing to push. Events pile up in the
                # gateway queue (oldest dropped when full), which is harmless:
                # they're just triggers to re-read positions, and the snapshot
                # pushed on reconnect is complete regardless.
                if not manager.connected_user_ids():
                    await asyncio.sleep(GATEWAY_EVENT_POLL_INTERVAL)
                    continue

                events, subscribed = await drain_position_events()

                # 订阅状态翻转要处理：订阅刚掉线时，known_flat 里的信息不再可信
                # （仓位可能在断线期间开出来而没有事件），必须清空退回全量轮询。
                if subscribed != subscription_state["alive"]:
                    subscription_state["alive"] = subscribed
                    if subscribed:
                        logger.info("Gateway 持仓订阅可用：开平仓将即时推送")
                    else:
                        logger.warning("Gateway 持仓订阅不可用：退回轮询模式")
                        known_flat.clear()

                if events:
                    # 事件里带的是 login，要反查它属于哪个用户才知道推给谁。
                    pairs = await run_in_threadpool(_gateway_accounts)
                    owner = {lg: uid for uid, lg in pairs}
                    by_user = _accounts_by_user(pairs)
                    connected = set(manager.connected_user_ids())

                    # 一个用户可能在同一批事件里出现多次（同时开两笔、或开+平），
                    # 但快照推一次就够了，按用户去重避免重复读持仓。
                    # A user can appear several times in one batch, but one
                    # snapshot suffices — dedupe to avoid re-reading positions.
                    affected: set[str] = set()
                    for e in events:
                        login = str(e.login)
                        uid = owner.get(login)
                        if uid is None:
                            # 不是本平台管理的账号（同一 MT5 服务器上的其他账号
                            # 也会触发回调），忽略。
                            continue
                        # ADD 说明这个账号现在有仓，先把它从空仓集合里拿出来，
                        # 免得慢拍在下一次读取前一直跳过它。
                        if e.action == "add":
                            known_flat.discard(login)
                        if uid in connected:
                            affected.add(uid)

                    if affected:
                        results = await asyncio.gather(
                            *(
                                _push_user_snapshot(uid, by_user.get(uid, []))
                                for uid in affected
                            ),
                            return_exceptions=True,
                        )
                        for uid, r in zip(affected, results):
                            if isinstance(r, asyncio.CancelledError):
                                raise r
                            if isinstance(r, Exception):
                                logger.error(
                                    "gateway 事件推送失败 (user=%s)", uid, exc_info=r
                                )

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("gateway 事件快拍异常")

            await asyncio.sleep(GATEWAY_EVENT_POLL_INTERVAL)

    # 快拍与慢拍并行。快拍负责「仓位出现/消失」的即时性，慢拍负责浮盈刷新、
    # 资金刷新、平仓明细落库这些周期性工作。
    async def _positions_loop() -> None:
        """慢拍：周期性刷新浮盈、资金、平仓明细。"""
        while True:
            try:
                # 没有任何前端连着时，先跳过这一拍——连查一次 mt5_accounts 都省掉。
                # 慢拍的产出（浮盈/资金/平仓明细）全部要推给正在看的前端；没人看
                # 时这次查库（远端 Supabase 的一次网络往返）纯属浪费。有人连上会在
                # 下一拍立即恢复，行为与之前完全一致。
                # Skip the whole tick when no client is connected — even the
                # mt5_accounts read is spared. Everything this tick produces is
                # pushed to a watching frontend; with nobody watching, the query
                # (a round trip to remote Supabase) is pure waste. A connecting
                # client is picked up on the next tick, behavior unchanged.
                connected = set(manager.connected_user_ids())
                if not connected:
                    await asyncio.sleep(GATEWAY_POSITIONS_INTERVAL)
                    continue

                pairs = await run_in_threadpool(_gateway_accounts)
                by_user = _accounts_by_user(pairs)
                targets = [(uid, lg) for uid, lg in by_user.items() if uid in connected]

                if targets:
                    # 并发跑各用户，并发度由 sem 限制。
                    # return_exceptions=True 是关键：单个用户炸了不能让整轮中断，
                    # 否则一个坏账号会连带拖停所有人的持仓推送。
                    # return_exceptions=True matters: one user blowing up must not
                    # abort the tick, or a single bad account would stall everyone's
                    # position pushes.
                    results = await asyncio.gather(
                        *(_process_user(uid, lg) for uid, lg in targets),
                        return_exceptions=True,
                    )
                    for (uid, _), r in zip(targets, results):
                        if isinstance(r, asyncio.CancelledError):
                            # 关服时的正常取消，往上抛让循环退出
                            raise r
                        if isinstance(r, Exception):
                            # 用 error + exc_info 而不是 exception()：这里不在 except
                            # 块里，exception() 取不到当前异常，只能显式传。
                            # error(exc_info=...) rather than exception(): we're not
                            # inside an except block, so there's no "current" exception.
                            logger.error(
                                "gateway user tick failed (user=%s)", uid, exc_info=r
                            )

            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("gateway_positions_loop 异常")

            await asyncio.sleep(GATEWAY_POSITIONS_INTERVAL)

    pump_task = asyncio.create_task(_event_pump())

    try:
        await _positions_loop()
    finally:
        pump_task.cancel()
