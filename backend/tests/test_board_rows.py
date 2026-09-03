from datetime import datetime, timedelta, timezone
from app.models import User, MT5Account, Order, ClosedTrade, PeriodBaseline
from app.services.gamification.boards import ensure_baselines, compute_board_rows
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache

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


def test_cross_boundary_leg_counts_full_profit(db_session):
    """跨界仓：同一仓位分两腿平仓，第一腿在期初前，最后一腿在期内——归期规则看
    最后一腿，命中即整仓（两腿）盈亏都进分子，不能只算期内那一腿。"""
    u = _user(db_session, "cb1@t.co"); _acct(db_session, u, "A", balance=2000.0)
    ensure_baselines(db_session, PK, T0)
    db_session.add(Order(user_id=u.id, client_order_id="cA100", symbol="X",
                         side="BUY", volume=0.2, status="FILLED", mt5_login="A",
                         mt5_ticket=100, trade_mode=2,
                         created_at=T0 - timedelta(days=3)))
    db_session.add(ClosedTrade(user_id=u.id, mt5_login="A", symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=30.0,
                               position_ticket=100, deal_ticket=1001,
                               closed_at=T0 - timedelta(days=2), verified=True))
    db_session.add(ClosedTrade(user_id=u.id, mt5_login="A", symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=20.0,
                               position_ticket=100, deal_ticket=1002,
                               closed_at=IN_WEEK, verified=True))
    db_session.commit()
    _mk(db_session, u, "A", 5, 0, win_p=10.0, start_ticket=200)  # 再垫 5 笔期内单腿单
    rows = compute_board_rows(db_session, PK)
    ret = {r["login"]: r for r in rows["return_pct"]}
    assert ret["A"]["sample"] == 6
    assert abs(ret["A"]["score"] - (50.0 + 50.0) / 2000.0) < 1e-9


def test_opted_out_user_disappears_from_both_boards(db_session):
    """期中退榜（设计 §4.1）：用户基线拍好、已有合格交易，两榜都出行；
    退榜开关一开，下次算行两榜都要立刻不出行——即使基线拍照发生在退榜之前。"""
    u = _user(db_session, "oo1@t.co"); _acct(db_session, u, "A", balance=2000.0)
    ensure_baselines(db_session, PK, T0)
    _mk(db_session, u, "A", 15, 5)                  # 20 笔，净 +125，两榜都够格
    rows = compute_board_rows(db_session, PK)
    assert "A" in {r["login"] for r in rows["return_pct"]}
    assert "A" in {r["login"] for r in rows["win_rate"]}

    u.leaderboard_opt_out = True
    db_session.commit()

    rows2 = compute_board_rows(db_session, PK)
    assert rows2["return_pct"] == []
    assert rows2["win_rate"] == []


def test_configurable_return_gate_lets_single_trade_through(db_session):
    """min_trades_return 调到 1：过去硬编码 5 笔起步，单笔合格仓位也能上收益榜。"""
    save_gamification_settings(db_session, {"min_trades_return": 1})
    db_session.commit(); invalidate_gamification_cache()
    try:
        u = _user(db_session, "cfg1@t.co"); _acct(db_session, u, "A", balance=2000.0)
        ensure_baselines(db_session, PK, T0)
        _mk(db_session, u, "A", 1, 0)                # 只 1 笔
        ret = {r["login"]: r for r in compute_board_rows(db_session, PK)["return_pct"]}
        assert "A" in ret and ret["A"]["sample"] == 1
    finally:
        save_gamification_settings(db_session, {"min_trades_return": 5})
        db_session.commit(); invalidate_gamification_cache()


def test_configurable_winrate_gate_lets_two_trades_through(db_session):
    """min_trades_winrate 调到 2：过去硬编码 20 笔起步，两笔正盈利也能上胜率榜；
    盈亏为正这道闸不受影响——净亏账户即使笔数够也依旧被挡下。"""
    save_gamification_settings(db_session, {"min_trades_winrate": 2})
    db_session.commit(); invalidate_gamification_cache()
    try:
        u = _user(db_session, "cfg2@t.co"); _acct(db_session, u, "A", balance=2000.0)
        ensure_baselines(db_session, PK, T0)
        _mk(db_session, u, "A", 2, 0)                # 2 笔全胜，净 +20
        wr = {r["login"]: r for r in compute_board_rows(db_session, PK)["win_rate"]}
        assert "A" in wr and wr["A"]["sample"] == 2 and wr["A"]["score"] == 1.0

        # 盈亏为正这道闸依旧生效：笔数够（2 笔）但净亏 → 不上榜
        u2 = _user(db_session, "cfg3@t.co"); _acct(db_session, u2, "B", balance=2000.0)
        ensure_baselines(db_session, PK, T0)
        _mk(db_session, u2, "B", 1, 1, win_p=1.0, loss_p=-10.0)   # 1 胜 1 负，净 -9
        wr2 = {r["login"] for r in compute_board_rows(db_session, PK)["win_rate"]}
        assert "B" not in wr2
    finally:
        save_gamification_settings(db_session, {"min_trades_winrate": 20})
        db_session.commit(); invalidate_gamification_cache()


def test_unphotographed_account_does_not_leak_into_sibling_account(db_session):
    """同一用户两个账户：A 已拍基线，B 是期中新开、从未拍照——B 完全不出行，
    且 B 的盈亏不能混进 A 的分子/样本（跨账户订单/腿要按 login 隔离）。"""
    u = _user(db_session, "mix1@t.co")
    _acct(db_session, u, "A", balance=2000.0)
    ensure_baselines(db_session, PK, T0)          # 此刻只有 A，只拍 A
    _acct(db_session, u, "B", balance=2000.0)     # B 期中才开户，从未拍照
    _mk(db_session, u, "A", 5, 0, win_p=10.0, start_ticket=1)     # A: 5 笔 +10
    _mk(db_session, u, "B", 5, 0, win_p=10.0, start_ticket=200)   # B: 5 笔 +10（应被排除）
    rows = compute_board_rows(db_session, PK)
    logins = {r["login"] for r in rows["return_pct"]}
    assert logins == {"A"}
    ret = {r["login"]: r for r in rows["return_pct"]}
    assert ret["A"]["sample"] == 5
    assert abs(ret["A"]["score"] - 50.0 / 2000.0) < 1e-9
