"""Gateway 绑定的撤销：改了 MT5 密码之后，旧绑定必须失去代客下单的能力。

**被修的问题。** Gateway 通道只在绑定那一刻校验一次主密码，此后读持仓、读资金、
下单全部由平台的 manager 完成，不再经过用户密码。也就是说这条链路上没有任何会
过期的凭证——用户改了密码、账号转手、密码被券商重置，那条旧绑定照样能下单。实测
现象就是「改了密码还能连」。

**补法。** 绑定时记下券商的 `LastPassChange`，每轮资金刷新拿当前值来比，对不上就
撤销。这里钉住的是这套判据里最容易写错、写错了又不会立刻暴露的那几处：

  1. 「没有信号」绝不能当成「时间为 0」去比对。券商不填这个字段、网关是旧版本、
     或者是本机制上线前就存在的绑定——这三种情况下两侧至少有一个是 0/None，
     一旦按普通值比，**每个账号一绑上就会被立刻撤销**，而且是全量的。
  2. 撤销之后要真的到处生效：判离线、不轮询、下单显式拒绝。只做其中一件（尤其
     只做"判离线"）会留下自动仓管带着明确 login 直接下单的口子。
  3. 重新验证是唯一的恢复路径，且必须真的能恢复。

另外钉住 `investorOnly` 的移除：投资者密码在券商侧是只读凭证，而绑定成功后不再
校验任何密码，所以用它绑定等于把「只能看」当场换成「能下单」。这个字段以前在
请求体里，前端从不传 true，但任何登录用户直接打接口就能用。

Revocation for gateway bindings. A gateway bind checks the password exactly once
and everything afterwards runs through the manager, so nothing on the link
expires — a changed password left the old binding fully able to trade. The
LastPassChange comparison fixes that; what's pinned here is the part that fails
silently if written wrong: "no signal" must never be compared as a real value
(otherwise every binding is revoked the moment it is created), revocation has to
take effect everywhere rather than only in the liveness check, and re-verifying
has to actually restore the binding. Also pins the removal of `investorOnly`,
which let a read-only broker credential be turned into order-placing access.
"""
import inspect
from datetime import datetime, timezone

import pytest

from app.models import MT5Account, Order
from app.services.gateway_binding import (
    REASON_PASSWORD_CHANGED,
    enforce,
    is_revoked,
    password_changed,
    record_baseline,
    revoke,
)


def _account(db, **kw):
    row = MT5Account(
        user_id=kw.pop("user_id", "u1"),
        login=kw.pop("login", "601144"),
        server="",
        source=kw.pop("source", "gateway"),
        **kw,
    )
    db.add(row)
    db.commit()
    return row


# ---------- 判据本身 / the comparison rule ----------


@pytest.mark.parametrize(
    "recorded, observed, expected",
    [
        # 正常情况：值变了就是变了，方向无所谓。变小同样说明这已经不是当初
        # 验证过的那条账号记录（券商回滚备份、login 被重新分配）。
        (1_700_000_000, 1_700_000_001, True),
        (1_700_000_001, 1_700_000_000, True),
        (1_700_000_000, 1_700_000_000, False),
        # 「没有信号」的三种形态。全部必须是 False —— 这三行是本文件的核心：
        # 任何一行返回 True，上线当天就是全量账号被撤销。
        (None, 1_700_000_000, False),   # 历史绑定，没有基线
        (1_700_000_000, 0, False),      # 券商这次没返回
        (1_700_000_000, None, False),   # 旧版网关，字段根本不存在
        (None, None, False),
        (0, 0, False),
    ],
)
def test_password_changed_rule(recorded, observed, expected):
    assert password_changed(recorded, observed) is expected


def test_revoke_is_idempotent(db_session):
    row = _account(db_session)

    assert revoke(db_session, row, REASON_PASSWORD_CHANGED) is True
    assert row.revoked_at is not None
    assert row.revoked_reason == REASON_PASSWORD_CHANGED
    first_at = row.revoked_at

    # 轮询每 15 秒跑一次，撤销后那一行还在库里；重复撤销不能刷新时间戳，
    # 否则「什么时候被撤销的」这个信息每一轮都被抹掉一次。
    assert revoke(db_session, row, REASON_PASSWORD_CHANGED) is False
    assert row.revoked_at == first_at


