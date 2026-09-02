from datetime import datetime, timedelta, timezone
from app.models import User, MT5Account, ClosedTrade, PeriodBaseline
from app.services.gamification.boards import ensure_baselines, reconcile_deposits

NOW = datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)
PK = "2026-W36"


def _user(db, email="b1@t.co", opt_out=False):
    u = User(email=email, api_token="tok_" + email, leaderboard_opt_out=opt_out)
    db.add(u); db.commit(); return u


def _acct(db, u, login, balance, tm=2):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance,
                      trade_mode=tm))
    db.commit()


def test_baseline_photographs_real_accounts_only(db_session):
    u = _user(db_session)
    _acct(db_session, u, "R1", 1000.0, tm=2)
    _acct(db_session, u, "D1", 500.0, tm=0)     # demo 不拍
    _acct(db_session, u, "N1", None, tm=2)      # 无余额暂缓
    n = ensure_baselines(db_session, PK, NOW)
    rows = db_session.query(PeriodBaseline).all()
    assert n == 1 and len(rows) == 1 and rows[0].mt5_login == "R1"
    assert rows[0].baseline == 1000.0
    assert ensure_baselines(db_session, PK, NOW) == 0   # 幂等：期内不重拍


def test_opt_out_user_skipped(db_session):
    u = _user(db_session, email="b2@t.co", opt_out=True)
    _acct(db_session, u, "R1", 1000.0)
    assert ensure_baselines(db_session, PK, NOW) == 0


def test_reconcile_deposit_joins_denominator(db_session):
    u = _user(db_session, email="b3@t.co")
    _acct(db_session, u, "R1", 1000.0)
    ensure_baselines(db_session, PK, NOW)
    acct = db_session.query(MT5Account).first()
    # 期内赚 50（有平仓记录），又入金 200 → balance 1250
    db_session.add(ClosedTrade(user_id=u.id, mt5_login="R1", symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=50.0,
                               position_ticket=1, deal_ticket=10,
                               closed_at=NOW + timedelta(hours=1), verified=True))
    acct.balance = 1250.0
    db_session.commit()
    assert reconcile_deposits(db_session, PK) == 1
    row = db_session.query(PeriodBaseline).first()
    assert abs(row.adjust - 200.0) < 1e-6


def test_reconcile_withdrawal_ignored(db_session):
    u = _user(db_session, email="b4@t.co")
    _acct(db_session, u, "R1", 1000.0)
    ensure_baselines(db_session, PK, NOW)
    acct = db_session.query(MT5Account).first()
    acct.balance = 700.0                        # 纯出金 300
    db_session.commit()
    assert reconcile_deposits(db_session, PK) == 0
    assert db_session.query(PeriodBaseline).first().adjust == 0.0


def test_reconcile_skips_unbound_account(db_session):
    u = _user(db_session, email="b5@t.co")
    _acct(db_session, u, "R1", 1000.0)
    ensure_baselines(db_session, PK, NOW)
    db_session.query(MT5Account).delete(); db_session.commit()   # 期中解绑
    assert reconcile_deposits(db_session, PK) == 0               # 冻结，不报错


def test_reconcile_noop_for_ended_period(db_session):
    u = _user(db_session, email="b6@t.co")
    _acct(db_session, u, "R1", 1000.0)
    past_pk = "2020-W01"
    db_session.add(PeriodBaseline(user_id=u.id, mt5_login="R1", period_key=past_pk,
                                  baseline=1000.0, taken_at=NOW))
    db_session.commit()
    acct = db_session.query(MT5Account).first()
    acct.balance = 1250.0                        # 期后账户仍在正常涨——不该被当成入金
    db_session.commit()
    assert reconcile_deposits(db_session, past_pk) == 0
    assert db_session.query(PeriodBaseline).first().adjust == 0.0


def test_reconcile_idempotent_when_no_state_change(db_session):
    u = _user(db_session, email="b7@t.co")
    _acct(db_session, u, "R1", 1000.0)
    ensure_baselines(db_session, PK, NOW)
    acct = db_session.query(MT5Account).first()
    acct.balance = 1200.0
    db_session.commit()
    assert reconcile_deposits(db_session, PK) == 1
    row = db_session.query(PeriodBaseline).first()
    assert abs(row.adjust - 200.0) < 1e-6
    assert reconcile_deposits(db_session, PK) == 0   # 无状态变化：再跑一次不重复调整
    assert abs(db_session.query(PeriodBaseline).first().adjust - 200.0) < 1e-6
