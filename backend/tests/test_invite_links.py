"""邀请链接：模型、短码生成、点击计数、注册归因的单元测试。

照仓库惯例走 service 级测试（无 TestClient 先例），用 conftest 的 db_session
内存库。本目录被 .gitignore 忽略，测试只在本地跑、不入库。
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod
from app.models import AdminAuditLog, InviteLink, User
from app.routers.invite import (
    _CODE_ALPHABET,
    _trial_grant_days,
    apply_invite,
    create_invite_link,
    generate_code,
    new_unique_code,
    offer_days,
    record_click,
)
from app.schemas import InviteLinkCreate
from app.services.settings_store import invalidate_trial_cache, save_trial_settings


def _mk_link(db, code="abcd2345", label="测试渠道", active=True):
    link = InviteLink(code=code, label=label, is_active=active)
    db.add(link)
    db.commit()
    return link


def _mk_user(db, email="u@example.com", **kw):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(user)
    db.commit()
    return user


def test_invite_link_model_defaults(db_session):
    link = _mk_link(db_session)
    assert link.id  # uuid 默认值生效
    assert link.clicks == 0
    assert link.is_active is True
    assert link.created_at is not None


def test_user_invite_code_column(db_session):
    user = _mk_user(db_session, invite_code="abcd2345")
    db_session.refresh(user)
    assert user.invite_code == "abcd2345"


def test_generate_code_shape():
    for _ in range(50):
        code = generate_code()
        assert len(code) == 8
        assert all(c in _CODE_ALPHABET for c in code)
    # 易混淆字符必须不在字符集里 / ambiguous chars excluded by construction
    for bad in "0O1lI":
        assert bad not in _CODE_ALPHABET


def test_new_unique_code_retries_on_collision(db_session, monkeypatch):
    _mk_link(db_session, code="collide1")
    seq = iter(["collide1", "fresh234"])
    monkeypatch.setattr("app.routers.invite.generate_code", lambda: next(seq))
    assert new_unique_code(db_session) == "fresh234"


def test_new_unique_code_gives_up_after_10(db_session, monkeypatch):
    _mk_link(db_session, code="collide1")
    monkeypatch.setattr("app.routers.invite.generate_code", lambda: "collide1")
    with pytest.raises(HTTPException) as exc:
        new_unique_code(db_session)
    assert exc.value.status_code == 500


def test_record_click_increments_active(db_session):
    link = _mk_link(db_session)
    record_click(db_session, link.code)
    record_click(db_session, link.code)
    db_session.refresh(link)
    assert link.clicks == 2


def test_record_click_ignores_inactive_and_unknown(db_session):
    link = _mk_link(db_session, active=False)
    record_click(db_session, link.code)   # 停用不计 / inactive: no count
    record_click(db_session, "nosuch12")  # 不存在不报错 / unknown: no error
    db_session.refresh(link)
    assert link.clicks == 0


def test_apply_invite_writes_note_and_code(db_session):
    link = _mk_link(db_session)
    user = _mk_user(db_session)
    apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)
    assert user.plan_note == "测试渠道"
    assert user.invite_code == link.code


def test_apply_invite_ignores_inactive_unknown_and_none(db_session):
    _mk_link(db_session, active=False)
    user = _mk_user(db_session)
    apply_invite(db_session, user, "abcd2345")  # 已停用 / disabled
    apply_invite(db_session, user, "nosuch12")  # 不存在 / unknown
    apply_invite(db_session, user, None)        # 没带 ref / absent
    assert user.plan_note is None
    assert user.invite_code is None


def test_apply_invite_never_overwrites_existing_attribution(db_session):
    first = _mk_link(db_session, code="first234", label="第一条")
    _mk_link(db_session, code="second23", label="第二条")
    user = _mk_user(db_session)
    apply_invite(db_session, user, first.code)
    apply_invite(db_session, user, "second23")
    assert user.plan_note == "第一条"
    assert user.invite_code == "first234"


def test_apply_invite_leaves_existing_user_untouched(db_session):
    """google_login 是查找或创建二合一，对已存在用户调用 apply_invite 必须是空
    操作——否则带着过期本地 ref 回来的老用户，会被覆盖掉管理员手写的备注、
    伪造一条从未发生过的注册归因。用一个已有 plan_note 与 invite_code（模拟
    管理员手改备注 + 早已归因过）的用户模拟这个「查找到既有用户」分支，
    确认两个字段都原样不动。
    google_login is find-or-create; calling apply_invite on an existing user
    must be a no-op — otherwise a returning user with a stale local ref would
    have the admin's hand-written note clobbered and a registration fabricated
    that never happened. A user pre-seeded with plan_note and invite_code (as
    if hand-edited by an admin and already attributed) simulates the
    find-existing-user branch; both fields must come out unchanged.
    """
    link = _mk_link(db_session, code="freshcod1", label="新渠道")
    user = _mk_user(db_session, plan_note="管理员手写备注", invite_code="already12")
    apply_invite(db_session, user, link.code)
    assert user.plan_note == "管理员手写备注"
    assert user.invite_code == "already12"


def test_record_click_normalizes_case_and_whitespace(db_session):
    """大写/带空白的 ref 照样计点击。

    _CODE_ALPHABET 全小写，所以大写永远不是真码，归一是无损的。链路上任何一段
    做过大小写归一（部分二维码/短链工具会），或者有人照单子手抄成大写，若比较
    是大小写敏感的就一个字不差也查不到；而打点端一律 204，丢了不会报警。

    An uppercased or whitespace-padded ref must still count. Lossless because
    the alphabet is lowercase-only; without it a case-folded or hand-retyped
    code silently matches nothing behind an always-204 endpoint.
    """
    link = _mk_link(db_session)
    record_click(db_session, link.code.upper())
    record_click(db_session, f"  {link.code}  ")
    record_click(db_session, f" {link.code.upper()}\n")
    db_session.refresh(link)
    assert link.clicks == 3


def test_apply_invite_normalizes_case_and_whitespace(db_session):
    """大写/带空白的 ref 照样归因，且写库存的是库里那份小写原码。
    Same normalization on the attribution path; the code persisted onto the user
    is the canonical row value, never the caller's uppercased string."""
    link = _mk_link(db_session)
    user = _mk_user(db_session)
    apply_invite(db_session, user, f"  {link.code.upper()}  ")
    db_session.commit()
    db_session.refresh(user)
    assert user.plan_note == "测试渠道"
    assert user.invite_code == link.code


