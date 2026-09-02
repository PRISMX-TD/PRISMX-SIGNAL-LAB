from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import (
    AdminAuditLog, User, MT5Account, Competition, CompetitionParticipant,
    LeaderboardSnapshot, UserBadge,
)
from app.services.gamification.competitions import comp_period_key, settle_competition

UTC = timezone.utc
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)


def _user(db, email):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _admin(db, email="admin@t.co"):
    a = User(email=email, api_token="tok_" + email, role="admin")
    db.add(a); db.commit(); return a


def _comp(db, status="ended", metric="return_pct", starts_at=T0, ends_at=ENDS, name="Comp A"):
    c = Competition(name=name, metric=metric, status=status,
                     starts_at=starts_at, ends_at=ends_at)
    db.add(c); db.commit(); return c


def _participant(db, comp, u, login, disqualified=False):
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                               disqualified=disqualified)
    db.add(p); db.commit(); return p


def _snap(db, comp, u, login, rank, score=0.1, sample=10):
    db.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                               user_id=u.id, mt5_login=login, rank=rank,
                               score=score, sample=sample))
    db.commit()


def _badges(db, user_id):
    return {b.badge_id for b in db.query(UserBadge).filter_by(user_id=user_id)}


# ---- status guard ----------------------------------------------------------

def test_settle_rejects_non_ended_status(db_session):
    admin = _admin(db_session)
    for status in ("draft", "upcoming", "running", "settled"):
        comp = _comp(db_session, status=status, name=f"C-{status}")
        with pytest.raises(HTTPException) as exc:
            settle_competition(db_session, comp, admin.id)
        assert exc.value.status_code == 400
        assert "已结束" in exc.value.detail
        assert comp.status == status                      # 未被改动


# ---- ranks written, unranked stay NULL -------------------------------------

def test_settle_writes_final_rank_and_score_matching_snapshot(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u1 = _user(db_session, "s1@t.co"); _acct = MT5Account(user_id=u1.id, login="A", server="s",
                                                            balance=1000.0, trade_mode=2)
    db_session.add(_acct); db_session.commit()
    p1 = _participant(db_session, comp, u1, "A")
    _snap(db_session, comp, u1, "A", rank=1, score=0.5, sample=20)

    u2 = _user(db_session, "s2@t.co")
    p2 = _participant(db_session, comp, u2, "B")           # 没入榜：无快照行

    result = settle_competition(db_session, comp, admin.id)

    db_session.refresh(p1); db_session.refresh(p2)
    assert p1.final_rank == 1 and p1.final_score == 0.5
    assert p2.final_rank is None and p2.final_score is None
    assert comp.status == "settled"
    assert result["ranked"] == 1


# ---- badge matrix -----------------------------------------------------------

def test_settle_badge_matrix_winner_podium_finisher_unranked_disqualified(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)

    u_winner = _user(db_session, "win@t.co")
    _participant(db_session, comp, u_winner, "A")
    _snap(db_session, comp, u_winner, "A", rank=1)

    u_second = _user(db_session, "sec@t.co")
    _participant(db_session, comp, u_second, "B")
    _snap(db_session, comp, u_second, "B", rank=2)

    u_third = _user(db_session, "third@t.co")
    _participant(db_session, comp, u_third, "C")
    _snap(db_session, comp, u_third, "C", rank=3)

    u_fourth = _user(db_session, "fourth@t.co")
    _participant(db_session, comp, u_fourth, "D")
    _snap(db_session, comp, u_fourth, "D", rank=4)

    u_unranked = _user(db_session, "unranked@t.co")
    _participant(db_session, comp, u_unranked, "E")        # 无快照行

    u_dq = _user(db_session, "dq@t.co")
    _participant(db_session, comp, u_dq, "F", disqualified=True)

    settle_competition(db_session, comp, admin.id)

    assert _badges(db_session, u_winner.id) == {"comp_winner", "comp_podium", "comp_finisher"}
    assert _badges(db_session, u_second.id) == {"comp_podium", "comp_finisher"}
    assert _badges(db_session, u_third.id) == {"comp_podium", "comp_finisher"}
    assert _badges(db_session, u_fourth.id) == {"comp_finisher"}
    assert _badges(db_session, u_unranked.id) == set()
    assert _badges(db_session, u_dq.id) == set()


def test_settle_disqualified_with_stale_snapshot_kept_out(db_session):
    """取消资格发生在拍快照之后（陈旧快照行未清）：line-247 的双保险要挡住这种
    情况——disqualified 参赛者哪怕有 rank=1 的快照行，也不该写 final_*，不该
    被计入任何一枚勋章。"""
    admin = _admin(db_session)
    comp = _comp(db_session)
    u_dq = _user(db_session, "staledq@t.co")
    p_dq = _participant(db_session, comp, u_dq, "A", disqualified=True)
    _snap(db_session, comp, u_dq, "A", rank=1)          # 陈旧快照：取消资格前留下的

    result = settle_competition(db_session, comp, admin.id)

    db_session.refresh(p_dq)
    assert p_dq.final_rank is None and p_dq.final_score is None
    assert _badges(db_session, u_dq.id) == set()
    assert result["ranked"] == 0


def test_settle_multi_account_same_user_dedups_badges(db_session):
    """同一人两个账户占 1/2 名：winner/podium/finisher 各只发一枚，不因两行快照重复。"""
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "dual@t.co")
    _participant(db_session, comp, u, "A")
    _participant(db_session, comp, u, "B")
    _snap(db_session, comp, u, "A", rank=1)
    _snap(db_session, comp, u, "B", rank=2)

    result = settle_competition(db_session, comp, admin.id)

    assert _badges(db_session, u.id) == {"comp_winner", "comp_podium", "comp_finisher"}
    winner_badges = [b for b in result["badges"] if b["userId"] == u.id]
    ids = [b["badgeId"] for b in winner_badges]
    assert sorted(ids) == ["comp_finisher", "comp_podium", "comp_winner"]  # 各一次


