"""实盘标记「信得过的说了算」（2026-09-06）：来源列 + 桥接自报只做参考。

  · 券商组名 / 登录号段规则 / 服务器名规则（含 demo 字样）先判，自报压不过；
  · 自报只能把规则判成实盘的账号往下降（安全方向），不能往上抬；
  · 规则判不出来才采用自报，来源标 self；有组名但没判出来的不采用自报；
  · 每小时循环用规则重判 self 行；rev 15 迁移回填来源；管理端榜单预览带来源。

Trusted sources decide trade_mode; the bridge's self-report is only a hint,
marked `self`, re-checked hourly, and flagged in the admin leaderboard preview.
"""
from datetime import datetime, timezone

from app.models import LeaderboardSnapshot, MT5Account, User
from app.routers.bridge import BridgeAccount, _upsert_account
from app.routers.gamification import build_board_rows_payload
from app.services.account_type import (
    DEMO, REAL, SOURCE_GROUP, SOURCE_LOGIN_RULE, SOURCE_SELF, SOURCE_SERVER_RULE,
    apply_self_reported, classify_account_with_source, classify_server,
)
from app.services.gamification.loop import backfill_account_trade_modes
from app.services.settings_store import ACCOUNT_TYPE_DEFAULTS


def _user(db, email):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _poll(db, uid, login, server, trade_mode=None):
    acc = BridgeAccount(login=login, server=server, tradeMode=trade_mode)
    row, _ = _upsert_account(db, uid, acc, existing_count=0, account_limit=None)
    db.commit()
    return row


# ---- 纯函数 / pure helpers ---------------------------------------------------------

def test_demo_keyword_in_server_name_forces_demo():
    assert classify_server("HolaPrime-Demo", ACCOUNT_TYPE_DEFAULTS) == DEMO
    assert classify_server("demoserver01", ACCOUNT_TYPE_DEFAULTS) == DEMO
    assert classify_server("HolaPrime-Server1", ACCOUNT_TYPE_DEFAULTS) is None
    assert classify_server("Foo-Live", {**ACCOUNT_TYPE_DEFAULTS, "demo_server_keywords": []}) is None


def test_with_source_reports_which_rule_decided():
    s = ACCOUNT_TYPE_DEFAULTS
    assert classify_account_with_source("demo\\x", "Any", "1", s) == (DEMO, SOURCE_GROUP)
    assert classify_account_with_source(None, "MakeCapital-Live", "600123", s) == (REAL, SOURCE_LOGIN_RULE)
    assert classify_account_with_source(None, "Foo-Demo", "1", s) == (DEMO, SOURCE_SERVER_RULE)
    assert classify_account_with_source(None, "Unknown-Live", "1", s) == (None, None)


def test_apply_self_reported_only_lowers_never_raises():
    assert apply_self_reported(REAL, DEMO) == DEMO        # 往下降：采信
    assert apply_self_reported(DEMO, REAL) == DEMO        # 往上抬：不采信
    assert apply_self_reported(REAL, REAL) == REAL
    assert apply_self_reported(REAL, None) == REAL
    assert apply_self_reported(None, REAL) == REAL        # 没规则：用自报
    assert apply_self_reported(None, None) is None


# ---- 桥接轮询 / _upsert_account ----------------------------------------------------

def test_self_reported_real_on_demo_server_is_demo(db_session):
    u = _user(db_session, "tm1@t.co")
    row = _poll(db_session, u.id, "1", "Broker-Demo", trade_mode=REAL)
    assert (row.trade_mode, row.trade_mode_source) == (DEMO, SOURCE_SERVER_RULE)


def test_self_reported_real_cannot_override_login_rule_demo(db_session):
    u = _user(db_session, "tm2@t.co")
    row = _poll(db_session, u.id, "100016", "MakeCapital-Live", trade_mode=REAL)
    assert (row.trade_mode, row.trade_mode_source) == (DEMO, SOURCE_LOGIN_RULE)


def test_self_reported_demo_may_lower_login_rule_real(db_session):
    u = _user(db_session, "tm3@t.co")
    row = _poll(db_session, u.id, "600123", "MakeCapital-Live", trade_mode=DEMO)
    assert (row.trade_mode, row.trade_mode_source) == (DEMO, SOURCE_SELF)


def test_rule_real_without_self_report_is_rule_sourced(db_session):
    u = _user(db_session, "tm4@t.co")
    row = _poll(db_session, u.id, "600123", "MakeCapital-Live")
    assert (row.trade_mode, row.trade_mode_source) == (REAL, SOURCE_LOGIN_RULE)


def test_self_report_used_when_no_rule_applies_and_marked_self(db_session):
    u = _user(db_session, "tm5@t.co")
    row = _poll(db_session, u.id, "777", "HolaPrime-Server1", trade_mode=REAL)
    assert (row.trade_mode, row.trade_mode_source) == (REAL, SOURCE_SELF)


