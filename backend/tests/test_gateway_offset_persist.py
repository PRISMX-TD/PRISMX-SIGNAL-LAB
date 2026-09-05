"""rev 13：gateway 服务器时区偏移持久化到 mt5_accounts.server_utc_offset。

**为什么要测。** 偏移以前只在进程内存里，后端一重启就忘；忘了就按 0 把平仓时间
入库，而 closed_trades 按 deal_ticket 去重——错的时间永远不会自愈，只能靠
scripts/shift_closed_at.py 手工平移。这里钉住三件事：

  · 观测到的值写得进库、读得回来；
  · 本账号没观测过时能借同一网关下别的账号的值（网关只连一台服务器，偏移是
    服务器级的），但绝不借 bridge 账号的（那边的时间已在客户端换算过）；
  · 迁移真的在旧库上补了这一列，且不回填、版本号 bump 过。

Persisted server zone offset (rev 13). The offset used to be memory-only: lost on
restart, treated as 0 until re-observed, and closed_trades dedupes on deal_ticket so
a wrong timestamp never self-corrects. Pins: round-trip through the column, sibling
fallback restricted to gateway rows, and the migration adding the column on a
pre-rev-13 schema without backfill.
"""
import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod
from app.models import MT5Account, User
from app.routers import gateway as gw


def _user(db, uid: str) -> User:
    u = User(id=uid, email=f"{uid}@x.test", password_hash="x", api_token="tok_" + uid)
    db.add(u)
    db.commit()
    return u


def _account(db, uid: str, login: str, source: str = "gateway", offset=None) -> MT5Account:
    a = MT5Account(user_id=uid, login=login, server="", source=source, server_utc_offset=offset)
    db.add(a)
    db.commit()
    return a


@pytest.fixture(autouse=True)
def _clean_cache():
    gw._gateway_utc_offset.clear()
    yield
    gw._gateway_utc_offset.clear()


def test_store_then_load_roundtrip(db_session):
    _user(db_session, "u1")
    _account(db_session, "u1", "601144")

    assert gw.load_server_offset(db_session, "601144") is None
    gw.store_server_offset(db_session, "601144", 3 * 3600)
    assert gw.load_server_offset(db_session, "601144") == 3 * 3600.0
    # 存的是整数秒 / stored as integer seconds
    row = db_session.query(MT5Account).filter_by(login="601144").one()
    assert row.server_utc_offset == 10800


def test_store_updates_every_gateway_row_for_that_login(db_session):
    """两个用户绑同一账号：偏移是账号（其实是服务器）的属性，两行一起更新。"""
    _user(db_session, "u1")
    _user(db_session, "u2")
    _account(db_session, "u1", "601144")
    _account(db_session, "u2", "601144")
    _account(db_session, "u2", "601145")

    gw.store_server_offset(db_session, "601144", 7200)

    got = {
        (a.user_id, a.login): a.server_utc_offset
        for a in db_session.query(MT5Account).all()
    }
    assert got == {("u1", "601144"): 7200, ("u2", "601144"): 7200, ("u2", "601145"): None}


def test_load_borrows_sibling_gateway_login_but_never_bridge(db_session):
    _user(db_session, "u1")
    _account(db_session, "u1", "500001", source="bridge", offset=5 * 3600)   # 不该被借
    _account(db_session, "u1", "601144")                                     # 新绑定，没观测过

    assert gw.load_server_offset(db_session, "601144") is None

    _account(db_session, "u1", "601145", offset=3 * 3600)                    # 同网关的老账号
    assert gw.load_server_offset(db_session, "601144") == 3 * 3600.0
    # 自己有值时优先用自己的 / own value wins over a sibling's
    gw.store_server_offset(db_session, "601144", 2 * 3600)
    assert gw.load_server_offset(db_session, "601144") == 2 * 3600.0


def test_cached_offset_falls_back_to_any_login_then_zero():
    assert gw.cached_server_offset("601144") == 0.0
    gw._gateway_utc_offset["601145"] = -3600.0
    assert gw.cached_server_offset("601144") == -3600.0
    gw._gateway_utc_offset["601144"] = 10800.0
    assert gw.cached_server_offset("601144") == 10800.0


# ---- 迁移 / migration -----------------------------------------------------------

# rev 12 时的 mt5_accounts：有 rev 9 的三列，没有 server_utc_offset。手抄以锚定历史。
_LEGACY_DDL = """
CREATE TABLE mt5_accounts (
    id VARCHAR NOT NULL,
    user_id VARCHAR NOT NULL,
    login VARCHAR NOT NULL,
    server VARCHAR,
    source VARCHAR,
    account_name VARCHAR,
    account_currency VARCHAR,
    balance FLOAT,
    equity FLOAT,
    leverage INTEGER,
    company VARCHAR,
    symbol_suffix VARCHAR,
    mt5_group VARCHAR,
    trade_mode INTEGER,
    pass_change_at BIGINT,
    revoked_at DATETIME,
    revoked_reason VARCHAR,
    online BOOLEAN,
    last_heartbeat DATETIME,
    PRIMARY KEY (id),
    CONSTRAINT uq_user_login_server UNIQUE (user_id, login, server)
)
"""


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})

    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401

    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP TABLE mt5_accounts"))
        conn.execute(text(_LEGACY_DDL))

    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    try:
        yield eng
    finally:
        eng.dispose()


def test_rev13_adds_offset_column_null_for_existing_rows(legacy_engine):
    with legacy_engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO mt5_accounts (id, user_id, login, server, source, balance) "
            "VALUES ('a', 'u1', '601144', '', 'gateway', 100.0)"
        ))

    db_mod._migrate_columns()

    cols = {c["name"] for c in inspect(legacy_engine).get_columns("mt5_accounts")}
    assert "server_utc_offset" in cols
    with legacy_engine.connect() as conn:
        rows = conn.execute(text("SELECT login, balance, server_utc_offset FROM mt5_accounts")).all()
    # 不回填：猜一个值等于把可能错的时间写成"确定" / never backfilled
    assert rows == [("601144", 100.0, None)]
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


def test_revision_was_bumped():
    assert db_mod.CURRENT_SCHEMA_REV >= 13
