"""账号停用：闸门必须在**鉴权那一层**落下，而不是只挡登录。

这套判据全都属于「写错了功能照样能用、只有被封的人和你自己不知道」的那一类：

1. **已经拿着有效 token 的会话必须立刻失效。** 只在登录入口挡的话，本站 token
   有效期 30 天且会滑动续期，一个正在用的人被封之后还能照常下单一个月——而后台
   里那一行明明写着「已停用」，没有任何人会发现对不上。
2. **不能停用管理员（包括自己）。** 这是唯一一条会把所有人关在门外的操作：解封
   的入口就在后台里面，锁死之后只能上服务器改库。
3. **恢复要干净。** 清掉两列就该恢复原状，plan / 到期时间 / 历史一个都不许动。
4. **审计要记旧值。** 审计行存在的唯一理由是回答「改之前是什么样」。

照仓库惯例走 service 级测试（直接调路由函数，Depends 当普通参数传）。

Every assertion here covers a failure mode that stays silent: a ban that only
takes effect in a month, an admin console nobody can get back into, an "enable"
that quietly loses the user's plan, and an audit row that records nothing.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response

from app.core.security import create_access_token
from app.models import AdminAuditLog, User
from app.routers.admin import disable_user, enable_user, list_users
from app.schemas import AdminUserDisableIn
from app.services.deps import get_current_user


def _mk_user(db, email="u@example.com", role="user", plan="PRO", **kw) -> User:
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", role=role, plan=plan, **kw)
    db.add(user)
    db.commit()
    return user


def _auth(user: User) -> str:
    return "Bearer " + create_access_token(user.id, user.token_version or 0)


def _call(db, user: User):
    """按当前 token 走一次鉴权链 / run the auth chain with this user's current token."""
    return get_current_user(response=Response(), authorization=_auth(user), db=db)


# ---------- 判定点在 get_current_user / the gate lives in get_current_user ----------

def test_a_live_token_stops_working_the_moment_the_account_is_disabled(db_session):
    """核心判据：token 没换、没过期，仅仅因为账号被停用就必须 403。

    这一条挂了就等于封号在一个月内无效——被封的人手里那张 token 照常能用。
    """
    user = _mk_user(db_session)
    token = _auth(user)
    assert get_current_user(response=Response(), authorization=token, db=db_session) is user

    user.disabled_at = datetime.now(timezone.utc)
    db_session.commit()

    with pytest.raises(HTTPException) as err:
        get_current_user(response=Response(), authorization=token, db=db_session)
    assert err.value.status_code == 403


def test_the_reason_is_handed_back_to_the_user_verbatim(db_session):
    """原因要原样带给用户——后台填的那句话就是他在界面上看到的那句话。"""
    user = _mk_user(db_session, disabled_at=datetime.now(timezone.utc), disabled_reason="涉嫌刷单")
    with pytest.raises(HTTPException) as err:
        _call(db_session, user)
    assert "涉嫌刷单" in err.value.detail
    assert "/" in err.value.detail and "disabled" in err.value.detail.lower()   # 中英双语


def test_no_reason_falls_back_to_a_generic_sentence(db_session):
    """没填原因也不能吐一句空话或 None。"""
    user = _mk_user(db_session, disabled_at=datetime.now(timezone.utc), disabled_reason="   ")
    with pytest.raises(HTTPException) as err:
        _call(db_session, user)
    assert "None" not in err.value.detail
    assert "账号已被停用" in err.value.detail and "disabled" in err.value.detail.lower()


def test_403_not_401_so_the_frontend_shows_the_reason(db_session):
    """401 会让前端清 token 跳登录页，用户再登一次、再被踢，循环里看不到理由。"""
    user = _mk_user(db_session, disabled_at=datetime.now(timezone.utc), disabled_reason="r")
    with pytest.raises(HTTPException) as err:
        _call(db_session, user)
    assert err.value.status_code == 403


def test_a_disabled_account_is_not_counted_as_active(db_session):
    """停用判定要排在 last_active_at 之前：被封的人不该再被算进 DAU。"""
    user = _mk_user(db_session, disabled_at=datetime.now(timezone.utc))
    with pytest.raises(HTTPException):
        _call(db_session, user)
    db_session.refresh(user)
    assert user.last_active_at is None


