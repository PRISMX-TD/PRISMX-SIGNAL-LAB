"""公开比赛接口（设计 §3.1）：未登录可读；不存在 / 草稿 / 未公开 / 总开关关 / 站内开关关
返回一字不差的同一个 404；载荷与行的字段集合精确锁死。"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.models import Competition, CompetitionParticipant, LeaderboardSnapshot, PromoFunnelDaily, User
from app.routers import public_competitions
from app.services import shared_cache
from app.services.deps import get_current_user, get_db, require_admin
from app.services.gamification.competitions import comp_period_key
from app.services.gamification.public_board import public_cache_key
from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings

UTC = timezone.utc
T0 = datetime(2026, 10, 1, tzinfo=UTC)
NOT_FOUND = {"detail": "比赛不存在或未公开 / Competition not found"}
PAYLOAD_KEYS = {"id", "name", "description", "prizeNote", "metric", "track", "enrollment",
                "status", "regOpensAt", "regClosesAt", "startsAt", "endsAt", "participants",
                "gates", "openAccountUrl", "snapshotAt", "rows", "nextCompetitionId"}
ROW_KEYS = {"rank", "displayName", "score", "sample", "equippedBadge", "equippedBadgeTier"}


def _flags(db, public=True, visible=True):
    save_gamification_settings(db, {"competitions_visible": visible,
                                    "competitions_public_enabled": public})
    db.commit(); invalidate_gamification_cache()


def _comp(db, **kw):
    fields = dict(name="Demo Cup", description="desc", metric="return_pct", enrollment="signup",
                  track="demo", status="running", starts_at=T0, ends_at=T0 + timedelta(days=14),
                  reg_opens_at=T0 - timedelta(days=3), reg_closes_at=T0 + timedelta(days=7),
                  public_view=True, open_account_url="https://broker.example/open")
    fields.update(kw)
    c = Competition(**fields); db.add(c); db.commit(); return c


def _ranked(db, comp, email, nickname, login, rank):
    u = User(email=email, api_token="tok_" + email, nickname=nickname)
    db.add(u); db.commit()
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                                  public_name=True))
    db.add(LeaderboardSnapshot(board=comp.metric, period_key=comp_period_key(comp.id),
                               user_id=u.id, mt5_login=login, rank=rank, score=0.1, sample=4))
    db.commit()


def _client(db):
    # TestClient 在工作线程里跑：最后一次 commit 之后取一次连接钉在 Session 上，
    # 否则工作线程另开连接看到的是空的内存库（同 test_gateway_login_path_param.py）。
    # Pin the connection after the last commit, or the worker thread sees an empty DB.
    db.connection()
    app = FastAPI()
    app.state.limiter = public_competitions.limiter
    app.include_router(public_competitions.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app, raise_server_exceptions=False)


def test_detail_readable_without_authorization(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    _ranked(db_session, comp, "a@t.co", "Alpha", "1001", 1)
    res = _client(db_session).get(f"/api/public/competitions/{comp.id}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == PAYLOAD_KEYS
    assert body["rows"] and all(set(r) == ROW_KEYS for r in body["rows"])
    assert body["rows"][0]["displayName"] == "Alpha"
    assert "1001" not in res.text


@pytest.mark.parametrize("case", ["unknown", "not-uuid", "draft", "not-public", "real-track",
                                  "public-off", "visible-off"])
def test_every_hidden_case_is_the_same_404(db_session, case):
    _flags(db_session, public=case != "public-off", visible=case != "visible-off")
    comp = {"draft": lambda: _comp(db_session, status="draft"),
            "not-public": lambda: _comp(db_session, public_view=False),
            "real-track": lambda: _comp(db_session, track="real")}.get(case, lambda: _comp(db_session))()
    comp_id = {"unknown": "00000000-0000-4000-8000-000000000000",
               "not-uuid": "abc'; drop"}.get(case, comp.id)
    res = _client(db_session).get(f"/api/public/competitions/{comp_id}")
    assert res.status_code == 404
    assert res.json() == NOT_FOUND


def test_featured_endpoint(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    res = _client(db_session).get("/api/public/competitions/featured")
    assert res.status_code == 200 and res.json() == {"id": comp.id}


def test_featured_is_null_when_switch_off(db_session):
    _flags(db_session, public=False)
    _comp(db_session)
    assert _client(db_session).get("/api/public/competitions/featured").json() == {"id": None}


def test_event_always_204_and_counts_valid_ones(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    client = _client(db_session)
    for body in ({"compId": "nope", "step": "view"},
                 {"compId": comp.id, "step": "bogus"},
                 {"compId": "00000000-0000-4000-8000-000000000000", "step": "view"}):
        assert client.post("/api/public/competitions/event", json=body).status_code == 204
    # 最后一次才真写库（commit 会把钉住的连接还回池子，所以放最后）。
    # The only real write goes last (its commit returns the pinned connection).
    res = client.post("/api/public/competitions/event",
                      json={"compId": comp.id, "step": "view", "ref": None})
    assert res.status_code == 204 and res.content == b""
    rows = db_session.query(PromoFunnelDaily).all()
    assert [(r.code, r.step, r.count) for r in rows] == [("", "view", 1)]


def test_detail_uses_shared_cache_with_not_found_sentinel(db_session, monkeypatch):
    """命中缓存不再读库；不存在也缓存成 {"nf": 1}；删键后立刻看到新值。直接调路由函数
    （request=None，关掉限流器，同 test_comp_public_api.py）。"""
    monkeypatch.setattr(public_competitions.limiter, "enabled", False)
    _flags(db_session)
    comp = _comp(db_session)
    first = public_competitions.get_public_competition(request=None, comp_id=comp.id, db=db_session)
    assert first["name"] == "Demo Cup"
    comp.name = "Renamed"; db_session.commit()
    cached = public_competitions.get_public_competition(request=None, comp_id=comp.id, db=db_session)
    assert cached["name"] == "Demo Cup"
    shared_cache.delete(public_cache_key(comp.id))
    fresh = public_competitions.get_public_competition(request=None, comp_id=comp.id, db=db_session)
    assert fresh["name"] == "Renamed"

    draft = _comp(db_session, status="draft")
    with pytest.raises(Exception) as e:
        public_competitions.get_public_competition(request=None, comp_id=draft.id, db=db_session)
    assert getattr(e.value, "status_code", None) == 404
    assert shared_cache.get_json(public_cache_key(draft.id)) == {"nf": 1}


def test_public_endpoints_are_rate_limited():
    limits = public_competitions.limiter._route_limits
    assert limits.get("app.routers.public_competitions.get_featured")
    assert limits.get("app.routers.public_competitions.get_public_competition")
    assert limits.get("app.routers.public_competitions.post_event")


def test_mounted_under_api_without_user_dependencies():
    from app import main as app_main
    routes = [r for r in app_main.app.routes
              if isinstance(r, APIRoute) and r.path.startswith("/api/public/competitions")]
    assert {r.path for r in routes} == {"/api/public/competitions/featured",
                                        "/api/public/competitions/{comp_id}",
                                        "/api/public/competitions/event"}
    for r in routes:
        calls = {d.call for d in r.dependant.dependencies}
        assert get_current_user not in calls and require_admin not in calls, r.path
