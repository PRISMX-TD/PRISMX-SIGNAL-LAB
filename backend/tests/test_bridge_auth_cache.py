"""桥接鉴权缓存：跨请求复用的 User 实例必须始终可读。
Bridge auth cache: the User instance reused across requests must stay readable.

背景 / background：缓存里存的是 ORM 实例。SQLAlchemy 的 expire_on_commit 默认为
True，所以持有该实例的那个会话一旦 commit，实例的属性就被标记为过期；请求结束
会话关闭后，它同时是 detached 又是 expired——下一个请求命中缓存、读任意一列，
SQLAlchemy 会试图刷新属性却找不到会话，抛 DetachedInstanceError，整个端点 500。

The cache holds ORM instances. With SQLAlchemy's default expire_on_commit=True, a
commit on the owning session marks the instance's attributes expired; once the
request ends and the session closes it is both detached and expired, so the next
request that hits the cache and reads any column raises DetachedInstanceError and
the endpoint 500s.
"""
from datetime import datetime, timezone

from app.models import AutoManageSettings, Order
from tests.conftest import BROKER_SERVER, make_account


def _positions_payload(login="10001", ticket=777):
    """一条本平台开出、带止损（R 有定义）的持仓上报。
    One reported position opened through the platform, with a stop (R defined)."""
    return {"data": [{
        "login": login,
        "ticket": ticket,
        "symbol": "XAUUSD",
        "side": "BUY",
        "volume": 0.1,
        "entryPrice": 2350.0,
        "currentPrice": 2355.0,
        "stopLoss": 2340.0,
        "takeProfit": 2370.0,
        "profit": 1.0,
    }]}


def _enable_auto_manage(db, user):
    """开自动仓管（PRO + 总开关）——这是让 evaluate_positions 真的写库并 commit
    的前提，也是生产上触发本 bug 的那套配置。
    Turn on auto-manage (PRO + master switch) — the precondition for
    evaluate_positions to actually write and commit, and the configuration that
    triggers this bug in production."""
    user.plan = "PRO"
    db.add(AutoManageSettings(user_id=user.id, enabled=True))
    db.commit()


def _platform_position_order(db, user, ticket=777, login="10001"):
    """一条本平台开出、仍持仓的成交单：让持仓上报能匹配到平台仓位。
    A filled platform open so the reported position matches a platform ticket."""
    db.add(Order(
        user_id=user.id,
        client_order_id=f"filled-{ticket}",
        symbol="XAUUSD",
        side="BUY",
        volume=0.1,
        status="FILLED",
        action="ORDER",
        mt5_login=login,
        mt5_ticket=ticket,
        created_at=datetime.now(timezone.utc),
    ))
    db.commit()


def test_poll_after_positions_report_still_authenticates(client, bridge_headers, db, user):
    """持仓上报之后紧接着轮询：不能因为鉴权缓存而 500。

    这就是生产上的真实序列——桥接每 1.5 秒先报持仓再轮询。只要用户有任何持仓，
    mark_positions_seen() 就会 commit，把缓存里的 User 实例置为过期；而 positions
    端点在 commit 之后不再读 user 的任何属性，于是这个过期状态被带出请求，下一拍
    poll 命中缓存即崩。用户侧表现为「已连接 · N 个账号 · 后端拒绝 HTTP 500」，
    与 Token 无关，且只要仓位还开着就永不自愈。

    The real production sequence: the bridge reports positions then polls, every
    1.5s. With any open position mark_positions_seen() commits, expiring the
    cached User; the positions endpoint never touches user afterwards, so the
    expired state escapes the request and the next poll's cache hit blows up.
    """
    make_account(db, user, login="10001")
    _enable_auto_manage(db, user)
    _platform_position_order(db, user)

    r1 = client.post("/api/bridge/positions", json=_positions_payload(), headers=bridge_headers)
    assert r1.status_code == 200

    r2 = client.post(
        "/api/bridge/poll",
        json={"accounts": [{"login": "10001", "server": BROKER_SERVER}]},
        headers=bridge_headers,
    )
    assert r2.status_code == 200, r2.text


def test_repeated_positions_reports_keep_authenticating(client, bridge_headers, db, user):
    """连续多次持仓上报同样不能把缓存实例弄坏 / repeated reports keep the cache usable."""
    make_account(db, user, login="10001")
    _enable_auto_manage(db, user)
    _platform_position_order(db, user)
    for _ in range(3):
        r = client.post("/api/bridge/positions", json=_positions_payload(), headers=bridge_headers)
        assert r.status_code == 200, r.text
