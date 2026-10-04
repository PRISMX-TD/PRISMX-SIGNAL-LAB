"""认证依赖与风控 / Auth dependencies and risk control."""
import logging
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Response, status
from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from app.core.config import settings
from app.core.database import SessionLocal, get_db
from app.core.security import create_access_token, decode_token_payload
from app.models import User, UserActiveDay
from app.services import shared_cache
from app.services.plan_expiry import downgrade_if_expired
from app.services.symbol_aliases import is_volume_on_step, lot_step, min_lot

# 滑动续期响应头：token 剩余有效期不足一半时，经此头下发新 token，
# 前端收到后自动替换本地 token，实现无感续期（不再每天被踢下线）。
# Sliding-renewal header: when the token has less than half its lifetime
# left, a fresh token is issued via this header; the frontend swaps it in
# silently so active users are never forced to re-login.
REFRESHED_TOKEN_HEADER = "X-Refreshed-Token"

logger = logging.getLogger("prismx.deps")

# 账号在线判定窗口（秒）：桥接心跳约 3 秒一次，留 3 个周期容错，
# 既能快速反映断线（约 10 秒内置灰），又不会因偶发丢包误判离线。
# Online window (s): bridge heartbeats every ~3s; allow ~3 missed cycles so a
# disconnect is reflected within ~10s without flapping on a single drop.
ONLINE_WINDOW = 10

# last_active_at 落库节流窗口（秒）：DAU 只需要"今天活跃与否"的精度，
# 没必要每个请求都触发一次 UPDATE。
# Throttle window (s) for persisting last_active_at: DAU only needs
# day-level precision, so there's no need to UPDATE on every single request.
LAST_ACTIVE_THROTTLE_SECONDS = 300



def is_account_online(row) -> bool:
    """判断一个 MT5 账号是否在线 / whether an MT5 account is online.

    Bridge 账号看最近心跳；Gateway 账号没有心跳，看 gateway 服务是否可达。
    Bridge accounts use the last heartbeat; gateway accounts have no heartbeat,
    so their liveness follows the gateway service itself.

    已撤销的 gateway 绑定一律判离线。这是让撤销"到处生效"最省事的一处改动：
    在线状态是全站唯一的账号可用性口径（持仓路由、CLOSE/MODIFY 的单账号兜底
    路由、账户卡片、连接状态徽标都读它），从这里断掉，就不必去每个下游各补
    一次判断——那种补法必然漏。下单路径另有独立的显式拒绝（见 orders.py），
    两道是有意重复的：在线状态是给界面看的，那一道是给资金安全兜底的。
    A revoked gateway binding always reads as offline. Liveness is the one
    account-usability notion the whole app already consults (position routing,
    the single-account fallback for CLOSE/MODIFY, account cards, the connection
    badge), so cutting it here beats patching every consumer and missing some.
    The order path additionally refuses explicitly — the duplication is
    intentional: this one is for the UI, that one is the money-safety backstop.
    """
    from app.services.gateway_binding import is_removed

    # 用户已删除的账号（软删）一律离线，两条通道都是：删除后它不该再被路由到。
    # A user-removed (soft-deleted) account is offline on either channel.
    if is_removed(row):
        return False

    if getattr(row, "source", None) == "gateway":
        from app.services.gateway_binding import is_revoked
        from app.services.gateway_client import is_gateway_online

        if is_revoked(row):
            return False
        return is_gateway_online()

    if not row.last_heartbeat:
        return False
    last = row.last_heartbeat
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - last).total_seconds() < ONLINE_WINDOW


def disabled_account_error(user: User) -> HTTPException:
    """被停用账号的统一拒绝：403 + 原样带回原因（JWT 与桥接 API Token 两条鉴权共用）。

    The single refusal for a disabled account — 403 with the reason — shared by
    the JWT path (get_current_user) and the bridge API-token path.
    """
    reason = (user.disabled_reason or "").strip()
    detail = (
        f"账号已被停用：{reason} / This account has been disabled: {reason}"
        if reason
        else "账号已被停用，如有疑问请联系客服 / This account has been disabled — please contact support"
    )
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


# ---------------------------------------------------------------------------
# 轻量鉴权：只看 {tv, disabled}，不拉整行 User / lightweight auth
# ---------------------------------------------------------------------------

