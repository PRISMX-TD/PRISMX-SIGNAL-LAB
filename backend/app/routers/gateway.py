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
from app.core.rate_limit import (
    clear_failed_mt5_verify,
    is_mt5_verify_locked,
    limiter,
    record_failed_mt5_verify,
)
from app.models import ClosedTrade, MT5Account, Order, User
from app.services.account_type import classify_group
from app.services.deps import get_current_user
from app.services.gateway_binding import enforce, is_revoked
from app.services.gateway_client import (
    get_account as gw_get_account,
    get_deals as gw_get_deals,
    get_positions as gw_get_positions,
    run_on_main_loop,
    verify_account as gw_verify,
)
from app.services.plans import max_mt5_accounts
from app.services.settings_store import get_account_type_settings
# 余额推送与 bridge 共用同一份去重状态（_last_pushed_balances），所以直接复用
# bridge 里的函数，而不是各自维护一套——两套状态会互相覆盖对方的余额。
# bridge 不导入 gateway，这个方向不会形成循环导入。
# Balance pushes share bridge's de-duplication state (_last_pushed_balances), so
# reuse its helper instead of keeping a second copy that would clobber the other
# side's balances. bridge doesn't import gateway, so this direction is safe.
from app.routers.bridge import push_balances_if_changed

logger = logging.getLogger("prismx.gateway.router")

router = APIRouter(prefix="/gateway", tags=["gateway"])

# 绑定失效时对用户说的话。按站内惯例做成「中文 / English」，前端的
# localizeApiError 直接可用。
#
# 措辞刻意只说"需要重新验证"，不说"因为你改了密码"：撤销的判据是券商记录的
# 改密时间变了，那件事未必是用户自己干的（券商重置、账号转手），断言原因会在
# 少数情况下把话说错。要查真实原因看服务端日志。
#
# What the user is told when a binding is revoked. Deliberately says
# "re-verify" rather than "you changed your password": the trigger is the
# broker's record changing, which the user did not necessarily do themselves.
_REVOKED_DETAIL = (
    "该 MT5 账号的密码已变更，连接已断开，请重新验证 / "
    "This MT5 account's password changed; the connection was revoked, please verify again"
)


# ---------- 请求/响应模型 ----------


class GatewayVerifyRequest(BaseModel):
    """绑定请求。**只有主密码**——这里曾经有一个 `investorOnly` 布尔字段。

    为什么删掉：投资者密码在券商侧是只读凭证，但 gateway 绑定成功后所有操作都
    由 manager 代劳、不再校验任何密码，所以用投资者密码绑上来，等于把「只能看」
    当场换成「能下单」。前端从来没传过 true，但这个字段在请求体里，任何登录用户
    直接打接口就能用只读凭证拿到完整交易权限。

    Main password only; this used to carry an `investorOnly` flag. The investor
    password is read-only at the broker, yet nothing re-checks any password after
    a successful bind — so binding with it silently upgraded read-only access to
    order placement. The frontend never sent true, but the field was in the
    request body, so any logged-in caller could.
    """

    login: int = Field(..., gt=0, description="MT5 账号")
    password: str = Field(..., min_length=1, description="MT5 主密码")


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
    # 绑定是否已失效、需要用户重新输一次主密码。
    # Whether this binding was revoked and needs the main password re-entered.
    needsReverify: bool = False
    revokedReason: str = ""


def _notify_revoked(user_id: str, login: str) -> None:
    """绑定被撤销时给用户推一条通知。同步、阻塞网络 IO，只能在线程里调。

    失败只记日志、不往上抛：撤销本身已经落库生效了，通知发不出去不该反过来
    影响它。推送这条路本来就可能因为用户没订阅、等级不够、浏览器拒绝而到不了
    ——界面上的「需重新验证」才是主要告知渠道，这里是尽力而为的补充。

    Notify the user that a binding was revoked. Synchronous blocking IO, so
    callers must already be off the event loop. Failures are logged and
    swallowed: the revocation is already committed and must not be undone by a
    push failure, and push is best-effort anyway (no subscription, plan gate,
    denied permission) — the in-app "needs re-verification" state is the primary
    channel.
    """
    from app.services.push_dispatch import EVENT_ACCOUNT_REVOKED, dispatch_event_push

    try:
        dispatch_event_push(
            user_id,
            EVENT_ACCOUNT_REVOKED,
            "MT5 连接已断开",
            f"账号 {login} 的密码已变更，自动交易已停止。请到「连接 MT5」重新验证。",
        )
    except Exception:
        logger.exception("撤销通知推送失败: user=%s login=%s", user_id, login)


