"""closed_trades 重建迁移的回归测试。

钉的是一次真实的生产数据丢失（2026-08-27）：重建走「RENAME 旧表 → 用模型 DDL 建
新表 → 搬数据 → DROP 旧表」，而 SQLite 有两个特性让这套写法必然出事——

① **索引名是全库唯一的，`ALTER TABLE ... RENAME` 不重命名索引**：它们跟着改名后
   的表走、名字原样占着，紧接着建新表时模型声明的具名索引就撞名抛异常。
② **pysqlite 只在 DML 前隐式开事务，DDL 直接自动提交**：RENAME 与 CREATE TABLE
   在异常发生时早已落库，`engine.begin()` 的回滚撤不掉。

结果是第一次启动崩掉、closed_trades 变空表、数据全滞留在 closed_trades_legacy；
第二次启动反而"成功"（新表已是新键，整段被跳过）并写下 schema_rev，此后走快速
通道，那批行再也没被搬回来过——**全程没有一行报错日志指向数据丢失**。

所以这里不只测"迁移能跑通"，更要测**中断之后能不能把数据捞回来**，以及**捞回来
的表是不是真的带着新去重键**（那个键正是这次迁移存在的理由）。

Regression tests for the closed_trades rebuild migration.

Pins a real production data loss (2026-08-27). The rebuild ran "rename the old
table, create the new one from the model's DDL, copy, drop the old" — which two
SQLite behaviours make unsafe: index names are database-global and survive
`ALTER TABLE ... RENAME` attached to the renamed table (so creating the new
table collides with them), and pysqlite autocommits DDL, so the rename and
create are already durable when the error is raised and cannot be rolled back.

The first start therefore crashed with an emptied closed_trades and every row
stranded in closed_trades_legacy; the second start "succeeded" by skipping the
whole block and recorded the revision, after which the fast path meant the rows
were never recovered — with nothing in the logs pointing at data loss.

These cases therefore test recovery after an interruption, not merely that the
migration runs, and assert that the recovered table really carries the new dedup
key, which is the reason this migration exists at all.
"""
import sqlite3

import pytest
from sqlalchemy import create_engine, inspect, text


# 旧表的建表语句：旧去重键 (user_id, deal_ticket)，外加两个具名索引——正是它们
# 在 RENAME 之后占着名字、把重建撞停的。
#
# **列必须与模型一一对应、NOT NULL 也照抄**。少一列不是"简化"，是让样本失真到
# 测不出东西：搬数据那句 INSERT 会因为 NOT NULL 违例而失败，早先用 INSERT OR
# IGNORE 时更是一行都进不去却毫无声响——那恰好就是这次事故的失败方式，用一张
# 缺列的样本表反而会把它掩盖过去。
#
# The old schema: the narrow dedup key plus the two named indexes whose surviving
# names are what collided and halted the rebuild.
#
# **The columns must mirror the model exactly, NOT NULL included.** Dropping one
# is not a simplification but a fixture that cannot detect anything: the copy
# would fail on a NOT NULL violation, and under the earlier INSERT OR IGNORE not
# one row would land while nothing was reported — precisely this incident's
# failure mode, which a short fixture would hide rather than catch.
_LEGACY_DDL = """
CREATE TABLE closed_trades (
    id VARCHAR NOT NULL PRIMARY KEY,
    user_id VARCHAR NOT NULL,
    mt5_login VARCHAR NOT NULL,
    symbol VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    close_volume FLOAT NOT NULL,
    close_price FLOAT NOT NULL,
    profit FLOAT NOT NULL,
    position_ticket VARCHAR NOT NULL,
    deal_ticket VARCHAR NOT NULL,
    closed_at DATETIME NOT NULL,
    created_at DATETIME,
    UNIQUE (user_id, deal_ticket)
);
CREATE INDEX ix_closed_trades_user_id ON closed_trades (user_id);
CREATE INDEX idx_closed_trades_position ON closed_trades (user_id, mt5_login, position_ticket);
"""