def get_auth_state(user_id: str) -> dict | None:
    """该用户的 {"tv": token_version, "d": 是否已停用}；用户不存在返回 None。**同步阻塞**。

    先读 shared_cache（`auth:tv:<id>`，300 秒；Redis 出错当未命中），未命中才查一次
    `users(token_version, disabled_at)` 两列并写回。不存在的用户不缓存（token 已验过签，
    来这里的「不存在」只有已删号，一次查库无所谓）。失效见 shared_cache 里的说明与本文件末尾
    的 ORM 事件。

    The user's {"tv", "d"}; None when the user doesn't exist. Blocking. Reads shared_cache first
    (a Redis error counts as a miss), then one two-column query, written back. Missing users are
    not cached. Invalidation: see shared_cache and the ORM events at the bottom of this file.
    """
    key = shared_cache.auth_state_key(user_id)
    hit = shared_cache.get_json(key)
    if isinstance(hit, dict) and isinstance(hit.get("tv"), int) and isinstance(hit.get("d"), bool):
        return hit
    db = SessionLocal()
    try:
        row = db.query(User.token_version, User.disabled_at).filter(User.id == user_id).first()
    finally:
        db.close()
    if row is None:
        return None
    state = {"tv": int(row[0] or 0), "d": row[1] is not None}
    shared_cache.set_json(key, state, ttl=shared_cache.AUTH_STATE_TTL_SECONDS)
    return state


def _disabled_error_from_db(user_id: str) -> HTTPException:
    """已停用账号才会走到：回库取一次原因，与完整鉴权的 403 文案一致（罕见路径，可以查库）。
    Only for disabled accounts: fetch the reason so the 403 reads like the full auth's (a rare
    path, a DB query is fine)."""
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if user is None:
            return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在 / User not found")
        return disabled_account_error(user)
    finally:
        db.close()


def check_token_light(token: str) -> str:
    """验签 + 会话版本 + 停用三道判定，只用缓存的 {tv, d}。通过返回 user_id，否则抛 HTTPException。
    不查整行 User、不碰 last_active_at / plan 自愈、不下发滑动续期头。
    Signature + session version + disabled, from the cached {tv, d} only. Returns the user_id or
    raises HTTPException. No full User row, no last_active_at / plan self-heal, no renewal header."""
    payload = decode_token_payload(token)
    user_id = payload.get("sub") if payload else None
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="凭证无效 / Invalid token")
    state = get_auth_state(user_id)
    if state is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在 / User not found")
    token_tv = payload.get("tv") if isinstance(payload.get("tv"), int) else 0
    if token_tv != state["tv"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="会话已失效，请重新登录 / Session invalidated, please log in again")
    if state["d"]:
        raise _disabled_error_from_db(user_id)
    return user_id


