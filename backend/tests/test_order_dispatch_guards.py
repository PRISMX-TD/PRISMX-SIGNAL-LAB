"""下单路由上的三道闸门（2026-09-19 审计补的）。

这三条都属于「不会报错、只会悄悄让用户多开一笔仓」的那一类，所以必须有测试钉住：

1. `_commit_order_or_existing` 撞并发唯一约束后返回 created=False，调用方据此
   **不再**拿被回滚的订单对象去调网关。此前那条路径靠网关的幂等缓存兜着，缓存
   一过期就是真的重复下单。
2. `_require_close_login` 只在「多个账号在线」这一种歧义下 400；「一个都不在线」
   必须继续留空排队，否则会砍掉「等桥接回来再执行」这个正常用法。
3. `cancel_order` 不许撤销已下发且仍在 ack 窗口内的指令，否则用户会看到
   「已撤销」而几秒后真回执把它改回 FILLED。

Three guards on the order router, all covering the "no error, just an extra
position" failure class. See each test for the specific rationale.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import MT5Account, Order, User
from app.routers.orders import (
    _commit_order_or_existing,
    _require_close_login,
    cancel_order as _cancel_decorated,
)

# 剥掉 slowapi 装饰器，与 test_email_domains.py / test_password_reset.py 同一手法：
# 限流与这里要验的判据无关，带着装饰器调用需要一个挂了 limiter 的 app.state，那是
# 给测试造场景而不是在测产品行为。
# Strip the slowapi decorator, as test_email_domains.py and test_password_reset.py
# already do: rate limiting is orthogonal to these guards, and calling through it
# would require staging an app.state that carries a limiter.
_cancel = _cancel_decorated.__wrapped__


def _mk_user(db, uid: str = "u1") -> User:
    user = User(id=uid, email=f"{uid}@example.com", api_token=f"tok_{uid}")
    db.add(user)
    db.commit()
    return user


def _mk_account(db, uid: str, login: str, *, online: bool) -> MT5Account:
    # is_account_online 认的是心跳窗口（deps.ONLINE_WINDOW，7 秒）。
    # 给一个远早于窗口的心跳就是"离线"。
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    acc = MT5Account(
        user_id=uid,
        login=login,
        source="bridge",
        last_heartbeat=now if online else now - timedelta(hours=1),
    )
    db.add(acc)
    db.commit()
    return acc


def _mk_order(db, uid: str, coid: str, **kw) -> Order:
    order = Order(
        user_id=uid, client_order_id=coid, action=kw.pop("action", "ORDER"),
        symbol="XAUUSD", side="BUY", volume=0.01, status=kw.pop("status", "PENDING"),
        created_at=kw.pop("created_at", datetime.now(timezone.utc)), **kw,
    )
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


# ---- 1. 并发撞键不得再次执行 / a lost race must not re-execute ---------------

def test_commit_reports_created_true_on_success(db_session):
    _mk_user(db_session)
    order = Order(user_id="u1", client_order_id="c-new", action="ORDER",
                  symbol="XAUUSD", side="BUY", volume=0.01, status="PENDING")

    _payload, created = _commit_order_or_existing(db_session, order, "u1", "c-new")

    assert created is True, "新订单必须报 created=True，调用方据此才会去执行"


def test_commit_reports_created_false_when_losing_the_race(db_session):
    """并发撞上同一 clientOrderId：返回既有订单且 created=False。

    created=False 是**不要再执行**的信号。此前这里只返回载荷，调用方无从区分，
    于是继续拿已被 rollback 的 order 去调网关——那是用同一个 clientOrderId 再执行
    一次，只有网关的幂等缓存挡着；缓存过期就是真的重复建仓。
    """
    _mk_user(db_session)
    _mk_order(db_session, "u1", "c-dup")  # 先手：模拟另一个请求已经赢了

    loser = Order(user_id="u1", client_order_id="c-dup", action="ORDER",
                  symbol="XAUUSD", side="BUY", volume=0.01, status="PENDING")
    payload, created = _commit_order_or_existing(db_session, loser, "u1", "c-dup")

    assert created is False
    assert payload.clientOrderId == "c-dup"


# ---- 2. 平仓的账号解析 / close-target resolution ----------------------------

def test_close_login_uses_explicit_request(db_session):
    _mk_user(db_session)
    assert _require_close_login(db_session, "u1", "500123") == "500123"


def test_close_login_falls_back_to_the_single_online_account(db_session):
    _mk_user(db_session)
    _mk_account(db_session, "u1", "500123", online=True)
    _mk_account(db_session, "u1", "500999", online=False)

    assert _require_close_login(db_session, "u1", None) == "500123"


def test_close_login_rejects_ambiguous_multi_account(db_session):
    """多个账号在线且没指定：当场 400。

    留空会让这条指令**永远**不被下发——bridge_poll 的目标解析同样是"唯一在线账号
    否则 None"，None 就 continue，于是它只能等 5 分钟被 stale 作废。平仓单静默
    拖 5 分钟是要赔钱的。
    """
    _mk_user(db_session)
    _mk_account(db_session, "u1", "500123", online=True)
    _mk_account(db_session, "u1", "500999", online=True)

    with pytest.raises(HTTPException) as e:
        _require_close_login(db_session, "u1", None)
    assert e.value.status_code == 400


def test_close_login_allows_queueing_when_nothing_is_online(db_session):
    """一个账号都不在线时**必须**留空排队，不能报错。

    这条是防回归的：目标账号是在 bridge_poll 里按当时的在线情况重新解析的，所以
    桥接稍后恢复（笔记本睡醒）时这条指令会被正常下发。在入口 409 掉等于把
    "排队等桥接回来"这个正常用法砍掉。
    """
    _mk_user(db_session)
    _mk_account(db_session, "u1", "500123", online=False)

    assert _require_close_login(db_session, "u1", None) is None


# ---- 3. 已下发的指令不可撤销 / a dispatched command cannot be cancelled ------

def test_delivered_order_within_ack_window_cannot_be_cancelled(db_session):
    """已下发且仍在 ack 窗口内 → 撤销必须被拒。

    此前只看 status：指令交给桥接、正在 MT5 里执行、回执还没回来的那个窗口里
    status 仍是 PENDING，撤销会"成功"，几秒后真回执又把它改回 FILLED。用户看到
    先"已撤销"后"已成交"，中间大概率已经重下了一笔。
    """
    user = _mk_user(db_session)
    order = _mk_order(db_session, "u1", "c-live", delivered=True,
                      delivered_at=datetime.now(timezone.utc))

    with pytest.raises(HTTPException) as e:
        _cancel(request=None, order_id=order.id, user=user, db=db_session)
    assert e.value.status_code == 409

    db_session.refresh(order)
    assert order.status == "PENDING", "被拒的撤销不得改动订单状态"


def test_undelivered_order_can_still_be_cancelled(db_session):
    """对照组：还没下发的指令照旧可以撤销——闸门不该把正常撤销一起挡掉。"""
    user = _mk_user(db_session)
    order = _mk_order(db_session, "u1", "c-idle", delivered=False)

    _cancel(request=None, order_id=order.id, user=user, db=db_session)

    db_session.refresh(order)
    assert order.status == "CANCELLED"


def test_stale_delivered_order_can_be_cancelled(db_session):
    """已下发但早就超过 ack 窗口（桥接大概率已经掉线）→ 允许撤销。

    闸门挡的是"正在执行"，不是"曾经下发过"。超时的那条本来也会被 stale 判定作废，
    此时让用户主动撤掉是合理的。
    """
    from app.core.config import settings

    user = _mk_user(db_session)
    long_ago = datetime.now(timezone.utc) - timedelta(
        seconds=settings.ORDER_PENDING_TIMEOUT_SECONDS + 60)
    order = _mk_order(db_session, "u1", "c-stale", delivered=True,
                      delivered_at=long_ago, created_at=long_ago)

    _cancel(request=None, order_id=order.id, user=user, db=db_session)

    db_session.refresh(order)
    assert order.status == "CANCELLED"
