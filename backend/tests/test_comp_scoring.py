from datetime import datetime, timedelta, timezone

from app.models import (
    User, MT5Account, Order, ClosedTrade, PeriodBaseline,
    Competition, CompetitionParticipant, LeaderboardSnapshot,
)
from app.services.gamification.competitions import (
    comp_period_key, compute_comp_rows, snapshot_competitions,
)
from app.services.gamification.boards import reconcile_deposits
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)
IN_WINDOW = T0 + timedelta(days=2)


def _user(db, email):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _acct(db, u, login, balance=2000.0, tm=2):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance,
                      trade_mode=tm)); db.commit()


def _pos(db, u, login, ticket, profit, closed_at, vol=0.1):
    db.add(Order(user_id=u.id, client_order_id=f"c{login}{ticket}", symbol="X",
                 side="BUY", volume=vol, status="FILLED", mt5_login=login,
                 mt5_ticket=ticket, trade_mode=2,
                 created_at=closed_at - timedelta(hours=2)))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=vol, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at, verified=True))
    db.commit()


def _mk(db, u, login, n_win, n_loss, win_p=10.0, loss_p=-5.0, start_ticket=1, base_time=IN_WINDOW):
    t = start_ticket
    for _ in range(n_win):
        _pos(db, u, login, t, win_p, base_time); t += 1
    for _ in range(n_loss):
        _pos(db, u, login, t, loss_p, base_time); t += 1
    return t


def _comp(db, metric="return_pct", status="running", starts_at=T0, ends_at=ENDS, name="Comp A"):
    c = Competition(name=name, metric=metric, status=status,
                     starts_at=starts_at, ends_at=ends_at)
    db.add(c); db.commit(); return c


def _baseline(db, comp, u, login, balance=2000.0, taken_at=T0):
    db.add(PeriodBaseline(user_id=u.id, mt5_login=login, period_key=comp_period_key(comp.id),
                          baseline=balance, taken_at=taken_at))
    db.commit()


def _participant(db, comp, u, login, scoring_from=None, disqualified=False):
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                                  scoring_from=scoring_from, disqualified=disqualified))
    db.commit()


def test_comp_period_key():
    assert comp_period_key("abc") == "comp:abc"


def test_two_participants_score_and_third_account_excluded(db_session):
    comp = _comp(db_session)
    u1 = _user(db_session, "p1@t.co"); _acct(db_session, u1, "A", balance=2000.0)
    u2 = _user(db_session, "p2@t.co"); _acct(db_session, u2, "B", balance=1000.0)
    _baseline(db_session, comp, u1, "A", balance=2000.0)
    _baseline(db_session, comp, u2, "B", balance=1000.0)
    _participant(db_session, comp, u1, "A")
    _participant(db_session, comp, u2, "B")
    _mk(db_session, u1, "A", 4, 1)                 # 5 笔，净 +35 (4*10 - 5)
    _mk(db_session, u2, "B", 3, 2)                  # 5 笔，净 +20 (3*10-2*5)

    # 第三个账户：既没注册参赛，也不该出现
    u3 = _user(db_session, "p3@t.co"); _acct(db_session, u3, "C", balance=2000.0)
    _mk(db_session, u3, "C", 5, 0)

    rows = compute_comp_rows(db_session, comp)
    by_login = {r["login"]: r for r in rows}
    assert set(by_login) == {"A", "B"}
    assert by_login["A"]["sample"] == 5
    assert abs(by_login["A"]["score"] - 35.0 / 2000.0) < 1e-9
    assert by_login["B"]["sample"] == 5
    assert abs(by_login["B"]["score"] - 20.0 / 1000.0) < 1e-9


def test_participants_other_account_does_not_leak_in(db_session):
    """同一用户名下未登记进这场比赛的其它账户，即使有交易也不该混进来。"""
    comp = _comp(db_session)
    u = _user(db_session, "leak@t.co")
    _acct(db_session, u, "A", balance=2000.0)
    _acct(db_session, u, "B", balance=2000.0)      # 未注册参赛
    _baseline(db_session, comp, u, "A", balance=2000.0)
    _participant(db_session, comp, u, "A")
    _mk(db_session, u, "A", 5, 0, win_p=10.0, start_ticket=1)
    _mk(db_session, u, "B", 5, 0, win_p=10.0, start_ticket=200)   # 应被排除

    rows = compute_comp_rows(db_session, comp)
    assert {r["login"] for r in rows} == {"A"}
    row = rows[0]
    assert row["sample"] == 5
    assert abs(row["score"] - 50.0 / 2000.0) < 1e-9


def test_scoring_from_later_than_start_excludes_earlier_closes(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "sf@t.co"); _acct(db_session, u, "A", balance=2000.0)
    _baseline(db_session, comp, u, "A", balance=2000.0, taken_at=T0)
    scoring_from = T0 + timedelta(days=1)
    _participant(db_session, comp, u, "A", scoring_from=scoring_from)

    _pos(db_session, u, "A", 1, 100.0, T0 + timedelta(hours=5))     # 计分起点前：不计
    for t in range(2, 8):
        _pos(db_session, u, "A", t, 10.0, scoring_from + timedelta(hours=t))  # 6 笔，之后

    rows = compute_comp_rows(db_session, comp)
    row = {r["login"]: r for r in rows}["A"]
    assert row["sample"] == 6
    assert abs(row["score"] - 60.0 / 2000.0) < 1e-9


