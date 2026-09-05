"""纪律分勋章分数线可参数化 + 校准脚本的纯函数。

**为什么要测。** 技术文档 §15 要求 08-27 重定口径后重新校准「纪律分 ≥90 连续 7/30
天」两枚勋章的分数线，实施时被跳过。校准脚本按不同分数线试算达标人数时**复用
badges._discipline_streak**（新加 threshold 参数），这里钉住：默认值仍是 90、传别的
分数线时判定随之变化、缺日断连的规则不受影响；以及脚本的分位数/占比摘要算得对。

The streak judge now takes a threshold (default unchanged at 90) so the calibration
script can try alternatives through the same code path; this pins that behaviour and
the script's pure summary helpers.
"""
from datetime import date, timedelta

from app.models import DisciplineSnapshot, User
from app.services.gamification.badges import DISCIPLINE_BADGE_THRESHOLD, _discipline_streak
from scripts.calibrate_discipline_badges import percentiles, summarize_scores


def _user(db, email="d@t.co"):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _days(db, uid, start: date, totals):
    for i, t in enumerate(totals):
        db.add(DisciplineSnapshot(user_id=uid, login="", date=(start + timedelta(days=i)).isoformat(), total=t))
    db.commit()


def test_default_threshold_is_90_and_alternatives_change_the_verdict(db_session):
    u = _user(db_session)
    _days(db_session, u.id, date(2026, 9, 1), [88.0] * 7)          # 连续 7 天 88 分
    assert DISCIPLINE_BADGE_THRESHOLD == 90.0
    assert _discipline_streak(db_session, u.id, 7) is False        # 默认 90：不够
    assert _discipline_streak(db_session, u.id, 7, threshold=85.0) is True
    assert _discipline_streak(db_session, u.id, 30, threshold=85.0) is False


def test_gap_and_null_break_the_run_regardless_of_threshold(db_session):
    u = _user(db_session, "gap@t.co")
    start = date(2026, 9, 1)
    _days(db_session, u.id, start, [95.0, 95.0, 95.0])
    _days(db_session, u.id, start + timedelta(days=4), [95.0, 95.0, 95.0, None, 95.0])  # 缺第 4 天，第 8 天 NULL
    assert _discipline_streak(db_session, u.id, 4, threshold=80.0) is False
    assert _discipline_streak(db_session, u.id, 3, threshold=80.0) is True


def test_summary_helpers():
    assert percentiles([]) == {}
    p = percentiles([10.0, 20.0, 30.0, 40.0, 50.0])
    assert p["min"] == 10.0 and p["p50"] == 30.0 and p["max"] == 50.0
    s = summarize_scores([79.0, 85.0, 90.0, 96.0])
    assert s["n"] == 4
    assert s["share_at_or_above"] == {80.0: 0.75, 85.0: 0.75, 90.0: 0.5, 95.0: 0.25}
    assert summarize_scores([])["share_at_or_above"][90.0] == 0.0
