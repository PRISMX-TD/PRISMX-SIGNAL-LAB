"""收益榜逐仓按「当时本金」计分（2026-09-06）。

原来分母是「基线 + 期内入金」、出金不减。改成每笔仓位的本金 =
max(开仓时刻本金, 平仓时刻本金)，收益率 = Σ 盈亏 ÷ 各自本金。这里钉住四件事：
  · 先赚再出金：本金按出金前算，收益率放大不了（改法最容易开的那个洞）；
  · 先出金再交易：本金按出金后算，不再被压低（改的初衷）；
  · 本金低于门槛时做的单不计入收益榜，其余照常（2026-10-26 前是整行不入榜）；
  · 没有出入金时分数与原公式逐位相同；比赛榜走同一个 return_score。

Per-position capital-at-time scoring for the return board. Pins: earn-then-
withdraw can't inflate, withdraw-then-trade is credited at the smaller capital,
positions on sub-floor capital are skipped (the rest still count), no-flow rows match the old formula exactly, and
competitions use the same return_score.
"""
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, MT5Account, Order, PeriodBaseline, User
from app.services.gamification.boards import (
    compute_board_rows, ensure_baselines, position_capitals, position_denominator, reconcile_deposits,
    return_score,
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


def test_trading_below_floor_after_withdrawal_is_not_counted(db_session):
    """提到只剩 300（< 500 门槛）还在交易：这几笔不计，而不是按 300 算出夸张收益率；
    一笔达标的都没有 → 不入榜。"""
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
    assert return_score(b, [], 500.0) is None
    # 一笔 600 + 一笔 1000：门槛 700 时只算 1000 那笔（sample 只数计入的），
    # 不计入那笔同时平掉的 +60 并进分母 → 50 ÷ 1060
    # 600 + 1000 capital: at a 700 floor only the 1000 one counts, carrying the skipped +60
    mixed = [(after, after, 60.0), (before, after, 50.0)]
    assert return_score(b, mixed, 700.0) == (50.0 / 1060.0, 1)
    assert return_score(b, mixed, 500.0) == (60.0 / 600.0 + 50.0 / 1000.0, 2)


def _monday_below_floor_then_topped_up(db, email):
    """周一本金 450（< 500 门槛）做 5 笔各赚 10，周二入金把本金补到 1000。
    Monday on 450 (below the 500 floor), five +10 trades; Tuesday tops capital up to 1000."""
    u = _user(db, email); _acct(db, u, "A", 450.0)
    ensure_baselines(db, PK, T0)
    _five_wins(db, u, "A", 10.0, T0 + timedelta(hours=1), T0 + timedelta(hours=2))
    acct = db.query(MT5Account).filter_by(login="A").first()
    acct.balance = 500.0; db.commit()
    assert reconcile_deposits(db, PK, now=T0 + timedelta(hours=3)) == 0     # 纯盈利，记下对账时刻
    acct.balance = 1050.0; db.commit()
    assert reconcile_deposits(db, PK, now=T0 + timedelta(days=1)) == 1      # 入金 550 → 本金 1000
    return u


def test_trades_below_floor_skipped_rest_still_rank(db_session):
    """周一本金不够做的 5 笔不计、也不连累整周；周二入金后的 5 笔照常上榜（603494，2026-10-26）。
    Monday's sub-floor trades are skipped without sinking the week; the 5 after Tuesday's top-up rank."""
    u = _monday_below_floor_then_topped_up(db_session, "cf9@t.co")
    wed = T0 + timedelta(days=2)
    _five_wins(db_session, u, "A", 20.0, wed, wed + timedelta(hours=1), start=6)   # +100
    row = _score(db_session, "A")
    assert row is not None and row["sample"] == 5
    # 分母 = 入金本金 1000 + 周一不计入的单赚的 50 / capital 1000 + Monday's skipped +50
    assert abs(row["score"] - 100.0 / 1050.0) < 1e-9
    wr = {r["login"]: r for r in compute_board_rows(db_session, PK)["win_rate"]}
    assert wr.get("A") is None or wr["A"]["sample"] == 10        # 胜率榜照旧数全部


def test_skipped_profit_joins_later_denominators_losses_do_not():
    """不计入的单：累计盈利并入之后计入那笔的分母（平仓时刻之前平掉的才算），亏损不扣；
    门槛只看入金本金，盈利凑不了门槛。
    Skipped positions: their net profit joins the denominator of later counted ones
    (only those closed by its close), losses aren't deducted, and profit never lifts the gate."""
    b = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=90.0, adjust=10.0,
                       taken_at=T0, flows='[["2026-09-01T12:00:00+00:00", 10.0]]')
    mon, tue, wed = T0 + timedelta(hours=1), T0 + timedelta(days=1, hours=13), T0 + timedelta(days=2)
    # 周一本金 90 赚 10（不计入）；周二入金到 100 后一笔赚 11 → 11 ÷ (100 + 10) = 10%
    caps = position_capitals(b, [(mon, mon, 10.0), (tue, tue, 11.0)], 100.0)
    assert caps == [None, 110.0]
    assert abs(return_score(b, [(mon, mon, 10.0), (tue, tue, 11.0)], 100.0)[0] - 0.1) < 1e-12
    # 周一亏的不扣：分母仍是 100 / a skipped loss isn't deducted
    assert position_capitals(b, [(mon, mon, -30.0), (tue, tue, 11.0)], 100.0) == [None, 100.0]
    # 盈亏相抵后按净额：+10 − 4 = 6 / netted: +10 − 4
    assert position_capitals(b, [(mon, mon, 10.0), (mon, mon, -4.0), (tue, tue, 1.0)], 100.0)[2] == 106.0
    # 跨过入金的那笔（开仓 90、平仓 100）照样拿到之前不计入的盈利 / a position spanning the top-up gets it too
    assert position_capitals(b, [(mon, mon, 7.0), (mon, wed, 5.0)], 100.0) == [None, 107.0]
    # 周二赚到余额 100 但入金仍 90 → 门槛不过 / profit alone never passes the gate
    assert position_capitals(b, [(mon, mon, 10.0), (mon, T0 + timedelta(hours=5), 1.0)], 100.0) == [None, None]


