"""取连接前的探活只对空闲连接做（core/database._ping_if_idle，2026-10-10）。

约定：刚还回来的连接直接用、不发 SELECT 1；空闲超过 DB_PING_IDLE_SECONDS 或从没记过时间的
先探活；探活失败抛 DisconnectionError（连接池据此丢掉这条、换新的）。
Ping only idle connections: a recently checked-in one is used as is; an idle or
never-stamped one is pinged; a failed ping raises DisconnectionError.
"""
import time

import pytest
from sqlalchemy import exc as sa_exc

from app.core import database
from app.core.config import settings


class _Cursor:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql):
        self.conn.executed.append(sql)
        if self.conn.broken:
            raise RuntimeError("server closed the connection unexpectedly")

    def close(self):
        pass


class _Conn:
    def __init__(self, broken=False):
        self.broken = broken
        self.executed: list[str] = []

    def cursor(self):
        return _Cursor(self)


class _Record:
    def __init__(self):
        self.info: dict = {}


def test_recently_used_connection_is_not_pinged(monkeypatch):
    monkeypatch.setattr(settings, "DB_PING_IDLE_SECONDS", 10.0)
    conn, rec = _Conn(), _Record()
    database._stamp(conn, rec)
    database._ping_if_idle(conn, rec, None)
    assert conn.executed == []


def test_idle_or_unstamped_connection_is_pinged(monkeypatch):
    monkeypatch.setattr(settings, "DB_PING_IDLE_SECONDS", 10.0)
    conn, rec = _Conn(), _Record()
    database._ping_if_idle(conn, rec, None)          # 从没记过时间 / never stamped
    rec.info[database._LAST_USED] = time.monotonic() - 11
    database._ping_if_idle(conn, rec, None)          # 空闲超过阈值 / idle past the threshold
    assert conn.executed == ["SELECT 1", "SELECT 1"]


def test_failed_ping_asks_the_pool_for_a_fresh_connection(monkeypatch):
    monkeypatch.setattr(settings, "DB_PING_IDLE_SECONDS", 10.0)
    conn, rec = _Conn(broken=True), _Record()
    # 整池作废（与内置 pre_ping 一致）/ invalidates the whole pool, like the built-in pre_ping
    with pytest.raises(sa_exc.InvalidatePoolError):
        database._ping_if_idle(conn, rec, None)