def _verify_failure(rsp) -> HTTPException:
    """把 gateway 的失败响应翻译成对用户有意义的 HTTP 错误。

    以前这里一律是 502「Gateway 不可用」，于是三件完全不同的事看起来一模一样：
    网关真的断了、账号所属组不在 gateway.ini 的 allowed_groups 白名单里、
    账号号码填错了。第二种尤其误导——券商刚开通真仓权限、白名单还停在
    `demo` 时，用户填真仓账号得到的提示是「网关不可用」，会让人去查一台其实
    好端端的服务器。

    但「账号不存在」这一类不再由本函数处理：它已被调用方合并进「账号或密码不
    正确」的 valid=False 分支。理由是这个端点会把账号密码转发到券商去验，若
    「不存在」与「密码错」可区分，任何登录用户都能拿它当探针枚举出券商真实存在
    的账号号段——那是撞库的前置步骤。合并后仍与「网关故障」「组未开放」两类清晰
    分开，上面那个 UX 教训依然成立：真正会让人去查健康服务器的是那两类。

    Translate a gateway failure into something the user can act on. This used to
    be a blanket 502 "gateway unavailable", which made three unrelated things
    look identical: a real outage, an account whose group isn't in the gateway's
    allowed_groups whitelist, and a mistyped login. The middle one is the
    misleading one — right after the broker enables live accounts but before the
    whitelist is updated, a live login reports "gateway unavailable" and sends
    everyone hunting a server that is perfectly healthy.

    "Account not found" is no longer handled here: the caller folds it into the
    same valid=False answer as a wrong password. This endpoint forwards
    credentials to the broker for verification, so a distinguishable "no such
    account" lets any logged-in user enumerate the broker's real login range —
    step one of credential stuffing. Folding it in still leaves outages and
    non-whitelisted groups clearly separate, which is where the UX lesson above
    actually applies.
    """
    if rsp.error == "group_not_allowed":
        return HTTPException(
            status_code=403,
            detail=(
                "该 MT5 账号所属的组尚未开放接入，请联系客服 / "
                "This MT5 account's group is not enabled for linking yet — please contact support"
            ),
        )

    if rsp.error == "timeout":
        return HTTPException(
            status_code=504,
            detail="Gateway 响应超时，请稍后重试 / Gateway timed out, please try again",
        )

    # 剩下的才是真正的「网关不可用」：连不上、401（token 不一致）、500。
    # 具体是哪一种只记日志，不回给客户端：rsp.error / rsp.retcode 是网关与 MT5 的
    # 内部状态（含 MTRetCode 枚举名），对普通用户没有任何可操作性，却能让人推断出
    # 后端拓扑与故障位置。调用方在抛出前已经打过一条含全部字段的 warning 日志，
    # 运维要分辨是哪一种，看那条日志即可。
    # What's left really is an unavailable gateway: unreachable, 401 (token
    # mismatch), 500. Which one goes to the log, not to the client: rsp.error and
    # rsp.retcode are gateway/MT5 internal state (MTRetCode enum names included) —
    # useless to a user, but enough to infer our topology and where it broke. The
    # caller already logs a warning carrying every field, which is where ops
    # should look.
    return HTTPException(
        status_code=502,
        detail="账号服务暂时不可用，请稍后重试 / account service temporarily unavailable",
    )


# ---------- 端点 ----------


