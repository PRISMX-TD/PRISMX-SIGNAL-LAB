"""审计 B 组：出入金「原地冲回」（_reverse_flows）不能抹掉真实的资金进出。

· 周期榜：入金 → 用大本金交易 → 出金，以前出金那一轮把入金原地冲成 0，期间那些单的本金
  回到基线，收益率按 入金 / 基线 倍放大；
· 比赛：分母固定是报名本金，资金进出只能靠 cashflowFlagged 标黄挡在终审前；入金后出金、
  或平台外亏损后补钱，net adjust 回到 0、流水清空，标记随之消失，终审直接放行。

只有能用平仓行与余额错拍解释的那一部分才原地冲回（与原来一样不留窗口）；比赛里拖了很久
才冲回的部分照样留作证据。

Audit group B: in-place reversal must not erase real cash flow.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import (
    ClosedTrade, Competition, CompetitionParticipant, MT5Account, Order, PeriodBaseline, User,
)
from app.services.gamification.boards import (
    capital_at, compute_board_rows, ensure_baselines, reconcile_deposits,
)
from app.services.gamification.competitions import (
    comp_period_key, competition_integrity, compute_comp_rows, settle_competition,
)

UTC = timezone.utc


# ---------- 周期榜 / standing board ----------

PK = "2026-W36"
W0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)


def _pos(db, u, login, ticket, profit, opened_at, closed_at):
    db.add(Order(user_id=u.id, client_order_id=f"c{login}{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", mt5_login=login, mt5_ticket=ticket, trade_mode=2,
                 created_at=opened_at))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY", close_volume=0.1,
                       close_price=1, profit=profit, position_ticket=ticket,
                       deal_ticket=ticket * 10, closed_at=closed_at, verified=True))
    db.commit()


def _balance(db, login, value):
    db.query(MT5Account).filter_by(login=login).one().balance = value
    db.commit()


def test_deposit_trade_withdraw_cannot_inflate(db_session):
    u = User(email="cf9@t.co", api_token="tok_cf9"); db_session.add(u); db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="A", server="s", balance=1000.0, trade_mode=2))
    db_session.commit()
    ensure_baselines(db_session, PK, W0)
    _balance(db_session, "A", 100000.0)
    assert reconcile_deposits(db_session, PK, now=W0 + timedelta(hours=1)) == 1
    day1 = W0 + timedelta(days=1)
    for t in range(1, 6):
        _pos(db_session, u, "A", t, 1000.0, day1, day1 + timedelta(hours=1))
    _balance(db_session, "A", 105000.0)
    assert reconcile_deposits(db_session, PK, now=day1 + timedelta(hours=2)) == 0
    _balance(db_session, "A", 6000.0)
    assert reconcile_deposits(db_session, PK, now=W0 + timedelta(days=2)) == 1
    row = {r["login"]: r for r in compute_board_rows(db_session, PK)["return_pct"]}["A"]
    assert abs(row["score"] - 0.05) < 1e-9
    b = db_session.query(PeriodBaseline).one()
    assert capital_at(b, day1) == 100000.0
    assert capital_at(b, W0 + timedelta(days=2)) == 1000.0


def test_withdraw_then_redeposit_does_not_erase_the_withdrawal(db_session):
    """出金后又入金：出金不被原地抹掉——中间那段的小本金照记（只影响那段的单）。"""
    u = User(email="cf10@t.co", api_token="tok_cf10"); db_session.add(u); db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="A", server="s", balance=10000.0, trade_mode=2))
    db_session.commit()
    ensure_baselines(db_session, PK, W0)
    _balance(db_session, "A", 1000.0)
    assert reconcile_deposits(db_session, PK, now=W0 + timedelta(hours=1)) == 1
    _balance(db_session, "A", 10000.0)
    assert reconcile_deposits(db_session, PK, now=W0 + timedelta(days=1)) == 1
    b = db_session.query(PeriodBaseline).one()
    assert abs(b.adjust) < 1e-6
    assert len(json.loads(b.flows)) == 2                    # 两笔都在，没有被并掉 / both kept


# ---------- 比赛 / competition ----------

T0 = datetime(2026, 9, 7, 0, 0, tzinfo=UTC)
E = T0 + timedelta(days=7)


@pytest.fixture
def comp_setup(db_session):
    db = db_session
    comp = Competition(name="CF", metric="return_pct", enrollment="signup", status="running",
                       track="real", starts_at=T0, ends_at=E, min_baseline_usd=1000.0,
                       max_baseline_usd=1000.0, min_trades=1)
    db.add(comp)
    u = User(email="cfc@t.co", api_token="tok_cfc")
    admin = User(email="adm@t.co", api_token="tok_adm", role="admin")
    db.add_all([u, admin]); db.commit()
    db.add(MT5Account(user_id=u.id, login="CF", server="s", source="gateway", trade_mode=2,
                      balance=1000.0, equity=1000.0))
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login="CF",
                                  scoring_from=T0))
    db.add(PeriodBaseline(user_id=u.id, mt5_login="CF", period_key=comp_period_key(comp.id),
                          baseline=1000.0, adjust=0.0, taken_at=T0))
    db.add(Order(user_id=u.id, client_order_id="cf111", symbol="X", side="BUY", volume=0.1,
                 status="FILLED", mt5_login="CF", mt5_ticket=111, trade_mode=2,
                 created_at=T0 + timedelta(hours=1)))
    db.add(ClosedTrade(user_id=u.id, mt5_login="CF", symbol="X", side="BUY", close_volume=0.1,
                       close_price=1, profit=5000.0, position_ticket=111, deal_ticket=1110,
                       closed_at=T0 + timedelta(hours=2), verified=True))
    db.commit()
    return db, comp, admin


def _reconcile(db, comp, at):
    return reconcile_deposits(db, comp_period_key(comp.id), now=at, bounds=(T0, E))


def _flag_kinds(db, comp):
    return {f["login"]: f["kinds"] for f in competition_integrity(db, comp)["flags"]}


def _settle_unacknowledged(db, comp, admin):
    comp.status = "ended"; db.commit()
    settle_competition(db, comp, admin.id, now=E + timedelta(hours=25))


def test_offplatform_loss_then_topup_stays_flagged(comp_setup):
    db, comp, admin = comp_setup
    _balance(db, "CF", 1000.0)                               # 平台外那条腿亏了 5000
    _reconcile(db, comp, T0 + timedelta(hours=3))
    assert "cashflowFlagged" in _flag_kinds(db, comp).get("CF", [])
    _balance(db, "CF", 6000.0)                               # 一小时后补钱 / top-up an hour later
    _reconcile(db, comp, T0 + timedelta(hours=4))
    assert "cashflowFlagged" in _flag_kinds(db, comp).get("CF", [])
    assert {r["login"]: r for r in compute_comp_rows(db, comp)}["CF"]["score"] == 5.0
    with pytest.raises(HTTPException) as e:
        _settle_unacknowledged(db, comp, admin)
    assert e.value.status_code == 400


def test_deposit_then_withdraw_stays_flagged(comp_setup):
    db, comp, admin = comp_setup
    _balance(db, "CF", 100000.0)
    _reconcile(db, comp, T0 + timedelta(hours=3))
    _balance(db, "CF", 6000.0)
    _reconcile(db, comp, T0 + timedelta(hours=4))
    b = db.query(PeriodBaseline).one()
    assert abs(b.adjust) < 1e-6
    assert "cashflowFlagged" in _flag_kinds(db, comp).get("CF", [])
    with pytest.raises(HTTPException):
        _settle_unacknowledged(db, comp, admin)


def test_quick_balance_lag_artifact_not_flagged(comp_setup):
    """平仓行先到、余额晚一轮（一分钟）才跟上：照旧原地冲回，不标黄。"""
    db, comp, admin = comp_setup
    at = T0 + timedelta(hours=2, minutes=1)
    _balance(db, "CF", 1000.0)                               # 余额还没跟上 / balance lagging
    _reconcile(db, comp, at)
    _balance(db, "CF", 6000.0)                               # 一分钟后跟上 / caught up
    _reconcile(db, comp, at + timedelta(minutes=1))
    b = db.query(PeriodBaseline).one()
    assert abs(b.adjust) < 1e-6
    assert "CF" not in _flag_kinds(db, comp)
    _settle_unacknowledged(db, comp, admin)
    assert db.query(CompetitionParticipant).one().final_rank == 1


def test_balance_ahead_of_close_row_artifact_not_flagged(comp_setup):
    """余额先到、平仓行晚一轮才入库：那笔假入金照旧原地冲回，不标黄。"""
    db, comp, admin = comp_setup
    late = db.query(ClosedTrade).one()
    db.delete(late); db.commit()                             # 平仓行还没到 / row not in yet
    at = T0 + timedelta(hours=2, minutes=1)
    _balance(db, "CF", 6000.0)
    _reconcile(db, comp, at)
    assert abs(db.query(PeriodBaseline).one().adjust - 5000.0) < 1e-6
    u = db.query(User).filter_by(email="cfc@t.co").one()
    db.add(ClosedTrade(user_id=u.id, mt5_login="CF", symbol="X", side="BUY", close_volume=0.1,
                       close_price=1, profit=5000.0, position_ticket=111, deal_ticket=1110,
                       closed_at=T0 + timedelta(hours=2), verified=True))
    db.commit()
    _reconcile(db, comp, at + timedelta(minutes=1))
    b = db.query(PeriodBaseline).one()
    assert abs(b.adjust) < 1e-6
    assert "CF" not in _flag_kinds(db, comp)