def test_create_invite_link_audit_records_active_not_null(db_session):
    """新建链接的审计行必须记成 isActive: true，不能是 null。

    is_active 是模型上 Column(default=True) 的 Python 侧默认值，只在 flush 时才
    应用；会话是 autoflush=False，所以 db.add() 之后立刻读属性拿到的是 None，
    审计行会写成 {"isActive": null}——把刚建好、明明是启用状态的链接记成状态
    不明，正好废掉审计日志存在的意义。这里直接调路由函数（本套件是 service 级
    的，没有 TestClient），因此 Depends 全部按普通默认参数显式传入。

    The creation audit row must record the link as active. is_active is a
    Python-side column default applied at flush, and the session is
    autoflush=False, so reading it right after db.add() yields None and the row
    would say {"isActive": null} — a link logged in an unknown state at the one
    moment its state is certain. The endpoint function is called directly (this
    suite is service-level, no TestClient), so the Depends defaults are just
    ordinary arguments.
    """
    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    created = create_invite_link(InviteLinkCreate(label="渠道甲"), db=db_session, admin=admin)
    assert created.isActive is True

    row = (
        db_session.query(AdminAuditLog)
        .filter(AdminAuditLog.field == f"invite:{created.code}")
        .one()
    )
    assert json.loads(row.new_value) == {"label": "渠道甲", "isActive": True, "grantsTrial": False}