@router.post("/verify", response_model=GatewayVerifyResponse)
@limiter.limit(settings.RATE_LIMIT_GATEWAY_VERIFY)
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
    # 0) 按 MT5 账号维度的失败锁定。端点自身的 IP 限流挡不住轮换出口 IP 对同一个
    #    账号的持续试探，而这个端点每次调用都是一次真实的券商侧密码校验——两个
    #    维度都堵住，才不至于让平台变成对券商撞库的代理。
    #    Per-login lockout. The endpoint's IP limit does nothing against rotating
    #    egress IPs hammering one account, and every call here is a real
    #    credential check at the broker; both dimensions must be closed so the
    #    platform can't serve as a brute-force proxy against it.
    if is_mt5_verify_locked(req.login):
        logger.warning("Gateway 验证已锁定: user=%s login=%s", user.id, req.login)
        raise HTTPException(
            status_code=429,
            detail=(
                "该 MT5 账号验证失败次数过多，请稍后再试 / "
                "Too many failed verification attempts for this MT5 account, try again later"
            ),
        )

    # 1) 调 gateway 验证
    rsp = run_on_main_loop(gw_verify(req.login, req.password), timeout=65.0)

    if not rsp.ok:
        logger.warning(
            "Gateway 验证被拒: user=%s login=%s status=%s error=%s message=%s",
            user.id, req.login, rsp.status, rsp.error, rsp.message[:200],
        )
        # 账号不存在/读不出来，与密码错返回完全相同的结果（见 _verify_failure 的
        # 说明）：对外只有「账号或密码不正确」这一个答案，问不出该账号在券商侧
        # 是否存在。同样计入失败锁定——枚举正是靠反复问这个问题。
        # An unreadable/nonexistent account answers exactly as a wrong password
        # does (see _verify_failure): the only observable outcome is "login or
        # password incorrect", which reveals nothing about whether the account
        # exists at the broker. It counts toward the lockout too — enumeration is
        # precisely the act of asking this repeatedly.
        if rsp.status == 404:
            record_failed_mt5_verify(req.login)
            return GatewayVerifyResponse(ok=True, valid=False, login=req.login)
        raise _verify_failure(rsp)

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

    # 2) 检查账户数上限。**只在真要新增一行时才查**：这个账号已经绑过的话，
    #    这次调用不会让账号数增加，拿上限挡它没有任何道理。
    #
    #    以前是不分情况一律查的，于是 FREE（上限 1）用户重新验证自己那唯一一个
    #    账号会得到「已达到账户数上限」。原本只是个别扭的边角，现在是硬伤：
    #    重新验证是绑定被撤销后**唯一**的恢复路径，挡住它等于让 FREE 用户一旦
    #    被撤销就再也连不上，除非先解绑——而解绑会把历史战绩的归属一起弄丢。
    #
    #    Only enforced when a new row would actually be created: re-verifying an
    #    already-bound account doesn't increase the count. This used to be checked
    #    unconditionally, so a FREE user (limit 1) re-verifying their only account
    #    was told they'd hit the limit. That was merely odd before; it is now a
    #    real defect, because re-verification is the only recovery path from a
    #    revoked binding — blocking it would strand FREE users unless they unbind
    #    first, which orphans their trading history.
    account_limit = max_mt5_accounts(user.plan)
    if existing is None and rsp.valid and account_limit is not None:
        existing_count = (
            db.query(MT5Account)
            .filter(MT5Account.user_id == user.id)
            .count()
        )
        if existing_count >= account_limit:
            raise HTTPException(
                status_code=403,
                detail=f"已达到账户数上限（{account_limit}），请升级或删除旧账号",
            )

    # 3) 验证通过则创建/更新 MT5Account
    if rsp.valid:
        clear_failed_mt5_verify(req.login)
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
        # 组名与由它判出的账户类型。gateway 是唯一拿得到券商侧组名的通道，
        # 也是唯一"用户碰不到"的实盘依据（见 services/account_type.py）。
        # 每次刷新都重写，规则改了下一轮自动纠正。
        existing.mt5_group = rsp.group or None
        existing.trade_mode = classify_group(rsp.group, get_account_type_settings(db))

        # 记下券商侧的「上次改密码时间」。这是本次授权的凭据：轮询每 15 秒拿
        # 当前值来比，对不上就说明用户刚才输的那个密码已经不是账号现在的密码，
        # 这次绑定的授权随之作废（判据见 services/gateway_binding.enforce）。
        #
        # 0 表示券商没给这个信号，落 None —— 校验逻辑会跳过该账号，而不是把 0
        # 当成一个真实时间去比对（那会让每个账号一绑上就立刻被撤销）。
        #
        # Record the broker's last-password-change time as this authorisation's
        # credential. 0 means the broker gave no signal and is stored as None so
        # the checker skips the account instead of comparing against zero.
        existing.pass_change_at = rsp.last_pass_change or None
        # 重新验证即重新授权：把撤销标记清掉，账号立刻恢复。这也是被撤销的用户
        # 唯一的恢复路径 —— 走的是和首次绑定完全相同的这段代码。
        # Re-verifying re-authorises: clear the revocation so the account comes
        # back. This is the only recovery path, and it is the same code as a
        # first-time bind.
        was_revoked = existing.revoked_at is not None
        existing.revoked_at = None
        existing.revoked_reason = None

        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail="该账号已绑定")

        logger.info(
            "Gateway 绑定成功: user=%s login=%s group=%s trade_mode=%s%s",
            user.id, login_str, rsp.group, existing.trade_mode,
            "（已从撤销状态恢复）" if was_revoked else "",
        )
        if not rsp.last_pass_change:
            # 券商没填 LastPassChange，或网关是加这个字段之前的版本。这台服务器
            # 上「改密码即撤销绑定」这道闸不生效，绑定会一直有效到用户手动解绑。
            # 记一条可检索的日志：这是安全能力的静默缺失，不该只在代码注释里存在。
            # The broker doesn't fill LastPassChange (or the gateway predates the
            # field): password-change revocation is inert for this account and the
            # binding stays valid until manually removed. Logged because it is a
            # silently missing security control.
            logger.warning(
                "Gateway 绑定缺少改密时间信号: login=%s —— 该账号改密码后不会自动撤销绑定，"
                "请确认网关版本，并用 selftest 确认券商是否提供 LastPassChange",
                login_str,
            )
        if existing.trade_mode is None and rsp.group:
            # 组名判不出类型：该账号会被排除在所有实盘统计之外。留一条可检索的
            # 日志，运维照它把前缀补进 account_type 设置即可。
            # Unclassifiable group: the account is excluded from every real-account
            # statistic. Logged so ops can add the prefix to the account_type setting.
            logger.warning(
                "账户类型判不出：login=%s group=%s —— 该账号暂不计入实盘统计，"
                "请把该组前缀补进平台设置 account_type",
                login_str, rsp.group,
            )
    else:
        record_failed_mt5_verify(req.login)
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
            needsReverify=is_revoked(row),
            revokedReason=row.revoked_reason or "",
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

    # 已撤销的绑定不再代表用户去券商读任何东西，与轮询循环的口径一致。
    # A revoked binding reads nothing on the user's behalf, matching the poller.
    if is_revoked(row):
        raise HTTPException(status_code=409, detail=_REVOKED_DETAIL)

    rsp = run_on_main_loop(gw_get_account(int(login)), timeout=65.0)
    if rsp is None:
        raise HTTPException(status_code=502, detail="Gateway 查询账号失败")

    # 手动刷新走的是和轮询同一套判据：这个端点也拿得到 lastPassChange，漏掉
    # 就等于给了一条「刷新能用、轮询会撤销」的不一致路径。
    # Same rule as the poller: this endpoint also receives lastPassChange, and
    # skipping it here would leave an inconsistent path.
    if not enforce(
        db, row,
        getattr(rsp, "last_pass_change", 0),
        on_revoke=lambda: _notify_revoked(user.id, login),
    ):
        raise HTTPException(status_code=409, detail=_REVOKED_DETAIL)

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

