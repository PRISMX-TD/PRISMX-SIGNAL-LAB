"""迁移里「建索引早于补列」这一类 bug 的回归测试。

_migrate_columns 通用索引块里曾经有一条 idx_strategy_signals_strategy_result，
而它依赖的 strategy_signals.result 是三百行之后才补上的。任何还没有这一列的库
跑到那里就会以 OperationalError: no such column: result 把整段迁移打断——迁移
在 uvicorn bind 端口之前同步跑，线上等价于服务器起不来。

这个 bug 在已经迁移过的库上永远复现不了：快速通道看到 schema_rev 就直接返回，
整块代码根本不执行。只有还原旧备份/旧快照再迁移时才炸。所以这里必须自己造一个
真正缺列的旧库，照 test_schema_rev.py 的 temp_engine 用文件库（_read/_write_
schema_rev 各开各的连接，:memory: 每次连接都是空库）。

（这个文件写于 backend/tests 还被 .gitignore 忽略的时期，一直留在一个已失效的
worktree 里从未提交。它验的正是"迁移中途报错 → 服务起不来"这一类事故，也正是
2026-08-27 把 backend/tests 纳入仓库的理由——只在一台机器上跑过的测试等于没跑。）

Regression tests for the "index created before its column" bug class in
_migrate_columns. See the module docstring above; the fast path makes this
undetectable on any already-migrated database, so the fixture builds one that is
genuinely missing the columns.
"""
import inspect as _pyinspect
import re

import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod

# 迁移自己补出来的列 + 建在它上面的索引。这两对就是这类 bug 的全部现场：
# 旧库上没有这些列，而索引必须等它们补完才能建。
# The columns this migration adds that also carry an index — the complete set of
# places this bug class can occur today.
_INDEXED_MIGRATED_COLUMNS = [
    ("strategy_signals", "result", "idx_strategy_signals_strategy_result",
     ["strategy_id", "result"]),
    ("signals", "result", "idx_signals_symbol_result", ["symbol", "result"]),
]


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    """本次修复**之前**的旧库：全表结构，但 signals / strategy_signals 都没有 result。

    先 create_all 建出完整结构再把列删掉，而不是手写两份精简建表语句：旧库与
    今天的差别只有这两列，手写的表反而会随模型演进而失真。

    与 users.invite_code 那次不同的是，这两条索引在模型的 __table_args__ 上就
    声明了，create_all 会一并建出来；SQLite 不允许删掉被索引引用的列，所以必须
    先 DROP INDEX 再 DROP COLUMN（DROP COLUMN 需 3.35+，本机 3.49）。这恰好也
    更贴近真实的旧库——还没有 result 列的年代，自然也还没有这两条索引。

    The database as it existed *before* this fix: full schema, minus
    signals.result and strategy_signals.result. Built via create_all and then
    dropping, rather than hand-writing trimmed DDL that would drift as the model
    evolves. Unlike the users.invite_code case, both indexes are declared in the
    models' __table_args__ so create_all creates them, and SQLite refuses to drop
    a column an index references — hence DROP INDEX first. That also models the
    real legacy database more closely: an era without the column had no index on
    it either.
    """
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型 / registers the tables

    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        for table, column, index_name, _cols in _INDEXED_MIGRATED_COLUMNS:
            conn.execute(text(f"DROP INDEX IF EXISTS {index_name}"))
            conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))

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


def _columns(eng, table):
    return {c["name"] for c in inspect(eng).get_columns(table)}


def _indexes(eng, table):
    return {i["name"]: list(i["column_names"]) for i in inspect(eng).get_indexes(table)}


