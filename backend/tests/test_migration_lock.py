"""init_db 的迁移互斥锁（database._migration_lock）。

生产是 uvicorn --workers 2，两个 worker 同时启动、同时跑慢通道时 DDL 会互撞（输家报
pg_type 唯一索引冲突 / 列已存在，被 uvicorn 拉起重来）。init_db 现在把 create_all +
_migrate_columns + _hash_legacy_api_tokens 整段放进 Postgres 事务级咨询锁。这里没有真
Postgres，用一个假引擎钉住三件事：

  · Postgres：先在一条独立连接上拿锁（带 lock_timeout），再跑三步，最后 rollback + close 放锁；
    中途抛异常也照样放锁。
  · 拿锁失败（等超时、连接不上）：只告警，不加锁照旧把三步跑完，启动不被卡住。
  · SQLite：一条连接都不开。

The migration lock around init_db, pinned with a fake engine (no Postgres here):
lock first on a dedicated connection, then the three steps, then rollback + close;
a failed lock only warns and runs unlocked; SQLite opens no connection at all.
"""
import logging
from types import SimpleNamespace

import pytest

import app.core.database as db_mod


class _FakeConn:
    def __init__(self, calls, *, fail_on=None):
        self.calls = calls
        self.fail_on = fail_on

    def execute(self, stmt, params=None):
        sql = str(stmt)
        self.calls.append(("sql", sql, params))
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError("canceling statement due to lock timeout")

    def rollback(self):
        self.calls.append(("rollback",))

    def close(self):
        self.calls.append(("close",))


class _FakeEngine:
    def __init__(self, dialect, calls, *, fail_on=None, connect_error=None):
        self.dialect = SimpleNamespace(name=dialect)
        self.calls = calls
        self.fail_on = fail_on
        self.connect_error = connect_error

    def connect(self):
        if self.connect_error is not None:
            raise self.connect_error
        self.calls.append(("connect",))
        return _FakeConn(self.calls, fail_on=self.fail_on)


@pytest.fixture()
def steps(monkeypatch):
    """把三步换成只记账的假函数 / replace the three steps with recorders."""
    calls: list = []
    monkeypatch.setattr(db_mod.Base.metadata, "create_all", lambda bind=None: calls.append(("create_all",)))
    monkeypatch.setattr(db_mod, "_migrate_columns", lambda: calls.append(("migrate",)))
    monkeypatch.setattr(db_mod, "_hash_legacy_api_tokens", lambda: calls.append(("hash",)))
    return calls


def _names(calls):
    out = []
    for c in calls:
        if c[0] != "sql":
            out.append(c[0])
        elif "pg_advisory_xact_lock" in c[1]:
            out.append("lock")
        elif "lock_timeout" in c[1]:
            out.append("timeout")
        elif "statement_timeout = 0" in c[1] or "idle_in_transaction_session_timeout = 0" in c[1]:
            out.append("untimeout")
        else:
            out.append(c[1])
    return out


def test_postgres_runs_the_migration_inside_the_advisory_lock(monkeypatch, steps):
    monkeypatch.setattr(db_mod, "engine", _FakeEngine("postgresql", steps))
    db_mod.init_db()
    assert _names(steps) == [
        "connect", "timeout", "untimeout", "untimeout", "lock",
        "create_all", "migrate", "hash", "rollback", "close",
    ]
    # 角色级 statement_timeout / idle_in_transaction_session_timeout 两个都只在这个事务里关掉
    # both role-level timeouts are switched off, for this transaction only
    sets = [c[1] for c in steps if c[0] == "sql" and c[1].startswith("SET LOCAL")]
    assert "SET LOCAL statement_timeout = 0" in sets
    assert "SET LOCAL idle_in_transaction_session_timeout = 0" in sets
    [lock] = [c for c in steps if c[0] == "sql" and "pg_advisory_xact_lock" in c[1]]
    assert lock[2] == {"k": db_mod._MIGRATION_LOCK_KEY}
    # 事务级锁（进程被杀时随事务回滚一定放掉），不是会话级
    # transaction-level (always released with the transaction), not session-level
    assert "pg_advisory_lock(" not in lock[1]


def test_lock_is_released_when_the_migration_raises(monkeypatch, steps):
    monkeypatch.setattr(db_mod, "engine", _FakeEngine("postgresql", steps))

    def _boom():
        steps.append(("migrate",))
        raise RuntimeError("ddl failed")

    monkeypatch.setattr(db_mod, "_migrate_columns", _boom)
    with pytest.raises(RuntimeError, match="ddl failed"):
        db_mod.init_db()
    assert _names(steps)[-2:] == ["rollback", "close"]


def test_lock_timeout_carries_on_unlocked(monkeypatch, steps, caplog):
    monkeypatch.setattr(db_mod, "engine", _FakeEngine("postgresql", steps, fail_on="pg_advisory_xact_lock"))
    with caplog.at_level(logging.WARNING, logger="prismx.database"):
        db_mod.init_db()
    names = _names(steps)
    assert names[:6] == ["connect", "timeout", "untimeout", "untimeout", "lock", "close"]  # 等不到就关掉这条连接
    assert names[6:] == ["create_all", "migrate", "hash"]           # 照旧跑完，不卡启动
    assert "migration lock not acquired" in caplog.text


def test_connect_failure_carries_on_unlocked(monkeypatch, steps, caplog):
    monkeypatch.setattr(db_mod, "engine",
                        _FakeEngine("postgresql", steps, connect_error=RuntimeError("no db")))
    with caplog.at_level(logging.WARNING, logger="prismx.database"):
        db_mod.init_db()
    assert _names(steps) == ["create_all", "migrate", "hash"]
    assert "migration lock not acquired" in caplog.text


def test_sqlite_takes_no_lock(monkeypatch, steps):
    monkeypatch.setattr(db_mod, "engine",
                        _FakeEngine("sqlite", steps, connect_error=AssertionError("no connect on sqlite")))
    db_mod.init_db()
    assert _names(steps) == ["create_all", "migrate", "hash"]