# ---------- 迁移：旧库补列 + 建索引 ----------
#
# 上面所有用例都用 conftest 的 db_session，那是 create_all 建出来的库，users 里
# 本来就有 invite_code——这类库永远复现不了「索引建在补列之前」的启动崩溃。这
# 一节因此自己造一个**缺列的旧库**，在上面跑真正的 _migrate_columns，仿照
# test_schema_rev.py 的 temp_engine 用文件库（_read/_write_schema_rev 各自
# engine.connect()，:memory: 每次连接都是空库）。
#
# Every case above uses conftest's db_session, built by create_all, whose users
# table already has invite_code — such a database can never reproduce the
# startup crash of "index created before the column". So this section builds a
# database that is genuinely missing the column and runs the real
# _migrate_columns against it, modelled on temp_engine in test_schema_rev.py: a
# file-backed database, because _read/_write_schema_rev each open their own
# connection and a :memory: database would be empty on every one of them.


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    """本次上线**之前**的旧库：全表结构，但 users 没有 invite_code。

    先 create_all 建出完整结构再把列删掉，而不是手写一份精简 users 建表语句：
    旧库与今天的差别只有这一列，手写的表反而会随模型演进而失真。invite_code
    在模型上没有 index=True，create_all 不会给它建索引，所以 SQLite 的
    DROP COLUMN 不会被"列被索引占用"挡住（3.35+ 支持，本机 3.49）。

    The database as it existed *before* this feature shipped: full schema, minus
    users.invite_code. Built by create_all and then dropping the column rather
    than hand-writing a trimmed users DDL — the only difference from today's
    schema is that one column, and a hand-written table would drift as the model
    evolves. invite_code carries no index=True on the model, so create_all never
    indexes it and SQLite's DROP COLUMN isn't blocked (3.35+; 3.49 here).
    """
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE users DROP COLUMN invite_code"))

    monkeypatch.setattr(db_mod, "engine", eng)
    # SessionLocal 在模块导入时就绑好了真 engine；慢通道里的
    # _disable_legacy_strategies / _backfill_strategy_watch 走的正是它，不一起
    # 换会打到开发机上的真库。
    # SessionLocal is bound at import time; the slow path's helpers use it, so
    # swapping only `engine` would let them hit the developer's real database.
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    yield eng
    eng.dispose()


def _user_columns(eng):
    return {c["name"] for c in inspect(eng).get_columns("users")}


def _users_indexes(eng):
    return {i["name"]: list(i["column_names"]) for i in inspect(eng).get_indexes("users")}


def test_migration_on_db_without_invite_code_adds_column_and_index(legacy_engine):
    """回归：旧库上整段迁移必须跑完，并同时留下列和索引。

    修复前 idx_users_invite_code 建在 users 补列**之前**的通用索引块里，这里会
    以 OperationalError: no such column: invite_code 直接失败——而这段迁移跑在
    uvicorn bind 端口之前，线上等价于服务器起不来。

    Regression: on a pre-existing database the whole migration must run to
    completion and leave behind both the column and the index. Before the fix
    idx_users_invite_code was created in the shared index block *above* the
    users column-add, so this failed with
    OperationalError: no such column: invite_code — and since the migration runs
    before uvicorn binds its port, that is a server that never starts.
    """
    assert "invite_code" not in _user_columns(legacy_engine), "fixture 没造出缺列的旧库"
    assert "idx_users_invite_code" not in _users_indexes(legacy_engine)

    db_mod._migrate_columns()

    assert "invite_code" in _user_columns(legacy_engine), "迁移没有补上 users.invite_code"
    assert _users_indexes(legacy_engine).get("idx_users_invite_code") == ["invite_code"], (
        "迁移没有建出 idx_users_invite_code，或它没建在 invite_code 上"
    )
    # 跑完才会记版本号；记上了说明迁移是整段跑通的，不是中途抛异常。
    # The marker is only written after every step succeeds.
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_migration_index_creation_is_idempotent(legacy_engine):
    """把版本号调小强制重跑：列已存在、索引已存在，都不能报错。
    Forcing a re-run must not raise now that both column and index exist."""
    db_mod._migrate_columns()
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)
    db_mod._migrate_columns()   # 不该抛 / must not raise
    assert _users_indexes(legacy_engine).get("idx_users_invite_code") == ["invite_code"]


# ---------- grants_trial：默认值与旧库补列 ----------

def test_invite_link_grants_trial_defaults_false(db_session):
    """新建链接默认不发试用——上线当天存量合作链接不能突然开始送 PRO。
    New links must default to not granting: shipping day must not turn existing
    partner links into PRO dispensers."""
    link = _mk_link(db_session)
    db_session.refresh(link)
    assert bool(link.grants_trial) is False