# 一整行的值，顺序与上面的列一致。verified 列刻意不在旧表里（rev 6 才加），
# 用来确认搬数据时按"legacy 实有列 ∩ 模型列"取交集是对的。
# One full row, in the column order above. `verified` is deliberately absent from
# the old table (rev 6 added it), which is what proves the copy correctly
# intersects legacy's actual columns with the model's.
_LEGACY_COLS = (
    "id, user_id, mt5_login, symbol, side, close_volume, close_price, profit, "
    "position_ticket, deal_ticket, closed_at, created_at"
)


def _row(i: int) -> tuple:
    return (f"id{i}", "u1", "600144", "XAUUSD", "BUY", 0.1, 2000.0, 12.5,
            f"p{i}", f"t{i}", "2026-08-20 10:00:00", "2026-08-20 10:00:00")


def _rows(db_path: str, table: str = "closed_trades") -> int:
    con = sqlite3.connect(db_path)
    try:
        return con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        con.close()


def _unique_keys(db_path: str) -> set[tuple[str, ...]]:
    con = sqlite3.connect(db_path)
    try:
        out = set()
        for row in con.execute("PRAGMA index_list('closed_trades')"):
            if row[2]:  # unique
                cols = tuple(c[2] for c in con.execute(f'PRAGMA index_info("{row[1]}")'))
                out.add(cols)
        return out
    finally:
        con.close()


def _table_names(db_path: str) -> set[str]:
    con = sqlite3.connect(db_path)
    try:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        con.close()


@pytest.fixture()
def legacy_db(tmp_path, monkeypatch):
    """一个带旧去重键、装了 3 行数据的库，并把迁移模块指向它。
    A database on the old dedup key holding three rows, with the migration module
    pointed at it."""
    path = tmp_path / "legacy.db"
    con = sqlite3.connect(path)
    con.executescript(_LEGACY_DDL)
    ph = ",".join("?" * len(_LEGACY_COLS.split(",")))
    con.executemany(
        f"INSERT INTO closed_trades ({_LEGACY_COLS}) VALUES ({ph})",
        [_row(i) for i in range(3)],
    )
    con.commit()
    con.close()

    from app.core import database as db_mod

    engine = create_engine(f"sqlite:///{path}")
    monkeypatch.setattr(db_mod, "engine", engine)
    yield str(path)
    engine.dispose()


def _rebuild(db_path: str):
    from app.core.database import _rebuild_closed_trades_sqlite

    _rebuild_closed_trades_sqlite()


NEW_KEY = ("user_id", "mt5_login", "deal_ticket")


def test_rebuild_keeps_every_row_and_switches_the_key(legacy_db):
    """基本路径：一行不丢，去重键换成三列的新键，legacy 表清掉。
    The base path: no row lost, the key widens to three columns, legacy is gone."""
    _rebuild(legacy_db)

    assert _rows(legacy_db) == 3
    assert NEW_KEY in _unique_keys(legacy_db)
    assert "closed_trades_legacy" not in _table_names(legacy_db)


def test_rebuild_is_idempotent(legacy_db):
    """重复跑不会翻倍，也不会报错——重启会反复触发这条路径。
    Running it again neither duplicates rows nor raises; restarts re-enter here."""
    _rebuild(legacy_db)
    _rebuild(legacy_db)
    assert _rows(legacy_db) == 3