def test_disqualified_participant_excluded(db_session):
    comp = _comp(db_session)
    u = _user(db_session, "dq@t.co"); _acct(db_session, u, "A", balance=2000.0)
    _baseline(db_session, comp, u, "A", balance=2000.0)
    _participant(db_session, comp, u, "A", disqualified=True)
    _mk(db_session, u, "A", 5, 0)

    rows = compute_comp_rows(db_session, comp)
    assert rows == []


def test_return_board_min_baseline_floor_gate(db_session):
    """denom（baseline+adjust）低于 min_baseline_usd（默认 500）门槛：不入 return_pct 榜，
    即使笔数达标；同赛高于门槛的参赛者正常上榜。"""
    comp = _comp(db_session)
    u_low = _user(db_session, "floor_low@t.co"); _acct(db_session, u_low, "A", balance=100.0)
    _baseline(db_session, comp, u_low, "A", balance=100.0)     # < 500
    _participant(db_session, comp, u_low, "A")
    _mk(db_session, u_low, "A", 5, 0)                          # 5 笔达标，denom 不达标

    u_ok = _user(db_session, "floor_ok@t.co"); _acct(db_session, u_ok, "B", balance=2000.0)
    _baseline(db_session, comp, u_ok, "B", balance=2000.0)     # >= 500
    _participant(db_session, comp, u_ok, "B")
    _mk(db_session, u_ok, "B", 5, 0)

    rows = compute_comp_rows(db_session, comp)
    logins = {r["login"] for r in rows}
    assert "A" not in logins
    assert "B" in logins


def test_win_rate_net_losing_excluded_despite_high_win_rate(db_session):
    """win_rate 榜第二道闸：sum(profit) > 0。20 笔、16 胜 4 负但小赢大亏、净亏损——
    胜率高达 80% 也不该上榜。这道闸 2026-09-04 起是可配开关（默认关，与周期榜
    共用同一个 board_gates），所以要显式打开才生效；默认关时该账户照常上榜。"""
    comp = _comp(db_session, metric="win_rate")
    u = _user(db_session, "wrloss@t.co"); _acct(db_session, u, "A", balance=2000.0)
    _baseline(db_session, comp, u, "A", balance=2000.0)
    _participant(db_session, comp, u, "A")
    _mk(db_session, u, "A", 16, 4, win_p=1.0, loss_p=-10.0)    # 16*1 - 4*10 = -24 < 0

    invalidate_gamification_cache()
    assert {r["login"] for r in compute_comp_rows(db_session, comp)} == {"A"}   # 默认关：照常上榜
    save_gamification_settings(db_session, {"winrate_require_profit": True})
    db_session.commit(); invalidate_gamification_cache()
    try:
        assert {r["login"] for r in compute_comp_rows(db_session, comp)} == set()
    finally:
        save_gamification_settings(db_session, {"winrate_require_profit": False})
        db_session.commit(); invalidate_gamification_cache()


def test_snapshot_two_running_comps_both_scored(db_session):
    comp1 = _comp(db_session, name="Comp 1")
    comp2 = _comp(db_session, name="Comp 2")
    u1 = _user(db_session, "multi1@t.co"); _acct(db_session, u1, "A", balance=2000.0)
    _baseline(db_session, comp1, u1, "A", balance=2000.0)
    _participant(db_session, comp1, u1, "A")
    _mk(db_session, u1, "A", 5, 0)

    u2 = _user(db_session, "multi2@t.co"); _acct(db_session, u2, "B", balance=2000.0)
    _baseline(db_session, comp2, u2, "B", balance=2000.0)
    _participant(db_session, comp2, u2, "B")
    _mk(db_session, u2, "B", 5, 0)

    result = snapshot_competitions(db_session, T0 + timedelta(days=1))
    assert result == {"comps": 2, "rows": 2}

    row1 = (db_session.query(LeaderboardSnapshot)
            .filter_by(board="return_pct", period_key=comp_period_key(comp1.id)).first())
    row2 = (db_session.query(LeaderboardSnapshot)
            .filter_by(board="return_pct", period_key=comp_period_key(comp2.id)).first())
    assert row1 is not None and row1.mt5_login == "A"
    assert row2 is not None and row2.mt5_login == "B"


def test_participant_without_baseline_skipped_others_unaffected(db_session):
    comp = _comp(db_session)
    u1 = _user(db_session, "nobl@t.co"); _acct(db_session, u1, "A", balance=2000.0)
    # 没有拍基线，直接注册参赛
    _participant(db_session, comp, u1, "A")
    _mk(db_session, u1, "A", 5, 0)

    u2 = _user(db_session, "haveb@t.co"); _acct(db_session, u2, "B", balance=2000.0)
    _baseline(db_session, comp, u2, "B", balance=2000.0)
    _participant(db_session, comp, u2, "B")
    _mk(db_session, u2, "B", 5, 0)

    rows = compute_comp_rows(db_session, comp)
    assert {r["login"] for r in rows} == {"B"}


