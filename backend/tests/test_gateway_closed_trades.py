"""build_closed_trade_legs 的归属判定测试。

用例取自 login=500039 的真实成交历史。那批数据暴露了归属判定的两个错误假设：

  * 平仓腿的 comment **不一定**带 PRISMX 前缀。TP 触发时由服务器写，实测是
    "[tp 4177.62]"；市价平仓时甚至是空串。
  * 开仓腿常常已经滑出回看窗口——实测开仓到平仓间隔 21~98 分钟，窗口只有 15 分钟。

两者叠加的结果是所有仓位都被判为「不是本平台的」而丢弃，明细永远是空的。
所以主依据必须是 known_position_tickets（来自 orders.mt5_position）。
"""

from dataclasses import dataclass

from datetime import datetime, timezone

from app.routers.gateway import build_closed_trade_legs, observe_server_offset

PREFIX = "PRISMX"


@dataclass
class FakeDeal:
    """够 build_closed_trade_legs 用的最小 DealRsp 替身。"""

    ticket: int
    position_id: int
    symbol: str
    action: int  # 0=BUY 1=SELL
    entry: int  # 0=IN 1=OUT
    volume: float
    price: float
    profit: float
    comment: str
    commission: float = 0.0
    storage: float = 0.0
    time: int = 1785936973


def _tp_close_only():
    """只有平仓腿、comment 被券商改成 TP 标记——开仓腿早已滑出窗口。"""
    return [
        FakeDeal(
            ticket=15525579, position_id=17431512, symbol="XAUUSD.s",
            action=1, entry=1, volume=0.5, price=4177.84, profit=777.0,
            comment="[tp 4177.62]",
        )
    ]


def test_tp_close_recognised_via_known_position():
    """TP 平仓 + 开仓腿不在窗口内：只能靠已知仓位号认出来。"""
    legs = build_closed_trade_legs(_tp_close_only(), PREFIX, {17431512})

    assert len(legs) == 1
    assert legs[0]["positionTicket"] == 17431512
    assert legs[0]["dealTicket"] == 15525579
    assert legs[0]["profit"] == 777.0
    # 平仓成交是 SELL，平掉的是多单
    assert legs[0]["side"] == "BUY"


def test_tp_close_dropped_without_known_position():
    """同一笔成交，不给已知仓位号就必然漏掉——这正是线上表现为空的原因。"""
    assert build_closed_trade_legs(_tp_close_only(), PREFIX, set()) == []


def test_empty_comment_close_recognised_via_known_position():
    """市价平仓 comment 为空串，同样只能靠仓位号。"""
    deals = [
        FakeDeal(
            ticket=15512197, position_id=17420270, symbol="XAUUSD.s",
            action=0, entry=1, volume=0.1, price=4154.54, profit=-35.4,
            comment="",
        )
    ]

    legs = build_closed_trade_legs(deals, PREFIX, {17420270})

    assert len(legs) == 1
    assert legs[0]["profit"] == -35.4
    # 平仓成交是 BUY，平掉的是空单
    assert legs[0]["side"] == "SELL"


def test_prefixed_opening_leg_still_works_as_fallback():
    """窗口内同时有带前缀的开仓腿时，不给已知仓位号也应认出（兜底路径）。"""
    deals = [
        FakeDeal(
            ticket=15508374, position_id=17420270, symbol="XAUUSD.s",
            action=1, entry=0, volume=0.1, price=4151.0, profit=0.0,
            comment="PRISMX-co_msfxkrjj_s5h61i",
        ),
        FakeDeal(
            ticket=15512197, position_id=17420270, symbol="XAUUSD.s",
            action=0, entry=1, volume=0.1, price=4154.54, profit=-35.4,
            comment="",
        ),
    ]

    legs = build_closed_trade_legs(deals, PREFIX, set())

    assert len(legs) == 1
    assert legs[0]["positionTicket"] == 17420270


def test_foreign_position_excluded():
    """既不在已知仓位里、也没有带前缀的腿，就不是本平台的，必须排除。"""
    deals = [
        FakeDeal(
            ticket=99999, position_id=88888, symbol="EURUSD.s",
            action=1, entry=1, volume=0.02, price=1.1, profit=5.0,
            comment="manual",
        )
    ]

    assert build_closed_trade_legs(deals, PREFIX, {17431512}) == []