def test_recovers_rows_stranded_by_an_interrupted_rebuild(legacy_db):
    """**这条就是那次数据丢失**：模拟上一次重建死在「建索引」那步之后重入。

    半途状态由三件事构成，与线上完全一致：旧表已被改名成 legacy（索引跟着走）、
    新表已由模型 DDL 建出（所以它带着正确的新键）、数据一行都还没搬。

    The data loss itself: resume after a previous rebuild died at index creation.
    The half-finished state matches production exactly — the old table renamed to
    legacy (its indexes travelling with it), the new table already created from
    the model DDL (hence carrying the correct new key), and not one row copied.
    """
    from app.core.database import engine
    from app.models import ClosedTrade

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE closed_trades RENAME TO closed_trades_legacy"))
        # 名字被 legacy 上的同名索引占着，得先腾出来才建得成——这正是原实现漏掉的
        # 一步，也正是它抛异常的地方。
        # The names are still taken by legacy's indexes and must be freed first;
        # skipping this is precisely what the original implementation did, and
        # precisely where it raised.
        for name in ("ix_closed_trades_user_id", "idx_closed_trades_position"):
            conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
        ClosedTrade.__table__.create(bind=conn)

    assert _rows(legacy_db) == 0, "前置条件：新表此刻必须是空的"
    assert _rows(legacy_db, "closed_trades_legacy") == 3

    _rebuild(legacy_db)

    assert _rows(legacy_db) == 3, "滞留在 legacy 里的行没有被搬回来"
    assert "closed_trades_legacy" not in _table_names(legacy_db)
    assert NEW_KEY in _unique_keys(legacy_db)


def test_partially_copied_rebuild_resumes_without_duplicating(legacy_db):
    """搬了一半就中断：重入要补齐剩下的，且不能把已搬的再搬一遍。
    Interrupted mid-copy: a resume completes the rest without re-copying."""
    from app.core.database import engine
    from app.models import ClosedTrade

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE closed_trades RENAME TO closed_trades_legacy"))
        for name in ("ix_closed_trades_user_id", "idx_closed_trades_position"):
            conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
        ClosedTrade.__table__.create(bind=conn)
        conn.execute(text(
            f"INSERT INTO closed_trades ({_LEGACY_COLS}) "
            f"SELECT {_LEGACY_COLS} FROM closed_trades_legacy LIMIT 1"
        ))

    _rebuild(legacy_db)

    assert _rows(legacy_db) == 3
    assert "closed_trades_legacy" not in _table_names(legacy_db)


def test_keyless_leftover_table_is_rebuilt_not_merely_indexed(legacy_db):
    """人工抢修留下的**无去重键**空表要被识别并重建，不能只补索引就放过。

    去重键正是这次迁移存在的理由（旧键太窄，会把第二个券商账号的真实成交当重复
    丢掉）。放过一张没有键的表，等于让同一个静默丢单的 bug 从后门回来。

    A hand-repaired leftover table lacking the dedup key must be rebuilt, not just
    re-indexed: that key is the whole reason for this migration (the old one was
    narrow enough to drop a second broker account's genuine fills as duplicates),
    so letting a keyless table through would reintroduce the same silent loss.
    """
    from app.core.database import engine

    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE closed_trades RENAME TO closed_trades_legacy"))
        for name in ("ix_closed_trades_user_id", "idx_closed_trades_position"):
            conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
        # CREATE TABLE ... AS SELECT 建出来的表不带任何约束
        # A table from CREATE TABLE ... AS SELECT carries no constraints at all
        conn.execute(text(
            "CREATE TABLE closed_trades AS SELECT * FROM closed_trades_legacy WHERE 0"
        ))

    assert NEW_KEY not in _unique_keys(legacy_db), "前置条件：这张表此刻没有去重键"

    _rebuild(legacy_db)

    assert NEW_KEY in _unique_keys(legacy_db)
    assert _rows(legacy_db) == 3


def test_named_indexes_survive_the_rebuild(legacy_db):
    """重建后模型声明的具名索引必须都在——它们是后台扫描的性能依赖，
    悄悄少一个只会表现为"某个查询变慢"，不会报错。
    The model's named indexes must all exist afterwards: the background sweeps
    depend on them, and a missing one shows up only as a slow query, never an
    error."""
    _rebuild(legacy_db)

    insp = inspect(create_engine(f"sqlite:///{legacy_db}"))
    names = {i["name"] for i in insp.get_indexes("closed_trades")}
    assert "ix_closed_trades_user_id" in names
    assert "idx_closed_trades_position" in names
