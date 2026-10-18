"""2026-10-18 Supabase Egress 降量：几处缓存 / 跳过必须与原来逐行等价。

  · 策略胜率的窗口行缓存（strategy_winrate._window_rows）：增量同步后的结果 = 每次整窗重读；
  · 比赛榜 / 周期榜的输入指纹（gamification.input_sig）：指纹不变才跳过，变了、快照表被人
    改了都照常重算；跳过时返回的行数与上次一致；
  · 网关平仓扫描按仓位号收窄（gateway.platform_positions）：收窄后的结果 = 整账号结果里
    这些仓位号的那部分。

指纹本身用的是 Postgres 的 hashtextextended，SQLite 上跑不了；这里把两个取指纹的函数换成
Python 版（输入用一个可控的计数器，快照指纹真去读快照表），只测「什么时候跳过」这条流程。

Egress reductions of 2026-10-18 must be row-for-row equivalent to the old behaviour.
The fingerprint SQL is Postgres-only, so its two functions are replaced with Python
stand-ins here (a controllable input token; a snapshot fingerprint that really reads
the table) to test when a recompute is skipped.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import (
    ClosedTrade, Competition, CompetitionParticipant, LeaderboardSnapshot, MT5Account,
    Order, PeriodBaseline, Signal, User,
)
from app.services import strategy_winrate as sw
from app.services.gamification import boards as boards_mod
from app.services.gamification import competitions as comp_mod
from app.services.gamification import input_sig

UTC = timezone.utc


# ---------------------------------------------------------------- 策略胜率行缓存

NOW = datetime.now(UTC).replace(microsecond=0)


class _Frozen(datetime):
    """冻结 strategy_winrate 里的 datetime.now（同 test_strategy_winrate 的做法），两次计算才
    对得上逐个 24h 桶。/ Freeze datetime.now inside strategy_winrate so both runs share a clock."""

    @classmethod
    def now(cls, tz=None):
        return NOW if tz is None else NOW.astimezone(tz)


@pytest.fixture()
def sdb(monkeypatch):
    monkeypatch.setattr(sw, "datetime", _Frozen)
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    sw.reset_row_cache()
    try:
        yield session
    finally:
        sw.reset_row_cache()
        session.close()
        engine.dispose()


def _naive(dt):
    return dt.astimezone(UTC).replace(tzinfo=None)


def _sig(db, *, ago_hours, result="PENDING", strategy="Alpha", symbol="XAUUSD", side="BUY",
         resolved_after_hours=None, source="tradingview"):
    created = NOW - timedelta(hours=ago_hours)
    s = Signal(symbol=symbol, side=side, entry=1.0, stop_loss=0.5, take_profit=1.5,
               indicator=strategy, source=source, result=result, created_at=_naive(created),
               resolved_at=(_naive(created + timedelta(hours=resolved_after_hours))
                            if resolved_after_hours is not None else None))
    db.add(s)
    db.commit()
    return s


def _both(db, monkeypatch, days, only=None):
    """同一时刻分别走缓存与不走缓存各算一次。/ Compute with and without the cache."""
    monkeypatch.setattr(sw, "_ROW_CACHE_ENABLED", True)
    cached = sw.compute_strategy_session_winrate(db, days, only_strategies=only)
    monkeypatch.setattr(sw, "_ROW_CACHE_ENABLED", False)
    fresh = sw.compute_strategy_session_winrate(db, days, only_strategies=only)
    for d in (cached, fresh):
        d.pop("windowStart"), d.pop("windowEnd")
    return cached, fresh


def test_row_cache_matches_full_reload_after_inserts_and_resolutions(sdb, monkeypatch):
    old = _sig(sdb, ago_hours=40)
    _sig(sdb, ago_hours=30, result="HIT_TP", resolved_after_hours=2, strategy="Beta")
    _sig(sdb, ago_hours=24 * 40)                       # 窗口外 / outside the window
    _sig(sdb, ago_hours=5, source="mock")              # 非外部来源 / not external
    cached, fresh = _both(sdb, monkeypatch, 30)
    assert cached == fresh

    # 新信号（created_at = 写入时刻）+ 老信号刚判定（resolved_at = 现在，与
    # signal_resolution 一致）。/ A new signal stamped at insert, an old one just resolved.
    _sig(sdb, ago_hours=0, strategy="Gamma", side="SELL")
    old.result = "HIT_SL"
    old.resolved_at = _naive(NOW)
    sdb.commit()
    cached, fresh = _both(sdb, monkeypatch, 30)
    assert cached == fresh
    assert cached["overall"]["total"]["samples"] == 3
    # 第二次是增量：缓存里的行数仍只含窗口内的外部信号
    # The second call was incremental; the cache holds only in-window external rows.
    assert len(sw._row_cache["rows"]) == 3


def test_row_cache_whitelist_and_shorter_window(sdb, monkeypatch):
    _sig(sdb, ago_hours=3, strategy="Alpha")
    _sig(sdb, ago_hours=3, strategy="Beta", result="HIT_TP", resolved_after_hours=1)
    _sig(sdb, ago_hours=24 * 10, strategy="Beta")
    cached, fresh = _both(sdb, monkeypatch, 7, only=["Beta"])
    assert cached == fresh
    assert [s["strategy"] for s in cached["strategies"]] == ["Beta"]
    assert cached["overall"]["total"]["samples"] == 1


def test_row_cache_bypassed_for_long_admin_windows(sdb, monkeypatch):
    _sig(sdb, ago_hours=24 * 60)
    cached, fresh = _both(sdb, monkeypatch, 90)
    assert cached == fresh and cached["overall"]["total"]["samples"] == 1
    assert sw._row_cache["rows"] is None


# ---------------------------------------------------------------- 榜单输入指纹

T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)


@pytest.fixture()
def fake_sig(monkeypatch):
    """可控的输入指纹 + 真读快照表的快照指纹。/ Controllable inputs, real snapshot read."""
    state = {"token": "v1"}

    def _inputs(db, kind, key, params, py_inputs):
        return f"{kind}:{key}:{state['token']}"

    def _snapshot(db, key):
        db.flush()
        rows = (db.query(LeaderboardSnapshot.board, LeaderboardSnapshot.rank,
                         LeaderboardSnapshot.mt5_login, LeaderboardSnapshot.score,
                         LeaderboardSnapshot.sample)
                .filter(LeaderboardSnapshot.period_key == key)
                .order_by(LeaderboardSnapshot.board, LeaderboardSnapshot.rank).all())
        return repr([tuple(r) for r in rows])

    monkeypatch.setattr(input_sig, "input_signature", _inputs)
    monkeypatch.setattr(input_sig, "snapshot_signature", _snapshot)
    yield state


def _count_calls(monkeypatch, module, name):
    calls = {"n": 0}
    real = getattr(module, name)

    def spy(*a, **kw):
        calls["n"] += 1
        return real(*a, **kw)

    monkeypatch.setattr(module, name, spy)
    return calls


def _seed_comp(db):
    comp = Competition(name="C", metric="return_pct", status="running",
                       starts_at=T0, ends_at=ENDS)
    db.add(comp)
    db.commit()
    for email, login, profit in (("e1@t.co", "A", 30.0), ("e2@t.co", "B", 10.0)):
        u = User(email=email, api_token="tok_" + email)
        db.add(u)
        db.commit()
        db.add(MT5Account(user_id=u.id, login=login, server="s", balance=2000.0, trade_mode=2))
        db.add(PeriodBaseline(user_id=u.id, mt5_login=login,
                              period_key=comp_mod.comp_period_key(comp.id),
                              baseline=2000.0, taken_at=T0))
        db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login))
        for t in range(1, 6):
            closed = T0 + timedelta(days=1, hours=t)
            db.add(Order(user_id=u.id, client_order_id=f"c{login}{t}", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login=login, mt5_ticket=t,
                         trade_mode=2, created_at=closed - timedelta(hours=1)))
            db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=profit,
                               position_ticket=t, deal_ticket=t * 10, closed_at=closed,
                               verified=True))
        db.commit()
    return comp


def test_comp_snapshot_skips_only_while_inputs_and_snapshot_match(db_session, fake_sig,
                                                                 monkeypatch):
    comp = _seed_comp(db_session)
    key = comp_mod.comp_period_key(comp.id)
    computed = _count_calls(monkeypatch, comp_mod, "compute_comp_rows")
    now = T0 + timedelta(days=2)
    try:
        first = comp_mod.snapshot_competitions(db_session, now)
        assert computed["n"] == 1 and first["rows"] == 2

        second = comp_mod.snapshot_competitions(db_session, now)
        assert computed["n"] == 1, "输入没变应跳过重算"
        assert second == first

        fake_sig["token"] = "v2"                       # 输入变了 / inputs changed
        comp_mod.snapshot_competitions(db_session, now)
        assert computed["n"] == 2

        # 快照表被别人删了：指纹对不上，照常重算并写回
        # Someone deleted the snapshot rows: mismatch, so it recomputes and rewrites them.
        db_session.query(LeaderboardSnapshot).filter_by(period_key=key).delete()
        db_session.commit()
        comp_mod.snapshot_competitions(db_session, now)
        assert computed["n"] == 3
        assert db_session.query(LeaderboardSnapshot).filter_by(period_key=key).count() == 2
    finally:
        input_sig.forget("comp", comp.id)


def test_comp_refresh_skip_and_force(db_session, fake_sig, monkeypatch):
    comp = _seed_comp(db_session)
    computed = _count_calls(monkeypatch, comp_mod, "compute_comp_rows")
    try:
        assert comp_mod.refresh_comp_board(db_session, comp, force=True) is True
        assert computed["n"] == 1
        # 没变：跳过（节流键先清掉，免得被 20 秒节流挡住而测不到跳过）
        from app.services import shared_state
        shared_state.kv_delete(comp_mod._refresh_throttle_key(comp.id))
        assert comp_mod.refresh_comp_board(db_session, comp) is False
        assert computed["n"] == 1
        # force（管理端「立即刷新」）永远重算 / force always recomputes
        assert comp_mod.refresh_comp_board(db_session, comp, force=True) is True
        assert computed["n"] == 2
    finally:
        input_sig.forget("comp", comp.id)


def test_board_snapshot_skips_when_unchanged(db_session, fake_sig, monkeypatch):
    from app.services.gamification.boards import ensure_baselines
    for email, login in (("b1@t.co", "A"), ("b2@t.co", "B")):
        u = User(email=email, api_token="tok_" + email)
        db_session.add(u)
        db_session.commit()
        db_session.add(MT5Account(user_id=u.id, login=login, server="s", balance=2000.0,
                                  trade_mode=2))
        db_session.commit()
    ensure_baselines(db_session, "2026-W36", T0)
    computed = _count_calls(monkeypatch, boards_mod, "compute_board_rows")
    now = T0 + timedelta(days=2, hours=12)
    keys = boards_mod.active_period_keys(now)
    try:
        first = boards_mod.snapshot_boards(db_session, now)
        assert computed["n"] == len(keys)
        second = boards_mod.snapshot_boards(db_session, now)
        assert computed["n"] == len(keys), "输入没变应整轮跳过"
        assert second == first
        fake_sig["token"] = "v2"
        boards_mod.snapshot_boards(db_session, now)
        assert computed["n"] == 2 * len(keys)
    finally:
        for k in keys:
            input_sig.forget("board", k)


def test_signature_is_none_off_postgres(db_session):
    """SQLite 上没有指纹 → 永远重算，行为与改动前一致。/ No fingerprint off Postgres."""
    assert input_sig.input_signature(db_session, "board", "2026-W36", {"key": "2026-W36"}, {}) is None
    assert input_sig.snapshot_signature(db_session, "2026-W36") is None
    assert input_sig.unchanged(db_session, "board", "2026-W36", None) is None


# ---------------------------------------------------------------- 网关仓位号收窄

def test_platform_positions_narrowed_equals_full_subset(db_session):
    from app.routers import gateway as gw
    u = User(email="g@t.co", api_token="tok_g")
    db_session.add(u)
    db_session.commit()
    db_session.add_all([
        Order(user_id=u.id, client_order_id=f"o{i}", action="ORDER", status="FILLED",
              symbol="X", side="BUY", volume=0.1, mt5_login="9", mt5_position=100 + i)
        for i in range(5)
    ])
    db_session.commit()
    full_known, full_opened = gw.platform_positions(db_session, u.id, "9")
    want = {101, 103, 999}
    known, opened = gw.platform_positions(db_session, u.id, "9", want)
    assert known == full_known & want
    assert opened == {k: v for k, v in full_opened.items() if k in want}