def test_revoke_keeps_the_row(db_session):
    """撤销不删行：订单与平仓明细按 (user_id, login) 关联，删了会让战绩失去归属。"""
    row = _account(db_session)
    revoke(db_session, row, REASON_PASSWORD_CHANGED)

    still_there = (
        db_session.query(MT5Account).filter(MT5Account.login == "601144").first()
    )
    assert still_there is not None


def test_baseline_only_fills_when_absent(db_session):
    """历史绑定补基线；已有基线的行绝不能被覆盖——覆盖等于把撤销判据抹平。"""
    legacy = _account(db_session, login="1", pass_change_at=None)
    assert record_baseline(db_session, legacy, 1_700_000_000) is True
    assert legacy.pass_change_at == 1_700_000_000

    # 已有基线：即便传进来一个不同的值也不能写。真出现不同值时该走的是撤销，
    # 而不是悄悄把基线更新成新值——那会让这道闸永远不可能触发。
    assert record_baseline(db_session, legacy, 1_800_000_000) is False
    assert legacy.pass_change_at == 1_700_000_000

    # 没有信号时不写，免得把 0 记成基线（之后每次比对都会被判成"变了"）。
    fresh = _account(db_session, login="2", pass_change_at=None)
    assert record_baseline(db_session, fresh, 0) is False
    assert fresh.pass_change_at is None


def test_bridge_accounts_are_never_revoked(db_session):
    """bridge 通道的凭证在用户自己手里，改密码会直接让桥接登不上、心跳停掉。

    这套标记只对 gateway 有意义。要是对 bridge 行也认，一次误写就会让一个
    本来靠心跳自然掉线的账号被永久标记，而 bridge 侧没有任何清除路径。
    """
    row = _account(db_session, source="bridge", revoked_at=datetime.now(timezone.utc))
    assert is_revoked(row) is False


# ---------- 唯一的判定入口 / the single decision point ----------


def test_enforce_revokes_and_notifies_once(db_session):
    """改密时间变了：撤销、返回失效、回调恰好触发一次。

    「恰好一次」是重点：轮询每 15 秒一拍，撤销后那一行还在库里，若每拍都回调，
    用户会被同一件事反复推送到关掉通知——那时真正要紧的提醒也一起没了。
    """
    row = _account(db_session, pass_change_at=1_700_000_000)
    fired = []

    assert enforce(db_session, row, 1_700_000_999, on_revoke=lambda: fired.append(1)) is False
    assert is_revoked(row) is True
    assert len(fired) == 1

    # 后续几拍：已经是撤销状态，不该再回调
    for _ in range(3):
        assert enforce(db_session, row, 1_700_000_999, on_revoke=lambda: fired.append(1)) is False
    assert len(fired) == 1


def test_enforce_passes_when_nothing_changed(db_session):
    row = _account(db_session, pass_change_at=1_700_000_000)
    fired = []

    assert enforce(db_session, row, 1_700_000_000, on_revoke=lambda: fired.append(1)) is True
    assert is_revoked(row) is False
    assert not fired


@pytest.mark.parametrize("observed", [0, None])
def test_enforce_never_revokes_without_a_signal(db_session, observed):
    """券商这次没返回改密时间（或网关是旧版本）：放行，不撤销。

    这是全套里最危险的一格。把"读不到"当成"变了"，一次券商侧的字段缺失就会让
    全部 gateway 账号在同一拍里集体掉线，而且没有任何自动恢复路径——每个用户
    都得自己去重新输一次密码。宁可这道闸在拿不到证据时不生效。
    """
    row = _account(db_session, pass_change_at=1_700_000_000)
    fired = []

    assert enforce(db_session, row, observed, on_revoke=lambda: fired.append(1)) is True
    assert is_revoked(row) is False
    assert row.pass_change_at == 1_700_000_000, "基线不该被读不到的值覆盖"
    assert not fired


def test_enforce_seeds_a_baseline_for_legacy_bindings(db_session):
    """本机制上线前就存在的绑定：首次读到值时补基线，此后的改动才会被撤销。

    不追溯（不因为"没有基线"就撤销），因为那些行的密码有没有被改过我们无从
    得知，唯一"安全"的做法是把存量用户全部踢下线，代价大于收益。
    """
    row = _account(db_session, pass_change_at=None)

    assert enforce(db_session, row, 1_700_000_000) is True
    assert row.pass_change_at == 1_700_000_000
    assert is_revoked(row) is False

    # 基线立起来之后，再变就撤销
    assert enforce(db_session, row, 1_700_000_001) is False
    assert is_revoked(row) is True


