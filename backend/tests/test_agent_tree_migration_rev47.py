"""rev 47 代理层级迁移：存量代理回填一级节点、链接唯一代理索引；有重复时跳过索引而不是挡启动。

照 test_badge_migration_rev16.py 的做法用文件库，并把 engine 换掉。
"""
import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    from app.core.database import Base
    import app.models  # noqa: F401
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        # 退回 rev 46：没有链接唯一索引。/ Back to rev 46: no one-agent-per-link index.
        conn.execute(text("DROP INDEX uq_invite_link_agents_link"))
    # users 的 NOT NULL 默认值在 ORM 上，走 ORM 建行（同 rev 16 的测试）。
    # users' NOT NULL defaults live on the ORM, so build them through it.
    from app.models import User
    session = sessionmaker(bind=eng)()
    session.add_all([User(id=uid, email=f"{uid}@t.co", api_token=f"tok-{uid}") for uid in ("u1", "u2")])
    session.commit()
    session.close()
    with eng.begin() as conn:
        for lid, code in (("l1", "code1111"), ("l2", "code2222")):
            conn.execute(text(
                "INSERT INTO invite_links (id, code, label, clicks, is_active) VALUES (:id, :c, :c, 0, 1)"
            ), {"id": lid, "c": code})
    monkeypatch.setattr(db_mod, "engine", eng)
    return eng


def _agent(eng, rid, link_id, user_id):
    with eng.begin() as conn:
        conn.execute(text(
            "INSERT INTO invite_link_agents (id, link_id, user_id) VALUES (:id, :l, :u)"
        ), {"id": rid, "l": link_id, "u": user_id})


def _index_names(eng):
    return {i["name"] for i in inspect(eng).get_indexes("invite_link_agents")}


def test_backfills_top_level_nodes_and_builds_the_index(legacy_engine):
    _agent(legacy_engine, "a1", "l1", "u1")
    _agent(legacy_engine, "a2", "l2", "u1")
    db_mod._migrate_agent_tree_rev47()
    db_mod._migrate_agent_tree_rev47()  # 幂等 / idempotent
    with legacy_engine.connect() as conn:
        nodes = conn.execute(text("SELECT user_id, parent_user_id, depth FROM agent_nodes")).fetchall()
    assert nodes == [("u1", None, 1)]
    assert "uq_invite_link_agents_link" in _index_names(legacy_engine)


def test_duplicate_agents_skip_the_index_without_failing(legacy_engine):
    _agent(legacy_engine, "a1", "l1", "u1")
    _agent(legacy_engine, "a2", "l1", "u2")
    db_mod._migrate_agent_tree_rev47()
    assert "uq_invite_link_agents_link" not in _index_names(legacy_engine)
    with legacy_engine.connect() as conn:
        users = {r[0] for r in conn.execute(text("SELECT user_id FROM agent_nodes"))}
    assert users == {"u1", "u2"}
