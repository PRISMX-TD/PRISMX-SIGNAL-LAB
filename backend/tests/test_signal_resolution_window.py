"""resolve_signals_with_price 的判定窗口与列裁剪测试。

这两点都是为削减 Supabase Egress 改的，而它们的失败方式都是"静默算错"而非报错：
窗口收窄若把仍需判定的信号排除在外，本该命中 TP/SL 的信号会被清扫成 STALE、
从胜率里消失；load_only 若漏掉判定用到的列，读取时会触发懒加载补查（Egress 反
而变多），或在 detached 状态下直接抛错。所以这里针对性地钉住这两条。

Tests for resolve_signals_with_price's resolution window and column pruning.

Both changes exist to cut Supabase Egress, and both fail *silently* rather than
loudly: if the window excludes signals that still need resolving, real TP/SL
hits get swept to STALE and vanish from the win rate; if load_only omits a
column resolution touches, reading it triggers a lazy re-query (more Egress,
not less) or raises once detached. Hence these pins.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base
from app.models import Signal
from app.services.signal_resolution import resolve_signals_with_price, sweep_stale_signals


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()


def _add(db, *, age_days: float = 0.0, side: str = "BUY", **kwargs) -> Signal:
    """建一条 PENDING 信号，created_at 按 age_days 往前推（列是 naive UTC）。
    Insert a PENDING signal aged age_days back (the column is naive UTC)."""
    defaults = dict(
        symbol="XAUUSD",
        side=side,
        entry=2000.0,
        stop_loss=1990.0 if side == "BUY" else 2010.0,
        take_profit=2010.0 if side == "BUY" else 1990.0,
        result="PENDING",
        created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=age_days),
    )
    defaults.update(kwargs)
    sig = Signal(**defaults)
    db.add(sig)
    db.commit()
    return sig


def test_first_observation_only_records_baseline(db):
    """首次观测只记基线、不判胜负（哪怕该根已越过 TP）。
    The first observation records the baseline and never resolves."""
    sig = _add(db)
    assert resolve_signals_with_price(db, "XAUUSD", 1980.0, 2020.0) == []
    assert sig.result == "PENDING"
    assert (sig.baseline_low, sig.baseline_high) == (1980.0, 2020.0)


def test_resolves_tp_beyond_baseline(db):
    """越过基线的新高命中 TP —— 判定链路在裁剪后的列上仍然完整。
    A new high beyond the baseline hits TP, proving resolution still works on
    the pruned column set."""
    sig = _add(db, baseline_high=2005.0, baseline_low=1995.0)
    resolved = resolve_signals_with_price(db, "XAUUSD", 1999.0, 2012.0)
    assert [s.id for s in resolved] == [sig.id]
    assert sig.result == "HIT_TP"
    assert sig.resolved_at is not None


def test_signal_just_inside_stale_window_still_resolves(db):
    """窗口内边缘（cutoff 内侧）的信号仍会被判定——这是收窄窗口最危险的边界。
    A signal just inside the cutoff still resolves: the risky edge of narrowing
    the window."""
    sig = _add(
        db,
        age_days=settings.SIGNAL_STALE_DAYS - 0.05,
        baseline_high=2005.0,
        baseline_low=1995.0,
    )
    resolve_signals_with_price(db, "XAUUSD", 1999.0, 2012.0)
    assert sig.result == "HIT_TP"


def test_signal_past_stale_window_is_skipped_and_swept(db):
    """超出窗口的信号不再判定，且确实由清扫接手成 STALE——不会永久卡在 PENDING。
    Signals past the window are skipped here and picked up by the sweep as
    STALE, so nothing is left stuck in PENDING forever."""
    sig = _add(
        db,
        age_days=settings.SIGNAL_STALE_DAYS + 1,
        baseline_high=2005.0,
        baseline_low=1995.0,
    )
    assert resolve_signals_with_price(db, "XAUUSD", 1999.0, 2012.0) == []
    assert sig.result == "PENDING"

    assert [s.id for s in sweep_stale_signals(db)] == [sig.id]
    assert sig.result == "STALE"


def test_window_spans_a_weekend_gap():
    """窗口必须盖得住周五收盘到周一开盘的空窗，否则周末生成的信号会在还没等到
    任何行情更新时就被判成 STALE。这条锁的是 SIGNAL_STALE_DAYS 的**下界**：
    2026-08-07 为削减 Egress 把它从 10 降到 5，再往下调就会擦到这个边界。

    The window must span the Friday-close-to-Monday-open gap, or signals created
    over a weekend get marked STALE before any price update can arrive. This
    pins the **lower bound** of SIGNAL_STALE_DAYS: it was cut from 10 to 5 on
    2026-08-07 to reduce Egress, and going lower starts grazing this edge.
    """
    # 周五 21:00 收盘 → 周一 01:00 开盘，最长约 2.2 天没有任何喂价。
    # Friday 21:00 close to Monday 01:00 open: ~2.2 days with no feed at all.
    weekend_gap_days = 2.2
    assert settings.SIGNAL_STALE_DAYS >= weekend_gap_days * 2, (
        "SIGNAL_STALE_DAYS must leave at least 2x the weekend gap as headroom "
        "for long holiday closures"
    )


def test_other_symbols_untouched(db):
    """按品种隔离：喂 XAUUSD 的价格不会动到 EURUSD 的信号。
    Symbol isolation: an XAUUSD price never touches a EURUSD signal."""
    other = _add(db, symbol="EURUSD", baseline_high=2005.0, baseline_low=1995.0)
    resolve_signals_with_price(db, "XAUUSD", 1999.0, 2012.0)
    assert other.result == "PENDING"
    assert other.baseline_high == 2005.0


def test_pruned_columns_do_not_trigger_lazy_reload(db):
    """判定后访问被裁掉的列不应产生新查询——否则列裁剪反而增加 Egress。
    Touching pruned columns after resolution must not emit a new query, or the
    pruning would increase Egress instead of cutting it."""
    _add(db, baseline_high=2005.0, baseline_low=1995.0)
    resolved = resolve_signals_with_price(db, "XAUUSD", 1999.0, 2012.0)
    assert len(resolved) == 1

    statements: list[str] = []
    from sqlalchemy import event

    conn = db.connection()

    def _record(conn_, cursor, statement, params, context, executemany):
        statements.append(statement)

    event.listen(conn.engine, "before_cursor_execute", _record)
    try:
        # 判定过程读写的列都在 load_only 里，访问它们不该回表。
        # Every column resolution reads/writes is in load_only, so these must
        # not hit the database again.
        _ = (
            resolved[0].side,
            resolved[0].stop_loss,
            resolved[0].take_profit,
            resolved[0].baseline_high,
            resolved[0].baseline_low,
            resolved[0].result,
            resolved[0].resolved_at,
        )
        assert statements == []
    finally:
        event.remove(conn.engine, "before_cursor_execute", _record)