@pytest.fixture()
def legacy_invite_engine(monkeypatch, tmp_path):
    """本次上线**之前**的旧库：全表结构，但 invite_links 没有 grants_trial。

    与同文件的 legacy_engine 同一套路：create_all 建全表再把列删掉，而不是手写
    一份精简 DDL——旧库与今天的差别只有这一列，手写的表会随模型演进而失真。
    grants_trial 没有 index=True，SQLite 的 DROP COLUMN 不会被索引占用挡住。

    The database as it was before this feature: full schema minus
    invite_links.grants_trial. Same approach as legacy_engine above.
    """
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy_invite.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE invite_links DROP COLUMN grants_trial"))

    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    yield eng
    eng.dispose()


def _invite_columns(eng):
    return {c["name"] for c in inspect(eng).get_columns("invite_links")}


def test_migration_adds_grants_trial_and_backfills_false(legacy_invite_engine):
    """旧库必须补上列，且存量行回填为 False（不是 NULL）。

    回填是关键：NULL 在 Python 侧是 falsy，看着"没问题"，但管理页的开关会渲染成
    未定态、审计快照会记成 null。一次性回填掉，读取处的 bool() 只是二重保险。

    The column must be added and pre-existing rows backfilled to False, not left
    NULL: NULL is falsy in Python so it looks fine, but the admin toggle renders
    indeterminate and audit snapshots record null.
    """
    with legacy_invite_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO invite_links (id, code, label, clicks, is_active) "
            "VALUES ('old-1', 'legacy12', '存量渠道', 7, 1)"
        ))
    assert "grants_trial" not in _invite_columns(legacy_invite_engine), "fixture 没造出缺列的旧库"

    db_mod._migrate_columns()

    assert "grants_trial" in _invite_columns(legacy_invite_engine), "迁移没有补上 grants_trial"
    with legacy_invite_engine.connect() as conn:
        val = conn.execute(text("SELECT grants_trial FROM invite_links WHERE id = 'old-1'")).scalar()
    assert val in (0, False), f"存量行没有回填成 False，实际是 {val!r}"
    # 跑完才会记版本号；记上了说明整段迁移跑通了，不是中途抛异常。
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_grants_trial_migration_is_idempotent(legacy_invite_engine):
    """把版本号调小强制重跑：列已存在也不能报错。"""
    db_mod._migrate_columns()
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)
    db_mod._migrate_columns()   # 不该抛 / must not raise
    assert "grants_trial" in _invite_columns(legacy_invite_engine)


# ---------- 注册自动开通试用 ----------

def _set_trial(db, *, enabled: bool, days: int = 7):
    """写全局试用设置并清缓存。

    get_trial_settings 带 TTL 的模块级缓存，不清的话前一个用例的设置会漏进下
    一个，而且是随机漏（看 TTL），排查起来极难。照 admin.update_trial 的顺序：
    save → commit → invalidate。
    Write the global trial settings and drop the cache. get_trial_settings has a
    module-level TTL cache; without this, settings leak between tests
    intermittently. Same order as admin.update_trial: save, commit, invalidate.
    """
    save_trial_settings(db, {"trial_enabled": enabled, "trial_days": days})
    db.commit()
    invalidate_trial_cache()


def test_apply_invite_grants_trial_when_link_and_global_on(db_session):
    """链接开 + 全局开 → 注册即 PRO，且四个试用字段一致。"""
    _set_trial(db_session, enabled=True, days=14)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    user = _mk_user(db_session)

    granted = apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)

    assert granted == 14
    assert user.plan == "PRO"
    assert user.plan_is_trial is True
    assert user.trial_used_at is not None
    assert user.plan_expires_at is not None
    # 到期时间约等于 now + 14 天（容忍执行耗时）
    delta = user.plan_expires_at.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)
    assert timedelta(days=13, hours=23) < delta <= timedelta(days=14)
    # 归因照旧写 / attribution still written
    assert user.invite_code == link.code
    assert user.plan_note == "测试渠道"


