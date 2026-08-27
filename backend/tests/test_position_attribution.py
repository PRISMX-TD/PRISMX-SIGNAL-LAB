"""仓位编号归属的回归测试：gateway 通道的仓位必须能算出胜负。

这里守的是一个**曾经真实存在于生产环境**的 bug：个人胜率与纪律分把开仓订单
的 `mt5_ticket` 直接拿去比对平仓明细的 `position_ticket`。两条执行通道存的编号
不是一回事——

  * Bridge：市价单成交后 MT5 给仓位的编号与订单编号同值，`mt5_ticket` 恰好
    就是仓位号，比对能中；
  * Gateway（合作券商）：`mt5_ticket` 存的是订单号/成交号，真实仓位号另存
    `mt5_position`，两者是彼此独立的编号空间。

结果是 gateway 账号的每一个仓位都永远匹配不到自己的平仓腿，永远停在"未平仓"，
胜率分母恒为 0、纪律分恒为空——而这恰好是合作券商开户引进来的那批用户。

修法见 services/trade_performance.position_id_of()：统一取
`mt5_position or mt5_ticket`。下面三个用例分别锁住两条通道的正确性，以及
"两条通道混在同一个用户名下"这个真实场景。

Regression tests for position-id attribution. Personal win rate and the
discipline score used to match an opening order's `mt5_ticket` against a close
leg's `position_ticket`; that holds for bridge orders (where MT5 numbers the
position the same as the order) but never for gateway orders, whose real
position id lives in `mt5_position`. Every gateway position therefore stayed
unresolved forever. See trade_performance.position_id_of().
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.trade_performance import compute_personal_winrate, mark_positions_seen


USER = "u-1"
LOGIN = "500123"


def _now():
    return datetime.now(timezone.utc)


@pytest.fixture()
def models():
    import app.models as m

    return m


def _open_order(models, *, ticket, position=None, volume=1.0, symbol="XAUUSD", login=LOGIN):
    """一笔已成交的开仓单。position 为空模拟 bridge，非空模拟 gateway。"""
    return models.Order(
        user_id=USER,
        client_order_id=f"c-{ticket}",
        action="ORDER",
        symbol=symbol,
        side="BUY",
        volume=volume,
        status="FILLED",
        mt5_login=login,
        mt5_ticket=ticket,
        mt5_position=position,
        created_at=_now() - timedelta(days=1),
    )


def _close_leg(models, *, position_ticket, profit, volume=1.0, deal=None, login=LOGIN):
    return models.ClosedTrade(
        user_id=USER,
        mt5_login=login,
        symbol="XAUUSD",
        side="BUY",
        close_volume=volume,
        close_price=2000.0,
        profit=profit,
        position_ticket=position_ticket,
        deal_ticket=deal if deal is not None else position_ticket,
        closed_at=_now(),
    )


def test_gateway_position_resolves_by_mt5_position(db_session, models):
    """Gateway：订单号 88881 与仓位号 99991 不同，平仓腿按仓位号上报。

    修复前这笔仓位永远算不出胜负（wins/losses 全 0、totalResolved 0）。
    """
    db_session.add(_open_order(models, ticket=88881, position=99991))
    db_session.add(_close_leg(models, position_ticket=99991, profit=120.0))
    db_session.commit()

    stats = compute_personal_winrate(db_session, USER, bound_logins=[LOGIN])

    assert stats["totalResolved"] == 1
    assert stats["wins"] == 1
    assert stats["losses"] == 0
    assert stats["winRate"] == 1.0


def test_bridge_position_still_resolves_by_ticket(db_session, models):
    """Bridge：mt5_position 为空，行为必须与修复前完全一致（无回归）。"""
    db_session.add(_open_order(models, ticket=77771, position=None))
    db_session.add(_close_leg(models, position_ticket=77771, profit=-50.0))
    db_session.commit()

    stats = compute_personal_winrate(db_session, USER, bound_logins=[LOGIN])

    assert stats["totalResolved"] == 1
    assert stats["losses"] == 1
    assert stats["wins"] == 0


def test_mixed_channels_under_one_user(db_session, models):
    """同一用户同时有 bridge 与 gateway 仓位——两笔都要计入。

    真实场景：用户先用自己的券商账号（bridge）交易，后来又开了合作券商账号
    （gateway）。修复前只有前者进统计，胜率被系统性算错。
    """
    db_session.add(_open_order(models, ticket=77772, position=None))  # bridge, 盈利
    db_session.add(_close_leg(models, position_ticket=77772, profit=30.0, deal=1001))
    db_session.add(_open_order(models, ticket=88882, position=99992))  # gateway, 亏损
    db_session.add(_close_leg(models, position_ticket=99992, profit=-10.0, deal=1002))
    db_session.commit()

    stats = compute_personal_winrate(db_session, USER, bound_logins=[LOGIN])

    assert stats["totalResolved"] == 2
    assert stats["wins"] == 1
    assert stats["losses"] == 1


def test_partial_closes_sum_to_full_volume(db_session, models):
    """分批平仓：只有累计手数补齐开仓手数才算分出胜负，盈亏按加总的正负判。"""
    db_session.add(_open_order(models, ticket=88883, position=99993, volume=1.0))
    db_session.add(_close_leg(models, position_ticket=99993, profit=-40.0, volume=0.4, deal=2001))
    db_session.commit()
    # 只平了 0.4 手 → 还没分出胜负
    assert compute_personal_winrate(db_session, USER, bound_logins=[LOGIN])["totalResolved"] == 0

    db_session.add(_close_leg(models, position_ticket=99993, profit=100.0, volume=0.6, deal=2002))
    db_session.commit()
    stats = compute_personal_winrate(db_session, USER, bound_logins=[LOGIN])
    assert stats["totalResolved"] == 1
    assert stats["wins"] == 1  # -40 + 100 > 0


def test_mark_positions_seen_stamps_gateway_positions(db_session, models):
    """持仓对账：上报里的 ticket 是真实仓位号，gateway 订单必须也能被刷到。

    修复前 gateway 的持仓一条也刷不到时间戳，_OPEN_FRESHNESS 之后会整体退出
    "进行中"——与平仓腿匹配不上是同一个编号错位的两个面。
    """
    db_session.add(_open_order(models, ticket=88884, position=99994))  # gateway
    db_session.add(_open_order(models, ticket=77774, position=None))   # bridge
    db_session.commit()

    updated = mark_positions_seen(
        db_session,
        USER,
        [{"login": LOGIN, "ticket": 99994}, {"login": LOGIN, "ticket": 77774}],
    )
    assert updated == 2

    stats = compute_personal_winrate(db_session, USER, bound_logins=[LOGIN])
    assert stats["openPositions"] == 2


def test_same_ticket_on_two_accounts_not_cross_attributed(db_session, models):
    """两个账号的仓位号撞车时，平仓腿不能算到另一个账号头上。"""
    other = "500999"
    db_session.add(_open_order(models, ticket=88885, position=99995, login=LOGIN))
    db_session.add(_open_order(models, ticket=88886, position=99995, login=other))
    # 只有 LOGIN 这个账号的仓位真的平了
    db_session.add(_close_leg(models, position_ticket=99995, profit=15.0, deal=3001, login=LOGIN))
    db_session.commit()

    stats = compute_personal_winrate(db_session, USER, bound_logins=[LOGIN, other])

    assert stats["totalResolved"] == 1
    assert stats["wins"] == 1
