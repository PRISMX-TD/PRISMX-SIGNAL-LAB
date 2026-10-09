"""操作日志埋点（设计 §4.2）：手动改单 / 平仓落库时记下这笔仓位的「原值」。

- /orders/modify：orders.prev_sl / prev_tp（0 = 原来没有，NULL = 不知道），顺带 pos_volume；
- /orders/close：orders.pos_volume（判断全平 / 部分平只能靠它，桥接回执会改写 volume）。

原值取自 connection_manager.find_position_shared（一次 Redis MGET，0.3 秒超时 + 30 秒熔断）。
要钉住的是：读到就填、读不到 / Redis 出错 / 查询本身抛异常都只是留空，**指令照常落库**；
幂等重放在早返回处就结束，不读快照；没带 mt5Login 时用解析出来的那个账号去找。

路由按本仓库惯例在 service 级直接调用（Depends 显式传参，不起 TestClient），限流关掉，网关
执行那一跳替换成 None（走桥接排队那条路）。orders.manager 换成一个新的 ConnectionManager，
本进程快照不会漏给别的用例。tests/fake_redis.FakeRedis 没有 MGET，就地补一个子类。

Activity-log hooks (design §4.2) on manual modify / close: the position's previous
SL / TP (and volume) are recorded at INSERT from find_position_shared. A hit fills
them; a miss, a Redis error or even an exception from the lookup leaves them NULL and
the command is still queued. An idempotent replay returns before any lookup, and an
omitted mt5Login is resolved first and used for the lookup.
"""
import json
from datetime import datetime, timezone

import pytest

from app.core.config import settings
from app.models import MT5Account, Order, User
from app.services import connection_manager as cm
from app.services import shared_state
from tests.fake_redis import FakeRedis

UID = "u-hooks"
LOGIN = "5001"
OTHER_LOGIN = "6002"
TICKET = 36109204


class MgetRedis(FakeRedis):
    """FakeRedis + MGET，并记下每次 MGET 的键。/ FakeRedis plus MGET, recording keys."""

    def __init__(self) -> None:
        super().__init__()
        self.mget_calls: list[list[str]] = []

    def mget(self, keys):
        self.mget_calls.append(list(keys))
        return [self.get(k) for k in keys]


class BrokenRedis:
    """只给查持仓用的客户端：每次 MGET 都超时。/ Lookup-only client whose MGET always times out."""

    def __init__(self) -> None:
        self.calls = 0

    def mget(self, keys):
        self.calls += 1
        raise TimeoutError("Timeout reading from socket")


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture()
def orders_mod(monkeypatch):
    from app.core import rate_limit
    import app.routers.orders as orders

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    # 只测落库那一刻，网关执行不参与（返回 None = 留给桥接取）
    # Only the INSERT matters here; None = left for the bridge to fetch.
    monkeypatch.setattr(orders, "_try_gateway_execute", lambda *a, **k: None)
    monkeypatch.setattr(orders, "manager", cm.ConnectionManager())
    return orders