def test_apply_invite_no_trial_when_link_off(db_session):
    """全局开着但链接没开 → 保持 FREE，只写归因。"""
    _set_trial(db_session, enabled=True, days=7)
    link = _mk_link(db_session)          # grants_trial 默认 False
    user = _mk_user(db_session)

    granted = apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)

    assert granted is None
    assert user.plan == "FREE"
    assert user.trial_used_at is None
    assert user.invite_code == link.code   # 归因不受影响


def test_apply_invite_no_trial_when_global_off(db_session):
    """链接开着但全局总闸关 → 一律不发。这是本功能唯一的紧急刹车。
    The global switch is the master gate and the feature's only kill switch."""
    _set_trial(db_session, enabled=False, days=7)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    user = _mk_user(db_session)

    granted = apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)

    assert granted is None
    assert user.plan == "FREE"
    assert user.trial_used_at is None


def test_apply_invite_inactive_link_grants_nothing(db_session):
    """已停用的链接：既不归因也不发试用，即便它的 grants_trial 是开的。
    A disabled link attributes nothing and grants nothing, even with the
    per-link switch left on — is_active is checked first."""
    _set_trial(db_session, enabled=True, days=7)
    link = _mk_link(db_session, active=False)
    link.grants_trial = True
    db_session.commit()
    user = _mk_user(db_session)

    granted = apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)

    assert granted is None
    assert user.plan == "FREE"
    assert user.invite_code is None


def test_apply_invite_grant_consumes_lifetime_trial(db_session):
    """自动领取消耗的是同一份终身一次的资格：领过之后 /payments/trial 的三条
    资格条件（开关开、从未用过、当前 FREE）里后两条都不再成立。
    The auto-grant consumes the same lifetime-once credential: afterwards the
    upgrade page's eligibility check fails on both trial_used_at and plan."""
    _set_trial(db_session, enabled=True, days=7)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    user = _mk_user(db_session)

    apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)

    eligible = user.trial_used_at is None and user.plan == "FREE"
    assert eligible is False


def test_apply_invite_existing_user_gets_no_trial(db_session):
    """google_login 是查找或创建二合一：对已存在的用户调用必须完全是空操作，
    尤其不能补发试用——老用户带着 30 天内的残留 ref 回来登录是常态，那会变成
    「每次换个 ref 登录一次就续一次 PRO」。
    google_login is find-or-create; on an existing user this must stay a total
    no-op. Granting here would mean a returning user with a stale ref renews
    PRO on every login."""
    _set_trial(db_session, enabled=True, days=7)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    user = _mk_user(db_session, plan_note="管理员手写备注", invite_code="already12")

    granted = apply_invite(db_session, user, link.code)

    assert granted is None
    assert user.plan == "FREE"
    assert user.trial_used_at is None
    assert user.plan_note == "管理员手写备注"


def test_invite_trial_audit_row_has_user_id(db_session):
    """自动开通必须留下一条审计行，且 target_user_id 非空。

    User.id 是模型上 Column(default=_uuid) 的 Python 侧默认值，**flush 时才生
    成**；会话是 autoflush=False。而 apply_invite 的调用点在 db.add(user) 之
    前，此刻 user.id 还是 None，直接拿去构造 AdminAuditLog 会写出一条外键为空
    的行——在 Postgres 上那是 NOT NULL 外键，直接违约，整个注册请求 500。
    这与 create_invite_link 里显式传 is_active=True 规避的是同一类坑。
    正确顺序是 add → flush（让 id 落定）→ 写审计 → commit，仍是一个事务。

    The grant must leave an audit row whose target_user_id is populated.
    User.id is a Python-side default applied at flush, and the session is
    autoflush=False, so at apply_invite's call site (before db.add) it is still
    None. Building the audit row there yields a null FK — a NOT NULL foreign key
    on Postgres, i.e. a 500 on the whole registration. Same family of trap as
    the explicit is_active=True in create_invite_link. Correct order:
    add, flush, audit, commit — still one transaction.
    """
    _set_trial(db_session, enabled=True, days=7)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()

    # 复刻 auth.register 的顺序：apply_invite → add → flush → 写审计 → commit
    user = User(email="new@example.com", password_hash="x", api_token="tok-new")
    granted = apply_invite(db_session, user, link.code)
    db_session.add(user)
    assert granted == 7
    db_session.flush()
    assert user.id is not None, "flush 之后 user.id 必须已生成"

    db_session.add(AdminAuditLog(
        admin_user_id=user.id,
        target_user_id=user.id,
        field="plan:invite_trial",
        old_value="FREE",
        new_value=f"PRO({granted}d)",
    ))
    db_session.commit()

    row = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == "plan:invite_trial"
    ).one()
    assert row.target_user_id == user.id
    assert row.new_value == "PRO(7d)"


