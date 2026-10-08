"""桥接平仓明细的服务端归属核验（ClosedTrade.verified）。

这个端点的数据来自用户自己电脑上的桥接程序，凭的是该用户自己的 API Token。
"只收本平台开的仓位"原本只是客户端的魔术号筛选，服务端收到什么写什么——也就
是说，任何人都能用自己的 token 直接 POST 一批凭空捏造的盈利记录。

核验规则：平仓腿的 (账号, 仓位编号) 必须对得上本用户一笔已成交的开仓订单。
核不过的**照常入库**、只标 False（回执丢失等正当原因不该让用户丢掉真实记录），
但任何对外代表成绩的统计都只应认 True。

Server-side attribution for bridge-reported closing legs. The endpoint is
authenticated by the user's own API token and used to store whatever it was
sent, so fabricated profits were accepted verbatim. A leg must now match one of
the user's filled opening orders to be flagged verified; unmatched legs are
still stored (a lost fill callback is a legitimate cause) but flagged False.
"""
from datetime import datetime, timezone

import pytest

from app.models import ClosedTrade, MT5Account, Order, User
from app.routers.bridge import BridgeClosedTrade, _trade_history_db_work
from app.services.gateway_binding import REASON_USER_REMOVED


LOGIN = "500123"


def _bridge_row(db, user_id, login=LOGIN, **kw):
    db.add(MT5Account(user_id=user_id, login=login, server="s", source="bridge", **kw))
    db.commit()


@pytest.fixture()
def user(db_session):
    u = User(email="t@example.com", api_token="tok-1")
    db_session.add(u)
    db_session.commit()
    db_session.refresh(u)
    # 桥接平仓明细只收本人仍挂着桥接行的账号（见 test_leg_for_gateway_only_login_is_rejected）
    _bridge_row(db_session, u.id)
    return u


def _order(db, user_id, *, ticket, position=None, login=LOGIN):
    db.add(Order(
        user_id=user_id,
        client_order_id=f"c-{ticket}",
        action="ORDER",
        symbol="XAUUSD",
        side="BUY",
        volume=1.0,
        status="FILLED",
        mt5_login=login,
        mt5_ticket=ticket,
        mt5_position=position,
        created_at=datetime.now(timezone.utc),
    ))
    db.commit()


def _leg(*, position_ticket, deal, profit=100.0, login=LOGIN):
    return BridgeClosedTrade(
        login=login,
        symbol="XAUUSD",
        side="BUY",
        closeVolume=1.0,
        closePrice=2000.0,
        profit=profit,
        positionTicket=position_ticket,
        dealTicket=deal,
        closedAt=datetime.now(timezone.utc),
    )


def _post(db, user, legs):
    inserted, unverified, rejected = _trade_history_db_work(db, user.id, legs)
    return {"inserted": inserted, "unverified": unverified, "rejected": rejected}


def test_leg_matching_a_platform_order_is_verified(db_session, user):
    _order(db_session, user.id, ticket=77771)

    res = _post(db_session, user, [_leg(position_ticket=77771, deal=9001)])

    assert res["inserted"] == 1
    row = db_session.query(ClosedTrade).one()
    assert row.verified is True


def test_fabricated_leg_is_stored_but_not_verified(db_session, user):
    """凭空捏造的仓位：本用户名下没有任何对应的开仓订单。

    修复前它和真实记录完全无法区分——这正是"自己造一批全胜记录"的攻击面。
    """
    res = _post(db_session, user, [_leg(position_ticket=424242, deal=9002, profit=99999.0)])

    assert res["inserted"] == 1, "不能因为存疑就丢掉记录"
    row = db_session.query(ClosedTrade).one()
    assert row.verified is False


def test_gateway_position_id_is_recognised(db_session, user):
    """Gateway 订单的仓位号存在 mt5_position，核验必须也认这一列。

    否则合作券商用户的每一条平仓明细都会被误判成"来路不明"。
    """
    _order(db_session, user.id, ticket=88881, position=99991)

    _post(db_session, user, [_leg(position_ticket=99991, deal=9003)])

    assert db_session.query(ClosedTrade).one().verified is True


def test_other_account_position_is_not_verified(db_session, user):
    """仓位号对得上，但账号对不上——不能算核验通过。"""
    _bridge_row(db_session, user.id, login="700999")
    _order(db_session, user.id, ticket=77772, login=LOGIN)

    _post(db_session, user, [_leg(position_ticket=77772, deal=9004, login="700999")])

    assert db_session.query(ClosedTrade).one().verified is False


def test_pending_order_does_not_vouch_for_a_leg(db_session, user):
    """只有 FILLED 的开仓订单才算数：挂单/被拒的订单不能给平仓腿背书。"""
    db_session.add(Order(
        user_id=user.id, client_order_id="c-x", action="ORDER", symbol="XAUUSD",
        side="BUY", volume=1.0, status="PENDING", mt5_login=LOGIN, mt5_ticket=66661,
        created_at=datetime.now(timezone.utc),
    ))
    db_session.commit()

    _post(db_session, user, [_leg(position_ticket=66661, deal=9005)])

    assert db_session.query(ClosedTrade).one().verified is False


def test_mixed_batch_flags_each_leg_independently(db_session, user):
    _order(db_session, user.id, ticket=77773)

    _post(db_session, user, [
        _leg(position_ticket=77773, deal=9006),      # 真的
        _leg(position_ticket=555555, deal=9007),     # 假的
    ])

    rows = {r.deal_ticket: r.verified for r in db_session.query(ClosedTrade).all()}
    assert rows == {9006: True, 9007: False}


