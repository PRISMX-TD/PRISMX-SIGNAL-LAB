"""rev 16 勋章改制迁移的回归测试：旧的 17 枚 id 并成"新 id + 档位"。

**为什么要测。** 这次迁移改的是已发出去的荣誉：并错档（金并成铜）、同一人两枚
旧勋章并进同一新 id 时撞唯一约束、佩戴列表里留着已删除的纪律勋章 id、纪律
快照表没删干净——每一种都不会报错，只会让某个用户的成就页悄悄变样。这里造一个
真正的 rev 15 旧库（user_badges 没有 tier 列、还有 discipline_snapshots 表），跑真迁移。

照 test_schema_rev.py 的做法用文件库（_read/_write_schema_rev 各开各的连接，
:memory: 每次连接都是新的空库），并把 SessionLocal 一并换掉。
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
        # 退回 rev 15 的样子：没有 tier 列、纪律快照表还在、后台还存着纪律参数
        conn.execute(text("ALTER TABLE user_badges DROP COLUMN tier"))
        conn.execute(text(
            "CREATE TABLE discipline_snapshots (id VARCHAR PRIMARY KEY, user_id VARCHAR, "
            "login VARCHAR, date VARCHAR, total FLOAT, positions INTEGER)"))
        conn.execute(text("INSERT INTO platform_settings (id, key, value) VALUES ('ps-d', 'discipline', '{}')"))
        conn.execute(text("INSERT INTO platform_settings (id, key, value) VALUES ('ps-r', 'schema_rev', '15')"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    return eng


def _seed(eng):
    # users 表的 NOT NULL 默认值（role / plan 等）都在 ORM 上，走 ORM 建行；
    # 勋章行故意用裸 SQL——旧库里没有 tier 列，ORM 会带上它。
    # users' NOT NULL defaults (role / plan ...) live on the ORM, so build those rows
    # through it; badge rows use raw SQL on purpose — the legacy table has no tier column.
    from app.models import User
    session = sessionmaker(bind=eng)()
    session.add_all([
        User(id="u1", email="a@t.co", api_token="t1", equipped_badge="first_close",
             equipped_badges="first_close,discipline_90_7,comp_winner"),
        User(id="u2", email="b@t.co", api_token="t2", equipped_badge="no_bad_sl_50",
             equipped_badges="no_bad_sl_50"),
        User(id="u3", email="c@t.co", api_token="t3"),
    ])
    session.commit(); session.close()
    with eng.begin() as conn:
        rows = [
            ("r1", "u1", "profile_complete"), ("r2", "u1", "first_close"), ("r3", "u1", "first_real_trade"),
            ("r4", "u1", "discipline_90_7"), ("r5", "u1", "comp_finisher"), ("r6", "u1", "comp_winner"),
            ("r7", "u1", "comp_back_to_back"),
            ("r8", "u2", "no_bad_sl_50"), ("r9", "u2", "evergreen_6m"), ("r10", "u2", "founder_2026"),
        ]
        for rid, uid, bid in rows:
            conn.execute(text("INSERT INTO user_badges (id, user_id, badge_id) VALUES (:i, :u, :b)"),
                         {"i": rid, "u": uid, "b": bid})


def test_rev16_folds_legacy_badges_into_tiers(legacy_engine):
    _seed(legacy_engine)
    db_mod._migrate_columns()

    insp = inspect(legacy_engine)
    assert "tier" in {c["name"] for c in insp.get_columns("user_badges")}
    assert "discipline_snapshots" not in insp.get_table_names()
    with legacy_engine.connect() as conn:
        badges = {(u, b): t for u, b, t in conn.execute(
            text("SELECT user_id, badge_id, tier FROM user_badges")).fetchall()}
        users = {u: (s, m) for u, s, m in conn.execute(
            text("SELECT id, equipped_badge, equipped_badges FROM users")).fetchall()}
        settings = {k for (k,) in conn.execute(text("SELECT key FROM platform_settings")).fetchall()}

    # u1：起步三枚并成一行取最高档；赛场完赛 + 冠军并成金；卫冕王原样；纪律的删了
    assert badges == {
        ("u1", "starter"): 3, ("u1", "arena"): 3, ("u1", "comp_back_to_back"): 0,
        ("u2", "evergreen"): 2, ("u2", "founder_2026"): 0,
    }
    # 佩戴列表改写：旧 id 映射、纪律的剔除、重复的合并；全是纪律的清空
    assert users["u1"] == ("starter", "starter,arena")
    assert users["u2"] == (None, "")
    assert users["u3"] == (None, None)
    assert "discipline" not in settings
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_rev16_is_idempotent_on_a_migrated_db(legacy_engine):
    _seed(legacy_engine)
    db_mod._migrate_columns()
    with legacy_engine.connect() as conn:
        before = sorted(conn.execute(text("SELECT user_id, badge_id, tier FROM user_badges")).fetchall())
    # 再跑一遍：tier 列已在，整块跳过，不会把 starter 再当旧 id 处理
    db_mod._migrate_columns()
    with legacy_engine.connect() as conn:
        after = sorted(conn.execute(text("SELECT user_id, badge_id, tier FROM user_badges")).fetchall())
    assert before == after