def test_user_id_is_none_before_flush(db_session):
    """把上面那条注释里的前提钉死：db.add 之后、flush 之前 id 仍是 None。
    这个断言就是整个 flush 步骤存在的理由；哪天 SQLAlchemy 改了行为，先在这里
    亮红灯，而不是在生产的注册接口上。
    Pins the premise behind the flush: id is still None after add. If this ever
    changes, it fails here rather than in production registration."""
    user = User(email="pending@example.com", password_hash="x", api_token="tok-pending")
    db_session.add(user)
    assert user.id is None


# ---------- 公开 offer 查询 ----------
#
# 打的是 offer_days 服务函数，不是 offer 路由：路由挂了限流装饰器，slowapi 要求
# request 是真的 Request 实例，本套件没有 TestClient 造不出来。与既有用例只测
# record_click、不测 click 是同一个理由。路由是无条件包一层 {"trialDays": ...}
# 的薄壳，所以这里成立的性质对端点同样成立。
# These target the offer_days service function, not the offer route: the route
# carries the rate-limit decorator and slowapi requires a genuine Request, which
# this TestClient-free suite cannot produce. Same reason the existing cases test
# record_click and never click. The route is an unconditional thin wrapper, so
# every property proven here holds for the endpoint too.

def test_offer_returns_days_for_granting_link(db_session):
    _set_trial(db_session, enabled=True, days=14)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    assert offer_days(db_session, link.code) == 14


def test_offer_hides_non_granting_links_behind_same_answer(db_session):
    """不存在的码、已停用的码、没开送试用的码——三者的回答必须**逐字相同**。

    这是本端点唯一的安全性质：/invite/click 一律 204 不给任何 code 存活信号，
    本端点是对那条原则的有意放宽，放宽的边界就在这里。三者同答意味着现有那些
    不发试用的合作链接仍然完全不可探测；能被探出来的只有正在对外宣传送礼的那
    批码，而那本来就是主动广而告之的。这条断言一旦被改松，泄露的是合作方名单
    的存在性。
    Unknown, disabled, and non-granting codes must answer *identically*. That is
    the entire security property of this endpoint: it is a deliberate relaxation
    of click's always-204 no-oracle rule, and this is where the relaxation
    stops. Existing non-granting partner links stay unprobeable; only codes we
    are actively advertising become detectable. Loosening this assertion leaks
    the existence of the partner list.
    """
    _set_trial(db_session, enabled=True, days=7)
    _mk_link(db_session, code="plainlnk")                      # 存在但没开送试用
    disabled = _mk_link(db_session, code="offlink1", active=False)
    disabled.grants_trial = True
    db_session.commit()

    unknown = offer_days(db_session, "nosuch12")
    plain = offer_days(db_session, "plainlnk")
    off = offer_days(db_session, "offlink1")
    assert unknown is None and plain is None and off is None


def test_offer_returns_null_when_global_trial_off(db_session):
    """全局总闸关 → 即便链接开着也回 None，与发放路径同一个判定。"""
    _set_trial(db_session, enabled=False, days=7)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    assert offer_days(db_session, link.code) is None


def test_offer_normalizes_case_and_whitespace(db_session):
    """大写/带空白的 code 照样命中，与 record_click / apply_invite 同一处理。
    不做归一的话，经过大小写归一的二维码或手抄的码会静默查不到，而端点一律
    200，丢了不会报警。"""
    _set_trial(db_session, enabled=True, days=7)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()
    assert offer_days(db_session, f"  {link.code.upper()}  ") == 7