def get_current_user_id_light(authorization: str | None = Header(default=None)) -> str:
    """FastAPI 依赖：高频、只读内存缓存的接口（/chart/latest、/quotes、/symbols 等）用它代替
    get_current_user——省掉每次请求的 users 查询（远端库上还带一次 pre_ping，共 2 次往返）。
    返回 user_id。判定语义与 get_current_user 的 tv / 停用两道相同；**不**更新 last_active_at（DAU
    交给 /bridge/accounts 之类仍走完整鉴权的请求），**不**下发 X-Refreshed-Token（同理）。
    FastAPI dependency for hot, cache-only endpoints, replacing get_current_user's per-request
    users query (two remote round-trips with pre_ping). Same tv / disabled semantics; does not
    touch last_active_at nor issue X-Refreshed-Token (endpoints on the full auth cover those)."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少凭证 / Missing token")
    return check_token_light(authorization.split(" ", 1)[1])


def get_current_user(
    response: Response,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """从 Authorization: Bearer <token> 解析当前用户 / resolve current user from JWT."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少凭证 / Missing token")
    token = authorization.split(" ", 1)[1]
    payload = decode_token_payload(token)
    user_id = payload.get("sub") if payload else None
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="凭证无效 / Invalid token")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在 / User not found")

    # 会话版本校验：token 的 "tv" 必须与用户当前的 token_version 一致，否则
    # 说明这个 token 是改密码之前签发的旧凭证（可能已泄露），拒绝。老 token
    # 没有 "tv" 字段，视为版本 0，与迁移里给存量用户回填的默认值一致。
    # Session-version check: the token's "tv" must match the user's current
    # token_version, or this is a stale credential issued before a password
    # change (possibly leaked) — reject it. Tokens with no "tv" claim are
    # treated as version 0, matching the backfill for existing users.
    token_tv = payload.get("tv") if isinstance(payload.get("tv"), int) else 0
    if token_tv != (user.token_version or 0):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="会话已失效，请重新登录 / Session invalidated, please log in again")

    # 账号停用闸门：判定放在这里，于是**每一个**需要登录的接口都跟着拒绝，而不是
    # 只挡登录入口。停用要立刻生效，而本站 JWT 有效期 30 天——只挡登录的话，封号
    # 对一个已经登录着的人在一个月内毫无作用。停用时同步自增 token_version（见
    # routers/admin.disable_user），这里的 tv 校验因此也会把旧 token 一并挡掉；
    # 两道判断是有意重复的：tv 那道让 WebSocket 重连等不经过本函数的入口也失效，
    # 本道保证「原因」能原样告诉用户，也保证清空 disabled_at 就能干净恢复。
    #
    # 用 403 不用 401：401 的语义是「你没证明你是谁」，前端据此清 token 跳登录页，
    # 用户会以为掉线了、再登一次、再被踢——循环里没人看得到理由。403 是「你是谁我
    # 知道，但不给你用」，理由随 detail 一起呈现。
    #
    # 放在 tv 校验之后、_touch_last_active 之前：被停用的人不该再被计进 DAU 与
    # user_active_days，否则运营看到的活跃数里混着一批根本进不来的账号。
    #
    # The disabled-account gate. Deciding it here makes *every* authenticated
    # endpoint refuse, not just the login route — tokens here live 30 days, so a
    # login-only check would leave a banned user fully operational for a month.
    # Disabling also bumps token_version, so the check above catches the old
    # tokens too; the duplication is intentional (that one also covers entry
    # points which never call this function, like a WebSocket reconnect, while
    # this one carries the reason back to the user and makes clearing the column
    # a clean restore). 403, not 401: 401 means "you didn't prove who you are",
    # which makes the frontend drop the token and bounce to the login page, so
    # the user re-logs in, gets kicked again, and never sees why. Placed before
    # _touch_last_active so a disabled account stops counting towards DAU.
    if user.disabled_at is not None:
        raise disabled_account_error(user)

    # 会员到期即时生效：本人任一带凭证请求都会自愈等级——到期后第一次请求就把
    # plan 落库改回 FREE，之后所有 is_realtime_plan(user.plan) 等判断自然看到 FREE。
    # 不发请求、但仍被 WS 广播/推送直接按 DB plan 命中的在线用户，由后台
    # plan_expiry_sweep_loop 兜底。
    # Membership expiry takes effect immediately: any authenticated request by
    # the user self-heals — the first request after expiry persists plan back to
    # FREE, so every downstream is_realtime_plan(user.plan) check sees FREE.
    # Users who don't make requests but are still hit by WS broadcast/push via
    # the DB plan are covered by the background plan_expiry_sweep_loop.
    if downgrade_if_expired(db, user):
        db.commit()

    # 滑动续期：剩余有效期不足一半则下发新 token / sliding renewal at half-life
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        remaining = exp - datetime.now(timezone.utc).timestamp()
        if remaining < settings.JWT_EXPIRE_MINUTES * 60 / 2:
            response.headers[REFRESHED_TOKEN_HEADER] = create_access_token(user.id, user.token_version or 0)

    _touch_last_active(db, user)
    return user


