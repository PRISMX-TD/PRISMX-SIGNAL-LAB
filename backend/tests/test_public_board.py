"""公开比赛载荷与可见性判定（设计 §1.3/§1.7/§1.8/§3.1）。直接测服务函数，不走 HTTP。"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    Competition, CompetitionParticipant, InviteLink, LeaderboardSnapshot, PromoFunnelDaily, User)
from app.services.gamification.competitions import comp_period_key
from app.services.gamification.public_board import (
    build_public_payload, featured_competition_id, initial_public_name, is_publicly_viewable,
    public_cache_key, record_funnel_event)
from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings

UTC = timezone.utc
T0 = datetime(2026, 10, 1, tzinfo=UTC)
PAYLOAD_KEYS = {"id", "name", "description", "prizeNote", "metric", "track", "enrollment",
                "status", "regOpensAt", "regClosesAt", "startsAt", "endsAt", "participants",
                "gates", "openAccountUrl", "snapshotAt", "rows", "nextCompetitionId"}
ROW_KEYS = {"rank", "displayName", "score", "sample", "equippedBadge", "equippedBadgeTier"}


def _flags(db, public=True, visible=True, **extra):
    save_gamification_settings(db, {"competitions_visible": visible,
                                    "competitions_public_enabled": public, **extra})
    db.commit(); invalidate_gamification_cache()


def _comp(db, **kw):
    fields = dict(name="Demo Cup", description="desc", metric="return_pct", enrollment="signup",
                  track="demo", status="running", starts_at=T0, ends_at=T0 + timedelta(days=14),
                  reg_opens_at=T0 - timedelta(days=3), reg_closes_at=T0 + timedelta(days=7),
                  prize_note="1st 100U", public_view=True,
                  open_account_url="https://broker.example/open?a=1")
    fields.update(kw)
    c = Competition(**fields); db.add(c); db.commit(); return c


def _user(db, email, nickname=None, **kw):
    u = User(email=email, api_token="tok_" + email, nickname=nickname, **kw)
    db.add(u); db.commit(); return u


def _entry(db, comp, u, login, rank=None, score=0.1, public_name=True, name_hidden=False,
           disqualified=False):
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                                  public_name=public_name, name_hidden=name_hidden,
                                  disqualified=disqualified))
    if rank is not None:
        db.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                                   user_id=u.id, mt5_login=login, rank=rank, score=score,
                                   sample=7))
    db.commit()


# ---- 可见性 ------------------------------------------------------------------

def test_viewable_only_when_every_condition_holds(db_session):
    _flags(db_session)
    assert is_publicly_viewable(db_session, _comp(db_session)) is True
    for bad in (dict(status="draft"), dict(public_view=False), dict(public_view=None),
                dict(track="real"), dict(enrollment="auto"),
                dict(open_account_url="http://broker.example"), dict(open_account_url=None)):
        assert is_publicly_viewable(db_session, _comp(db_session, **bad)) is False, bad
    assert is_publicly_viewable(db_session, None) is False


@pytest.mark.parametrize("flags", [dict(public=False), dict(visible=False)])
def test_global_switches_hide_everything(db_session, flags):
    _flags(db_session, **flags)
    comp = _comp(db_session)
    assert is_publicly_viewable(db_session, comp) is False
    assert initial_public_name(db_session, comp) is None
    assert featured_competition_id(db_session) is None


def test_initial_public_name_true_only_when_public(db_session):
    _flags(db_session)
    assert initial_public_name(db_session, _comp(db_session)) is True
    assert initial_public_name(db_session, _comp(db_session, public_view=False)) is None


# ---- 主推比赛 ----------------------------------------------------------------

def test_featured_prefers_valid_pin_then_running_then_soonest_upcoming(db_session):
    _flags(db_session)
    up_late = _comp(db_session, status="upcoming", starts_at=T0 + timedelta(days=20),
                    ends_at=T0 + timedelta(days=30))
    up_soon = _comp(db_session, status="upcoming", starts_at=T0 + timedelta(days=10),
                    ends_at=T0 + timedelta(days=30))
    assert featured_competition_id(db_session) == up_soon.id
    running = _comp(db_session, status="running")
    _comp(db_session, status="running", public_view=False)            # 不可公开的不算
    assert featured_competition_id(db_session) == running.id
    _flags(db_session, featured_competition_id=up_late.id)
    assert featured_competition_id(db_session) == up_late.id
    _flags(db_session, featured_competition_id=_comp(db_session, track="real").id)
    assert featured_competition_id(db_session) == running.id          # 指向不可公开 → 自动


# ---- 载荷 --------------------------------------------------------------------

def test_payload_shape_and_name_rules(db_session):
    _flags(db_session)
    comp = _comp(db_session, min_baseline_usd=1000.0, max_baseline_usd=1000.0, min_trades=3)
    shown = _user(db_session, "a@t.co", "Alpha", equipped_badge="midas_touch")
    undecided = _user(db_session, "b@t.co", "Bravo", equipped_badge="midas_touch")
    hidden = _user(db_session, "c@t.co", "Charlie", equipped_badge="midas_touch")
    no_nick = _user(db_session, "d@t.co", None)
    opted_out = _user(db_session, "e@t.co", "Echo", leaderboard_opt_out=True)
    dq = _user(db_session, "f@t.co", "Foxtrot")
    _entry(db_session, comp, shown, "1001", rank=1, score=0.3)
    _entry(db_session, comp, undecided, "1002", rank=2, score=0.2, public_name=None)
    _entry(db_session, comp, hidden, "1003", rank=3, score=0.1, name_hidden=True)
    _entry(db_session, comp, no_nick, "1004", rank=4, score=0.05)
    _entry(db_session, comp, opted_out, "1005", rank=5, score=0.01)
    _entry(db_session, comp, shown, "1006")                           # 同一人第二个账户
    _entry(db_session, comp, dq, "1007", disqualified=True)

    out = build_public_payload(db_session, comp)

    assert set(out) == PAYLOAD_KEYS
    assert all(set(r) == ROW_KEYS for r in out["rows"])
    assert set(out["gates"]) == {"minBaselineUsd", "maxBaselineUsd", "minTrades"}
    assert out["gates"] == {"minBaselineUsd": 1000.0, "maxBaselineUsd": 1000.0, "minTrades": 3}
    assert [r["displayName"] for r in out["rows"]] == ["Alpha", None, None, None, None]
    assert out["rows"][0]["equippedBadge"] == "midas_touch"
    assert all(r["equippedBadge"] is None and r["equippedBadgeTier"] == 0 for r in out["rows"][1:])
    assert out["rows"][0] == {"rank": 1, "displayName": "Alpha", "score": 0.3, "sample": 7,
                              "equippedBadge": "midas_touch", "equippedBadgeTier": 0}
    assert out["participants"] == 5                                   # 不同用户、不含被取消资格
    assert out["openAccountUrl"] == "https://broker.example/open?a=1"
    assert out["snapshotAt"] is not None
    assert out["nextCompetitionId"] is None                          # running 不给「下一场」
    flat = repr(out)
    for leak in ("1001", "a@t.co", shown.id, "Bravo", "Charlie", "Echo"):
        assert leak not in flat, leak


def test_payload_rows_capped_at_fifty(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    for i in range(55):
        u = _user(db_session, f"u{i}@t.co", f"N{i}")
        _entry(db_session, comp, u, str(2000 + i), rank=i + 1, score=1.0 - i / 100)
    rows = build_public_payload(db_session, comp)["rows"]
    assert len(rows) == 50 and rows[-1]["rank"] == 50


def test_finished_comp_points_to_next_featured(db_session):
    _flags(db_session)
    ended = _comp(db_session, status="ended")
    nxt = _comp(db_session, status="upcoming", starts_at=T0 + timedelta(days=30),
                ends_at=T0 + timedelta(days=40))
    assert build_public_payload(db_session, ended)["nextCompetitionId"] == nxt.id
    assert build_public_payload(db_session, nxt)["nextCompetitionId"] is None


def test_cache_key_format():
    assert public_cache_key("abc") == "comp-public:abc"


# ---- 漏斗打点 ----------------------------------------------------------------

def test_record_funnel_event_upserts_per_day_code_step(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    db_session.add(InviteLink(code="fbad01", label="FB", competition_id=comp.id, channel="FB广告"))
    db_session.commit()
    assert record_funnel_event(db_session, comp.id, "view", None, day="2026-10-08")
    assert record_funnel_event(db_session, comp.id, "view", None, day="2026-10-08")
    assert record_funnel_event(db_session, comp.id, "cta", " FBAD01 ", day="2026-10-08")
    assert record_funnel_event(db_session, comp.id, "cta", "nosuch", day="2026-10-08")
    rows = {(r.code, r.step): r.count for r in db_session.query(PromoFunnelDaily).all()}
    assert rows == {("", "view"): 2, ("fbad01", "cta"): 1, ("", "cta"): 1}


def test_record_funnel_event_ignores_garbage_and_hidden_comps(db_session):
    _flags(db_session)
    hidden = _comp(db_session, public_view=False)
    assert record_funnel_event(db_session, hidden.id, "view", None) is False
    assert record_funnel_event(db_session, _comp(db_session).id, "signup", None) is False
    assert record_funnel_event(db_session, "not-a-uuid", "view", None) is False
    assert db_session.query(PromoFunnelDaily).count() == 0