# ---- badge award failures don't undo finality -------------------------------

def test_settle_badge_award_failure_lands_in_badgeErrors_finality_intact(db_session, monkeypatch):
    """某一枚勋章授予中途抛出非 IntegrityError 异常：settle 正常返回，比赛仍
    settled，名次仍写死，失败进 badgeErrors——不传导成整场结算的异常。"""
    import app.services.gamification.competitions as comp_mod

    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "boom@t.co")
    _participant(db_session, comp, u, "A")
    _snap(db_session, comp, u, "A", rank=1)

    real_award_badge = comp_mod.award_badge

    def _boom(db, user_id, badge_id):
        if badge_id == "comp_winner":
            raise RuntimeError("simulated award failure")
        return real_award_badge(db, user_id, badge_id)

    monkeypatch.setattr(comp_mod, "award_badge", _boom)

    result = settle_competition(db_session, comp, admin.id)

    assert comp.status == "settled"
    p = db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, mt5_login="A").first()
    assert p.final_rank == 1                            # 名次不受发奖失败影响

    errors = [e for e in result["badgeErrors"] if e["badgeId"] == "comp_winner"]
    assert len(errors) == 1 and errors[0]["userId"] == u.id
    # comp_winner 失败不该拖垮同一用户的其它勋章授予（同一次 _award 调用互不影响）
    assert "comp_finisher" in _badges(db_session, u.id)
    assert "comp_podium" in _badges(db_session, u.id)
    assert "comp_winner" not in _badges(db_session, u.id)

    # session 在异常后仍可用（未被脏事务卡死）——能正常再查询/写入
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id).count() == 1


# ---- back-to-back -----------------------------------------------------------

def test_settle_back_to_back_awarded_when_same_winner(db_session):
    admin = _admin(db_session)
    u = _user(db_session, "champ@t.co")

    comp1 = _comp(db_session, starts_at=T0, ends_at=ENDS, name="Comp 1")
    _participant(db_session, comp1, u, "A")
    _snap(db_session, comp1, u, "A", rank=1)
    settle_competition(db_session, comp1, admin.id)
    assert "comp_back_to_back" not in _badges(db_session, u.id)   # 首场没有「上一届」

    comp2 = _comp(db_session, starts_at=ENDS + timedelta(days=1),
                  ends_at=ENDS + timedelta(days=8), name="Comp 2")
    _participant(db_session, comp2, u, "A")
    _snap(db_session, comp2, u, "A", rank=1)
    settle_competition(db_session, comp2, admin.id)

    assert "comp_back_to_back" in _badges(db_session, u.id)


def test_settle_back_to_back_not_awarded_when_different_winner(db_session):
    admin = _admin(db_session)
    u1 = _user(db_session, "champ1@t.co")
    u2 = _user(db_session, "champ2@t.co")

    comp1 = _comp(db_session, starts_at=T0, ends_at=ENDS, name="Comp 1")
    _participant(db_session, comp1, u1, "A")
    _snap(db_session, comp1, u1, "A", rank=1)
    settle_competition(db_session, comp1, admin.id)

    comp2 = _comp(db_session, starts_at=ENDS + timedelta(days=1),
                  ends_at=ENDS + timedelta(days=8), name="Comp 2")
    _participant(db_session, comp2, u2, "B")
    _snap(db_session, comp2, u2, "B", rank=1)
    settle_competition(db_session, comp2, admin.id)

    assert "comp_back_to_back" not in _badges(db_session, u1.id)
    assert "comp_back_to_back" not in _badges(db_session, u2.id)


def test_settle_back_to_back_empty_board_adjacent_no_crash_no_spurious_award(db_session):
    """相邻（按 starts_at）的一场比赛没有任何快照行（零参赛/零入榜）：那一届没有
    冠军（winner_by_comp 为 None），不该让相邻对的比较抛异常，也不该误发
    comp_back_to_back 给任何人。"""
    admin = _admin(db_session)
    u = _user(db_session, "soloChamp@t.co")

    comp_empty = _comp(db_session, starts_at=T0, ends_at=ENDS, name="Comp Empty")
    settle_competition(db_session, comp_empty, admin.id)   # 零参赛、零快照，照样能终审

    comp_winner = _comp(db_session, starts_at=ENDS + timedelta(days=1),
                        ends_at=ENDS + timedelta(days=8), name="Comp Winner")
    _participant(db_session, comp_winner, u, "A")
    _snap(db_session, comp_winner, u, "A", rank=1)
    result = settle_competition(db_session, comp_winner, admin.id)

    assert comp_empty.status == "settled" and comp_winner.status == "settled"
    assert "comp_back_to_back" not in _badges(db_session, u.id)
    assert result["badgeErrors"] == []


# ---- audit -------------------------------------------------------------------

def test_settle_writes_audit_log(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "audit@t.co")
    _participant(db_session, comp, u, "A")
    _snap(db_session, comp, u, "A", rank=1)

    settle_competition(db_session, comp, admin.id)

    rows = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:settle:{comp.id}").all()
    assert len(rows) == 1
    assert rows[0].admin_user_id == admin.id


# ---- not re-runnable ----------------------------------------------------------

def test_settle_is_not_rerunnable(db_session):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "once@t.co")
    _participant(db_session, comp, u, "A")
    _snap(db_session, comp, u, "A", rank=1)

    settle_competition(db_session, comp, admin.id)
    assert comp.status == "settled"

    with pytest.raises(HTTPException) as exc:
        settle_competition(db_session, comp, admin.id)
    assert exc.value.status_code == 400
