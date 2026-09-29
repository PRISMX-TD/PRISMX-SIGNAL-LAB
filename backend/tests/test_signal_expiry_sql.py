"""信号过期扫描：时间条件推进 SQL 后，只有到期的 ACTIVE 信号被翻成 EXPIRED。
Expiry sweep with the time condition in SQL: only due ACTIVE signals flip to EXPIRED."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event
from sqlalchemy.orm import sessionmaker

import app.engine.signal_engine as se
from app.models import Signal


def _sig(status, expire_at, symbol="XAUUSD"):
    return Signal(
        symbol=symbol, side="BUY", entry=2000.0, stop_loss=1990.0, take_profit=2010.0,
        indicator="Test", source="tradingview", status=status,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None), result="PENDING",
        expire_at=expire_at,
    )


def test_only_due_active_signals_expire_and_query_filters_in_sql(db_session, monkeypatch):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    past = _sig("ACTIVE", now - timedelta(minutes=1))
    future = _sig("ACTIVE", now + timedelta(hours=1))
    never = _sig("ACTIVE", None)
    done = _sig("EXPIRED", now - timedelta(hours=1))
    db_session.add_all([past, future, never, done])
    db_session.commit()
    ids = {"past": past.id, "future": future.id, "never": never.id}

    maker = sessionmaker(bind=db_session.get_bind(), autocommit=False, autoflush=False)
    monkeypatch.setattr(se, "SessionLocal", maker)
    seen = []

    def _hook(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT") and "signals" in statement:
            seen.append(statement)

    event.listen(db_session.get_bind(), "before_cursor_execute", _hook)
    out = se._expire_stale_signals()
    assert [p["id"] for p in out] == [ids["past"]]
    assert "expire_at <=" in seen[0]     # 时间条件在 SQL 里 / the time filter is in SQL

    db_session.expire_all()
    status = {r.id: r.status for r in db_session.query(Signal).all()}
    assert status[ids["past"]] == "EXPIRED"
    assert status[ids["future"]] == "ACTIVE"
    assert status[ids["never"]] == "ACTIVE"
    assert se._expire_stale_signals() == []
