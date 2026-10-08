"""代理专属开户链接：校验、管理端设置/清除、代理自助设置、解析优先级、公开跳转、站内详情。

照 test_invite_competition_links.py 的惯例走 service 级测试（路由函数直接调用，Depends
默认值显式传，限流装饰器用 __wrapped__ 剥掉）；公开跳转走 TestClient（要看 302 与 Location）。
Agent-specific open-account links: validation, admin set/clear, agent self-service,
resolution priority, the public redirect and the in-app detail.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.models import AdminAuditLog, Competition, InviteLink, PromoFunnelDaily, User
from app.routers.invite import assign_agent
from app.services.deps import get_db
from app.services.open_account import (
    ALLOWED_OPEN_ACCOUNT_HOSTS,
    normalize_agent_open_url,
    resolve_open_account_url,
)
from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings

UTC = timezone.utc
T0 = datetime(2026, 10, 1, tzinfo=UTC)
COMP_URL = "https://broker.example/open"
AGENT_URL = "https://my.makecapital.com/open?ib=123"
MSG_BAD = "开户链接需为 Make Capital 的 https 地址 / Open-account URL must be an https Make Capital link"
MSG_COMP = "比赛推广链接使用比赛自己的开户链接 / Competition promo links use the competition's open-account URL"
NOT_FOUND = {"detail": "比赛不存在或未公开 / Competition not found"}


def _mk_user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u); db.commit(); return u


def _mk_link(db, code, **kw):
    link = InviteLink(code=code, label="L-" + code, is_active=kw.pop("active", True), **kw)
    db.add(link); db.commit(); return link


def _admin(db):
    return db.query(User).filter(User.email == "admin@x.io").first() or _mk_user(db, "admin@x.io", role="admin")


def _agent_link(db, code, url=None, active=True):
    agent = _mk_user(db, f"agent-{code}@x.io")
    link = _mk_link(db, code, open_account_url=url, active=active)
    assign_agent(db, _admin(db), link, agent)
    return link, agent


def _comp(db, **kw):
    fields = dict(name="Demo Cup", description="d", metric="return_pct", enrollment="signup",
                  track="demo", status="running", starts_at=T0, ends_at=T0 + timedelta(days=14),
                  reg_opens_at=T0 - timedelta(days=3), reg_closes_at=T0 + timedelta(days=7),
                  public_view=True, open_account_url=COMP_URL)
    fields.update(kw)
    c = Competition(**fields); db.add(c); db.commit(); return c


def _flags(db, public=True, visible=True):
    save_gamification_settings(db, {"competitions_visible": visible,
                                    "competitions_public_enabled": public})
    db.commit(); invalidate_gamification_cache()


# ---------- 校验 / validation ----------

def test_allowed_hosts_constant():
    assert ALLOWED_OPEN_ACCOUNT_HOSTS == ("makecapital.com",)


@pytest.mark.parametrize("raw,expected", [
    (None, None),
    ("", None),
    ("   ", None),
    ("  https://makecapital.com/open  ", "https://makecapital.com/open"),
    ("https://my.makecapital.com/r?ib=1", "https://my.makecapital.com/r?ib=1"),
    ("https://MY.MakeCapital.com/x", "https://MY.MakeCapital.com/x"),
    ("https://makecapital.com:443/open", "https://makecapital.com:443/open"),
])
def test_normalize_accepts(raw, expected):
    assert normalize_agent_open_url(raw) == expected


@pytest.mark.parametrize("raw", [
    "http://makecapital.com/open",            # 非 https
    "https://evilmakecapital.com/open",       # 后缀不是 .makecapital.com
    "https://makecapital.com.evil.io/open",
    "https://evil.io/makecapital.com",
    "https://makecapital.com@evil.io/",       # userinfo 把真实主机藏起来
    "https://evil.io@makecapital.com/",       # 带 userinfo 一律不收
    "makecapital.com/open",                   # 没有 scheme
    "javascript:alert(1)",
    "https://make capital.com/",
    "https://makecapital.com/a b",
    "https://[::1/",                          # urlsplit 抛 ValueError
    "https://makecapital.com/" + "a" * 480,   # > 500
    "https://evil.io\\.makecapital.com/",    # 浏览器把反斜杠当 /，真实主机是 evil.io
    "https://evil.io%5c.makecapital.com/",    # 编码过的反斜杠
    "https://makecapital.com/?q=%41",         # 任何 % 都不收
    "https://mäkecapital.com/",               # 非 ASCII 主机
    "https://xn--mkecapital-x5a.com.evil.io/",
    "https://makecapital.com/\tx",           # 制表符
    "https://makecapital.com/\x01",        # 控制字符
    "https://makecapital.com:99999999/",      # 端口超长
    "https://@makecapital.com/",              # 空 userinfo
])
def test_normalize_rejects(raw):
    with pytest.raises(HTTPException) as exc:
        normalize_agent_open_url(raw)
    assert exc.value.status_code == 400
    assert exc.value.detail == MSG_BAD


def test_normalize_length_boundary():
    url = "https://makecapital.com/" + "a" * (500 - len("https://makecapital.com/"))
    assert len(url) == 500
    assert normalize_agent_open_url(url) == url


# ---------- 管理端 / admin ----------

def _update(db, link, **body):
    from app.routers.invite import update_invite_link
    from app.schemas import InviteLinkUpdate

    return update_invite_link(link.id, InviteLinkUpdate(**body), db=db, admin=_admin(db))


def test_admin_set_keep_and_clear(db_session):
    link, _ = _agent_link(db_session, "agnt2345")
    out = _update(db_session, link, openAccountUrl=f"  {AGENT_URL} ")
    assert out.openAccountUrl == AGENT_URL
    out = _update(db_session, link, label="改名")
    assert out.openAccountUrl == AGENT_URL   # 没传不动 / omitted = unchanged
    out = _update(db_session, link, openAccountUrl="  ")
    assert out.openAccountUrl is None        # 空白清除 / blank clears
    _update(db_session, link, openAccountUrl=AGENT_URL)
    out = _update(db_session, link, openAccountUrl=None)
    assert out.openAccountUrl is None        # null 清除 / null clears


def test_admin_set_writes_audit_with_open_account_url(db_session):
    link = _mk_link(db_session, "plat2345")
    _update(db_session, link, openAccountUrl=AGENT_URL)
    row = (db_session.query(AdminAuditLog)
           .filter(AdminAuditLog.field == "invite:plat2345").order_by(AdminAuditLog.id.desc()).first())
    assert json.loads(row.old_value)["openAccountUrl"] is None
    assert json.loads(row.new_value)["openAccountUrl"] == AGENT_URL


def test_admin_rejects_invalid_url(db_session):
    link = _mk_link(db_session, "plat2345")
    with pytest.raises(HTTPException) as exc:
        _update(db_session, link, openAccountUrl="https://evil.io/x")
    assert exc.value.status_code == 400 and exc.value.detail == MSG_BAD
    db_session.refresh(link)
    assert link.open_account_url is None


def test_admin_rejects_on_competition_link(db_session):
    comp = _comp(db_session)
    link = _mk_link(db_session, "comp2345", competition_id=comp.id)
    with pytest.raises(HTTPException) as exc:
        _update(db_session, link, openAccountUrl=AGENT_URL)
    assert exc.value.status_code == 400 and exc.value.detail == MSG_COMP
    # 清空（null / 空白）对比赛链接是无害的 no-op / clearing is a harmless no-op
    assert _update(db_session, link, openAccountUrl=None).openAccountUrl is None


def test_admin_list_carries_open_account_url(db_session):
    from app.routers.invite import list_invite_links

    _agent_link(db_session, "agnt2345", url=AGENT_URL)
    rows = list_invite_links(kind=None, competitionId=None, channel=None, db=db_session, _admin=_admin(db_session))
    assert {r["code"]: r["openAccountUrl"] for r in rows["links"]} == {"agnt2345": AGENT_URL}


# ---------- 代理自助 / agent self-service ----------

def _agent_set(db, user, link_id, url):
    from app.routers.invite import my_agent_set_open_account_url
    from app.schemas import AgentOpenAccountUrlUpdate

    return my_agent_set_open_account_url.__wrapped__(
        request=None, link_id=link_id, body=AgentOpenAccountUrlUpdate(url=url), db=db, user=user,
    )


def test_agent_sets_and_clears_own_link(db_session):
    link, agent = _agent_link(db_session, "agnt2345")
    out = _agent_set(db_session, agent, link.id, f" {AGENT_URL} ")
    assert out.id == link.id and out.openAccountUrl == AGENT_URL
    db_session.refresh(link)
    assert link.open_account_url == AGENT_URL
    row = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "invite:agnt2345").order_by(
        AdminAuditLog.id.desc()).first()
    assert row.admin_user_id == agent.id and row.target_user_id == agent.id
    assert json.loads(row.new_value)["openAccountUrl"] == AGENT_URL

    out = _agent_set(db_session, agent, link.id, None)
    assert out.openAccountUrl is None


def test_agent_links_list_carries_open_account_url(db_session):
    from app.routers.invite import agent_links

    link, agent = _agent_link(db_session, "agnt2345", url=AGENT_URL)
    assert [l.openAccountUrl for l in agent_links(db_session, agent)] == [AGENT_URL]


def test_agent_cannot_touch_someone_elses_link(db_session):
    _, agent = _agent_link(db_session, "agnt2345")
    other, _ = _agent_link(db_session, "agnt6789")
    plain = _mk_link(db_session, "plat2345")
    for target in (other.id, plain.id, "nope"):
        with pytest.raises(HTTPException) as exc:
            _agent_set(db_session, agent, target, AGENT_URL)
        assert exc.value.status_code == 404
    db_session.refresh(other)
    assert other.open_account_url is None


def test_agent_invalid_url_is_400(db_session):
    link, agent = _agent_link(db_session, "agnt2345")
    with pytest.raises(HTTPException) as exc:
        _agent_set(db_session, agent, link.id, "https://evil.io/x")
    assert exc.value.status_code == 400 and exc.value.detail == MSG_BAD


def test_agent_endpoint_is_rate_limited():
    from app.core.rate_limit import limiter

    assert limiter._route_limits.get("app.routers.invite.my_agent_set_open_account_url")


def test_agent_url_schema_bounds():
    from pydantic import ValidationError

    from app.schemas import AgentOpenAccountUrlUpdate

    assert AgentOpenAccountUrlUpdate(url=None).url is None
    with pytest.raises(ValidationError):
        AgentOpenAccountUrlUpdate(url="x" * 3000)


# ---------- 解析 / resolution ----------

def test_resolve_agent_with_url_wins(db_session):
    comp = _comp(db_session)
    _agent_link(db_session, "agnt2345", url=AGENT_URL)
    assert resolve_open_account_url(db_session, comp, ["agnt2345"]) == AGENT_URL


def test_resolve_agent_without_url_falls_back(db_session):
    comp = _comp(db_session)
    _agent_link(db_session, "agnt2345")
    assert resolve_open_account_url(db_session, comp, ["agnt2345"]) == COMP_URL


def test_resolve_platform_link_falls_back(db_session):
    comp = _comp(db_session)
    # 平台链接哪怕被写进了 URL（比如代理被撤掉之后），也不用它 / no agent → comp default
    _mk_link(db_session, "plat2345", open_account_url=AGENT_URL)
    assert resolve_open_account_url(db_session, comp, ["plat2345"]) == COMP_URL


def test_resolve_agent_priority_over_newer_platform_ref(db_session):
    comp = _comp(db_session)
    _mk_link(db_session, "plat2345")
    _agent_link(db_session, "agnt2345", url=AGENT_URL)
    assert resolve_open_account_url(db_session, comp, ["plat2345", "agnt2345"]) == AGENT_URL


def test_resolve_inactive_agent_link_and_no_refs(db_session):
    comp = _comp(db_session)
    _agent_link(db_session, "agnt2345", url=AGENT_URL, active=False)
    assert resolve_open_account_url(db_session, comp, ["agnt2345"]) == COMP_URL
    assert resolve_open_account_url(db_session, comp, []) == COMP_URL
    nourl = _comp(db_session, open_account_url=None, public_view=False)
    assert resolve_open_account_url(db_session, nourl, []) is None


# ---------- 公开跳转 / public redirect ----------

def _client(db):
    from app.routers import public_competitions

    db.connection()
    app = FastAPI()
    app.state.limiter = public_competitions.limiter
    app.include_router(public_competitions.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app, raise_server_exceptions=False)


def _funnel(db):
    return [(r.code, r.step, r.count) for r in db.query(PromoFunnelDaily).all()]


def test_redirect_to_agent_url_and_records_funnel(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    _mk_link(db_session, "plat2345")
    _agent_link(db_session, "agnt2345", url=AGENT_URL)
    res = _client(db_session).get(
        f"/api/public/competitions/{comp.id.upper()}/open-account?refs=plat2345,agnt2345",
        follow_redirects=False)
    assert res.status_code == 302, res.text
    assert res.headers["location"] == AGENT_URL
    assert "agnt2345" not in res.text
    assert _funnel(db_session) == [("agnt2345", "open_account", 1)]


def test_redirect_without_refs_goes_to_comp_url(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    res = _client(db_session).get(f"/api/public/competitions/{comp.id}/open-account",
                                  follow_redirects=False)
    assert res.status_code == 302
    assert res.headers["location"] == COMP_URL
    assert _funnel(db_session) == [("", "open_account", 1)]


def test_redirect_platform_ref_records_its_code(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    _mk_link(db_session, "plat2345")
    res = _client(db_session).get(f"/api/public/competitions/{comp.id}/open-account?refs=PLAT2345,,nosuch",
                                  follow_redirects=False)
    assert res.status_code == 302 and res.headers["location"] == COMP_URL
    assert _funnel(db_session) == [("plat2345", "open_account", 1)]


@pytest.mark.parametrize("case", ["unknown", "not-uuid", "draft", "not-public", "public-off", "visible-off"])
def test_redirect_404_when_not_public(db_session, case):
    _flags(db_session, public=case != "public-off", visible=case != "visible-off")
    comp = {"draft": lambda: _comp(db_session, status="draft"),
            "not-public": lambda: _comp(db_session, public_view=False)}.get(case, lambda: _comp(db_session))()
    comp_id = {"unknown": "00000000-0000-4000-8000-000000000000", "not-uuid": "abc"}.get(case, comp.id)
    res = _client(db_session).get(f"/api/public/competitions/{comp_id}/open-account",
                                  follow_redirects=False)
    assert res.status_code == 404
    assert res.json() == NOT_FOUND
    assert _funnel(db_session) == []


def test_redirect_rejects_too_long_refs(db_session):
    _flags(db_session)
    comp = _comp(db_session)
    res = _client(db_session).get(f"/api/public/competitions/{comp.id}/open-account?refs=" + "a" * 400,
                                  follow_redirects=False)
    assert res.status_code == 422


def test_redirect_endpoint_is_rate_limited():
    from app.routers import public_competitions

    assert public_competitions.limiter._route_limits.get(
        "app.routers.public_competitions.open_account_redirect")


def test_is_http_url():
    from app.services.open_account import is_http_url

    assert is_http_url("https://broker.example/open") and is_http_url("http://a.b/")
    for bad in (None, "", "javascript:alert(1)", "https://", "ftp://a.b/", "https://[::1/"):
        assert not is_http_url(bad), bad


def test_parse_refs_bounds():
    from app.routers.public_competitions import _parse_refs

    assert _parse_refs(None) == []
    assert _parse_refs("") == []
    assert _parse_refs(" a , ,b,") == ["a", "b"]
    assert _parse_refs(",".join(str(i) for i in range(9))) == ["0", "1", "2", "3", "4"]
    assert _parse_refs("x" * 33 + ",ok") == ["ok"]


# ---------- 站内详情 / in-app detail ----------

def test_in_app_detail_resolves_by_users_invite_code(db_session, monkeypatch):
    from app.core import rate_limit
    from app.routers.competitions import get_competition

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    _flags(db_session)
    comp = _comp(db_session)
    _agent_link(db_session, "agnt2345", url=AGENT_URL)
    attributed = _mk_user(db_session, "a@t.co", invite_code="agnt2345")
    plain = _mk_user(db_session, "p@t.co")
    assert get_competition(request=None, comp_id=comp.id, db=db_session, user=attributed)["openAccountUrl"] == AGENT_URL
    assert get_competition(request=None, comp_id=comp.id, db=db_session, user=plain)["openAccountUrl"] == COMP_URL