def test_a_normal_account_is_untouched(db_session):
    """disabled_at 为 NULL 就是正常账号，这条闸门不能误伤。"""
    user = _mk_user(db_session)
    assert _call(db_session, user) is user


# ---------- 管理端：停用 / admin: disable ----------

def test_disable_writes_both_columns_and_bumps_the_token_version(db_session):
    """token_version 必须跟着自增，否则滑动续期会让被封的人一直换到新 token。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")
    before_tv = target.token_version or 0

    out = disable_user(target.id, AdminUserDisableIn(reason="涉嫌刷单"), db=db_session, admin=admin)

    db_session.refresh(target)
    assert target.disabled_at is not None
    assert target.disabled_reason == "涉嫌刷单"
    assert target.token_version == before_tv + 1
    assert out.disabledAt is not None and out.disabledReason == "涉嫌刷单"


def test_the_token_version_bump_kills_tokens_minted_before_the_ban(db_session):
    """封号之前签发的 token 连"停用"这条判断都走不到，先被会话版本挡掉——
    WebSocket 建连只校验 tv，不经过 get_current_user，靠的就是这一下。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")
    old_token = _auth(target)

    disable_user(target.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)

    with pytest.raises(HTTPException) as err:
        get_current_user(response=Response(), authorization=old_token, db=db_session)
    assert err.value.status_code == 401


def test_disable_does_not_touch_plan_or_expiry(db_session):
    """停用是闸门、plan 是等级，两件事（见 models 里 disabled_at 的说明）。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    expires = datetime(2026, 12, 31, 0, 0, 0)
    target = _mk_user(db_session, email="t@example.com", plan="PRO", plan_expires_at=expires)

    disable_user(target.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)

    db_session.refresh(target)
    assert target.plan == "PRO"
    assert target.plan_expires_at == expires


def test_an_admin_cannot_disable_themselves(db_session):
    """手滑一次就是把自己锁在门外，而解锁的入口正好也在门里面。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    with pytest.raises(HTTPException) as err:
        disable_user(admin.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)
    assert err.value.status_code == 400
    db_session.refresh(admin)
    assert admin.disabled_at is None


def test_an_admin_cannot_disable_another_admin(db_session):
    """两个管理员互停、或一人把其余管理员全停掉，都能把**所有人**关在外面。
    要封同事得先降权再停用——多的这一步是有意的。"""
    admin = _mk_user(db_session, email="a1@example.com", role="admin")
    other = _mk_user(db_session, email="a2@example.com", role="admin")

    with pytest.raises(HTTPException) as err:
        disable_user(other.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)
    assert err.value.status_code == 400

    db_session.refresh(other)
    assert other.disabled_at is None
    assert (other.token_version or 0) == 0          # 连 token_version 都不许动


def test_demoting_first_makes_the_disable_go_through(db_session):
    """挡的是「停用管理员」，不是「停用某个人」——降权之后照常能停。"""
    admin = _mk_user(db_session, email="a1@example.com", role="admin")
    other = _mk_user(db_session, email="a2@example.com", role="admin")

    other.role = "user"
    db_session.commit()
    disable_user(other.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)

    db_session.refresh(other)
    assert other.disabled_at is not None


def test_disabling_an_unknown_user_is_a_404(db_session):
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    with pytest.raises(HTTPException) as err:
        disable_user("no-such-id", AdminUserDisableIn(reason="r"), db=db_session, admin=admin)
    assert err.value.status_code == 404


# ---------- 管理端：恢复 / admin: enable ----------

def test_enable_clears_both_columns_and_the_user_works_again(db_session):
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")
    disable_user(target.id, AdminUserDisableIn(reason="涉嫌刷单"), db=db_session, admin=admin)

    out = enable_user(target.id, db=db_session, admin=admin)

    db_session.refresh(target)
    assert target.disabled_at is None and target.disabled_reason is None
    assert out.disabledAt is None and out.disabledReason is None
    # 拿一张停用之后重新签发的 token（现实里就是重新登录），应当畅通无阻
    assert _call(db_session, target) is target


