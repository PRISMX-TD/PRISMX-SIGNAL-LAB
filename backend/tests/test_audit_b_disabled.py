"""审计 B 组：被管理员封禁（users.disabled_at）的用户不再进榜、不再拍基线、不自动入场、
不出比赛行，终审也就不会给他名次和勋章。

Audit group B: an admin-disabled user (users.disabled_at) is no longer baselined,
auto-enrolled, ranked on standing or competition boards, or settled / badged.
"""
from datetime import datetime, timedelta, timezone

from app.models import (
    ClosedTrade, Competition, CompetitionParticipant, MT5Account, Order, PeriodBaseline, User,
    UserBadge,
)
from app.services.gamification.boards import compute_board_rows, ensure_baselines
from app.services.gamification.competitions import (
    advance_competition_statuses, comp_period_key, compute_comp_rows, settle_competition,
)

UTC = timezone.utc
PK = "2026-W36"
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
DAY1 = T0 + timedelta(days=1)


def _user(db, email, disabled=False, role=None):
    u = User(email=email, api_token="tok_" + email,
             disabled_at=datetime(2026, 9, 1) if disabled else None)
    if role:
        u.role = role
    db.add(u); db.commit(); return u


def _acct(db, u, login, balance=1000.0):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance, trade_mode=2,
                      source="gateway"))
    db.commit()


def _wins(db, u, login, profit, at, n=5, start=1):
    for t in range(start, start + n):
        db.add(Order(user_id=u.id, client_order_id=f"c{login}{t}", symbol="X", side="BUY",
                     volume=0.1, status="FILLED", mt5_login=login, mt5_ticket=t, trade_mode=2,
                     created_at=at - timedelta(hours=1)))
        db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                           close_volume=0.1, close_price=1, profit=profit, position_ticket=t,
                           deal_ticket=t * 10, closed_at=at, verified=True))
    db.commit()


def test_disabled_user_not_baselined(db_session):
    a = _user(db_session, "ban1@t.co", disabled=True)
    b = _user(db_session, "ok1@t.co")
    _acct(db_session, a, "A"); _acct(db_session, b, "B")
    ensure_baselines(db_session, PK, T0)
    assert {r.mt5_login for r in db_session.query(PeriodBaseline)} == {"B"}


def test_disabled_user_not_ranked_on_standing_board(db_session):
    a = _user(db_session, "ban2@t.co")
    b = _user(db_session, "ok2@t.co")
    _acct(db_session, a, "A"); _acct(db_session, b, "B")
    ensure_baselines(db_session, PK, T0)                 # 封禁前拍的基线 / baseline taken before the ban
    _wins(db_session, a, "A", 100.0, DAY1)
    _wins(db_session, b, "B", 10.0, DAY1, start=100)
    a.disabled_at = datetime(2026, 9, 1); db_session.commit()
    rows = compute_board_rows(db_session, PK)
    assert {r["login"] for r in rows["return_pct"]} == {"B"}
    assert all(r["login"] != "A" for r in rows["win_rate"])


def test_disabled_user_not_auto_enrolled(db_session):
    a = _user(db_session, "ban3@t.co", disabled=True)
    b = _user(db_session, "ok3@t.co")
    _acct(db_session, a, "A"); _acct(db_session, b, "B")
    comp = Competition(name="Auto", metric="return_pct", enrollment="auto", status="upcoming",
                       track="real", starts_at=T0, ends_at=T0 + timedelta(days=7))
    db_session.add(comp); db_session.commit()
    advance_competition_statuses(db_session, T0 + timedelta(minutes=1))
    assert {p.mt5_login for p in db_session.query(CompetitionParticipant)} == {"B"}


def test_disabled_user_not_ranked_or_settled_in_competition(db_session):
    ends = T0 + timedelta(days=7)
    comp = Competition(name="C", metric="return_pct", enrollment="signup", status="ended",
                       track="real", starts_at=T0, ends_at=ends, min_trades=1)
    db_session.add(comp); db_session.commit()
    a = _user(db_session, "ban4@t.co")
    b = _user(db_session, "ok4@t.co")
    admin = _user(db_session, "adm4@t.co", role="admin")
    for u, lg, profit, start in ((a, "A", 100.0, 1), (b, "B", 10.0, 100)):
        _acct(db_session, u, lg)
        db_session.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id,
                                              mt5_login=lg, scoring_from=T0))
        db_session.add(PeriodBaseline(user_id=u.id, mt5_login=lg,
                                      period_key=comp_period_key(comp.id), baseline=1000.0,
                                      taken_at=T0))
        db_session.commit()
        _wins(db_session, u, lg, profit, DAY1, start=start)
    a.disabled_at = datetime(2026, 9, 5); db_session.commit()
    assert {r["login"] for r in compute_comp_rows(db_session, comp)} == {"B"}
    settle_competition(db_session, comp, admin.id, now=ends + timedelta(hours=25))
    parts = {p.mt5_login: p for p in db_session.query(CompetitionParticipant)}
    assert parts["A"].final_rank is None
    assert parts["B"].final_rank == 1
    assert db_session.query(UserBadge).filter_by(user_id=a.id).count() == 0
