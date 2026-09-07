"""公开主页（2026-09-07 设计）：榜单行带 profileId 不带 userId；主页端点的 404 /
打码 / 交易画像开关 / 本人自看 / 缓存；资料接口的 statsPublic。
Public profile: board rows carry profileId but no userId; the profile endpoint's
404 / masking / stats switch / self-view / cache; statsPublic on the profile patch.
"""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.models import (Competition, CompetitionParticipant, LeaderboardSnapshot, User,
                        UserBadge, UserTask)
from app.routers.account import _apply_profile_patch
from app.routers.gamification import build_leaderboard_payload, build_profile_payload
from app.schemas import ProfilePatchIn
from app.services import shared_state
from app.services.gamification import periods

UTC = timezone.utc
WEEK = periods.week_key(datetime.now(UTC))
MONTH = periods.month_key(datetime.now(UTC))


def _user(db, email, **kw):
    u = User(email=email, api_token="tok_" + email, **kw)
    db.add(u); db.commit(); db.refresh(u); return u


def _row(db, u, login, rank, score, board="return_pct", period_key=WEEK):
    db.add(LeaderboardSnapshot(board=board, period_key=period_key, user_id=u.id,
                               mt5_login=login, rank=rank, score=score, sample=8))
    db.commit()


@pytest.fixture(autouse=True)
def _fresh_cache():
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


def test_new_users_get_a_public_id_and_stats_private(db_session):
    a = _user(db_session, "a@t.co")
    b = _user(db_session, "b@t.co")
    assert a.public_id and len(a.public_id) == 10 and a.public_id != b.public_id
    assert a.stats_public is False


def test_board_rows_carry_profile_id_but_no_user_id(db_session):
    a = _user(db_session, "top@t.co", nickname="Trader")
    viewer = _user(db_session, "v@t.co")
    _row(db_session, a, "500123", 1, 0.2)
    p = build_leaderboard_payload(db_session, viewer, "return_pct", WEEK)
    row = p["rows"][0]
    assert row["profileId"] == a.public_id
    assert "userId" not in row and "email" not in row


def test_previous_winner_carries_profile_id(db_session):
    a = _user(db_session, "win@t.co")
    viewer = _user(db_session, "v@t.co")
    prev = periods.previous_period_key(WEEK)
    _row(db_session, a, "500123", 1, 0.3, period_key=prev)
    p = build_leaderboard_payload(db_session, viewer, "return_pct", WEEK)
    assert p["rows"] == [] and p["previousWinner"]["profileId"] == a.public_id


def test_profile_404_for_unknown_and_opted_out(db_session):
    viewer = _user(db_session, "v@t.co")
    out = _user(db_session, "out@t.co", leaderboard_opt_out=True)
    for pid in ("nope", "", out.public_id):
        with pytest.raises(HTTPException) as e:
            build_profile_payload(db_session, viewer, pid)
        assert e.value.status_code == 404


def test_profile_shape_masking_and_stats_hidden_by_default(db_session, monkeypatch):
    target = _user(db_session, "trader@t.co", nickname="Trader",
                   created_at=datetime(2026, 6, 30, tzinfo=UTC))
    viewer = _user(db_session, "v@t.co")
    db_session.add_all([
        UserTask(user_id=target.id, task_id="set_nickname"),
        UserBadge(user_id=target.id, badge_id="starter", tier=2),
        UserBadge(user_id=target.id, badge_id="founder_2026"),
    ])
    target.equipped_badges = "founder_2026,starter"; target.equipped_badge = "founder_2026"
    db_session.commit()
    _row(db_session, target, "500123", 2, 0.12)
    _row(db_session, target, "500999", 7, 0.02)
    _row(db_session, target, "500123", 1, 0.66, board="win_rate", period_key=MONTH)
    comp = Competition(name="九月杯", metric="return_pct", status="settled",
                       starts_at=datetime(2026, 9, 1, tzinfo=UTC), ends_at=datetime(2026, 9, 7, tzinfo=UTC))
    db_session.add(comp); db_session.commit()
    db_session.add_all([
        CompetitionParticipant(competition_id=comp.id, user_id=target.id, mt5_login="500123",
                               final_rank=3, final_score=0.09),
        CompetitionParticipant(competition_id=comp.id, user_id=target.id, mt5_login="500999",
                               final_rank=None),                       # 未终审的不列
    ])
    db_session.commit()
    monkeypatch.setattr("app.routers.gamification.compute_comprehensive_stats",
                        lambda db, uid, data=None: pytest.fail("stats must not be computed when private"))

    p = build_profile_payload(db_session, viewer, target.public_id)
    assert p["displayName"] == "T***r" and p["isSelf"] is False
    assert p["level"] == 1 and p["title"] == "novice"
    assert p["memberSince"] == "2026-06"
    assert p["equippedBadges"] == [{"id": "founder_2026", "tier": 0}, {"id": "starter", "tier": 2}]
    assert [b["id"] for b in p["badges"]] == ["starter", "founder_2026"]
    assert all("progress" not in b and "owners" not in b for b in p["badges"])
    week_return = next(b for b in p["boards"] if b["board"] == "return_pct" and b["period"] == "week")
    assert [e["rank"] for e in week_return["entries"]] == [2, 7]
    month_win = next(b for b in p["boards"] if b["board"] == "win_rate" and b["period"] == "month")
    assert month_win["entries"] == [{"login": "500123", "rank": 1, "score": 0.66}]
    assert len(p["boards"]) == 4
    assert p["competitions"] == [{"id": comp.id, "name": "九月杯", "login": "500123",
                                  "finalRank": 3, "finalScore": 0.09}]
    assert p["stats"] is None and p["statsPublic"] is False


def test_profile_stats_for_self_and_when_public_with_cache(db_session, monkeypatch):
    target = _user(db_session, "trader@t.co")
    viewer = _user(db_session, "v@t.co")
    calls = []

    def fake_stats(db, uid, data=None):
        calls.append(uid)
        return {"win_rate": 0.61, "window_days": 365, "trades": 42}
    monkeypatch.setattr("app.routers.gamification.compute_comprehensive_stats", fake_stats)

    # 本人自看：开关关着也给，且提示 statsPublic=False
    me = build_profile_payload(db_session, target, target.public_id)
    assert me["isSelf"] is True and me["stats"] == {"winRate": 0.61, "windowDays": 365, "trades": 42}
    assert me["statsPublic"] is False
    # 访客：开关关 → 没有（缓存里已有值也不给）
    assert build_profile_payload(db_session, viewer, target.public_id)["stats"] is None
    # 开关开 → 访客拿到，且 60 秒内命中缓存，不重算
    target.stats_public = True; db_session.commit()
    p = build_profile_payload(db_session, viewer, target.public_id)
    assert p["stats"]["winRate"] == 0.61 and p["statsPublic"] is True
    assert len(calls) == 1


def test_profile_patch_stats_public(db_session):
    u = _user(db_session, "pp@t.co")
    _apply_profile_patch(db_session, u, ProfilePatchIn(statsPublic=True))
    assert u.stats_public is True
    _apply_profile_patch(db_session, u, ProfilePatchIn(nickname="Trader"))
    assert u.stats_public is True                      # 没传就不动
    _apply_profile_patch(db_session, u, ProfilePatchIn(statsPublic=False))
    assert u.stats_public is False
