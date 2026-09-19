"""网关平仓明细的归属可信度分级（2026-09-19 审计）。

问题：`build_closed_trade_legs` 认一个仓位属于本平台有两条路——仓位号在 `known` 里，
或者某条成交的 `comment` 以配置的前缀开头。此前两者一视同仁，落库时一律
`verified=True`。

但 `comment` 是用户在 MT5 客户端下单时**自己填得进去**的字段。谁在终端里手填一句
"PRISMX" 就能让自己的手动单变成"平台成绩"，而 verified 的记录会进榜单、竞赛与等级。
（另外 (user_id, login) 是多对多，同一 login 上别人开的 PRISMX 单也会记到本人名下。）

现在：仓位号命中 → verified=True（那个号是本平台下单时自己记的，铁证）；
仅前缀命中 → 仍然收录（多半确实是平台的单，只是开仓早于回扫窗口），但 verified=False。

对照组同样重要：前缀命中的腿**不能**被丢掉。丢了就等于用户的历史成绩凭空少一截。

Attribution trust levels for gateway close legs. A position-id hit is proof; a
comment-prefix hit relies on a user-writable field and is recorded unverified.
"""
from dataclasses import dataclass
from datetime import timezone

from app.routers.gateway import build_closed_trade_legs

# MT5 成交方向 / deal actions and entry kinds, mirroring the module's constants
_BUY, _SELL = 0, 1
_IN, _OUT = 0, 1


@dataclass
class FakeDeal:
    ticket: int
    position_id: int
    symbol: str
    action: int
    entry: int
    volume: float
    price: float
    profit: float
    comment: str
    commission: float = 0.0
    storage: float = 0.0
    time: int = 1_785_936_973
    reason: int = -1
    sl: float = 0.0
    tp: float = 0.0


def _pair(position_id: int, comment: str) -> list[FakeDeal]:
    """一开一平两条成交 / one opening and one closing deal for a position."""
    return [
        FakeDeal(ticket=position_id * 10, position_id=position_id, symbol="XAUUSD.s",
                 action=_BUY, entry=_IN, volume=1.0, price=4000.0, profit=0.0,
                 comment=comment, time=1_785_930_000),
        FakeDeal(ticket=position_id * 10 + 1, position_id=position_id, symbol="XAUUSD.s",
                 action=_SELL, entry=_OUT, volume=1.0, price=4010.0, profit=1000.0,
                 comment=comment, time=1_785_936_973),
    ]


def test_position_id_match_is_verified():
    """仓位号命中 = 本平台自己记下来的号，铁证。"""
    legs = build_closed_trade_legs(_pair(50, "PRISMX"), "PRISMX", {50}, server_offset_seconds=0)

    assert len(legs) == 1
    assert legs[0]["attributedByTicket"] is True


def test_comment_prefix_only_match_is_recorded_but_unverified():
    """只有注释前缀命中：收录，但不算已核验。

    这是本次改动的核心。comment 用户可以自己填，拿它当"已核验"等于把 MT5 客户端
    里手打一句 PRISMX 的手动单放进榜单。
    """
    legs = build_closed_trade_legs(_pair(77, "PRISMX manual"), "PRISMX", set(),
                                   server_offset_seconds=0)

    assert len(legs) == 1, "前缀命中的腿必须仍然收录，不能丢掉用户的历史"
    assert legs[0]["attributedByTicket"] is False


def test_unrelated_position_is_still_excluded():
    """既没有仓位号也没有前缀 → 照旧完全不收录（这条没变）。"""
    legs = build_closed_trade_legs(_pair(88, "my own trade"), "PRISMX", {50},
                                   server_offset_seconds=0)

    assert legs == []


def test_known_ticket_wins_even_when_the_comment_is_absent():
    """仓位号命中就够了，注释是什么都不影响——平台单未必带注释。"""
    legs = build_closed_trade_legs(_pair(50, ""), "PRISMX", {50}, server_offset_seconds=0)

    assert len(legs) == 1
    assert legs[0]["attributedByTicket"] is True


def test_mixed_batch_grades_each_position_independently():
    """同一批里两个仓位分别按自己的依据定级，不会互相沾光。"""
    deals = _pair(50, "PRISMX") + _pair(77, "PRISMX")
    legs = build_closed_trade_legs(deals, "PRISMX", {50}, server_offset_seconds=0)

    by_pos = {leg["positionTicket"]: leg["attributedByTicket"] for leg in legs}
    assert by_pos == {50: True, 77: False}


def test_no_prefix_and_no_known_tickets_records_everything_unverified():
    """前缀没配且没有已知仓位号：沿用"不过滤"的老行为（会把手动单也收进来），
    但这些腿一条都不该是已核验的——否则配置漏填就等于给所有手动交易发成绩。"""
    legs = build_closed_trade_legs(_pair(99, "whatever"), "", set(), server_offset_seconds=0)

    assert len(legs) == 1
    assert legs[0]["attributedByTicket"] is False


def test_server_time_offset_is_still_applied():
    """顺带钉住时间换算没被这次改动碰坏（券商服务器墙钟 +3h 不是 UTC）。"""
    legs = build_closed_trade_legs(_pair(50, "PRISMX"), "PRISMX", {50},
                                   server_offset_seconds=3 * 3600)

    from datetime import datetime
    assert legs[0]["closedAt"] == datetime.fromtimestamp(1_785_936_973 - 3 * 3600,
                                                         tz=timezone.utc)
