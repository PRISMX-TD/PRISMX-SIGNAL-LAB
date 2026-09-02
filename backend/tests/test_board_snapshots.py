from datetime import datetime, timedelta, timezone
from app.models import User, MT5Account, Order, ClosedTrade, LeaderboardSnapshot
from app.services.gamification.boards import ensure_baselines, snapshot_boards

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
NOW = T0 + timedelta(days=2, hours=12)


def _seed_two_accounts(db):
    """两个用户各一实盘账户，A 收益率高于 B；均过两榜门槛（20 笔）。

    基线在 T0（期初）就手动拍好——不依赖 snapshot_boards 首次调用时才补拍：
    若等 snapshot_boards(db, NOW) 自己拍基线，taken_at 会落在 NOW（T0 后 60h），
    比下面所有交易的平仓时间都晚，整仓归期的下界 `max(期初, taken_at)` 会把
    这些交易全部排除在外（这正是 test_board_rows.py::
    test_taken_at_excludes_prior_closes 验证过的既有设计）。这里显式在 T0 拍
    基线，让样本按预期计入。
    """
    out = []
    for email, login, win_p in (("s1@t.co", "A", 20.0), ("s2@t.co", "B", 5.0)):
        u = User(email=email, api_token="tok_" + email); db.add(u); db.commit()
        db.add(MT5Account(user_id=u.id, login=login, server="s", balance=2000.0,
                          trade_mode=2)); db.commit()
        ensure_baselines(db, "2026-W36", T0)
        for t in range(1, 21):                        # 20 笔全胜
            closed = T0 + timedelta(hours=t)
            db.add(Order(user_id=u.id, client_order_id=f"c{login}{t}", symbol="X",
                         side="BUY", volume=0.1, status="FILLED", mt5_login=login,
                         mt5_ticket=t, trade_mode=2, created_at=closed - timedelta(hours=1)))
            db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=win_p,
                               position_ticket=t, deal_ticket=t * 10,
                               closed_at=closed, verified=True))
        db.commit()
        out.append((u, login))
    return out


def test_snapshot_ranks_and_upserts(db_session):
    _seed_two_accounts(db_session)
    r = snapshot_boards(db_session, NOW)
    assert r["rows"] > 0
    week_rows = (db_session.query(LeaderboardSnapshot)
                 .filter_by(board="return_pct", period_key="2026-W36")
                 .order_by(LeaderboardSnapshot.rank).all())
    assert [x.mt5_login for x in week_rows] == ["A", "B"]
    assert week_rows[0].rank == 1 and week_rows[1].rank == 2
    # 重跑覆盖不翻倍
    snapshot_boards(db_session, NOW)
    n = db_session.query(LeaderboardSnapshot).filter_by(
        board="return_pct", period_key="2026-W36").count()
    assert n == 2


def test_grace_window_recompute_and_seal(db_session):
    _seed_two_accounts(db_session)
    snapshot_boards(db_session, NOW)
    # 周结束后 10h：W36 仍被重算（行会刷新 computed_at）
    after_end = datetime(2026, 9, 7, 10, 0, tzinfo=UTC)
    r2 = snapshot_boards(db_session, after_end)
    assert r2["periods"] >= 3                       # W37 + W36(宽限) + 2026-09
    # 出窗后：W36 不再动（rows 保留）
    sealed_time = datetime(2026, 9, 10, 0, 0, tzinfo=UTC)
    before = {x.id for x in db_session.query(LeaderboardSnapshot)
              .filter_by(period_key="2026-W36")}
    snapshot_boards(db_session, sealed_time)
    after = {x.id for x in db_session.query(LeaderboardSnapshot)
             .filter_by(period_key="2026-W36")}
    assert before == after                          # 封存：行未被删重建