@pytest.fixture()
def memory_backend(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()
    yield
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()


@pytest.fixture()
def redis_backend(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = MgetRedis()
    shared_state.reset_for_tests(fake)
    cm.reset_position_lookup_for_tests(fake)
    yield fake
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()


@pytest.fixture()
def broken_lookup(monkeypatch):
    """共享状态走正常的 FakeRedis（唤醒广播等），只有查持仓的专用客户端是坏的。
    Shared state on a healthy FakeRedis; only the dedicated lookup client is broken."""
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    shared_state.reset_for_tests(FakeRedis())
    broken = BrokenRedis()
    cm.reset_position_lookup_for_tests(broken)
    yield broken
    shared_state.reset_for_tests()
    cm.reset_position_lookup_for_tests()


# ── helpers ──────────────────────────────────────────────────────────────────

def _user(db, *, online=()):
    """建用户和两个桥接账号；online 里的账号带上刚刚的心跳（= 在线）。"""
    db.add(User(id=UID, email="hooks@t.co", api_token="tok_hooks"))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for login in (LOGIN, OTHER_LOGIN):
        db.add(MT5Account(user_id=UID, login=login, server="", source="bridge",
                          last_heartbeat=now if login in online else None))
    db.commit()
    return db.get(User, UID)


def _pos(ticket=TICKET, login=LOGIN, sl=0.0, tp=0.0, volume=0.5):
    return {"ticket": ticket, "symbol": "XAUUSD", "side": "BUY", "volume": volume,
            "stopLoss": sl, "takeProfit": tp, "login": login}


def _put_local(mgr, source, rows):
    mgr._local("positions").setdefault(UID, {})[source] = rows
    mgr._stamp_local("positions", UID, source)


def _store(fake, source, rows):
    fake.set(f"prismx:positions:{UID}:{source}", json.dumps(rows))


def _modify(orders, db, *, cid="mod-1", login=LOGIN, sl=2400.0, tp=0.0):
    req = orders.ModifyPositionRequest(
        clientOrderId=cid, ticket=TICKET, symbol="XAUUSD", side="BUY",
        mt5Login=login, stopLoss=sl, takeProfit=tp,
    )
    return orders.modify_position(request=None, req=req, user=db.get(User, UID), db=db)


def _close(orders, db, *, cid="close-1", login=LOGIN, volume=None):
    req = orders.ClosePositionRequest(
        clientOrderId=cid, ticket=TICKET, symbol="XAUUSD", side="BUY",
        mt5Login=login, volume=volume,
    )
    return orders.close_position(request=None, req=req, user=db.get(User, UID), db=db)


def _row(db, cid) -> Order:
    db.expire_all()
    return db.query(Order).filter(Order.client_order_id == cid).one()


# ── /orders/modify ───────────────────────────────────────────────────────────

def test_modify_records_previous_sl_tp_from_local_snapshot(db_session, orders_mod, memory_backend):
    _user(db_session)
    _put_local(orders_mod.manager, "bridge",
               [_pos(sl=2390.5, tp=0.0, volume=0.3), _pos(ticket=11, sl=1.0)])

    _modify(orders_mod, db_session, sl=2400.0, tp=2500.0)

    o = _row(db_session, "mod-1")
    assert o.action == "MODIFY" and o.status == "PENDING"
    assert (o.sl, o.tp) == (2400.0, 2500.0)                  # 新值照旧 / new values unchanged
    assert o.prev_sl == 2390.5
    assert o.prev_tp == 0.0                                    # 0 = 原来没有止盈 / no TP before
    assert o.pos_volume == 0.3


def test_modify_reads_redis_once_and_records_previous_values(db_session, orders_mod, redis_backend):
    _user(db_session)
    _store(redis_backend, "gateway", [_pos(sl=2390.0, tp=2450.0, volume=1.0)])

    _modify(orders_mod, db_session)

    o = _row(db_session, "mod-1")
    assert (o.prev_sl, o.prev_tp, o.pos_volume) == (2390.0, 2450.0, 1.0)
    assert redis_backend.mget_calls == [
        [f"prismx:positions:{UID}:bridge", f"prismx:positions:{UID}:gateway"]
    ]


def test_modify_snapshot_not_found_leaves_columns_null(db_session, orders_mod, redis_backend):
    """快照里没有这张票（刚平掉 / 快照还没到）：原值留空，指令照常落库。"""
    _user(db_session)
    _store(redis_backend, "bridge", [_pos(ticket=999)])

    _modify(orders_mod, db_session)

    o = _row(db_session, "mod-1")
    assert o.status == "PENDING"
    assert (o.prev_sl, o.prev_tp, o.pos_volume) == (None, None, None)


def test_modify_redis_error_never_blocks_and_opens_breaker(db_session, orders_mod, broken_lookup):
    """Redis 超时：原值留空、指令照常落库；熔断打开后下一单不再碰 Redis。"""
    _user(db_session)

    _modify(orders_mod, db_session, cid="mod-1")
    _modify(orders_mod, db_session, cid="mod-2", sl=2401.0)

    for cid in ("mod-1", "mod-2"):
        o = _row(db_session, cid)
        assert o.status == "PENDING"
        assert (o.prev_sl, o.prev_tp, o.pos_volume) == (None, None, None)
    assert broken_lookup.calls == 1                            # 第二单走熔断 / second one skipped Redis


def test_modify_survives_a_lookup_that_raises(db_session, orders_mod, memory_backend, monkeypatch):
    """find_position_shared 自己保证不抛；万一被改坏了抛出来，代价也只是少一个原值。"""
    _user(db_session)

    def _boom(*a, **k):
        raise RuntimeError("regression")

    monkeypatch.setattr(orders_mod.manager, "find_position_shared", _boom)

    _modify(orders_mod, db_session)

    o = _row(db_session, "mod-1")
    assert o.status == "PENDING"
    assert (o.prev_sl, o.prev_tp, o.pos_volume) == (None, None, None)


def test_idempotent_replay_does_not_read_redis(db_session, orders_mod, redis_backend):
    """同一 clientOrderId 重放：在幂等早返回处就结束，不再查持仓，原记录不变。"""
    _user(db_session)
    _store(redis_backend, "bridge", [_pos(sl=2390.0)])

    first = _modify(orders_mod, db_session)
    assert len(redis_backend.mget_calls) == 1

    _store(redis_backend, "bridge", [_pos(sl=1111.0)])         # 快照变了也不该被读到
    again = _modify(orders_mod, db_session)

    assert len(redis_backend.mget_calls) == 1
    assert again.id == first.id
    assert db_session.query(Order).filter(Order.action == "MODIFY").count() == 1
    assert _row(db_session, "mod-1").prev_sl == 2390.0


def test_modify_without_login_looks_up_the_resolved_account(db_session, orders_mod, memory_backend):
    """没带 mt5Login、只有一个账号在线：用解析出来的账号去找。两个账号撞同一张票号时，
    不带账号的查询会拒绝猜（返回 None），所以这里能填上原值就说明用的是解析后的账号。
    No mt5Login with one account online: the resolved login is used for the lookup —
    the same ticket on two accounts would otherwise be refused as ambiguous."""
    _user(db_session, online=(LOGIN,))
    _put_local(orders_mod.manager, "bridge",
               [_pos(login=LOGIN, sl=2390.0), _pos(login=OTHER_LOGIN, sl=7.0)])

    _modify(orders_mod, db_session, login=None)

    o = _row(db_session, "mod-1")
    assert o.mt5_login == LOGIN
    assert o.prev_sl == 2390.0


# ── /orders/close ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("volume,stored", [(0.2, 0.2), (None, 0.0)])
def test_close_records_position_volume(db_session, orders_mod, redis_backend, volume, stored):
    """部分平（0.2）与全平（省略 = 0）都记下平之前的仓位手数；CLOSE 不写原止损止盈。"""
    _user(db_session)
    _store(redis_backend, "bridge", [_pos(sl=2390.0, tp=2450.0, volume=0.5)])

    _close(orders_mod, db_session, volume=volume)

    o = _row(db_session, "close-1")
    assert o.action == "CLOSE" and o.status == "PENDING"
    assert o.volume == stored
    assert o.pos_volume == 0.5
    assert (o.prev_sl, o.prev_tp) == (None, None)
    assert len(redis_backend.mget_calls) == 1


def test_close_snapshot_not_found_leaves_pos_volume_null(db_session, orders_mod, memory_backend):
    _user(db_session)

    _close(orders_mod, db_session, volume=0.2)

    o = _row(db_session, "close-1")
    assert o.status == "PENDING"
    assert o.pos_volume is None


def test_close_redis_error_never_blocks(db_session, orders_mod, broken_lookup):
    _user(db_session)

    _close(orders_mod, db_session)

    o = _row(db_session, "close-1")
    assert o.status == "PENDING"
    assert o.pos_volume is None
    assert broken_lookup.calls == 1


def test_close_idempotent_replay_does_not_read_redis(db_session, orders_mod, redis_backend):
    _user(db_session)
    _store(redis_backend, "bridge", [_pos(volume=0.5)])

    _close(orders_mod, db_session)
    _close(orders_mod, db_session)

    assert len(redis_backend.mget_calls) == 1
    assert db_session.query(Order).filter(Order.action == "CLOSE").count() == 1
    assert _row(db_session, "close-1").pos_volume == 0.5