def test_trial_grant_days_treats_non_positive_days_as_no_grant(db_session):
    """trial_days<=0 时 _trial_grant_days 必须返回 None，不能是 0。

    管理端 schema 把 trial_days 下限设成 ge=1，走 API 永远到不了这里；这条测
    试模拟的是 platform_settings 被手改成 0（或负数）的情形。真让 0 流出这个
    函数：apply_invite 会把 plan_expires_at 设成"现在"、燃掉用户唯一一次试用
    机会，auth.py 的 `if granted_days` 因为 0 是假值而不写审计行，offer 端点
    与两处前端的 `if (r.trialDays)` 也都把 0 当"没有活动"。三个消费方全都不
    认 0，只有这一处判定函数曾经认，现在把它堵在源头。

    _trial_grant_days must return None, not 0, when trial_days<=0. The admin
    schema bounds trial_days at ge=1 so this is unreachable via the API; this
    test simulates a hand-edited platform_settings row. Letting 0 escape this
    function would make apply_invite set plan_expires_at to "now" and burn the
    user's one-time trial, auth.py's `if granted_days` would skip the audit row
    because 0 is falsy, and both the offer endpoint's callers and the two
    frontends' `if (r.trialDays)` would read it as no offer. None of the three
    consumers accept 0 — only this function used to, so the guard belongs here.
    """
    _set_trial(db_session, enabled=True, days=0)
    link = _mk_link(db_session)
    link.grants_trial = True
    db_session.commit()

    assert _trial_grant_days(db_session, link) is None
    assert offer_days(db_session, link.code) is None

    user = _mk_user(db_session)
    granted = apply_invite(db_session, user, link.code)
    db_session.commit()
    db_session.refresh(user)

    assert granted is None
    assert user.plan == "FREE"
    assert user.trial_used_at is None
    assert user.invite_code == link.code   # 归因不受影响，只是不发试用


# ---------- 管理端开关 ----------

def test_create_invite_link_defaults_grants_trial_false_in_audit(db_session):
    """新建链接的审计快照必须记成 grantsTrial: false，不能是 null。

    与同文件 is_active 那个用例同一个坑：模型上的 Column(default=False) 是
    flush 时才应用的 Python 侧默认值，而会话是 autoflush=False，_audit_value
    在 db.add() 之后立刻读属性拿到的是 None。所以 create_invite_link 必须显式
    传 grants_trial=False。「这条链接建的时候到底送不送」正是审计要回答的问题。
    Same trap as the is_active case above: the column default is applied at
    flush, the session is autoflush=False, so _audit_value reads None unless the
    value is passed explicitly. Whether a link granted PRO at creation time is
    exactly what the audit log exists to answer.
    """
    admin = _mk_user(db_session, email="admin2@example.com", role="admin")
    created = create_invite_link(InviteLinkCreate(label="渠道乙"), db=db_session, admin=admin)
    assert created.grantsTrial is False

    row = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"invite:{created.code}"
    ).one()
    assert json.loads(row.new_value)["grantsTrial"] is False


def test_update_invite_link_toggles_grants_trial(db_session):
    from app.routers.invite import update_invite_link
    from app.schemas import InviteLinkUpdate

    admin = _mk_user(db_session, email="admin3@example.com", role="admin")
    link = _mk_link(db_session)

    updated = update_invite_link(
        link.id, InviteLinkUpdate(grantsTrial=True), db=db_session, admin=admin
    )
    assert updated.grantsTrial is True
    db_session.refresh(link)
    assert bool(link.grants_trial) is True

    updated = update_invite_link(
        link.id, InviteLinkUpdate(grantsTrial=False), db=db_session, admin=admin
    )
    assert updated.grantsTrial is False


def test_update_invite_link_patch_does_not_clobber_other_fields(db_session):
    """只传 grantsTrial 时，label 与 isActive 必须原样不动（exclude_unset 语义）。
    A patch that carries only grantsTrial must leave label and isActive alone."""
    from app.routers.invite import update_invite_link
    from app.schemas import InviteLinkUpdate

    admin = _mk_user(db_session, email="admin4@example.com", role="admin")
    link = _mk_link(db_session, label="原标记名")

    updated = update_invite_link(
        link.id, InviteLinkUpdate(grantsTrial=True), db=db_session, admin=admin
    )
    assert updated.label == "原标记名"
    assert updated.isActive is True
