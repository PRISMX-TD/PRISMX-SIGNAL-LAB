"""rev 50 迁移：链接主人从 invite_link_agents 搬进 invite_links、软删链接丢的主人从审计找回、
普通客户的归属 = 来源链接的主人、体检（补节点、重算层级）。照 rev 47 的测试用文件库换 engine。
"""
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    from app.core.database import Base
    import app.models  # noqa: F401
    Base.metadata.create_all(eng)
    from app.models import User
    session = sessionmaker(bind=eng)()
    # A：一级代理（链接 la）；B：二级（链接 lb）；Z：一级代理，链接 lz 在 rev 50 前被软删。
    # c_a / c_b / c_z：三人各自的客户；p：平台链接的客户；B 本人经 la 注册。
    users = {
        "A": None, "B": "la000000", "Z": None,
        "c_a": "la000000", "c_b": "lb000000", "c_z": "lz000000", "p": "pl000000",
    }
    session.add_all([
        User(id=uid, email=f"{uid}@t.co", api_token=f"tok-{uid}", invite_code=code) for uid, code in users.items()
    ])
    session.commit()
    session.close()
    with eng.begin() as conn:
        for lid, code, deleted in (("la", "la000000", None), ("lb", "lb000000", None),
                                   ("lz", "lz000000", "2026-10-01 00:00:00"), ("pl", "pl000000", None)):
            conn.execute(text(
                "INSERT INTO invite_links (id, code, label, clicks, is_active, deleted_at) "
                "VALUES (:id, :c, :c, 0, 1, :d)"
            ), {"id": lid, "c": code, "d": deleted})
        for rid, lid, uid in (("r1", "la", "A"), ("r2", "lb", "B")):
            conn.execute(text(
                "INSERT INTO invite_link_agents (id, link_id, user_id, created_at) "
                "VALUES (:id, :l, :u, CURRENT_TIMESTAMP)"
            ), {"id": rid, "l": lid, "u": uid})
        # B 的 depth 故意存错成 5，验证重算。/ B's depth is wrong on purpose.
        for nid, uid, parent, depth in (("n1", "A", None, 1), ("n2", "B", "A", 5), ("n3", "Z", None, 1)):
            conn.execute(text(
                "INSERT INTO agent_nodes (id, user_id, parent_user_id, depth) VALUES (:id, :u, :p, :d)"
            ), {"id": nid, "u": uid, "p": parent, "d": depth})
        # lz 软删时代理行被删了，只剩审计里那一条「assigned」。
        conn.execute(text(
            "INSERT INTO admin_audit_logs (id, admin_user_id, target_user_id, field, old_value, new_value, created_at) "
            "VALUES ('au1', 'A', 'Z', 'invite:lz000000:agent', '', 'assigned', CURRENT_TIMESTAMP)"
        ))
    monkeypatch.setattr(db_mod, "engine", eng)
    return eng


def test_backfills_owners_customers_and_repairs_the_tree(legacy_engine):
    db_mod._migrate_agent_attribution_rev50()
    db_mod._migrate_agent_attribution_rev50()  # 幂等 / idempotent
    with legacy_engine.connect() as conn:
        owners = dict(conn.execute(text("SELECT id, owner_user_id FROM invite_links")).fetchall())
        agent_of = dict(conn.execute(text("SELECT id, agent_user_id FROM users")).fetchall())
        depth = dict(conn.execute(text("SELECT user_id, depth FROM agent_nodes")).fetchall())
    assert owners == {"la": "A", "lb": "B", "lz": "Z", "pl": None}
    # 客户归来源链接的主人（含软删链接找回的 Z）；代理本人不回填；平台客户留空。
    assert agent_of["c_a"] == "A" and agent_of["c_b"] == "B" and agent_of["c_z"] == "Z"
    assert agent_of["p"] is None and agent_of["B"] is None
    assert depth == {"A": 1, "B": 2, "Z": 1}


def test_owner_without_a_node_gets_a_top_level_one(legacy_engine):
    with legacy_engine.begin() as conn:
        conn.execute(text("DELETE FROM agent_nodes WHERE user_id = 'A'"))
    db_mod._migrate_agent_attribution_rev50()
    with legacy_engine.connect() as conn:
        nodes = dict(conn.execute(text("SELECT user_id, parent_user_id FROM agent_nodes")).fetchall())
    # A 补成一级；B 的上级 A 当时不在，按「父节点不存在」改成一级（只告警，不挡启动）。
    assert nodes["A"] is None and "B" in nodes
