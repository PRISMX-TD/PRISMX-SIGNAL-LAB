"""比赛推广链接 + 邀请链接重整（后端）：pick_ref、比赛链接备注、分类/渠道/报名数、
指派守卫、pendingCompetition。

照 test_invite_links.py 的惯例走 service 级测试：路由函数直接调用，Depends /
Query 默认值当普通参数显式传；限流装饰器用 __wrapped__ 剥掉。
Service-level, like test_invite_links.py: route functions are called directly
with Depends/Query defaults passed explicitly; slowapi is stripped via __wrapped__.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models import AdminAuditLog, Competition, CompetitionParticipant, InviteLink, InviteLinkAgent, User
from app.routers.invite import assign_agent, pick_ref
from app.schemas import GoogleAuthRequest, RegisterRequest

UTC = timezone.utc
_SIGNUP = dict(email="new@example.com", password="a-good-password", phoneCountry="60", phone="123456789")


@pytest.fixture(autouse=True)
def _clean_shared_state():
    """注册路径的发信频次计数住在 shared_state，跨用例不会自己清（同 test_email_verification）。"""
    from app.services import shared_state
    from app.services.settings_store import invalidate_trial_cache

    shared_state.reset_for_tests()
    invalidate_trial_cache()
    yield
    shared_state.reset_for_tests()
    invalidate_trial_cache()


def _mk_link(db, code="abcd2345", label="测试渠道", active=True, **kw):
    link = InviteLink(code=code, label=label, is_active=active, **kw)
    db.add(link)
    db.commit()
    return link


def _mk_user(db, email="u@example.com", **kw):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(user)
    db.commit()
    return user


def _mk_comp(db, name="秋季模拟赛", status="upcoming", enrollment="signup", reg_open=True):
    now = datetime.now(UTC)
    comp = Competition(
        name=name, track="demo", metric="return_pct", enrollment=enrollment, status=status,
        reg_opens_at=now - timedelta(days=1),
        reg_closes_at=now + timedelta(days=3) if reg_open else now - timedelta(hours=1),
        starts_at=now + timedelta(days=4), ends_at=now + timedelta(days=11),
    )
    db.add(comp)
    db.commit()
    return comp


def _enter(db, comp, user, login, disqualified=False):
    db.add(CompetitionParticipant(
        competition_id=comp.id, user_id=user.id, mt5_login=login, disqualified=disqualified,
    ))
    db.commit()


def _agent_link(db, code, admin_email="admin@x.io"):
    """建一条已指派代理的链接（管理员按邮箱复用）。"""
    admin = db.query(User).filter(User.email == admin_email).first() or _mk_user(db, admin_email, role="admin")
    agent = _mk_user(db, f"agent-{code}@x.io")
    link = _mk_link(db, code=code)
    assign_agent(db, admin, link, agent)
    return link


class _Background:
    """BackgroundTasks 的替身：记下要发的信，不真发。"""

    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *args, **kwargs):
        self.tasks.append((fn, args, kwargs))


# ---------- B1: pick_ref（30 天内代理优先）----------

def test_pick_ref_agent_link_beats_newer_platform_link(db_session):
    _mk_link(db_session, code="plat2345")
    _agent_link(db_session, "agnt2345")
    # refs 最新在前：平台链接更新，但窗口内有代理链接 → 代理优先
    assert pick_ref(db_session, ["plat2345", "agnt2345"]) == "agnt2345"


def test_pick_ref_newest_agent_link_among_several(db_session):
    _agent_link(db_session, "agnt2345")
    _agent_link(db_session, "agnt6789")
    assert pick_ref(db_session, ["agnt6789", "agnt2345"]) == "agnt6789"


def test_pick_ref_without_agent_links_takes_newest_active(db_session):
    _mk_link(db_session, code="dead2345", active=False)
    _mk_link(db_session, code="plat2345")
    _mk_link(db_session, code="plat6789")
    assert pick_ref(db_session, ["dead2345", "nosuch23", "plat6789", "plat2345"]) == "plat6789"


def test_pick_ref_skips_inactive_agent_link(db_session):
    dead = _agent_link(db_session, "agnt2345")
    dead.is_active = False
    db_session.commit()
    _mk_link(db_session, code="plat2345")
    assert pick_ref(db_session, ["agnt2345", "plat2345"]) == "plat2345"


def test_pick_ref_none_when_nothing_usable(db_session):
    _mk_link(db_session, code="dead2345", active=False)
    assert pick_ref(db_session, ["dead2345", "nosuch23"]) is None
    assert pick_ref(db_session, []) is None
    assert pick_ref(db_session, None) is None


def test_pick_ref_normalizes_and_returns_canonical_code(db_session):
    _agent_link(db_session, "agnt2345")
    assert pick_ref(db_session, ["  AGNT2345 "]) == "agnt2345"


def test_pick_ref_competition_link_is_not_an_agent_link(db_session):
    comp = _mk_comp(db_session)
    _mk_link(db_session, code="comp2345", competition_id=comp.id)
    _mk_link(db_session, code="plat2345")
    # 两条都不是代理链接 → 取最新的活跃链接
    assert pick_ref(db_session, ["comp2345", "plat2345"]) == "comp2345"


def test_refs_field_bounds():
    ok = RegisterRequest(**_SIGNUP, refs=["a" * 32] * 5)
    assert ok.refs == ["a" * 32] * 5
    assert RegisterRequest(**_SIGNUP).refs is None
    for bad in (["x"] * 6, [""], ["x" * 33]):
        with pytest.raises(ValidationError):
            RegisterRequest(**_SIGNUP, refs=bad)
        with pytest.raises(ValidationError):
            GoogleAuthRequest(credential="c" * 40, refs=bad)


def test_register_uses_refs_agent_first_and_hides_choice(db_session):
    from app.routers.auth import register

    _mk_link(db_session, code="plat2345")
    _agent_link(db_session, "agnt2345")
    out = register.__wrapped__(
        request=None,
        req=RegisterRequest(**_SIGNUP, ref="plat2345", refs=["plat2345", "agnt2345"]),
        background=_Background(),
        db=db_session,
    )
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    assert user.invite_code == "agnt2345"
    # 选中谁不回传 / the choice is never echoed back
    assert "agnt2345" not in out.model_dump_json()


def test_register_old_client_single_ref_still_attributes(db_session):
    from app.routers.auth import register

    _mk_link(db_session, code="plat2345")
    register.__wrapped__(
        request=None, req=RegisterRequest(**_SIGNUP, ref="plat2345"), background=_Background(), db=db_session
    )
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    assert user.invite_code == "plat2345"


def test_google_signup_uses_refs(db_session, monkeypatch):
    from app.core.config import settings
    from app.routers import auth as auth_mod

    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "test-client")
    monkeypatch.setattr(auth_mod, "verify_google_id_token", lambda _c: {"email": "g@gmail.com"})
    _mk_link(db_session, code="plat2345")
    _agent_link(db_session, "agnt2345")
    auth_mod.google_login.__wrapped__(
        request=None,
        req=GoogleAuthRequest(credential="c" * 40, ref="plat2345", refs=["plat2345", "agnt2345"]),
        db=db_session,
    )
    user = db_session.query(User).filter(User.email == "g@gmail.com").one()
    assert user.invite_code == "agnt2345"


# ---------- B2: 比赛链接的注册备注 ----------

def test_apply_invite_competition_link_note_is_comp_and_label(db_session):
    from app.routers.invite import apply_invite

    comp = _mk_comp(db_session, name="秋季模拟赛")
    link = _mk_link(db_session, code="comp2345", label="FB广告", competition_id=comp.id)
    user = _mk_user(db_session)
    apply_invite(db_session, user, link.code)
    assert user.plan_note == "秋季模拟赛·FB广告"
    assert user.invite_code == "comp2345"


def test_apply_invite_competition_link_missing_comp_falls_back_to_label(db_session):
    from app.routers.invite import apply_invite

    _mk_link(db_session, code="comp2345", label="FB广告", competition_id="00000000-0000-0000-0000-000000000000")
    user = _mk_user(db_session)
    apply_invite(db_session, user, "comp2345")
    assert user.plan_note == "FB广告"