def test_repeat_report_is_still_deduped(db_session, user):
    """回看窗口会反复报同一笔成交，去重行为不能因为加了核验而改变。"""
    _order(db_session, user.id, ticket=77774)
    legs = [_leg(position_ticket=77774, deal=9008)]

    first = _post(db_session, user, legs)
    second = _post(db_session, user, legs)

    assert first["inserted"] == 1
    assert second["inserted"] == 0
    assert db_session.query(ClosedTrade).count() == 1


def test_empty_payload_is_a_noop(db_session, user):
    assert _post(db_session, user, [])["inserted"] == 0
    assert db_session.query(ClosedTrade).count() == 0


# ---- 只收本人仍挂着桥接行的账号 / only logins with a live bridge row ---------------

def test_leg_for_gateway_only_login_is_rejected(db_session, user):
    """账号只经 gateway 绑定：桥接通道报上来的平仓腿一律不收。

    否则拿自己的 API Token 就能给直连账户的真实仓位号伪造一条带任意盈利的平仓腿，
    而 known_position_ids 认 gateway 订单的 mt5_position，这条腿会被记成 verified，
    直接进比赛成绩。
    """
    db_session.add(MT5Account(user_id=user.id, login="600111", server="", source="gateway"))
    db_session.commit()
    _order(db_session, user.id, ticket=1, position=99991, login="600111")

    res = _post(db_session, user, [_leg(position_ticket=99991, deal=9101, login="600111",
                                        profit=99999.0)])

    assert res == {"inserted": 0, "unverified": 0, "rejected": 1}
    assert db_session.query(ClosedTrade).count() == 0


def test_leg_for_removed_bridge_login_is_rejected(db_session, user):
    _bridge_row(db_session, user.id, login="700777", revoked_reason=REASON_USER_REMOVED)
    _order(db_session, user.id, ticket=7001, login="700777")

    res = _post(db_session, user, [_leg(position_ticket=7001, deal=9102, login="700777")])

    assert res["rejected"] == 1 and res["inserted"] == 0
    assert db_session.query(ClosedTrade).count() == 0


def test_other_users_bridge_row_does_not_count(db_session, user):
    other = User(email="o@example.com", api_token="tok-2")
    db_session.add(other); db_session.commit()
    _bridge_row(db_session, other.id, login="700888")

    res = _post(db_session, user, [_leg(position_ticket=1, deal=9103, login="700888")])

    assert res["rejected"] == 1
    assert db_session.query(ClosedTrade).count() == 0


def test_mixed_batch_keeps_bridge_legs_and_drops_others(db_session, user):
    _order(db_session, user.id, ticket=77779)

    res = _post(db_session, user, [
        _leg(position_ticket=77779, deal=9104),                    # 桥接账号，真单
        _leg(position_ticket=77779, deal=9105, login="600222"),    # 没有桥接行
    ])

    assert res == {"inserted": 1, "unverified": 0, "rejected": 1}
    assert {r.deal_ticket for r in db_session.query(ClosedTrade).all()} == {9104}


def test_temporary_bridge_row_cannot_forge_legs_for_a_gateway_login(db_session, user):
    """用户已经用 gateway 直连绑了 L，再用不同的服务器名给 L 建一条桥接行，
    借这条临时桥接行上报伪造腿、事后删掉桥接行抹痕迹——腿必须一开始就被拒。

    A live gateway row for L makes L gateway-owned: a second bridge row under a
    different server name must not open the bridge channel for L.
    """
    db_session.add(MT5Account(user_id=user.id, login="600333", server="Broker-Live",
                              source="gateway"))
    db_session.commit()
    _bridge_row(db_session, user.id, login="600333")   # server="s"，不同服务器名
    _order(db_session, user.id, ticket=3, position=99993, login="600333")

    res = _post(db_session, user, [_leg(position_ticket=99993, deal=9201, login="600333",
                                        profit=99999.0)])

    assert res == {"inserted": 0, "unverified": 0, "rejected": 1}
    # 删掉临时桥接行之后也不留下任何伪造腿
    bridge = (db_session.query(MT5Account)
              .filter_by(user_id=user.id, login="600333", source="bridge").one())
    bridge.revoked_reason = REASON_USER_REMOVED
    db_session.commit()
    assert db_session.query(ClosedTrade).filter_by(mt5_login="600333").count() == 0


def test_removed_or_revoked_gateway_row_does_not_block_bridge_legs(db_session, user):
    """只有仍有效（未软删、未撤销）的 gateway 行才接管该账号；
    已删除 / 已撤销的 gateway 行不挡这个账号的桥接腿。"""
    db_session.add(MT5Account(user_id=user.id, login=LOGIN, server="g1", source="gateway",
                              revoked_reason=REASON_USER_REMOVED,
                              revoked_at=datetime.now(timezone.utc)))
    db_session.add(MT5Account(user_id=user.id, login=LOGIN, server="g2", source="gateway",
                              revoked_reason="password_changed",
                              revoked_at=datetime.now(timezone.utc)))
    db_session.commit()
    _order(db_session, user.id, ticket=77780)

    res = _post(db_session, user, [_leg(position_ticket=77780, deal=9202)])

    assert res == {"inserted": 1, "unverified": 0, "rejected": 0}