def _touch_last_active(db: Session, user: User) -> None:
    """限流写入 last_active_at：同一用户 5 分钟内只落库一次，供 DAU 统计用。
    跨 UTC 日界的首次触发额外写一行 user_active_days（「三日之约」数据源）；
    与另一并发会话撞唯一约束时只撤销这一行（SAVEPOINT），last_active_at 与
    session 里其它未提交的改动照常提交，绝不向上抛异常。

    **为什么用 SAVEPOINT 而不是整体 rollback**：本函数跑在 get_current_user 里，
    与同一请求的其它写操作共用 session。整体 rollback 会把它们一起撤掉——目前
    downgrade_if_expired 先于本函数 commit 所以没实害，但以后谁在鉴权链里再加一
    个写，就会被这里悄悄吃掉。撞约束说明那一行已经存在，跳过它就是正确结果。
    Throttled last_active_at write: at most once per 5 minutes per user, for DAU.
    The first touch that crosses a UTC day boundary also inserts one
    user_active_days row. A unique-constraint collision with a concurrent
    session rolls back only that insert (SAVEPOINT); last_active_at and anything
    else pending on the session still commit. A whole-session rollback here
    would silently discard sibling writes made earlier in the auth chain."""
    now = datetime.now(timezone.utc)
    last = user.last_active_at
    if last is not None:
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if (now - last).total_seconds() < LAST_ACTIVE_THROTTLE_SECONDS:
            return
    # TODO(口径统一): 这里按 **UTC** 切天，而 PageVisitorDay.day 与整个看板用的是
    # STATS_TZ（Asia/Shanghai，见 services/stats_time.py）。北京时间 0-8 点之间两张
    # "活跃日"表会记成不同的日期，「三日之约」这类按天数判定的游戏化条件也随之
    # 早一天或晚一天达成。
    # 刻意不在本次一并改：切天口径一变，user_active_days 的历史行与新行就不同源，
    # 而游戏化的条件判定直接读这张表——改法要连同"存量是否回填、已发的徽章是否
    # 复核"一起定，属于跨模块的产品决策，不是一行 strftime 的事。
    # TODO(day boundary): this cuts days in **UTC**, while PageVisitorDay.day and
    # the whole dashboard use STATS_TZ (Asia/Shanghai, see services/stats_time.py).
    # Between 00:00 and 08:00 Beijing time the two "active day" tables record
    # different dates, and day-counting gamification conditions land a day early or
    # late with them. Deliberately not changed here: switching the boundary makes
    # existing user_active_days rows disagree with new ones, and the gamification
    # conditions read this table directly — the fix has to be decided together with
    # "do we backfill?" and "do we re-check badges already awarded?", which is a
    # cross-module product call, not a one-line strftime change.
    today = now.strftime("%Y-%m-%d")
    prev_day = last.strftime("%Y-%m-%d") if last is not None else None
    user.last_active_at = now
    if prev_day != today:
        try:
            with db.begin_nested():
                db.add(UserActiveDay(user_id=user.id, day=today))
                db.flush()
        except IntegrityError:
            # 并发请求下的竞态：同一 (user_id, day) 已被另一会话写入。SAVEPOINT
            # 只撤掉这一行的插入，那一行本来就已存在，结果是对的。
            # Concurrent race: another session already wrote this (user_id, day).
            # The savepoint undoes only this insert; the row exists, which is the
            # correct end state.
            pass
    db.commit()


# 前端靠这个前缀认出「要先验证邮箱」并换成引导，别改措辞。
# The frontend recognises this prefix to show the verify prompt; keep the wording.
EMAIL_NOT_VERIFIED_DETAIL = "请先验证邮箱 / Please verify your email first"


def require_verified_email(user: User = Depends(get_current_user)) -> User:
    """要求当前用户已验证邮箱：绑定 MT5、领 PRO 试用这两处用（软拦截，见
    User.email_verified_at）。403 而非 401，理由同停用账号——401 会被前端当成
    掉线、清 token 踢回登录页。
    Require a verified email; used by MT5 binding and the trial claim. 403, not
    401, for the same reason as disabled accounts: the frontend treats 401 as a
    lost session and bounces to the login page."""
    if user.email_verified_at is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=EMAIL_NOT_VERIFIED_DETAIL)
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    """要求当前用户具备管理员权限（role == "admin"）。
    Require the current user to hold admin rights (role == "admin")."""
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限 / Admin privileges required")
    return user


def validate_order(symbol: str, side: str, volume: float, equity: float | None = None) -> None:
    """服务端下单风控校验 / server-side order risk validation.

    equity 提供时，按"每手所需净值"粗估手数上限，防止小余额账户过度下单。
    When equity is provided, cap the lot size by a rough equity-per-lot rule to
    prevent over-sized orders on small accounts.
    """
    if side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="方向无效 / Invalid side")
    if not symbol or len(symbol) > 20:
        raise HTTPException(status_code=400, detail="品种无效 / Invalid symbol")
    if volume < min_lot(symbol):
        raise HTTPException(
            status_code=400,
            detail=f"低于 {symbol} 的最小手数 {min_lot(symbol)} / Below min volume for {symbol}",
        )
    if volume < settings.MIN_VOLUME_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"低于单笔最小手数 {settings.MIN_VOLUME_PER_ORDER} / Below min volume",
        )
    if volume > settings.MAX_VOLUME_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"超过单笔最大手数 {settings.MAX_VOLUME_PER_ORDER} / Exceeds max volume",
        )
    # 手数必须落在该品种的步长上。不是整数倍的手数不会被 MT5 当场拒绝，而是被
    # 接受成一张永远不会成交的订单，挂在仓位上把后续平仓全挡掉（2026-09-17 事故）。
    if not is_volume_on_step(volume, symbol):
        raise HTTPException(
            status_code=400,
            detail=f"手数必须是 {lot_step(symbol)} 的整数倍 / Volume must be a multiple of {lot_step(symbol)}",
        )
    # 按净值粗估手数上限 / rough equity-based lot cap
    if equity is not None and equity > 0 and settings.EQUITY_PER_LOT > 0:
        max_by_equity = equity / settings.EQUITY_PER_LOT
        if volume > max_by_equity:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"手数超过账户净值可承受上限（约 {max_by_equity:.2f} 手）"
                    f" / Volume exceeds equity-based cap (~{max_by_equity:.2f} lots)"
                ),
            )


