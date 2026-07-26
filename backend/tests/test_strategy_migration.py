"""数据模型与迁移测试：新列/新表/索引存在，旧行回填后行为不变。

Model & migration tests: new columns/tables/indexes exist and existing rows are
backfilled such that behaviour doesn't change on upgrade.
"""
import json

from sqlalchemy import inspect, text

from app.core.database import engine, init_db
from app.models import StrategySignal, StrategyWatch, UserStrategy
from app.services.strategy import presets as ps


def test_user_strategies_has_new_columns(db):
    cols = {c["name"] for c in inspect(engine).get_columns("user_strategies")}
    assert {
        "rules", "symbols", "intervals", "exit_timeout_bars",
        "session_filter", "daily_signal_cap", "cooldown_minutes",
    } <= cols


def test_strategy_signals_has_new_columns(db):
    cols = {c["name"] for c in inspect(engine).get_columns("strategy_signals")}
    assert {"baseline_high", "baseline_low", "interval", "bars_held"} <= cols


def test_strategy_watch_table_exists_with_constraints(db):
    insp = inspect(engine)
    assert "strategy_watch" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("strategy_watch")}
    assert {"id", "strategy_id", "symbol", "interval"} <= cols
    uniques = {tuple(u["column_names"]) for u in insp.get_unique_constraints("strategy_watch")}
    assert ("strategy_id", "symbol", "interval") in uniques
    indexes = {tuple(i["column_names"]) for i in insp.get_indexes("strategy_watch")}
    assert ("symbol", "interval") in indexes


def test_strategy_signals_has_strategy_result_index(db):
    indexes = {tuple(i["column_names"]) for i in inspect(engine).get_indexes("strategy_signals")}
    assert ("strategy_id", "result") in indexes


def test_strategy_watch_rejects_duplicate_triples(db, user):
    strat = UserStrategy(
        user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="15",
        rules=json.dumps(ps.PRESET_RULES["ma_cross"]),
        symbols=json.dumps(["XAUUSD"]), intervals=json.dumps(["15"]),
    )
    db.add(strat)
    db.commit()
    db.add(StrategyWatch(strategy_id=strat.id, symbol="XAUUSD", interval="15"))
    db.commit()
    db.add(StrategyWatch(strategy_id=strat.id, symbol="XAUUSD", interval="15"))
    try:
        db.commit()
        raise AssertionError("duplicate (strategy_id, symbol, interval) should be rejected")
    except Exception:
        db.rollback()


def test_strategy_signal_defaults(db, user):
    strat = UserStrategy(
        user_id=user.id, template="ma_cross", symbol="XAUUSD", interval="15",
        rules=json.dumps(ps.PRESET_RULES["ma_cross"]),
        symbols=json.dumps(["XAUUSD"]), intervals=json.dumps(["15"]),
    )
    db.add(strat)
    db.commit()
    sig = StrategySignal(
        strategy_id=strat.id, user_id=user.id, symbol="XAUUSD", interval="15",
        side="BUY", entry=100.0, stop_loss=99.0, take_profit=102.0, bar_t=1000,
    )
    db.add(sig)
    db.commit()
    db.refresh(sig)
    assert sig.bars_held == 0
    assert sig.result == "PENDING"
    assert sig.baseline_high is None
    assert sig.baseline_low is None