def test_known_but_unclassified_group_ignores_self_report(db_session):
    u = _user(db_session, "tm6@t.co")
    db_session.add(MT5Account(user_id=u.id, login="888", server="Some-Live", mt5_group="weird\\grp"))
    db_session.commit()
    row = _poll(db_session, u.id, "888", "Some-Live", trade_mode=REAL)
    assert row.trade_mode is None and row.trade_mode_source is None


def test_old_bridge_without_trademode_and_no_rule_leaves_value_alone(db_session):
    u = _user(db_session, "tm7@t.co")
    db_session.add(MT5Account(user_id=u.id, login="999", server="Some-Live",
                              trade_mode=REAL, trade_mode_source=SOURCE_SELF))
    db_session.commit()
    row = _poll(db_session, u.id, "999", "Some-Live")
    assert (row.trade_mode, row.trade_mode_source) == (REAL, SOURCE_SELF)


# ---- 每小时循环重判 / hourly re-check ----------------------------------------------

def test_loop_rejudges_self_reported_rows_with_rules(db_session):
    u = _user(db_session, "tm8@t.co")
    rows = [
        MT5Account(user_id=u.id, login="1", server="Foo-Demo", trade_mode=REAL, trade_mode_source=SOURCE_SELF),
        MT5Account(user_id=u.id, login="600555", server="MakeCapital-Live", trade_mode=REAL, trade_mode_source=SOURCE_SELF),
        MT5Account(user_id=u.id, login="600556", server="MakeCapital-Live", trade_mode=DEMO, trade_mode_source=SOURCE_SELF),
        MT5Account(user_id=u.id, login="3", server="HolaPrime-Server1", trade_mode=REAL, trade_mode_source=None),
        MT5Account(user_id=u.id, login="4", server="HolaPrime-Server1", trade_mode=REAL, trade_mode_source=SOURCE_SELF),
        MT5Account(user_id=u.id, login="5", server="MakeCapital-Live", trade_mode=None),
    ]
    db_session.add_all(rows); db_session.commit()
    changed = backfill_account_trade_modes(db_session)
    got = {r.login: (r.trade_mode, r.trade_mode_source)
           for r in db_session.query(MT5Account).filter_by(user_id=u.id)}
    assert got["1"] == (DEMO, SOURCE_SERVER_RULE)        # 自报实盘、服务器带 demo → 改回模拟
    assert got["600555"] == (REAL, SOURCE_LOGIN_RULE)    # 规则也说实盘 → 来源升级
    assert got["600556"] == (DEMO, SOURCE_SELF)          # 自报往下降 → 保留
    assert got["3"] == (REAL, SOURCE_SELF)               # 来源未知的旧行 → 标 self
    assert got["4"] == (REAL, SOURCE_SELF)               # 没规则 → 不动
    assert got["5"] == (DEMO, SOURCE_LOGIN_RULE)         # 没判过 → default=demo
    assert changed == 4


# ---- 管理端预览带来源 / admin preview flag ------------------------------------------

def test_admin_preview_carries_source_and_user_view_does_not(db_session):
    admin = _user(db_session, "tm9a@t.co")
    u = _user(db_session, "tm9@t.co")
    db_session.add(MT5Account(user_id=u.id, login="L1", server="s", trade_mode=REAL, trade_mode_source=SOURCE_SELF))
    db_session.add(LeaderboardSnapshot(board="return_pct", period_key="2026-W36", user_id=u.id,
                                       mt5_login="L1", rank=1, score=0.1, sample=6))
    db_session.commit()
    shown = build_board_rows_payload(db_session, admin, "return_pct", "2026-W36", reveal=True)
    assert shown["rows"][0]["tradeModeSource"] == SOURCE_SELF
    hidden = build_board_rows_payload(db_session, u, "return_pct", "2026-W36")
    assert "tradeModeSource" not in hidden["rows"][0]


# ---- rev 15 迁移 / migration ------------------------------------------------------

def test_rev15_adds_columns_and_backfills_source(monkeypatch, tmp_path):
    import app.core.database as db_mod
    from sqlalchemy import create_engine, inspect, text
    from sqlalchemy.orm import sessionmaker
    from app.core.database import Base
    import app.models  # noqa: F401

    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE mt5_accounts DROP COLUMN trade_mode_source"))
        conn.execute(text("ALTER TABLE period_baselines DROP COLUMN flows"))
        conn.execute(text(
            "INSERT INTO mt5_accounts (id, user_id, login, server, mt5_group, trade_mode) VALUES "
            "('a', 'u1', '1', 's', 'real\\grp', 2), ('b', 'u1', '2', 's', NULL, 2), ('c', 'u1', '3', 's', NULL, NULL)"
        ))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    try:
        db_mod._migrate_columns()
        insp = inspect(eng)
        assert "trade_mode_source" in {c["name"] for c in insp.get_columns("mt5_accounts")}
        assert "flows" in {c["name"] for c in insp.get_columns("period_baselines")}
        with eng.connect() as conn:
            got = dict(conn.execute(text("SELECT id, trade_mode_source FROM mt5_accounts")).all())
        assert got == {"a": "group", "b": "self", "c": None}
        assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV >= 15
    finally:
        eng.dispose()
