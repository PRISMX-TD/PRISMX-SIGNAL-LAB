"""个人跟单胜率聚合的单测：多账号仓位编号撞车（准确性）+ 拿 MT5 实时持仓对账
（把平仓明细漏报、永远卡在"进行中"的仓位剔除）。
Unit tests for personal win-rate aggregation: the multi-account ticket-collision
accuracy fix, plus reconciliation against MT5's live positions (dropping
positions whose close-legs were missed and would otherwise stick at "进行中").
"""
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, Order
from app.services.trade_performance import compute_personal_winrate, mark_positions_seen


def _now():
    return datetime.now(timezone.utc)


def _order(db, user, ticket, login, volume=1.0, last_seen="fresh"):
    # last_seen: "fresh" = 最近仍持仓 / recently open; "stale" = 很久没被报为持仓;
    # None = 从没被报过（历史脏数据）/ never reported (legacy dirty data)
    if last_seen == "fresh":
        seen = _now()
    elif last_seen == "stale":
        seen = _now() - timedelta(hours=2)
    else:
        seen = None
    o = Order(
        user_id=user.id,
        client_order_id=f"co-{login}-{ticket}",
        action="ORDER",
        status="FILLED",
        symbol="XAUUSD",
        side="BUY",
        volume=volume,
        mt5_login=login,
        mt5_ticket=ticket,
        position_last_seen_open=seen,
    )
    db.add(o)
    db.commit()
    return o


def _leg(db, user, ticket, login, profit, volume=1.0, deal=None):
    row = ClosedTrade(
        user_id=user.id,
        mt5_login=login,
        symbol="XAUUSD",
        side="BUY",
        close_volume=volume,
        close_price=2360.0,
        profit=profit,
        position_ticket=ticket,
        deal_ticket=deal if deal is not None else int(f"{ticket}{int(profit) % 100:02d}"),
        closed_at=_now(),
    )
    db.add(row)
    db.commit()
    return row


def test_no_orders_returns_empty(db, user):
    assert compute_personal_winrate(db, user.id) == {
        "wins": 0, "losses": 0, "totalResolved": 0, "winRate": None, "openPositions": 0
    }


def test_single_account_win_loss_open(db, user):
    _order(db, user, ticket=100, login="10001")
    _leg(db, user, ticket=100, login="10001", profit=12.5)   # 全平且盈利 → win
    _order(db, user, ticket=101, login="10001")
    _leg(db, user, ticket=101, login="10001", profit=-8.0)   # 全平且亏损 → loss
    _order(db, user, ticket=102, login="10001", last_seen="fresh")  # 仍持仓 → open

    r = compute_personal_winrate(db, user.id)
    assert (r["wins"], r["losses"], r["totalResolved"], r["openPositions"]) == (1, 1, 2, 1)
    assert r["winRate"] == 0.5


def test_partial_close_still_open(db, user):
    _order(db, user, ticket=200, login="10001", volume=1.0, last_seen="fresh")
    _leg(db, user, ticket=200, login="10001", profit=5.0, volume=0.4)  # 只平了 0.4/1.0，仍持仓
    r = compute_personal_winrate(db, user.id)
    assert r["openPositions"] == 1
    assert r["totalResolved"] == 0


def test_multi_account_ticket_collision(db, user):
    # 两个账号各有一个仓位编号 500 的仓位——必须算成两个独立仓位，
    # 且各自的平仓明细不能串到对方头上。
    # Same ticket 500 on two different logins: two distinct positions, and each
    # account's close-legs must not bleed into the other.
    _order(db, user, ticket=500, login="10001", volume=1.0)
    _order(db, user, ticket=500, login="20002", volume=1.0)
    _leg(db, user, ticket=500, login="10001", profit=30.0, deal=90001)   # 账号 A 盈利
    _leg(db, user, ticket=500, login="20002", profit=-15.0, deal=90002)  # 账号 B 亏损

    r = compute_personal_winrate(db, user.id)
    # 修复前：字典键相撞只剩一个仓位、两条明细相加(30-15>0)误判成单个 win。
    assert (r["wins"], r["losses"], r["totalResolved"], r["openPositions"]) == (1, 1, 2, 0)