def test_migration_on_legacy_db_adds_columns_and_indexes(legacy_engine):
    """回归：旧库上整段迁移必须跑完，并同时留下列和建在它上面的索引。

    修复前 idx_strategy_signals_strategy_result 建在 strategy_signals 补列**之前**
    的通用索引块里，这里会以 OperationalError: no such column: result 直接失败。

    Regression: on a pre-existing database the whole migration must run to
    completion and leave behind both the columns and the indexes over them.
    Before the fix idx_strategy_signals_strategy_result was created in the shared
    index block *above* the strategy_signals column-add, so this failed with
    OperationalError: no such column: result.
    """
    for table, column, index_name, _cols in _INDEXED_MIGRATED_COLUMNS:
        assert column not in _columns(legacy_engine, table), \
            f"fixture 没造出缺列的旧库：{table}.{column} 还在"
        assert index_name not in _indexes(legacy_engine, table)

    db_mod._migrate_columns()

    for table, column, index_name, cols in _INDEXED_MIGRATED_COLUMNS:
        assert column in _columns(legacy_engine, table), f"迁移没有补上 {table}.{column}"
        assert _indexes(legacy_engine, table).get(index_name) == cols, (
            f"迁移没有建出 {index_name}，或它没建在 {cols} 上"
        )

    # 跑完才会记版本号；记上了说明迁移是整段跑通的，不是中途抛异常。
    # The marker is only written after every step succeeded.
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_migration_backfills_result_on_legacy_rows(legacy_engine):
    """补列之后的回填照旧生效：旧行的 result 必须是 'PENDING'，不是 NULL。

    索引挪位置不能顺带把补列块里的回填 UPDATE 跳过——判定逻辑按
    result == 'PENDING' 找待判定信号，留 NULL 等于这些信号再也不会被判定。

    Moving the index must not skip the backfill that follows the ADD COLUMN:
    resolution finds pending signals by result == 'PENDING', so a NULL means the
    row is never resolved again.
    """
    # 裸 SQL 绕过 ORM 的 Python 侧默认值，NOT NULL 的列要自己给值；FK 不用凑
    # （SQLite 默认不开启外键约束，也不影响本用例要验的回填）。
    # Raw SQL bypasses the ORM's Python-side defaults, so NOT NULL columns are
    # supplied explicitly; the FK target isn't needed (SQLite doesn't enforce
    # foreign keys by default, and it's irrelevant to the backfill under test).
    with legacy_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO strategy_signals "
            "(id, strategy_id, user_id, symbol, side, entry, stop_loss, take_profit, "
            " bar_t, bars_held) "
            "VALUES ('sig1', 's1', 'u1', 'BTCUSD', 'BUY', 1.0, 0.9, 1.2, 0, 0)"
        ))

    db_mod._migrate_columns()

    with legacy_engine.connect() as conn:
        result = conn.execute(
            text("SELECT result FROM strategy_signals WHERE id = 'sig1'")
        ).scalar()
    assert result == "PENDING"


def test_migration_is_idempotent_on_forced_rerun(legacy_engine):
    """把版本号调小强制重跑：列已存在、索引已存在，都不能报错。
    Forcing a re-run must not raise now that both columns and indexes exist."""
    db_mod._migrate_columns()
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)
    db_mod._migrate_columns()   # 不该抛 / must not raise

    for table, _column, index_name, cols in _INDEXED_MIGRATED_COLUMNS:
        assert _indexes(legacy_engine, table).get(index_name) == cols


def test_no_create_index_precedes_any_add_column():
    """结构性守卫：_migrate_columns 里所有 CREATE INDEX 必须排在所有 ADD COLUMN 之后。

    上面两个用例只钉死了今天已知的两列。真正让这类 bug「写不出来」的是位置
    约束本身：只要建索引整体位于补列之后，未来任何新补的列都不可能被它上面的
    索引引用到。靠注释提醒挡不住下一个人（users.invite_code 就是被同一个坑绊
    过一次），所以直接对源码断言。

    比对的是剥掉注释后的源码——本函数的说明文字里就写着这两个短语。

    Structural guard: every CREATE INDEX in _migrate_columns must come after
    every ADD COLUMN. The cases above pin down only today's two columns; what
    makes the bug class unwritable is the ordering itself, so it's asserted
    directly. Comments compare against source with `#` lines stripped, since the
    explanatory prose in that function contains both phrases.
    """
    source = _pyinspect.getsource(db_mod._migrate_columns)
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )

    add_columns = [m.start() for m in re.finditer(r"ADD COLUMN", code)]
    create_indexes = [m.start() for m in re.finditer(r"CREATE INDEX", code)]
    assert add_columns, "源码里找不到 ADD COLUMN，断言失去意义"
    assert create_indexes, "源码里找不到 CREATE INDEX，断言失去意义"

    assert max(add_columns) < min(create_indexes), (
        "_migrate_columns 里有 CREATE INDEX 排在 ADD COLUMN 之前。"
        "旧库上这会以 'no such column' 打断迁移，而迁移跑在 uvicorn bind 端口"
        "之前——服务器直接起不来。把建索引移到函数末尾那个索引块里。"
    )
