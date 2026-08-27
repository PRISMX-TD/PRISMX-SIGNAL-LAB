"""rev 6 迁移：closed_trades 补 verified 列 + 去重键换成 (user, login, deal)。

SQLite 把表级 UNIQUE 实现成匿名自动索引，没法单独 DROP，所以这条迁移是**整表
重建**——数据搬运、旧表删除都在一个事务里。表重建是所有迁移里最容易悄悄丢数据
的一种，所以这里在一个"长得和上线前一模一样"的旧库上真跑一遍：验列在、旧键没
了、新键生效、每一行数据原样还在。

Migration test for rev 6. Rebuilding a table is the migration shape most likely
to silently lose rows, so this runs the real migration against a database built
with the pre-migration schema and asserts the column exists, the old key is
gone, the new key is enforced, and every row survived intact.
"""
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod


# 上线前的 closed_trades 定义：没有 verified，唯一键是 (user_id, deal_ticket)。
# 手抄一遍是**故意的**——它必须锚定"迁移前长什么样"这个历史事实，不能跟着
# 模型一起漂移，否则这个测试就验不到真正的升级路径了。
_LEGACY_DDL = """
CREATE TABLE closed_trades (
    id VARCHAR NOT NULL,
    user_id VARCHAR NOT NULL,
    mt5_login VARCHAR NOT NULL,
    symbol VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    close_volume FLOAT NOT NULL,
    close_price FLOAT NOT NULL,
    profit FLOAT NOT NULL,
    position_ticket INTEGER NOT NULL,
    deal_ticket INTEGER NOT NULL,
    closed_at DATETIME NOT NULL,
    created_at DATETIME,
    PRIMARY KEY (id),
    CONSTRAINT uq_user_deal_ticket UNIQUE (user_id, deal_ticket)
)
"""


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    """建一个"迁移前"的库：全表结构，但 closed_trades 换成旧定义。"""
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})

    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型

    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE closed_trades"))
        conn.execute(text(_LEGACY_DDL))

    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    try:
        yield eng
    finally:
        eng.dispose()


def _seed(eng, rows):
    now = datetime.now(timezone.utc).isoformat(sep=" ")
    with eng.begin() as conn:
        for r in rows:
            conn.execute(
                text(
                    "INSERT INTO closed_trades (id, user_id, mt5_login, symbol, side, "
                    "close_volume, close_price, profit, position_ticket, deal_ticket, closed_at) "
                    "VALUES (:id, :u, :l, 'XAUUSD', 'BUY', 1.0, 2000.0, :p, :pt, :dt, :ts)"
                ),
                {"id": r["id"], "u": r["u"], "l": r["l"], "p": r["p"], "pt": r["pt"], "dt": r["dt"], "ts": now},
            )


def test_rev6_rebuild_keeps_every_row_and_swaps_the_key(legacy_engine):
    _seed(legacy_engine, [
        {"id": "a", "u": "u1", "l": "500001", "p": 10.0, "pt": 111, "dt": 9001},
        {"id": "b", "u": "u1", "l": "500001", "p": -5.0, "pt": 112, "dt": 9002},
        {"id": "c", "u": "u2", "l": "600001", "p": 3.0, "pt": 113, "dt": 9001},  # 跨用户同号，旧键也允许
    ])

    db_mod._migrate_columns()

    insp = inspect(legacy_engine)
    cols = {c["name"] for c in insp.get_columns("closed_trades")}
    assert "verified" in cols, "verified 列没补上"

    # SQLite 的表级 UNIQUE 是匿名自动索引，只有 get_unique_constraints 看得见；
    # 两处都收集，兼容"迁移建的是显式唯一索引"这种形态。
    uniques = [set(uc["column_names"]) for uc in insp.get_unique_constraints("closed_trades")]
    uniques += [set(i["column_names"]) for i in insp.get_indexes("closed_trades") if i.get("unique")]
    assert {"user_id", "mt5_login", "deal_ticket"} in uniques, "新去重键没建起来"
    assert {"user_id", "deal_ticket"} not in uniques, "旧去重键还在，跨券商撞号仍会丢数据"

    with legacy_engine.connect() as conn:
        got = conn.execute(
            text("SELECT id, user_id, mt5_login, profit, deal_ticket, verified "
                 "FROM closed_trades ORDER BY id")
        ).all()
    assert [(r[0], r[1], r[2], r[3], r[4]) for r in got] == [
        ("a", "u1", "500001", 10.0, 9001),
        ("b", "u1", "500001", -5.0, 9002),
        ("c", "u2", "600001", 3.0, 9001),
    ], "重建后数据对不上"
    assert all(r[5] is None for r in got), "历史行的 verified 应保持 NULL（无从判定）"
    # 旧表必须已经删掉，不留残骸
    assert "closed_trades_legacy" not in insp.get_table_names()


def test_rev6_lets_two_brokers_share_a_deal_ticket(legacy_engine):
    """迁移后：同一用户、两个账号、同一个成交编号，两行都要存得下。

    这正是旧键丢数据的场景——第二行会撞 (user_id, deal_ticket) 被当成重复上报。
    """
    _seed(legacy_engine, [{"id": "a", "u": "u1", "l": "500001", "p": 10.0, "pt": 111, "dt": 9001}])
    db_mod._migrate_columns()

    _seed(legacy_engine, [{"id": "b", "u": "u1", "l": "700002", "p": 20.0, "pt": 222, "dt": 9001}])

    with legacy_engine.connect() as conn:
        n = conn.execute(text("SELECT COUNT(*) FROM closed_trades WHERE deal_ticket = 9001")).scalar()
    assert n == 2, "跨账号同号的两笔成交应各自入库"


def test_rev6_is_idempotent(legacy_engine):
    """重复跑不炸、不丢数据（迁移随时可能被重跑）。"""
    _seed(legacy_engine, [{"id": "a", "u": "u1", "l": "500001", "p": 10.0, "pt": 111, "dt": 9001}])

    db_mod._migrate_columns()
    db_mod._write_schema_rev(0)  # 强制第二次走完整迁移
    db_mod._migrate_columns()

    with legacy_engine.connect() as conn:
        n = conn.execute(text("SELECT COUNT(*) FROM closed_trades")).scalar()
    assert n == 1