def test_legacy_order_without_login_falls_back_to_ticket(db, user):
    # 历史订单账号未回填(None)时，退回按编号匹配，避免误判为一直未平仓。
    _order(db, user, ticket=600, login=None, volume=1.0)
    _leg(db, user, ticket=600, login="10001", profit=7.0)
    r = compute_personal_winrate(db, user.id)
    assert (r["wins"], r["losses"], r["openPositions"]) == (1, 0, 0)


def test_stale_open_without_close_is_dropped(db, user):
    # 核心修复：既没有平仓明细、MT5 也很久没把它报为持仓（或从没报过）——判定为已
    # 在别处平掉、平仓明细漏报，从"进行中"里剔除，不再永远卡着。
    # Core fix: no close record AND not reported open recently (or ever) →
    # treated as closed elsewhere and dropped from "进行中".
    _order(db, user, ticket=700, login="10001", last_seen="stale")
    _order(db, user, ticket=701, login="10001", last_seen=None)  # 历史脏数据 / dirty legacy row
    r = compute_personal_winrate(db, user.id)
    assert (r["wins"], r["losses"], r["totalResolved"], r["openPositions"]) == (0, 0, 0, 0)


def test_reconciliation_flow_marks_and_drops(db, user):
    # 端到端：三笔历史仓位都卡在"进行中"(last_seen=None)；桥接上报实时持仓只含其中
    # 两笔 → 这两笔被刷新为持仓、算作"进行中"，另一笔没上报（已在别处平掉）被剔除。
    # End-to-end: three legacy positions stuck open (last_seen=None); a live
    # report lists only two of them → those two get refreshed and counted open,
    # the unreported one (closed elsewhere) is dropped.
    _order(db, user, ticket=800, login="10001", last_seen=None)
    _order(db, user, ticket=801, login="10001", last_seen=None)
    _order(db, user, ticket=802, login="10001", last_seen=None)

    before = compute_personal_winrate(db, user.id)
    assert before["openPositions"] == 0  # 对账前都是脏数据、还没被报为持仓

    n = mark_positions_seen(db, user.id, [
        {"login": "10001", "ticket": 800},
        {"login": "10001", "ticket": 801},
    ])
    assert n == 2

    after = compute_personal_winrate(db, user.id)
    assert after["openPositions"] == 2  # 802 没被上报，仍不算"进行中"


def test_mark_positions_seen_respects_account(db, user):
    # 同一编号在两个账号：只有被上报的那个账号该被刷新为持仓。
    # Same ticket on two accounts: only the reported account gets refreshed.
    _order(db, user, ticket=900, login="10001", last_seen=None)
    _order(db, user, ticket=900, login="20002", last_seen=None)

    mark_positions_seen(db, user.id, [{"login": "10001", "ticket": 900}])

    r = compute_personal_winrate(db, user.id)
    assert r["openPositions"] == 1  # 只有账号 10001 的那笔算作进行中


def test_http_bridge_positions_reconciles_winrate(client, auth_headers, bridge_headers, db, user):
    # 端到端走真实 HTTP：脏数据仓位先不算进行中；桥接 POST /bridge/positions 上报后，
    # GET /orders/winrate 才把它算作进行中——验证 bridge→trade_performance 的接线。
    # Real HTTP end-to-end: a dirty position isn't counted open; after the bridge
    # POSTs /bridge/positions, GET /orders/winrate counts it open — exercises the
    # bridge -> trade_performance wiring (async endpoint + threadpool + its own session).
    _order(db, user, ticket=1234, login="10001", last_seen=None)

    r0 = client.get("/api/orders/winrate", headers=auth_headers)
    assert r0.status_code == 200 and r0.json()["openPositions"] == 0

    rp = client.post(
        "/api/bridge/positions",
        json={"data": [{"login": "10001", "ticket": 1234, "symbol": "XAUUSD",
                        "side": "BUY", "volume": 1.0, "entryPrice": 2350.0,
                        "currentPrice": 2352.0, "stopLoss": 0.0, "takeProfit": 0.0}]},
        headers=bridge_headers,
    )
    assert rp.status_code == 200

    r1 = client.get("/api/orders/winrate", headers=auth_headers)
    assert r1.status_code == 200 and r1.json()["openPositions"] == 1
