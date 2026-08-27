"""rev 9 迁移：mt5_accounts 补 pass_change_at / revoked_at / revoked_reason。

**为什么单独测这条。** 这三列不是普通的新字段，它们是 gateway 绑定撤销的判据，
而判据的默认值一旦搞错，方向是灾难性的：

  · pass_change_at 若被回填成任何非 NULL 的值，等于宣布"这些历史绑定的密码从没
    变过"——而它们恰恰是在完全没有校验的年代绑上来的。
  · revoked_at 若不是 NULL，全站 gateway 账号会在升级那一刻集体掉线。

所以这里在一个"迁移前长什么样"的旧库上真跑一遍，并且**带着数据**跑：验列补上了、
每一行原样还在、三列全部是 NULL。旧表定义手抄一份是故意的，它要锚定历史事实，
不能跟着模型漂移。

顺带钉住版本号：迁移块是靠 CURRENT_SCHEMA_REV 的快速通道决定跑不跑的，忘了 +1
的话这段在已有的生产库上一次都不会执行，而本地新建的库因为 create_all 直接就有
这三列，测试和开发机全都看不出问题——正是那种只在生产爆的错。

Migration test for rev 9. These three columns are the revocation rule's inputs,
and a wrong default is catastrophic in either direction: a backfilled
pass_change_at asserts "this binding's password never changed" about rows created
when nothing was ever checked, and a non-NULL revoked_at disconnects every
gateway account at once. Runs the real migration against a pre-migration schema
with data in it. Also pins the revision bump: without it the block never runs on
an existing production database, while a freshly created local database has the
columns from create_all — the failure mode that only appears in production.
"""
import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod


# 上线前的 mt5_accounts 定义：没有那三列。手抄是故意的（见模块说明）。
_LEGACY_DDL = """
CREATE TABLE mt5_accounts (
    id VARCHAR NOT NULL,
    user_id VARCHAR NOT NULL,
    login VARCHAR NOT NULL,
    server VARCHAR,
    source VARCHAR,
    account_name VARCHAR,
    account_currency VARCHAR,
    balance FLOAT,
    equity FLOAT,
    leverage INTEGER,
    company VARCHAR,
    symbol_suffix VARCHAR,
    mt5_group VARCHAR,
    trade_mode INTEGER,
    online BOOLEAN,
    last_heartbeat DATETIME,
    PRIMARY KEY (id),
    CONSTRAINT uq_user_login_server UNIQUE (user_id, login, server)
)
"""

_NEW_COLUMNS = ("pass_change_at", "revoked_at", "revoked_reason")


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    """建一个"迁移前"的库：全表结构，但 mt5_accounts 换成旧定义。"""
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})

    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型

    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE mt5_accounts"))
        conn.execute(text(_LEGACY_DDL))

    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    try:
        yield eng
    finally:
        eng.dispose()


def test_rev9_adds_columns_without_touching_existing_bindings(legacy_engine):
    with legacy_engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO mt5_accounts (id, user_id, login, server, source, balance) "
                "VALUES ('a', 'u1', '601144', '', 'gateway', 100.0), "
                "       ('b', 'u2', '500001', 'X-Live', 'bridge', 50.0)"
            )
        )

    db_mod._migrate_columns()

    cols = {c["name"] for c in inspect(legacy_engine).get_columns("mt5_accounts")}
    for name in _NEW_COLUMNS:
        assert name in cols, f"{name} 列没补上"

    with legacy_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT id, login, balance, pass_change_at, revoked_at, revoked_reason "
                "FROM mt5_accounts ORDER BY id"
            )
        ).all()

    assert [(r[0], r[1], r[2]) for r in rows] == [
        ("a", "601144", 100.0),
        ("b", "500001", 50.0),
    ], "既有绑定被迁移改动了"

    # 三列全部为空：不回填任何基线，也不撤销任何人。这两条各自的理由见
    # database.py 里那段注释，方向都是"拿不到证据时不动手"。
    for r in rows:
        assert r[3] is None, "pass_change_at 被回填了：等于宣布历史绑定的密码从没变过"
        assert r[4] is None, "revoked_at 非空：升级会让全站 gateway 账号集体掉线"
        assert r[5] is None


def test_revision_was_bumped():
    """迁移块只在 schema_rev 落后时才跑；忘了 +1，这段在生产库上一次都不会执行。

    本地新建的库走 create_all，天生就有这三列，所以"忘记 bump"在开发机上完全
    看不出来——只在已经跑过一次迁移的生产库上爆。
    """
    assert db_mod.CURRENT_SCHEMA_REV >= 9