# ---------- 撤销之后到处生效 / the revocation actually bites ----------


def test_revoked_account_reads_as_offline(db_session, monkeypatch):
    """在线状态是全站的账号可用性口径（持仓路由、单账号兜底路由、账户卡片）。"""
    import app.services.gateway_client as gc
    from app.services.deps import is_account_online

    monkeypatch.setattr(gc, "is_gateway_online", lambda: True)

    row = _account(db_session)
    assert is_account_online(row) is True

    revoke(db_session, row, REASON_PASSWORD_CHANGED)
    assert is_account_online(row) is False


def test_revoked_account_is_dropped_from_polling(db_session):
    """轮询目标里排除已撤销的绑定：撤销意味着不再代表用户去券商读任何东西。"""
    live = _account(db_session, login="1")
    dead = _account(db_session, login="2")
    revoke(db_session, dead, REASON_PASSWORD_CHANGED)

    rows = (
        db_session.query(MT5Account.login)
        .filter(MT5Account.source == "gateway", MT5Account.revoked_at.is_(None))
        .all()
    )
    assert [r[0] for r in rows] == [live.login]


def test_revoked_account_refuses_orders_without_calling_the_gateway(db_session, monkeypatch):
    """下单是资金安全的最后一道闸，且必须在真正调 gateway **之前**拒掉。

    单独判「离线」不够：自动仓管与策略自动下单都会带着明确的 mt5Login 走到
    _try_gateway_execute，不经过任何在线判定。
    """
    import app.routers.orders as orders_mod

    called = []
    monkeypatch.setattr(
        orders_mod, "gw_open", lambda *a, **kw: called.append(a) or None
    )

    row = _account(db_session)
    revoke(db_session, row, REASON_PASSWORD_CHANGED)

    order = Order(
        user_id="u1",
        mt5_login=row.login,
        action="ORDER",
        symbol="EURUSD",
        side="BUY",
        volume=0.01,
        status="PENDING",
        client_order_id="co_test_1",
    )
    db_session.add(order)
    db_session.commit()

    payload = orders_mod._try_gateway_execute(db_session, order)

    assert payload is not None          # 是 gateway 账号，不能当成 bridge 放过去
    assert order.status == "REJECTED"
    assert not called                   # 一次券商往返都不该发生


def test_reverifying_restores_the_binding(db_session):
    """重新验证是唯一的恢复路径，必须真的能恢复，且换上新的基线。"""
    row = _account(db_session, pass_change_at=1_700_000_000)
    revoke(db_session, row, REASON_PASSWORD_CHANGED)
    assert is_revoked(row) is True

    # 这是 gateway_verify 在 rsp.valid 分支里做的事
    row.pass_change_at = 1_800_000_000
    row.revoked_at = None
    row.revoked_reason = None
    db_session.commit()

    assert is_revoked(row) is False
    assert password_changed(row.pass_change_at, 1_800_000_000) is False


def _verify(monkeypatch, db, user, login, last_pass_change, valid=True):
    """直接调 /gateway/verify 的实现函数，网关那一跳换成假的。

    本套件是 service 级的（仓库惯例，没有 TestClient 先例），所以 Depends 全部
    按普通参数显式传入；限流器临时关掉——它按 IP 计数，与本用例要验的东西无关，
    开着只会让同一个用例里连验两次时随机翻车。
    """
    from app.core import rate_limit
    import app.routers.gateway as gw
    from app.services.gateway_client import VerifyRsp

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)

    rsp = VerifyRsp(
        ok=True, valid=valid, retcode="MT_RET_OK" if valid else "MT_RET_ERR_NOTFOUND",
        login=int(login), name="Tester", group=r"MCSA\I-STD-SLAB-USD",
        leverage=100, balance=1000.0, equity=1000.0,
        last_pass_change=last_pass_change,
    )
    # gw_verify 换成不返回协程的桩，再让 run_on_main_loop 直接给出结果。两个
    # 一起换是必须的：只换后者的话，前者产生的协程永远不会被 await，asyncio 会
    # 在 GC 时抛 "coroutine was never awaited"。
    monkeypatch.setattr(gw, "gw_verify", lambda *a, **kw: None)
    monkeypatch.setattr(gw, "run_on_main_loop", lambda _c, timeout=None: rsp)

    return gw.gateway_verify(
        request=None,
        req=gw.GatewayVerifyRequest(login=int(login), password="Secret#1"),
        user=user,
        db=db,
    )


