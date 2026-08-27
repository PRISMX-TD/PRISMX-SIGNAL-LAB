"""纪律分判定口径的回归测试。

守的是两条被真实用户体感发现的问题：

D3 出场纪律曾经等价于"这一单亏没亏钱"——`整仓盈亏 < 0` 即违规。于是价格已经
贴着止损、理性认输平掉判违规，离止盈还远就提前落袋跑掉反而判合规；手动部分平
仓明明是赚的、剩余仓位随后被止损打掉，也算在这次手动操作头上。对一个习惯手动
平仓的用户来说，纪律分整体退化成了胜率的线性变换。现在判据是"离止损还有多远"。

D1 止损纪律有两处：信号本身没带止损时（webhook 的 stopLoss 是可选字段）把账算在
用户头上；以及比较基准跟着每次改单滚动，导致"先拉保本再一路放宽"全程不触发，而
同一个终点一步到位反而判违规。

D2 仓位纪律曾经比原始手数，且不分品种。按账户固定比例（如 1%）下单时，黄金和
货币对算出来的手数差一个数量级，同一品种里止损放宽一倍手数也要减半——按风险
下单这个最有纪律的习惯，反而最容易被判成"报复性加仓"。现在比的是同品种内的
风险敞口 `手数 × |入场价 − 止损价|`。

Regression tests for the discipline-score rules. D3 used to be "did this trade
lose money"; D2 used to compare raw lot sizes across all symbols. Both flagged
correctly-executed trades — see the module docstring of services/discipline.py.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.services.discipline import compute_discipline

USER = "u-1"
LOGIN = "500123"


def _now():
    return datetime.now(timezone.utc)


@pytest.fixture()
def models():
    import app.models as m

    return m


def _open_order(
    models, *, ticket, symbol="XAUUSD", volume=0.10, entry=2000.0, sl=1990.0, minutes_ago=600
):
    """一笔已成交的信号跟单（bridge 通道：仓位号即订单号）。"""
    return models.Order(
        user_id=USER,
        client_order_id=f"o-{ticket}",
        signal_id=f"s-{ticket}",
        action="ORDER",
        symbol=symbol,
        side="BUY",
        volume=volume,
        status="FILLED",
        mt5_login=LOGIN,
        mt5_ticket=ticket,
        sl=sl,
        filled_price=entry,
        created_at=_now() - timedelta(minutes=minutes_ago),
    )


def _close_cmd(models, *, ticket, minutes_ago=60, volume=0.0, auto=False):
    """一条平仓指令。auto=True 模拟系统自动仓管发的，不算用户行为。"""
    prefix = "auto_" if auto else ""
    return models.Order(
        user_id=USER,
        client_order_id=f"{prefix}c-{ticket}-{minutes_ago}",
        action="CLOSE",
        symbol="XAUUSD",
        side="BUY",
        volume=volume,
        status="FILLED",
        mt5_login=LOGIN,
        ticket=ticket,
        created_at=_now() - timedelta(minutes=minutes_ago),
    )


def _modify_cmd(models, *, ticket, sl, minutes_ago=90, auto=False):
    prefix = "auto_" if auto else ""
    return models.Order(
        user_id=USER,
        client_order_id=f"{prefix}m-{ticket}-{minutes_ago}",
        action="MODIFY",
        symbol="XAUUSD",
        side="BUY",
        volume=0.0,
        status="FILLED",
        mt5_login=LOGIN,
        ticket=ticket,
        sl=sl,
        created_at=_now() - timedelta(minutes=minutes_ago),
    )


def _leg(models, *, ticket, profit, close_price, volume=0.10, deal=None, minutes_ago=60):
    return models.ClosedTrade(
        user_id=USER,
        mt5_login=LOGIN,
        symbol="XAUUSD",
        side="BUY",
        close_volume=volume,
        close_price=close_price,
        profit=profit,
        position_ticket=ticket,
        deal_ticket=deal if deal is not None else ticket,
        closed_at=_now() - timedelta(minutes=minutes_ago),
    )


def _dims(db):
    return compute_discipline(db, USER, bound_logins=[LOGIN])["dimensions"]


# --------------------------------------------------------------------------
# D3 出场纪律 / exit discipline
# --------------------------------------------------------------------------

def test_exit_stop_out_is_compliant(db_session, models):
    """亏损但没有网页平仓指令：出场交给了止损，合规。"""
    db_session.add_all([
        _open_order(models, ticket=1),
        _leg(models, ticket=1, profit=-50.0, close_price=1990.0),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["score"] == 100.0


def test_exit_near_stop_is_compliant(db_session, models):
    """离场价已经贴着止损（走完 90% 的止损距离）：这是在执行计划，不是恐慌。

    旧口径只看"亏没亏钱"，这一笔会被判违规。
    """
    db_session.add_all([
        _open_order(models, ticket=2),
        _close_cmd(models, ticket=2),
        _leg(models, ticket=2, profit=-45.0, close_price=1991.0),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["score"] == 100.0


def test_exit_far_from_stop_is_violation(db_session, models):
    """离止损还剩 80% 的距离就手动砍掉：真正的提前离场，判违规。"""
    db_session.add_all([
        _open_order(models, ticket=3),
        _close_cmd(models, ticket=3),
        _leg(models, ticket=3, profit=-10.0, close_price=1998.0),
    ])
    db_session.commit()
    exit_dim = _dims(db_session)["exit"]
    assert exit_dim["score"] == 0.0
    assert exit_dim["violations"] == 1


def test_exit_profit_taking_is_compliant(db_session, models):
    """盈利落袋不算违规（与用户端帮助文案一致）。"""
    db_session.add_all([
        _open_order(models, ticket=4),
        _close_cmd(models, ticket=4),
        _leg(models, ticket=4, profit=+60.0, close_price=2006.0),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["score"] == 100.0


def test_exit_scores_only_the_manually_closed_legs(db_session, models):
    """手动平掉的半仓是赚的（+30），剩下半仓随后被止损打掉（-80）。

    整仓合计为负，但用户那次操作本身没有问题——旧口径按整仓加总，会判违规。
    """
    db_session.add_all([
        _open_order(models, ticket=5, volume=0.20),
        _close_cmd(models, ticket=5, minutes_ago=300, volume=0.10),
        _leg(models, ticket=5, profit=+30.0, close_price=2005.0, volume=0.10,
             deal=51, minutes_ago=299),
        _leg(models, ticket=5, profit=-80.0, close_price=1990.0, volume=0.10,
             deal=52, minutes_ago=30),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["score"] == 100.0


def test_exit_uses_the_stop_actually_in_force(db_session, models):
    """自动移动止损把止损抬到 1999 之后，在 1998 平仓已经穿过了止损。

    拿开仓时的原始止损（1990）算距离会以为"离止损还远"，凭空多判一次违规。
    """
    db_session.add_all([
        _open_order(models, ticket=6),
        _modify_cmd(models, ticket=6, sl=1999.0, minutes_ago=90, auto=True),
        _close_cmd(models, ticket=6, minutes_ago=60),
        _leg(models, ticket=6, profit=-2.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["score"] == 100.0


def test_exit_auto_close_is_not_a_user_action(db_session, models):
    """系统自动仓管平的仓不是用户行为，不参与出场纪律。"""
    db_session.add_all([
        _open_order(models, ticket=7),
        _close_cmd(models, ticket=7, auto=True),
        _leg(models, ticket=7, profit=-10.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["score"] == 100.0


def test_exit_abstains_when_no_leg_matches_the_command(db_session, models):
    """平仓指令找不到对应的成交回执时不评分，宁可样本少也不误判。"""
    db_session.add_all([
        _open_order(models, ticket=8),
        _close_cmd(models, ticket=8, minutes_ago=60),
        _leg(models, ticket=8, profit=-50.0, close_price=1990.0, minutes_ago=300),
    ])
    db_session.commit()
    assert _dims(db_session)["exit"]["samples"] == 0


# --------------------------------------------------------------------------
# D2 仓位纪律 / position-size discipline
# --------------------------------------------------------------------------

def _history(models, *, symbol, volume, entry, sl, count, start_minutes_ago=5000, ticket_base=1000):
    """一批更早的同品种信号单，用来充当基准样本。"""
    return [
        _open_order(
            models, ticket=ticket_base + i, symbol=symbol, volume=volume,
            entry=entry, sl=sl, minutes_ago=start_minutes_ago - i * 10,
        )
        for i in range(count)
    ]


def test_volume_baseline_is_per_symbol(db_session, models):
    """黄金 0.10 手、欧美 2.00 手，都是按固定风险下的单。

    旧口径把所有品种混在一个中位数里（基准≈0.10），欧美这一单必然超 3 倍被判
    违规——而它跟自己的历史完全一致。
    """
    db_session.add_all(_history(models, symbol="XAUUSD", volume=0.10, entry=2000.0, sl=1990.0, count=10))
    db_session.add_all(_history(
        models, symbol="EURUSD", volume=2.00, entry=1.1000, sl=1.0950, count=6,
        start_minutes_ago=4000, ticket_base=2000,
    ))
    db_session.add_all([
        _open_order(models, ticket=20, symbol="EURUSD", volume=2.00, entry=1.1000, sl=1.0950),
        _leg(models, ticket=20, profit=-10.0, close_price=1.0950, volume=2.00),
    ])
    db_session.commit()
    assert _dims(db_session)["volume"]["score"] == 100.0


def test_volume_baseline_is_risk_not_lots(db_session, models):
    """同品种：历史止损 30 美元宽、下 0.033 手；这一单止损收窄到 5 美元、下 0.20 手。

    货币风险完全一样（0.033×30 ≈ 0.20×5），但手数是历史的 6 倍——按手数比必然
    判违规，按风险敞口比是合规的。
    """
    db_session.add_all(_history(models, symbol="XAUUSD", volume=0.033, entry=2000.0, sl=1970.0, count=6))
    db_session.add_all([
        _open_order(models, ticket=21, symbol="XAUUSD", volume=0.20, entry=2000.0, sl=1995.0),
        _leg(models, ticket=21, profit=-5.0, close_price=1995.0, volume=0.20),
    ])
    db_session.commit()
    assert _dims(db_session)["volume"]["score"] == 100.0


def test_volume_real_oversize_is_still_a_violation(db_session, models):
    """止损宽度不变、手数翻 5 倍：风险确实放大了，仍然判违规。"""
    db_session.add_all(_history(models, symbol="XAUUSD", volume=0.10, entry=2000.0, sl=1990.0, count=6))
    db_session.add_all([
        _open_order(models, ticket=22, symbol="XAUUSD", volume=0.50, entry=2000.0, sl=1990.0),
        _leg(models, ticket=22, profit=-250.0, close_price=1990.0, volume=0.50),
    ])
    db_session.commit()
    volume_dim = _dims(db_session)["volume"]
    assert volume_dim["score"] == 0.0
    assert volume_dim["violations"] == 1


def test_volume_abstains_without_enough_same_symbol_history(db_session, models):
    """同品种历史不足（默认要 5 笔）时不评分，而不是拿别的品种凑数。"""
    db_session.add_all(_history(models, symbol="XAUUSD", volume=0.10, entry=2000.0, sl=1990.0, count=10))
    db_session.add_all([
        _open_order(models, ticket=23, symbol="EURUSD", volume=2.00, entry=1.1000, sl=1.0950),
        _leg(models, ticket=23, profit=-10.0, close_price=1.0950, volume=2.00),
    ])
    db_session.commit()
    assert _dims(db_session)["volume"]["samples"] == 0


# --------------------------------------------------------------------------
# D1 止损纪律 / stop-loss discipline
# --------------------------------------------------------------------------

def _signal(models, *, ticket, stop_loss, entry=2000.0):
    return models.Signal(
        id=f"s-{ticket}",
        symbol="XAUUSD",
        side="BUY",
        entry=entry,
        stop_loss=stop_loss,
        take_profit=2030.0,
        status="ACTIVE",
        created_at=_now() - timedelta(minutes=700),
    )


def _stop_dim(db):
    return _dims(db)["stopLoss"]


def test_stop_abstains_when_the_signal_had_none(db_session, models):
    """信号自己就没带止损：用户没有"原始止损"可保留，不评分而不是判他违纪。"""
    db_session.add_all([
        _signal(models, ticket=30, stop_loss=None),
        _open_order(models, ticket=30, sl=None),
        _leg(models, ticket=30, profit=-20.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _stop_dim(db_session)["samples"] == 0


def test_stop_removed_at_entry_is_a_violation(db_session, models):
    """信号给了止损，订单上却没有：是下单时被主动抹掉的，判违规。"""
    db_session.add_all([
        _signal(models, ticket=31, stop_loss=1990.0),
        _open_order(models, ticket=31, sl=None),
        _leg(models, ticket=31, profit=-20.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _stop_dim(db_session)["score"] == 0.0


def test_stop_breakeven_then_widening_is_a_violation(db_session, models):
    """先把止损拉到保本价、再放宽到 1900：终点在计划之外，分几步都算违规。

    基准跟着改单滚动时，保本那一步会把容差的分母压成 0，后面怎么放都不触发。
    """
    db_session.add_all([
        _signal(models, ticket=32, stop_loss=1990.0),
        _open_order(models, ticket=32, sl=1990.0),
        _modify_cmd(models, ticket=32, sl=2000.0, minutes_ago=400),
        _modify_cmd(models, ticket=32, sl=1900.0, minutes_ago=300),
        _leg(models, ticket=32, profit=-20.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _stop_dim(db_session)["score"] == 0.0


def test_stop_tightening_and_easing_within_plan_is_compliant(db_session, models):
    """收紧到 1995 之后回到 1992：始终比原始止损（1990）更紧，是在按计划执行。"""
    db_session.add_all([
        _signal(models, ticket=33, stop_loss=1990.0),
        _open_order(models, ticket=33, sl=1990.0),
        _modify_cmd(models, ticket=33, sl=1995.0, minutes_ago=400),
        _modify_cmd(models, ticket=33, sl=1992.0, minutes_ago=300),
        _leg(models, ticket=33, profit=-20.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _stop_dim(db_session)["score"] == 100.0


def test_stop_deleting_the_stop_is_a_violation(db_session, models):
    """把止损清掉。"""
    db_session.add_all([
        _signal(models, ticket=34, stop_loss=1990.0),
        _open_order(models, ticket=34, sl=1990.0),
        _modify_cmd(models, ticket=34, sl=0.0, minutes_ago=300),
        _leg(models, ticket=34, profit=-20.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _stop_dim(db_session)["score"] == 0.0


def test_stop_auto_trailing_is_not_a_user_action(db_session, models):
    """系统自动仓管改的止损不是用户行为，不参与止损纪律。"""
    db_session.add_all([
        _signal(models, ticket=35, stop_loss=1990.0),
        _open_order(models, ticket=35, sl=1990.0),
        _modify_cmd(models, ticket=35, sl=1900.0, minutes_ago=300, auto=True),
        _leg(models, ticket=35, profit=-20.0, close_price=1998.0),
    ])
    db_session.commit()
    assert _stop_dim(db_session)["score"] == 100.0
