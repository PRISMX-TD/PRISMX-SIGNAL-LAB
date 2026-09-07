"""勋章扩充（2026-09-07）：五枚新勋章的判定 + 注册表 shelf 结构。

每枚新勋章的失败方式都是静默的（该发不发、不该发却发），所以每条口径边界
单独钉一条：门槛差一、口径外的数据（模拟盘 / 胜率榜 / 比赛快照 / 未封存周期 /
取消资格 / 当前月）一律不算。
"""
from datetime import datetime, timedelta, timezone

from app.models import (
    User, Order, ClosedTrade, UserBadge, UserActiveDay,
    LeaderboardSnapshot, Competition, CompetitionParticipant,
)
from app.services.gamification.badges import BADGES, SHELVES, badge_display_name, judge_and_award_badges

NOW = datetime.now(timezone.utc)


def _user(db, email="x@t.co", **kw):
    u = User(email=email, api_token="tok_" + email, **kw)
    db.add(u); db.commit(); return u


def _owned(db, user_id):
    return {(b.badge_id, b.tier) for b in db.query(UserBadge).filter_by(user_id=user_id)}


def test_registry_shelves_are_explicit():
    for bid, meta in BADGES.items():
        assert meta["shelf"] in SHELVES, bid
        if meta["shelf"] == "tiered":
            assert meta["max_tier"] == 3 and (meta["judges"] is None or len(meta["judges"]) == 3), bid
        else:
            assert meta["max_tier"] == 0, bid
        if meta["shelf"] == "limited":
            assert isinstance(meta["closes_at"], datetime) and meta["closes_at"].tzinfo is not None, bid
        else:
            assert meta.get("closes_at") is None, bid
    assert BADGES["comp_back_to_back"]["shelf"] == "special"
    assert BADGES["founder_2026"]["shelf"] == "limited"