def test_reverify_restores_a_revoked_binding_end_to_end(db_session, monkeypatch):
    """把恢复路径整条走一遍：撤销 → 用新密码重新验证 → 绑定活过来、基线换新。

    这条路径同时踩到两个坑，任一没修都会让被撤销的用户永远回不来：
      · 账户数上限以前无条件检查，FREE 用户（上限 1）重验自己唯一的账号会 403；
      · 撤销标记不清掉的话，验证成功了账号仍然是失效状态。
    """
    from app.models import User

    user = User(id="u_free", email="a@b.c", api_token="t1", plan="FREE")
    db_session.add(user)
    row = _account(db_session, user_id="u_free", login="601144", pass_change_at=1_700_000_000)
    revoke(db_session, row, REASON_PASSWORD_CHANGED)
    assert is_revoked(row) is True

    out = _verify(monkeypatch, db_session, user, "601144", last_pass_change=1_800_000_000)

    assert out.valid is True
    db_session.refresh(row)
    assert is_revoked(row) is False, "重新验证没能恢复绑定"
    assert row.pass_change_at == 1_800_000_000, "基线没换成这次验证时的值"

    # 账号数没有增加：走的是更新分支，不是新建
    assert db_session.query(MT5Account).filter(MT5Account.user_id == "u_free").count() == 1


def test_new_binding_still_hits_the_account_limit(db_session, monkeypatch):
    """上限本身不能被顺手放开：换一个**新**账号时仍然必须挡住。"""
    import pytest as _pytest
    from fastapi import HTTPException as _HTTPException

    from app.models import User

    user = User(id="u_free2", email="d@e.f", api_token="t2", plan="FREE")
    db_session.add(user)
    _account(db_session, user_id="u_free2", login="601144")

    with _pytest.raises(_HTTPException) as exc:
        _verify(monkeypatch, db_session, user, "999999", last_pass_change=1_800_000_000)
    assert exc.value.status_code == 403


def test_binding_without_a_signal_stores_no_baseline(db_session, monkeypatch):
    """券商不返回改密时间时，绑定照常成功，但基线留空（=这道闸对该账号不生效）。

    这里是"读不到就不撤销"这条取舍的入口：存一个 0 会让下一拍立刻把它撤销。
    """
    from app.models import User

    user = User(id="u_pro", email="g@h.i", api_token="t3", plan="PRO")
    db_session.add(user)
    db_session.commit()

    out = _verify(monkeypatch, db_session, user, "700001", last_pass_change=0)

    assert out.valid is True
    row = (
        db_session.query(MT5Account)
        .filter(MT5Account.login == "700001")
        .first()
    )
    assert row is not None
    assert row.pass_change_at is None, "0 被当成时间存下来了，下一拍就会误撤销"


# ---------- 投资者密码这条路已经封死 / the investor-password path is gone ----------


def test_verify_request_no_longer_accepts_investor_only():
    """请求体里不能再有这个字段。

    前端从来没传过 true，所以它「看起来」没被用过——但它在请求体里，任何登录
    用户直接打接口就能用只读的投资者密码换到完整的下单权限。
    """
    from app.routers.gateway import GatewayVerifyRequest

    assert "investorOnly" not in GatewayVerifyRequest.model_fields

    # Pydantic 默认忽略多余字段，所以「构造成功」不代表它生效了；真正要钉的是
    # 传进来的值到不了模型上。
    req = GatewayVerifyRequest(login=1, password="x", investorOnly=True)
    assert not hasattr(req, "investorOnly")


def test_gateway_client_verify_has_no_investor_parameter():
    """连往网关的调用也不该再有这个开关，否则删掉的只是入口、能力还在。"""
    from app.services.gateway_client import verify_account

    assert "investor_only" not in inspect.signature(verify_account).parameters
