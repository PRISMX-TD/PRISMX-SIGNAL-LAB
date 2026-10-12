"""信号面板策略下拉的全量策略名（2026-10-12）：近 30 天发过信号的全部策略，
不只是此刻有信号的；去重、排序，空名与窗口外的不算。

Strategy names for the signal board's filter (2026-10-12): every strategy with a
signal in the last 30 days, not just those live now; deduplicated, sorted, blanks
and out-of-window rows excluded.
"""
from datetime import datetime, timedelta, timezone

from app.models import Signal, User
from app.routers.signals import strategy_names


def test_lists_every_strategy_in_window(db_session):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = [
        ("s1", "响尾蛇", now - timedelta(days=2), "EXPIRED"),
        ("s2", "AIFT", now - timedelta(minutes=1), "ACTIVE"),
        ("s3", "AIFT", now - timedelta(days=1), "EXPIRED"),
        ("s4", "旧策略", now - timedelta(days=45), "EXPIRED"),
        ("s5", "", now, "EXPIRED"),
        ("s6", None, now, "EXPIRED"),
    ]
    for sid, ind, at, st in rows:
        db_session.add(Signal(id=sid, symbol="XAUUSD", side="BUY", indicator=ind, status=st, created_at=at))
    db_session.commit()

    out = strategy_names(_user=User(id="u"), db=db_session)

    assert out == {"names": ["AIFT", "响尾蛇"]}