def test_positions_after_withdrawing_below_floor_still_count():
    """计入过之后出金跌破门槛：之后的单（赚、亏都算）照常计入，分母沿用最近一笔正常计入单的
    分母（606370 的 11 月月榜：出金 500 后 W47 亏光，月榜仍挂着 +87%，2026-11-19）。
    Once counted, a withdrawal below the floor no longer hides later positions: wins and
    losses count on the last regularly counted denominator."""
    # 本金 1000，周二出金 900（本金 100 < 门槛 500）/ capital 1000, Tuesday withdraws 900
    b = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=1000.0, adjust=-900.0,
                       taken_at=T0, flows='[["2026-09-01T12:00:00+00:00", -900.0]]')
    mon, wed, thu = T0 + timedelta(hours=1), T0 + timedelta(days=2), T0 + timedelta(days=3)
    resolved = [(mon, mon, 300.0), (wed, wed, -250.0), (thu, thu, 40.0)]
    assert position_capitals(b, resolved, 500.0) == [1000.0, 1000.0, 1000.0]
    assert return_score(b, resolved, 500.0) == ((300.0 - 250.0 + 40.0) / 1000.0, 3)
    # 出的比入的多（提走了盈利）：先抵盈利 300，本金 = 400 − 200 = 200，正是账上的钱（④）
    # withdrawing more than deposited: profit first, principal 200 = the money left (4)
    neg = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=400.0, adjust=-500.0,
                         taken_at=T0, flows='[["2026-09-01T12:00:00+00:00", -500.0]]')
    assert position_capitals(neg, [(mon, mon, 300.0), (wed, wed, -250.0)], 100.0) == [400.0, 200.0]
    # 抵完盈利仍跌破门槛 → ③：分母沿用 400 / still below the floor after that → (3) keeps 400
    assert position_capitals(neg, [(mon, mon, 300.0), (wed, wed, -250.0)], 300.0) == [400.0, 400.0]
    # 从没计入过的账户不受影响：门槛下先亏仍不计 / never-counted accounts are unchanged
    assert position_capitals(b, [(wed, wed, -250.0)], 500.0) == [None]
    # 超上限跳过的（比赛那种上限）不在此列 / ceiling skips are not affected
    up = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=1000.0, adjust=5000.0,
                        taken_at=T0, flows='[["2026-09-01T12:00:00+00:00", 5000.0]]')
    assert position_capitals(up, [(mon, mon, 10.0), (wed, wed, -50.0)], 500.0, 2000.0) == [1000.0, None]