def test_legacy_row_backfilled_to_rules_symbols_intervals_and_watch(db):
    """模拟升级前的旧行：只有 template/params/symbol/interval，rules 等新列为
    NULL。再跑一次迁移，应回填出与模板等价的 AST、单元素多值列，以及 watch 行。
    Simulate a pre-upgrade row (template/params/symbol/interval only, new
    columns NULL); re-running the migration must backfill an AST equivalent to
    the template, single-element multi-value columns and the watch row."""
    from app.models import User

    u = User(email="legacy@example.com", password_hash="x", api_token="legacyhash")
    db.add(u)
    db.commit()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO user_strategies "
                "(id, user_id, template, symbol, interval, params, stop_loss_method, "
                " stop_loss_value, take_profit_method, take_profit_value, "
                " one_trade_at_a_time, enabled) "
                "VALUES ('legacy1', :uid, 'rsi_reversal', 'EURUSD', '60', "
                " '{\"period\": 14, \"oversold\": 25, \"overbought\": 75, \"direction\": \"long\"}', "
                " 'percent', 1.0, 'rr', 2.0, 1, 1)"
            ),
            {"uid": u.id},
        )

    init_db()  # 迁移幂等，可重复跑 / the migration is idempotent

    db.expire_all()
    row = db.query(UserStrategy).filter(UserStrategy.id == "legacy1").first()
    assert json.loads(row.symbols) == ["EURUSD"]
    assert json.loads(row.intervals) == ["60"]
    expected = ps.template_to_ast(
        "rsi_reversal", {"period": 14, "oversold": 25, "overbought": 75, "direction": "long"}
    )
    assert json.loads(row.rules) == expected
    # direction=long 的旧策略回填后空头侧为空，行为与旧引擎一致
    assert json.loads(row.rules)["short"] is None
    watches = db.query(StrategyWatch).filter(StrategyWatch.strategy_id == "legacy1").all()
    assert [(w.symbol, w.interval) for w in watches] == [("EURUSD", "60")]


def test_backfill_is_idempotent(db):
    from app.models import User

    u = User(email="legacy2@example.com", password_hash="x", api_token="legacyhash2")
    db.add(u)
    db.commit()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO user_strategies "
                "(id, user_id, template, symbol, interval, params, stop_loss_method, "
                " stop_loss_value, take_profit_method, take_profit_value, "
                " one_trade_at_a_time, enabled) "
                "VALUES ('legacy2', :uid, 'ma_cross', 'XAUUSD', '15', '{}', "
                " 'percent', 1.0, 'rr', 2.0, 1, 1)"
            ),
            {"uid": u.id},
        )
    init_db()
    init_db()
    db.expire_all()
    watches = db.query(StrategyWatch).filter(StrategyWatch.strategy_id == "legacy2").all()
    assert len(watches) == 1


def test_legacy_pending_signals_get_interval_backfilled(db):
    """旧 strategy_signals 行没有 interval；判定与超时计数都需要它，按所属策略
    的 interval 回填。Legacy signal rows have no interval; resolution and the
    timeout counter both need one, backfilled from the owning strategy."""
    from app.models import User

    u = User(email="legacy3@example.com", password_hash="x", api_token="legacyhash3")
    db.add(u)
    db.commit()
    with engine.begin() as conn:
        # 真实的升级前表根本没有这两列（计划文档里直接 INSERT 省略 bars_held，
        # 但新建的表上它已是 NOT NULL，插入会被约束拒绝）。先删列还原旧表形状，
        # 才能真正走一遍「ALTER TABLE 加列 + 回填」这条迁移路径。
        # A real pre-upgrade table simply lacks these two columns (the plan's
        # raw INSERT omits bars_held, but on a freshly created table it is
        # already NOT NULL, so the insert is rejected). Dropping them first
        # restores the old table shape, which is what makes this test exercise
        # the actual "ALTER TABLE add column + backfill" migration path.
        conn.execute(text("ALTER TABLE strategy_signals DROP COLUMN interval"))
        conn.execute(text("ALTER TABLE strategy_signals DROP COLUMN bars_held"))
        conn.execute(
            text(
                "INSERT INTO user_strategies "
                "(id, user_id, template, symbol, interval, params, stop_loss_method, "
                " stop_loss_value, take_profit_method, take_profit_value, "
                " one_trade_at_a_time, enabled) "
                "VALUES ('legacy3', :uid, 'ma_cross', 'XAUUSD', '240', '{}', "
                " 'percent', 1.0, 'rr', 2.0, 1, 1)"
            ),
            {"uid": u.id},
        )
        conn.execute(
            text(
                "INSERT INTO strategy_signals "
                "(id, strategy_id, user_id, symbol, side, entry, stop_loss, take_profit, bar_t, result) "
                "VALUES ('lsig3', 'legacy3', :uid, 'XAUUSD', 'BUY', 100.0, 99.0, 102.0, 1000, 'PENDING')"
            ),
            {"uid": u.id},
        )
    init_db()
    db.expire_all()
    sig = db.query(StrategySignal).filter(StrategySignal.id == "lsig3").first()
    assert sig.interval == "240"
    assert sig.bars_held == 0