# 成交订阅可用时的兜底扫描间隔。
#
# 订阅建立后，平仓由 /deal-events 在 0.25 秒的快拍里即时触发扫描，这条定时扫描
# 就从「发现平仓的主路径」降级成「兜底」——它存在的意义只剩下：事件因队列溢出
# 被丢、或某次事件读取失败时，仍能在可接受的时间内补上。
#
# 所以这里必须放宽，否则这次改造就是「只加不减」：延迟降下来了，查询次数一次没少。
# 15 秒是每 login 每分钟从 20 次 Manager API 往返降到 4 次。
#
# 订阅不可用时自动回落到 3 秒（见 _process_user 里的取值逻辑），行为与改造前一致。
#
# Fallback scan interval while the deal subscription is alive. With it, closes are
# picked up by the 0.25s event pump, so this timer stops being the discovery path
# and becomes a safety net for dropped or failed event reads. Relaxing it is the
# whole point — otherwise this change would only add latency wins without removing
# any queries. Falls back to 3s automatically when unsubscribed.
GATEWAY_DEALS_SCAN_INTERVAL_SUBSCRIBED = 15.0

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


async def _read_positions(login: str) -> tuple[list[dict], bool]:
    """读一个账号的持仓，转成前端/自动仓管使用的格式。返回 (列表, 是否成功)。

    这里产出的字典是 gateway 通道唯一的持仓数据来源，同时喂给三个消费方：
    前端的 POSITIONS 推送、胜率对账（mark_positions_seen）、自动仓位管理
    （auto_manage.evaluate_positions）。键名必须与 bridge 上报的载荷一致，
    否则消费方会静默读到 None —— 比如 side 若不是大写的 "BUY"/"SELL"，
    auto_manage 会把每个仓位都跳过，且不报任何错。

    模块级函数而非循环内的闭包，就是为了让这层映射能被单独测到（见
    tests/test_auto_manage_gateway.py 里的 gateway 数据链路用例）。

    The only source of position data on the gateway channel, consumed by the
    frontend push, win-rate reconciliation and auto-management alike. Key names
    must match the bridge's payload or consumers silently read None — e.g. a
    lowercase side would make auto_manage skip every position without an error.
    Kept at module level rather than nested in the loop so it can be tested.
    """
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
    from app.services.gateway_client import drain_deal_events, drain_position_events

    # ----- 共享状态与辅助函数 -----

    def _gateway_accounts() -> list[tuple[str, str]]:
        """(user_id, login) 列表。只取有 WS 连接的用户，避免空转。

        已撤销的绑定整条排除：不读持仓、不刷资金、不扫平仓。撤销的含义是
        「这次授权已经作废」，那就不该继续代表用户去券商那边读任何东西——
        只挡下单、却仍然把持仓和余额拉回来推给前端，是自相矛盾的半吊子撤销。
        Revoked bindings are excluded entirely: no positions, no funds, no close
        scan. Revocation means the authorisation is void, so continuing to read
        the account on the user's behalf — and only blocking orders — would be a
        half-measure that contradicts itself.
        """
        db = SessionLocal()
        try:
            rows = (
                db.query(MT5Account.user_id, MT5Account.login)
                .filter(
                    MT5Account.source == "gateway",
                    MT5Account.revoked_at.is_(None),
                )
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
        # 本轮是否发生了撤销。用可变容器而不是直接在回调里发通知：发通知是一次
        # 阻塞的 Web Push 网络往返，在下面的 try 里发就意味着整段网络 IO 期间
        # 都攥着一条数据库连接不放。挪到 finally 里、db.close() 之后再发。
        # Whether this tick revoked. The notification is a blocking Web Push
        # round-trip, so it is deferred to after db.close() rather than fired
        # from inside the callback, which would hold a DB connection for the
        # duration of that network IO.
        revoked: list[int] = []
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

            # 改密比对。放在这里而不是单开一个循环：这一拍本来就已经拿着券商
            # 刚返回的账号记录，`lastPassChange` 随资金一起回来，比对是纯内存
            # 运算，一次 Manager API 往返都不用多花。
            #
            # 撤销后直接 return：这一轮不再写余额，也不推送持仓。下一轮
            # _gateway_accounts 就不会再选中这个账号了。
            #
            # Password-change check. It lives here because this tick already holds
            # the broker's fresh account record — lastPassChange rides along with
            # the funds, so the comparison costs no extra Manager API round-trip.
            if not enforce(
                db, row,
                getattr(rsp, "last_pass_change", 0),
                on_revoke=lambda: revoked.append(1),
            ):
                return None

            row.balance = rsp.balance
            row.equity = rsp.equity
            row.leverage = rsp.leverage
            if rsp.name:
                row.account_name = rsp.name
            # 组名与账户类型每轮重写：券商把账号挪组、或运维改了前缀规则，
            # 都在下一次资金刷新时自动跟上，不需要用户重新绑定。
            # Rewritten every round so a regrouped account or a changed prefix
            # rule self-corrects without the user re-binding.
            if rsp.group:
                row.mt5_group = rsp.group
                row.trade_mode = classify_group(rsp.group, get_account_type_settings(db))
            db.commit()
            return float(row.balance or 0.0)
        finally:
            db.close()
            if revoked:
                # 撤销之后界面上这个账号会变成"需重新验证"，但用户不一定正开着
                # 页面，而在他重新验证之前，所有自动下单都是静默失效的。推一条
                # 通知是唯一能主动够到他的手段。本函数由 run_in_threadpool 调进
                # 来，已经不在事件循环上，所以可以直接用同步版本。
                # The UI will show "needs re-verification", but the user may not
                # have the page open, and until they act every automated order
                # silently fails. This runs in a thread pool, so the synchronous
                # dispatcher is fine here.
                _notify_revoked(user_id, login)

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
                    # 这条通道天然可核验：成交历史是本服务端直接向券商 Manager API
                    # 取的，不经用户机器；归属判定也已在 build_closed_trade_legs
                    # 里做过（主依据就是上面这份 known 仓位号）。与桥接通道的
                    # verified 是同一个语义，见 models.ClosedTrade.verified。
                    # Inherently verifiable: this history comes from the broker's
                    # Manager API through our own server, never via the user's
                    # machine, and attribution already ran in build_closed_trade_legs.
                    verified=True,
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

    # 成交订阅是否可用。与持仓订阅分开跟踪：券商可能只给其中一个的权限，
    # 而且它决定的是另一件事——平仓兜底扫描用 15 秒还是 3 秒。
    # Tracked separately from the position subscription: the broker may grant one
    # and not the other, and this one decides the fallback scan interval.
    deal_subscription_state = {"alive": False}

    # 正在扫描平仓明细的 login。快拍 0.25 秒一拍、慢拍 2 秒一拍，收到成交事件时
    # 两边可能同时想扫同一个账号；重复扫不会写坏数据（唯一约束去重），但会白白
    # 多打一次 Manager API 往返。
    # Logins with a closed-trade scan in flight, so the 0.25s pump and the 2s tick
    # don't scan the same account twice.
    deals_in_flight: set[str] = set()

    # 一轮内限制同时在飞的用户数，避免把 gateway 的单连接打满。
    # Cap in-flight users per tick so we don't saturate the gateway's single link.
    sem = asyncio.Semaphore(GATEWAY_MAX_CONCURRENT_USERS)

    async def _scan_deals(user_id: str, login: str) -> None:
        """拉取并入库一个账号的平仓明细。

        快拍（收到成交事件，即时）与慢拍（定时兜底）共用这一份实现——两处各写一遍
        必然长歪，而这段代码里藏着好几个来之不易的细节：`to` 要往后留一天余量、
        首扫用 7 天宽窗补空档、归属不匹配时降到 debug 免得刷屏。

        `deals_in_flight` 防止同一账号被并发扫两次：快拍 0.25 秒一拍，慢拍 2 秒
        一拍，收到事件时两边可能撞在一起。重复扫描不会写坏数据（唯一约束会去重），
        但会白白多打一次 Manager API 往返，而"减少往返"正是本次改造的目的之一。

        Shared by the fast path (deal event just arrived) and the slow fallback
        timer. One implementation, because this block carries several hard-won
        details: the one-day pad on `to`, the 7-day first-scan window, the debug-level
        log when attribution doesn't match. `deals_in_flight` stops the 0.25s pump and
        the 2s tick from scanning the same login at once — harmless for data (the
        unique constraint dedupes) but a wasted round trip, and cutting round trips
        is half the point of this change.
        """
        if login in deals_in_flight:
            return
        deals_in_flight.add(login)
        try:
            last_deals_scan[login] = time.monotonic()
            first_scan = login not in scanned_once
            scanned_once.add(login)
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
        finally:
            deals_in_flight.discard(login)

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

        await manager.push_positions(user_id, data, source="gateway")

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
            failed = False
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

                # --- 平仓明细扫描（兜底节奏）---
                # 成交订阅可用时放宽到 15 秒：此时发现平仓的主路径是快拍里的
                # /deal-events 即时触发，这条定时扫描只负责兜底（事件丢了/读失败）。
                # 订阅不可用则回落到 3 秒，与改造前完全一致。
                # Relaxed to 15s while the deal subscription is alive: discovery then
                # happens in the event pump and this timer is only a safety net.
                # Falls back to 3s when unsubscribed, exactly as before.
                scan_interval = (
                    GATEWAY_DEALS_SCAN_INTERVAL_SUBSCRIBED
                    if deal_subscription_state["alive"]
                    else GATEWAY_DEALS_SCAN_INTERVAL
                )
                if now - last_deals_scan.get(login, 0.0) >= scan_interval:
                    await _scan_deals(user_id, login)

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
                    # 读失败就放弃整轮推送，与快拍保持一致（见 _push_user_snapshot）。
                    # 只 continue 会把该账号的持仓从 data 里漏掉，然后照样推出去，
                    # 前端是整表替换 —— 单账号用户会直接看到持仓表清空，下一拍
                    # 又恢复。晚 2 秒更新远好过让仓位凭空消失一下。
                    #
                    # Abandon the whole push when a read fails, matching the fast
                    # tick. Skipping just this login would still push the rest as a
                    # complete snapshot, and the frontend replaces wholesale — a
                    # single-account user would watch their positions vanish and
                    # come back. Being 2s stale beats flickering.
                    failed = True
                    break

                # 标记空仓：下轮慢拍可以跳过（前提是订阅活着）
                if rows:
                    known_flat.discard(login)
                else:
                    known_flat.add(login)

                data.extend(rows)

            # 本轮有账号读失败：data 不是完整快照，推它会让前端丢行。下游的
            # mark_positions_seen 也吃这个 data 做胜率对账与自动仓管，喂残缺
            # 数据可能被当成"仓位已消失"，所以整轮一起跳过，等下一拍。
            #
            # A failed read means `data` is not a full snapshot. Besides the
            # flicker, mark_positions_seen consumes it for reconciliation and auto
            # position management, where a missing row could read as "closed".
            # Skip the whole round and let the next tick handle it.
            if failed:
                return

            # 与 /bridge/positions 走同一个方法：缓存快照 + 附带按 login 汇总的
            # 浮动盈亏 + 跳过重复推送。gateway 的资金刷新是 15 秒一次，光靠它
            # 账户卡片会明显滞后于持仓表。
            # Same path as /bridge/positions: cache the snapshot, attach per-login
            # floating P/L, skip unchanged ticks. The gateway funds refresh runs
            # every 15s, which would leave the account card behind.
            await manager.push_positions(user_id, data, source="gateway")

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
                deal_logins, deal_subscribed = await drain_deal_events()

                if deal_subscribed != deal_subscription_state["alive"]:
                    deal_subscription_state["alive"] = deal_subscribed
                    if deal_subscribed:
                        logger.info(
                            "Gateway 成交订阅可用：平仓即时入库，兜底扫描放宽至 %.0f 秒",
                            GATEWAY_DEALS_SCAN_INTERVAL_SUBSCRIBED,
                        )
                    else:
                        logger.warning(
                            "Gateway 成交订阅不可用：兜底扫描回落至 %.0f 秒",
                            GATEWAY_DEALS_SCAN_INTERVAL,
                        )

                # 订阅状态翻转要处理：订阅刚掉线时，known_flat 里的信息不再可信
                # （仓位可能在断线期间开出来而没有事件），必须清空退回全量轮询。
                if subscribed != subscription_state["alive"]:
                    subscription_state["alive"] = subscribed
                    if subscribed:
                        logger.info("Gateway 持仓订阅可用：开平仓将即时推送")
                    else:
                        logger.warning("Gateway 持仓订阅不可用：退回轮询模式")
                        known_flat.clear()

                if events or deal_logins:
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

                    # 成交事件：立刻去拉这个账号的平仓明细，不等兜底扫描。
                    # 这是本条改造的核心——平仓从「最多等 3 秒被扫到」变成
                    # 「事件到达即拉」，端到端降到 1 秒以内。
                    #
                    # 与持仓事件一样要过滤非本平台账号：成交订阅是**服务器级**的，
                    # 同一台 MT5 上其他券商客户的成交也会回调进来。
                    #
                    # 不管用户当前在不在线都扫：平仓明细是要落库的历史数据，
                    # 用户回来时应该已经在列表里，而不是等他连上才补。这与持仓
                    # 快照不同（那个只对在线用户有意义，推给没连接的人是浪费）。
                    #
                    # Deal events: fetch this account's closed trades right away
                    # instead of waiting for the fallback timer — the core of this
                    # change, taking close-to-visible from up to 3s down to under 1s.
                    # Same filtering as positions (the subscription is server-wide).
                    # Scanned regardless of whether the user is online: closed trades
                    # are persisted history that should already be there when they
                    # return, unlike a position snapshot which only matters live.
                    deal_scans = []
                    for lg in deal_logins:
                        login = str(lg)
                        uid = owner.get(login)
                        if uid is None:
                            continue
                        deal_scans.append(_scan_deals(uid, login))

                    if deal_scans:
                        results = await asyncio.gather(*deal_scans, return_exceptions=True)
                        for r in results:
                            if isinstance(r, asyncio.CancelledError):
                                raise r
                            if isinstance(r, Exception):
                                logger.error("gateway 成交事件扫描失败", exc_info=r)

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
