"""#24 迁移版本号快速通道。

_migrate_columns 整段跑在 uvicorn bind 端口之前，每多花一秒就是多一秒 502。
加了版本号之后：日常重启直接返回，只有真改了 schema（手工 +1）才跑完整迁移。

这是本项唯一的行为改变，所以重点验：命中就跳过、不命中就跑、跑完写回、
中途失败不写回（下次重跑）、版本号调小能强制重跑。
"""
import json

import pytest
from sqlalchemy import create_engine, text

import app.core.database as db_mod


@pytest.fixture()
def temp_engine(monkeypatch, tmp_path):
    """一次性 SQLite 文件库（建全表），并把模块级 engine 换成它。

    用文件而不是 :memory:，因为 _read_schema_rev / _write_schema_rev 各自
    engine.connect()，内存库每次连接都是新的空库。

    建的是**真实全表结构**而不是只建 platform_settings：慢通道里有若干
    CREATE INDEX 之类不经过 inspector 的语句，缺表会直接报错。让真迁移在真
    结构上跑，测试才有意义。
    """
    url = "sqlite:///" + str(tmp_path / "t.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})

    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401  —— 注册模型

    Base.metadata.create_all(eng)
    monkeypatch.setattr(db_mod, "engine", eng)
    # SessionLocal 在模块导入时就绑好了真 engine，换 engine 不会连带换它；
    # 而慢通道里的 _disable_legacy_strategies / _backfill_strategy_watch 走的
    # 正是 SessionLocal，不一起换的话它们会打到开发机上的真库。
    # SessionLocal is bound at import time, so swapping engine alone leaves the
    # slow path's helpers pointing at the developer's real database.
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    yield eng
    eng.dispose()


def _count_migrations(monkeypatch, counter):
    """把 db_mod.inspect 换成计数壳，仍然委托给真实实现。
    Wrap db_mod.inspect with a counter while still delegating to the real one."""
    real_inspect = db_mod.inspect

    def _counting(engine):
        counter["n"] += 1
        return real_inspect(engine)

    monkeypatch.setattr(db_mod, "inspect", _counting)


# ---------- 读写版本号 ----------


def test_read_returns_none_when_never_written(temp_engine):
    assert db_mod._read_schema_rev() is None


def test_write_then_read_roundtrip(temp_engine):
    db_mod._write_schema_rev(7)
    assert db_mod._read_schema_rev() == 7


def test_write_is_idempotent_upsert(temp_engine):
    """重复写同一个键要更新而不是插出第二行（key 是主键，插两次会炸）。"""
    db_mod._write_schema_rev(1)
    db_mod._write_schema_rev(2)
    assert db_mod._read_schema_rev() == 2
    with temp_engine.connect() as conn:
        n = conn.execute(
            text("SELECT count(*) FROM platform_settings WHERE key = 'schema_rev'")
        ).scalar()
    assert n == 1


def test_read_tolerates_missing_table(monkeypatch, tmp_path):
    """首次部署时 platform_settings 还不存在，必须当成"没跑过"而不是抛异常。"""
    url = "sqlite:///" + str(tmp_path / "empty.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    monkeypatch.setattr(db_mod, "engine", eng)
    try:
        assert db_mod._read_schema_rev() is None
    finally:
        eng.dispose()


def test_read_tolerates_garbage_value(temp_engine):
    """值被写坏时当成没跑过，走完整迁移（幂等，重跑无害）。"""
    with temp_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO platform_settings (id, key, value) "
            "VALUES ('x1', 'schema_rev', 'not-json')"
        ))
    assert db_mod._read_schema_rev() is None


# ---------- 快速通道 ----------


def test_fast_path_skips_when_current(temp_engine, monkeypatch):
    """版本号命中时必须直接返回，一次 inspect 都不做。"""
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV)

    called = {"inspect": 0}

    def _boom(*a, **k):
        called["inspect"] += 1
        raise AssertionError("快速通道未生效：不该走到 inspect")

    monkeypatch.setattr(db_mod, "inspect", _boom)
    db_mod._migrate_columns()          # 不该抛
    assert called["inspect"] == 0


def test_slow_path_runs_when_stale(temp_engine, monkeypatch):
    """版本号落后时必须跑完整迁移（在真实表结构上真跑一遍）。"""
    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)

    counter = {"n": 0}
    _count_migrations(monkeypatch, counter)
    db_mod._migrate_columns()
    assert counter["n"] == 1, "版本号落后时必须走完整迁移"


def test_slow_path_writes_marker_on_success(temp_engine, monkeypatch):
    """完整迁移跑完后要记下版本号，下次才能走快速通道。"""
    counter = {"n": 0}
    _count_migrations(monkeypatch, counter)
    assert db_mod._read_schema_rev() is None
    db_mod._migrate_columns()
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_marker_not_written_when_migration_raises(temp_engine, monkeypatch):
    """中途抛异常就不该记版本号——否则未完成的迁移会被当成已完成，永远跳过。"""
    def _boom(_e):
        raise RuntimeError("migration blew up")

    monkeypatch.setattr(db_mod, "inspect", _boom)
    with pytest.raises(RuntimeError):
        db_mod._migrate_columns()
    assert db_mod._read_schema_rev() is None, "失败的迁移绝不能留下已完成标记"


def test_lowering_marker_forces_rerun(temp_engine, monkeypatch):
    """把库里的版本号调小可以强制重跑——这是出问题时的逃生舱。

    顺带验证了慢通道确实幂等：同一个库上连跑两遍不报错。
    """
    runs = {"n": 0}
    _count_migrations(monkeypatch, runs)

    db_mod._migrate_columns()          # 首次：跑
    db_mod._migrate_columns()          # 第二次：跳过
    assert runs["n"] == 1, "第二次必须走快速通道"

    db_mod._write_schema_rev(db_mod.CURRENT_SCHEMA_REV - 1)
    db_mod._migrate_columns()          # 调小后：重跑
    assert runs["n"] == 2, "版本号调小后必须重跑"
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV
