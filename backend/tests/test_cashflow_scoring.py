"""收益榜逐仓按「当时本金」计分（2026-09-06）。

原来分母是「基线 + 期内入金」、出金不减。改成每笔仓位的本金 =
max(开仓时刻本金, 平仓时刻本金)，收益率 = Σ 盈亏 ÷ 各自本金。这里钉住四件事：
  · 先赚再出金：本金按出金前算，收益率放大不了（改法最容易开的那个洞）；
  · 先出金再交易：本金按出金后算，不再被压低（改的初衷）；
  · 出金后本金低于门槛还在交易：整行不入榜（与原来的分母闸同一语义）；
  · 没有出入金时分数与原公式逐位相同；比赛榜走同一个 return_score。

Per-position capital-at-time scoring for the return board. Pins: earn-then-
withdraw can't inflate, withdraw-then-trade is credited at the smaller capital,
sub-floor capital drops the row, no-flow rows match the old formula exactly, and
competitions use the same return_score.
"""
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, MT5Account, Order, PeriodBaseline, User
from app.services.gamification.boards import (
    compute_board_rows, ensure_baselines, position_denominator, reconcile_deposits, return_score,
)

UTC = timezone.utc
PK = "2026-W36"
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)      # 周一（期初）


def _user(db, email):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _acct(db, u, login, balance):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance, trade_mode=2))
    db.commit()


def _pos(db, u, login, ticket, profit, opened_at, closed_at, vol=0.1):
    db.add(Order(user_id=u.id, client_order_id=f"c{login}{ticket}", symbol="X",
                 side="BUY", volume=vol, status="FILLED", mt5_login=login,
                 mt5_ticket=ticket, trade_mode=2, created_at=opened_at))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=vol, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at, verified=True))
    db.commit()


def _five_wins(db, u, login, profit, opened_at, closed_at, start=1):
    for t in range(start, start + 5):
        _pos(db, u, login, t, profit, opened_at, closed_at)


def _withdraw(db, login, new_balance, at):
    acct = db.query(MT5Account).filter_by(login=login).first()
    acct.balance = new_balance
    db.commit()
    return reconcile_deposits(db, PK, now=at)


def _score(db, login):
    rows = compute_board_rows(db, PK)["return_pct"]
    return {r["login"]: r for r in rows}.get(login)


def test_earn_then_withdraw_cannot_inflate(db_session):
    """10000 本金赚 1000，再提走 9000：收益率仍是 10%，不是 100%。"""
    u = _user(db_session, "cf1@t.co"); _acct(db_session, u, "A", 10000.0)
    ensure_baselines(db_session, PK, T0)
    day1 = T0 + timedelta(days=1)
    _five_wins(db_session, u, "A", 200.0, day1, day1 + timedelta(hours=1))   # +1000
    acct = db_session.query(MT5Account).filter_by(login="A").first()
    acct.balance = 11000.0; db_session.commit()
    assert reconcile_deposits(db_session, PK, now=day1 + timedelta(hours=2)) == 0   # 纯盈利，无流水
    assert _withdraw(db_session, "A", 2000.0, T0 + timedelta(days=2)) == 1         # 出金 9000
    row = _score(db_session, "A")
    assert abs(row["score"] - 1000.0 / 10000.0) < 1e-9 and row["sample"] == 5


def test_withdraw_then_trade_credited_at_smaller_capital(db_session):
    """先提走 8000 剩 2000，再赚 500：收益率 25%，不再按 10000 压成 5%。"""
    u = _user(db_session, "cf2@t.co"); _acct(db_session, u, "A", 10000.0)
    ensure_baselines(db_session, PK, T0)
    assert _withdraw(db_session, "A", 2000.0, T0 + timedelta(days=1)) == 1
    day2 = T0 + timedelta(days=2)
    _five_wins(db_session, u, "A", 100.0, day2, day2 + timedelta(hours=1))   # +500
    row = _score(db_session, "A")
    assert abs(row["score"] - 500.0 / 2000.0) < 1e-9


def test_withdraw_mid_trade_keeps_larger_capital(db_session):
    """开仓时 10000、平仓前提走 9000：这笔按 10000 算（钱在开仓时刻在账户里）。"""
    u = _user(db_session, "cf3@t.co"); _acct(db_session, u, "A", 10000.0)
    ensure_baselines(db_session, PK, T0)
    opened = T0 + timedelta(days=1)
    assert _withdraw(db_session, "A", 1000.0, T0 + timedelta(days=2)) == 1
    _five_wins(db_session, u, "A", 100.0, opened, T0 + timedelta(days=3))
    row = _score(db_session, "A")
    assert abs(row["score"] - 500.0 / 10000.0) < 1e-9


def test_deposit_mid_trade_dilutes_like_before(db_session):
    """开仓时 1000、平仓前入金 9000：这笔按 10000 算——与原来「入金摊薄」同方向。"""
    u = _user(db_session, "cf4@t.co"); _acct(db_session, u, "A", 1000.0)
    ensure_baselines(db_session, PK, T0)
    opened = T0 + timedelta(days=1)
    acct = db_session.query(MT5Account).filter_by(login="A").first()
    acct.balance = 10000.0; db_session.commit()
    assert reconcile_deposits(db_session, PK, now=T0 + timedelta(days=2)) == 1
    _five_wins(db_session, u, "A", 100.0, opened, T0 + timedelta(days=3))
    row = _score(db_session, "A")
    assert abs(row["score"] - 500.0 / 10000.0) < 1e-9


def test_trading_below_floor_after_withdrawal_drops_row(db_session):
    """提到只剩 300（< 500 门槛）还在交易：整行不入榜，而不是按 300 算出夸张收益率。"""
    u = _user(db_session, "cf5@t.co"); _acct(db_session, u, "A", 2000.0)
    ensure_baselines(db_session, PK, T0)
    assert _withdraw(db_session, "A", 300.0, T0 + timedelta(days=1)) == 1
    day2 = T0 + timedelta(days=2)
    _five_wins(db_session, u, "A", 100.0, day2, day2 + timedelta(hours=1))
    assert _score(db_session, "A") is None


def test_no_flows_matches_old_formula_exactly(db_session):
    u = _user(db_session, "cf6@t.co"); _acct(db_session, u, "A", 2000.0)
    ensure_baselines(db_session, PK, T0)
    day1 = T0 + timedelta(days=1)
    for t, p in enumerate((7.5, 7.5, 7.5, 7.5, 7.5, 7.5, 7.5, 7.5), start=1):
        _pos(db_session, u, "A", t, p, day1, day1 + timedelta(hours=t))
    row = _score(db_session, "A")
    assert row["score"] == 60.0 / 2000.0          # 逐位相同（不是近似）


def test_return_score_helper_and_denominator():
    b = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=1000.0, adjust=-400.0,
                       taken_at=T0, flows='[["2026-09-02T00:00:00+00:00", -400.0]]')
    before, after = T0 + timedelta(days=1), T0 + timedelta(days=3)
    assert position_denominator(b, before, after) == 1000.0     # 跨过出金：取大
    assert position_denominator(b, after, after + timedelta(hours=1)) == 600.0
    assert return_score(b, [(after, after, 60.0)], 500.0) == (0.1, 1)
    assert return_score(b, [(after, after, 60.0)], 700.0) is None   # 本金 600 < 门槛
    assert return_score(b, [], 500.0) == (0.0, 0)