def validate_sl_tp_direction(
    side: str, stop_loss: float | None, take_profit: float | None
) -> None:
    """服务端止损/止盈方向校验：两者都填时，买单必须 SL < TP、卖单必须 SL > TP。

    只做相对关系判断，不需要参考入场价——纯粹挡住"把止损止盈填反"的错误订单。
    前端 ChartOrderModal 已经拦了一层，这里是服务端兜底：绕过网页直接发请求
    时，这种明显填反的单也不会被静默接受再丢给 MT5。0 / None 表示该侧未设置
    （下单时省略、改单时 0 表示清除），跳过不校验。

    Server-side SL/TP direction check: when both are set, a BUY needs SL < TP and
    a SELL needs SL > TP. Purely relative — no entry reference needed — it just
    catches a swapped SL/TP. The frontend already blocks this in the order
    modal; this is the server-side backstop so an API request crafted around the
    UI can't get an obviously-inverted order silently forwarded to MT5. A value
    of 0 / None means that side isn't set (omitted on place, 0 clears on modify)
    and is skipped.
    """
    if not stop_loss or not take_profit or stop_loss <= 0 or take_profit <= 0:
        return
    if side == "BUY" and stop_loss >= take_profit:
        raise HTTPException(
            status_code=400,
            detail="买单止损必须低于止盈 / For a BUY, stop-loss must be below take-profit",
        )
    if side == "SELL" and stop_loss <= take_profit:
        raise HTTPException(
            status_code=400,
            detail="卖单止损必须高于止盈 / For a SELL, stop-loss must be above take-profit",
        )


# ---------------------------------------------------------------------------
# 让轻量鉴权缓存跟着 users 表的两列走 / keep the auth cache in step with the two columns
# ---------------------------------------------------------------------------
# 凡是经 ORM 改了 User.token_version / User.disabled_at（或删了用户）的事务，在 commit **之后**
# 自动删掉 auth:tv:<id>。先在 flush 阶段（after_update / after_delete）把 user_id 记进
# session.info，等 Session 真正 commit 了才删：提前删的话，别的请求可能在 commit 之前把旧值又
# 读回缓存。回滚则丢掉记录。
# Any ORM transaction that changes User.token_version / User.disabled_at (or deletes a user)
# deletes auth:tv:<id> *after* the commit. The id is noted in session.info at flush time and only
# acted on once the Session really commits — deleting earlier would let a concurrent request
# re-cache the old value before the commit. A rollback discards the note.
_AUTH_INVALIDATE_KEY = "prismx_auth_invalidate"


def _note_auth_change(target: User) -> None:
    session = object_session(target)
    if session is not None and target.id:
        session.info.setdefault(_AUTH_INVALIDATE_KEY, set()).add(target.id)


@event.listens_for(User, "after_update")
def _user_updated(mapper, connection, target: User) -> None:
    state = sa_inspect(target)
    if state.attrs.token_version.history.has_changes() or state.attrs.disabled_at.history.has_changes():
        _note_auth_change(target)


@event.listens_for(User, "after_delete")
def _user_deleted(mapper, connection, target: User) -> None:
    _note_auth_change(target)


@event.listens_for(Session, "after_commit")
def _invalidate_auth_after_commit(session: Session) -> None:
    ids = session.info.pop(_AUTH_INVALIDATE_KEY, None)
    if ids:
        shared_cache.invalidate_auth_state(*ids)


@event.listens_for(Session, "after_rollback")
def _forget_auth_changes_on_rollback(session: Session) -> None:
    session.info.pop(_AUTH_INVALIDATE_KEY, None)