def test_withdrawal_consumes_period_profit_first():
    """赚了钱再出金：出金先抵本期已实现盈利，超出部分才减本金（2026-11-19）。
    1 万赚 1000、提走 9900 → 本金 1100（账上的钱），之后赚 110 是 10%，不是按 100 算的 110%。
    A withdrawal consumes realized profit first: 10000 + 1000 profit, withdraw 9900 →
    principal 1100, so a later +110 is 10%, not 110% on 100."""
    b = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=10000.0, adjust=-9900.0,
                       taken_at=T0, flows='[["2026-09-01T12:00:00+00:00", -9900.0]]')
    mon, wed = T0 + timedelta(hours=1), T0 + timedelta(days=2)
    resolved = [(mon, mon, 1000.0), (wed, wed, 110.0)]
    assert position_capitals(b, resolved, 100.0) == [10000.0, 1100.0]
    assert return_score(b, resolved, 100.0) == (1000.0 / 10000.0 + 110.0 / 1100.0, 2)
    # 盈利只能抵一次：两笔出金共 600，盈利 500 → 本金 10000 − 100 / profit is consumed once
    two = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=10000.0, adjust=-600.0,
                         taken_at=T0, flows='[["2026-09-01T10:00:00+00:00", -300.0], '
                                            '["2026-09-01T12:00:00+00:00", -300.0]]')
    assert position_capitals(two, [(mon, mon, 500.0), (wed, wed, 1.0)], 100.0)[1] == 9900.0
    # 出金之后才平仓的盈利不抵：本金 100 / profit closed after the withdrawal doesn't count
    assert position_capitals(b, [(wed, wed, 1000.0)], 100.0) == [100.0]
    assert position_capitals(b, [(wed, wed, 1000.0)], 500.0) == [None]
    # 本期累计亏损时出金整笔减本金（与以前相同）/ with a net loss the whole withdrawal hits principal
    lost = PeriodBaseline(user_id="u", mt5_login="A", period_key=PK, baseline=10000.0, adjust=-4000.0,
                          taken_at=T0, flows='[["2026-09-01T12:00:00+00:00", -4000.0]]')
    assert position_capitals(lost, [(mon, mon, -5000.0), (wed, wed, 10.0)], 100.0) == [10000.0, 6000.0]


def test_trade_gate_counts_only_positions_above_floor(db_session):
    """本金达标的只有 4 笔（< 5 笔门槛）：周一那 5 笔不能凑数，不入收益榜。
    Only 4 in-range positions (< the 5-trade gate): Monday's 5 can't pad the count."""
    u = _monday_below_floor_then_topped_up(db_session, "cf10@t.co")
    wed = T0 + timedelta(days=2)
    for t in range(6, 10):
        _pos(db_session, u, "A", t, 20.0, wed, wed + timedelta(hours=1))
    assert _score(db_session, "A") is None


def test_refill_from_empty_then_trade_before_next_check_ranks(db_session):
    """余额归零的账户入金后马上交易、下一轮对账才发现入金：入金记在上一次对账时刻，
    这期间的单子按入金后的本金算，而不是按 0 算、整行不入榜（2026-09-28 实例）。"""
    u = _user(db_session, "cf7@t.co"); _acct(db_session, u, "A", 0.0)
    ensure_baselines(db_session, PK, T0)
    prev_check = T0 + timedelta(days=1)
    assert reconcile_deposits(db_session, PK, now=prev_check) == 0      # 还是 0，无流水
    opened = prev_check + timedelta(minutes=10)                          # 入金后立刻开仓
    _five_wins(db_session, u, "A", 100.0, opened, opened + timedelta(minutes=10))   # +500
    acct = db_session.query(MT5Account).filter_by(login="A").first()
    acct.balance = 1500.0; db_session.commit()                           # 入金 1000 + 盈利 500
    assert reconcile_deposits(db_session, PK, now=prev_check + timedelta(hours=1)) == 1
    row = _score(db_session, "A")
    assert row is not None and abs(row["score"] - 500.0 / 1000.0) < 1e-9


def test_withdrawal_still_stamped_at_detection_time(db_session):
    """出金仍记在发现它的这一轮：上一次对账到这一次之间平掉的单子按出金前的大本金算。"""
    u = _user(db_session, "cf8@t.co"); _acct(db_session, u, "A", 10000.0)
    ensure_baselines(db_session, PK, T0)
    prev_check = T0 + timedelta(days=1)
    assert reconcile_deposits(db_session, PK, now=prev_check) == 0
    traded = prev_check + timedelta(minutes=10)
    _five_wins(db_session, u, "A", 100.0, traded, traded + timedelta(minutes=10))   # +500
    acct = db_session.query(MT5Account).filter_by(login="A").first()
    acct.balance = 1500.0; db_session.commit()                           # 赚 500 后提走 9000
    assert reconcile_deposits(db_session, PK, now=prev_check + timedelta(hours=1)) == 1
    row = _score(db_session, "A")
    assert abs(row["score"] - 500.0 / 10000.0) < 1e-9
