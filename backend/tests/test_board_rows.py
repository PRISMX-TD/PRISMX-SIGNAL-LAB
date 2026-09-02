from datetime import datetime, timedelta, timezone
from app.models import User, MT5Account, Order, ClosedTrade, PeriodBaseline
from app.services.gamification.boards import ensure_baselines, compute_board_rows

UTC = timezone.utc
PK = "2026-W36"
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)      # 周一（期初）
IN_WEEK = T0 + timedelta(days=2)


def _user(db, email):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _acct(db, u, login, balance=2000.0):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance,
                      trade_mode=2)); db.commit()


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


def _mk(db, u, login, n_win, n_loss, win_p=10.0, loss_p=-5.0, start_ticket=1):
    t = start_ticket
    for _ in range(n_win):
        _pos(db, u, login, t, win_p, IN_WEEK); t += 1
    for _ in range(n_loss):
        _pos(db, u, login, t, loss_p, IN_WEEK); t += 1
    return t


def test_return_board_score_and_gates(db_session):
    u = _user(db_session, "r1@t.co"); _acct(db_session, u, "A", balance=2000.0)
    ensure_baselines(db_session, PK, T0)
    _mk(db_session, u, "A", 4, 2)                  # 6 笔，净 +30 → 30/2000
    rows = compute_board_rows(db_session, PK)
    ret = {r["login"]: r for r in rows["return_pct"]}
    assert abs(ret["A"]["score"] - 30.0 / 2000.0) < 1e-9 and ret["A"]["sample"] == 6


def test_return_board_min_trades_gate(db_session):
    u = _user(db_session, "r2@t.co"); _acct(db_session, u, "A")
    ensure_baselines(db_session, PK, T0)
    _mk(db_session, u, "A", 3, 1)                  # 4 笔 < 5 → 不入榜
    assert compute_board_rows(db_session, PK)["return_pct"] == []


def test_return_board_baseline_floor(db_session):
    u = _user(db_session, "r3@t.co"); _acct(db_session, u, "A", balance=100.0)  # < 500
    ensure_baselines(db_session, PK, T0)
    _mk(db_session, u, "A", 5, 0)
    assert compute_board_rows(db_session, PK)["return_pct"] == []


def test_winrate_board_two_gates(db_session):
    u = _user(db_session, "w1@t.co"); _acct(db_session, u, "A")
    ensure_baselines(db_session, PK, T0)
    # 20 笔、13 胜 7 负、净 +95 → 上榜 0.65
    _mk(db_session, u, "A", 13, 7)
    wr = {r["login"]: r for r in compute_board_rows(db_session, PK)["win_rate"]}
    assert abs(wr["A"]["score"] - 13 / 20) < 1e-9
    # 高胜率但净亏：小赢大亏 → 拦下
    u2 = _user(db_session, "w2@t.co"); _acct(db_session, u2, "B")
    ensure_baselines(db_session, PK, T0)
    _mk(db_session, u2, "B", 16, 4, win_p=1.0, loss_p=-10.0)   # 胜率 80% 净 -24
    wr2 = {r["login"] for r in compute_board_rows(db_session, PK)["win_rate"]}
    assert "B" not in wr2


def test_taken_at_excludes_prior_closes(db_session):
    u = _user(db_session, "t1@t.co"); _acct(db_session, u, "A")
    late = T0 + timedelta(days=1)                  # 基线迟到一天
    ensure_baselines(db_session, PK, late)
    _pos(db_session, u, "A", 1, 100.0, T0 + timedelta(hours=5))   # 拍照前的平仓
    for t in range(2, 8):
        _pos(db_session, u, "A", t, 10.0, late + timedelta(hours=t))
    ret = {r["login"]: r for r in compute_board_rows(db_session, PK)["return_pct"]}
    assert ret["A"]["sample"] == 6 and abs(ret["A"]["score"] - 60.0 / 2000.0) < 1e-9


def test_account_without_baseline_not_listed(db_session):
    u = _user(db_session, "n1@t.co"); _acct(db_session, u, "A")
    # 不拍基线直接有交易 → 不出行
    _mk(db_session, u, "A", 5, 0)
    assert compute_board_rows(db_session, PK)["return_pct"] == []