def test_balance_operations_ignored():
    """出入金等非交易成交没有 position_id，不能进平仓明细。"""
    deals = [
        FakeDeal(
            ticket=15412003, position_id=0, symbol="", action=2, entry=0,
            volume=0.0, price=0.0, profit=10000.0, comment="d_",
        )
    ]

    assert build_closed_trade_legs(deals, PREFIX, set()) == []


def test_partial_closes_share_position_and_split_fees():
    """同一仓位两次部分平仓：各自入库，手续费按手数比例分摊。"""
    deals = [
        FakeDeal(
            ticket=1, position_id=555, symbol="XAUUSD.s", action=1, entry=1,
            volume=0.3, price=4200.0, profit=30.0, comment="", commission=-3.0,
        ),
        FakeDeal(
            ticket=2, position_id=555, symbol="XAUUSD.s", action=1, entry=1,
            volume=0.1, price=4201.0, profit=10.0, comment="", commission=-1.0,
        ),
    ]

    legs = build_closed_trade_legs(deals, PREFIX, {555})

    assert len(legs) == 2
    by_deal = {leg["dealTicket"]: leg for leg in legs}
    # 总费用 -4，按 0.3/0.4 与 0.1/0.4 分摊
    assert by_deal[1]["profit"] == 30.0 + (-4.0 * 0.75)
    assert by_deal[2]["profit"] == 10.0 + (-4.0 * 0.25)


# ---- 服务器时区偏移 / server zone offset --------------------------------------
# Manager API 的 deal.time 是服务器墙钟 epoch。开仓腿的 time 与我们 orders.created_at
# （真 UTC）之差 = 偏移；平仓腿落库前减掉它。见 gateway.observe_server_offset。

_OPENED = datetime(2026, 9, 4, 13, 30, 0, tzinfo=timezone.utc)   # 我们下单的 UTC 时刻
_SERVER_AHEAD = 3 * 3600                                          # 服务器 UTC+3


def _in_out(pos: int, opened_utc: datetime, ahead: int, latency: int = 2):
    """一开一平，time 都按"服务器领先 ahead 秒"的参照系给出。"""
    t_open = int(opened_utc.timestamp()) + ahead + latency
    return [
        FakeDeal(ticket=pos * 10, position_id=pos, symbol="XAUUSD", action=0, entry=0,
                 volume=0.1, price=2400.0, profit=0.0, comment="PRISMX", time=t_open),
        FakeDeal(ticket=pos * 10 + 1, position_id=pos, symbol="XAUUSD", action=1, entry=1,
                 volume=0.1, price=2410.0, profit=100.0, comment="", time=t_open + 600),
    ]


def test_offset_observed_from_in_leg_rounded_to_half_hour():
    deals = _in_out(1, _OPENED, _SERVER_AHEAD)
    assert observe_server_offset(deals, {1: _OPENED}) == _SERVER_AHEAD
    # 执行延迟几十秒也不影响：四舍五入到半小时
    assert observe_server_offset(_in_out(2, _OPENED, _SERVER_AHEAD, latency=40), {2: _OPENED}) == _SERVER_AHEAD


def test_offset_none_without_platform_in_leg_and_ignores_outliers():
    only_out = [d for d in _in_out(1, _OPENED, _SERVER_AHEAD) if d.entry == 1]
    assert observe_server_offset(only_out, {1: _OPENED}) is None        # 窗口里没有开仓腿
    assert observe_server_offset(_in_out(1, _OPENED, _SERVER_AHEAD), {}) is None   # 不是我们开的
    # 相差一个月的样本不可能是时区，丢弃
    stale = _in_out(3, _OPENED, 30 * 86400)
    assert observe_server_offset(stale, {3: _OPENED}) is None


def test_closed_at_shifted_back_to_true_utc():
    deals = _in_out(7, _OPENED, _SERVER_AHEAD)
    legs = build_closed_trade_legs(deals, PREFIX, {7}, server_offset_seconds=_SERVER_AHEAD)
    assert len(legs) == 1
    closed = legs[0]["closedAt"]
    # 真 UTC：开仓后 10 分钟 + 2 秒延迟，不再多出 3 小时
    assert closed == _OPENED.replace(second=2) + (datetime(2026, 1, 1, 0, 10) - datetime(2026, 1, 1))
    # 默认 0 偏移 = 旧行为（仍然领先 3 小时）
    legacy = build_closed_trade_legs(deals, PREFIX, {7})[0]["closedAt"]
    assert (legacy - closed).total_seconds() == _SERVER_AHEAD