def test_enable_keeps_the_old_sessions_dead(db_session):
    """恢复是「允许他重新登录」，不是「把旧会话还给他」——其中可能正有一张是被封的原因。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")
    old_token = _auth(target)
    tv_before = target.token_version or 0

    disable_user(target.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)
    enable_user(target.id, db=db_session, admin=admin)

    db_session.refresh(target)
    assert target.token_version == tv_before + 1        # 恢复不再加一次
    with pytest.raises(HTTPException) as err:
        get_current_user(response=Response(), authorization=old_token, db=db_session)
    assert err.value.status_code == 401


def test_enable_is_not_blocked_by_the_disable_side_guards(db_session):
    """恢复不套「不能动管理员」那两条：一个被停用的账号事后被提成管理员，
    再套上去就没有任何入口能把他放出来了。"""
    admin = _mk_user(db_session, email="a1@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")
    disable_user(target.id, AdminUserDisableIn(reason="r"), db=db_session, admin=admin)

    target.role = "admin"
    db_session.commit()

    enable_user(target.id, db=db_session, admin=admin)
    db_session.refresh(target)
    assert target.disabled_at is None


# ---------- 审计 / audit trail ----------

def test_the_disable_audit_row_records_the_previous_state(db_session):
    """记旧值是审计行存在的唯一理由：改原因时要看得出上一条原因是什么。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")

    disable_user(target.id, AdminUserDisableIn(reason="第一次"), db=db_session, admin=admin)
    disable_user(target.id, AdminUserDisableIn(reason="改成第二次"), db=db_session, admin=admin)

    # 不能按 id 排序：`AdminAuditLog.id` 是 UUID 字符串（models 里 default=_uuid），
    # 字典序与写入先后毫无关系，排出来是随机的。按内容定位这两行才稳。
    # Not ordered by id: it is a UUID string, so lexical order has nothing to do with
    # insertion order. Locate the two rows by content instead.
    rows = (
        db_session.query(AdminAuditLog)
        .filter(AdminAuditLog.field == "account:disable")
        .all()
    )
    assert len(rows) == 2
    first = next(r for r in rows if "第一次" in r.new_value)
    second = next(r for r in rows if "改成第二次" in r.new_value)

    assert first.admin_user_id == admin.id and first.target_user_id == target.id
    assert "null" in first.old_value                        # 停用前：disabledAt 为 null
    assert "第一次" in second.old_value                     # 第二条记得住上一条原因


def test_the_enable_audit_row_records_who_was_disabled_and_why(db_session):
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    target = _mk_user(db_session, email="t@example.com")
    disable_user(target.id, AdminUserDisableIn(reason="涉嫌刷单"), db=db_session, admin=admin)
    enable_user(target.id, db=db_session, admin=admin)

    row = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "account:enable").one()
    assert "涉嫌刷单" in row.old_value
    assert "null" in row.new_value
    assert row.admin_user_id == admin.id and row.target_user_id == target.id


# ---------- 管理端列表 / admin list ----------

def test_the_user_list_shows_the_disabled_state(db_session):
    """被封的 PRO 和正常的 PRO 在列表里必须分得出来——只看 plan 是一模一样的。"""
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    banned = _mk_user(db_session, email="b@example.com", plan="PRO")
    normal = _mk_user(db_session, email="n@example.com", plan="PRO")
    disable_user(banned.id, AdminUserDisableIn(reason="涉嫌刷单"), db=db_session, admin=admin)

    # 直接调路由函数，所以 Query(...) 默认值要当普通参数显式传（本套件没有 TestClient）
    listed = list_users(q=None, plan=None, role=None, invite_code=None, limit=50, offset=0, db=db_session, _admin=admin)
    rows = {u["email"]: u for u in listed["users"]}
    assert rows["b@example.com"]["disabledAt"] is not None
    assert rows["b@example.com"]["disabledReason"] == "涉嫌刷单"
    assert rows["n@example.com"]["disabledAt"] is None