def test_win_rate_metric_20_trade_gate(db_session):
    comp = _comp(db_session, metric="win_rate")
    u = _user(db_session, "wr1@t.co"); _acct(db_session, u, "A", balance=2000.0)
    _baseline(db_session, comp, u, "A", balance=2000.0)
    _participant(db_session, comp, u, "A")
    _mk(db_session, u, "A", 12, 7)                 # 19 笔 < 20 → 不入榜
    assert compute_comp_rows(db_session, comp) == []

    u2 = _user(db_session, "wr2@t.co"); _acct(db_session, u2, "B", balance=2000.0)
    _baseline(db_session, comp, u2, "B", balance=2000.0)
    _participant(db_session, comp, u2, "B")
    _mk(db_session, u2, "B", 13, 7)                # 20 笔，净 +95 → 上榜
    rows = compute_comp_rows(db_session, comp)
    row = {r["login"]: r for r in rows}["B"]
    assert abs(row["score"] - 13 / 20) < 1e-9
    assert row["sample"] == 20


def test_snapshot_running_reconciles_and_writes_rows(db_session):
    comp = _comp(db_session, status="running")
    u = _user(db_session, "snap1@t.co"); _acct(db_session, u, "A", balance=2000.0)
    _baseline(db_session, comp, u, "A", balance=2000.0, taken_at=T0)
    _participant(db_session, comp, u, "A")
    _mk(db_session, u, "A", 4, 1)                  # 5 笔，净 +35

    # 期内入金：balance 从 2000 涨到 2235（35 盈利 + 200 入金）
    acct = db_session.query(MT5Account).filter_by(login="A").first()
    acct.balance = 2235.0
    db_session.commit()

    result = snapshot_competitions(db_session, T0 + timedelta(days=1))
    assert result == {"comps": 1, "rows": 1}

    row = (db_session.query(LeaderboardSnapshot)
           .filter_by(board="return_pct", period_key=comp_period_key(comp.id)).first())
    assert row is not None and row.mt5_login == "A" and row.rank == 1
    # 对账已把 200 入金并入分母：denom = 2000 + 200 = 2200
    assert abs(row.score - 35.0 / 2200.0) < 1e-9
    baseline_row = db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id)).first()
    assert abs(baseline_row.adjust - 200.0) < 1e-6


def test_snapshot_ended_does_not_reconcile(db_session):
    comp = _comp(db_session, status="ended")
    u = _user(db_session, "end1@t.co"); _acct(db_session, u, "A", balance=2000.0)
    _baseline(db_session, comp, u, "A", balance=2000.0, taken_at=T0)
    _participant(db_session, comp, u, "A")
    _mk(db_session, u, "A", 4, 1)                  # 5 笔，净 +35

    acct = db_session.query(MT5Account).filter_by(login="A").first()
    acct.balance = 2235.0                          # 结束后又涨了：不该被当成入金
    db_session.commit()

    result = snapshot_competitions(db_session, ENDS + timedelta(hours=1))
    assert result == {"comps": 1, "rows": 1}

    baseline_row = db_session.query(PeriodBaseline).filter_by(
        period_key=comp_period_key(comp.id)).first()
    assert baseline_row.adjust == 0.0               # 未对账

    row = (db_session.query(LeaderboardSnapshot)
           .filter_by(board="return_pct", period_key=comp_period_key(comp.id)).first())
    assert abs(row.score - 35.0 / 2000.0) < 1e-9     # denom 未被入金污染


def test_snapshot_settled_untouched(db_session):
    comp = _comp(db_session, status="settled")
    key = comp_period_key(comp.id)
    u = _user(db_session, "set1@t.co")
    db_session.add(LeaderboardSnapshot(board="return_pct", period_key=key,
                                       user_id=u.id, mt5_login="A", rank=1,
                                       score=0.5, sample=10))
    db_session.commit()
    before = {x.id for x in db_session.query(LeaderboardSnapshot).filter_by(period_key=key)}
    assert before

    result = snapshot_competitions(db_session, ENDS + timedelta(days=1))
    assert result == {"comps": 0, "rows": 0}

    after = {x.id for x in db_session.query(LeaderboardSnapshot).filter_by(period_key=key)}
    assert before == after


def test_snapshot_draft_and_upcoming_untouched(db_session):
    for status in ("draft", "upcoming"):
        comp = _comp(db_session, status=status, name=f"C-{status}")
        u = _user(db_session, f"{status}@t.co"); _acct(db_session, u, "A", balance=2000.0)
        _baseline(db_session, comp, u, "A", balance=2000.0)
        _participant(db_session, comp, u, "A")
        _mk(db_session, u, "A", 5, 0)
    result = snapshot_competitions(db_session, T0 + timedelta(days=1))
    assert result == {"comps": 0, "rows": 0}
    assert db_session.query(LeaderboardSnapshot).count() == 0
