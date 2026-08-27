"""账户类型的落库侧：rev 7 迁移 + 前缀规则的存取。

分类逻辑本身在 test_account_type.py；这里管的是"存不存得下、改不改得动"：

- **迁移**：`mt5_accounts` 是既有表，`create_all` 不会给它补列，必须靠 rev 7 的
  ALTER 补上——漏了不会报错，只会让这两列在生产库上永远是 NULL（正是
  CURRENT_SCHEMA_REV 那段注释警告的失败方式）。
- **前缀规则可改**：券商命名不守惯例时，运维要能改设置而不改代码。存进
  PlatformSetting 之后必须真的读得回来，且部分覆盖不能把没提到的那几档清空。

Persistence side of account-type classification: the rev 7 migration (mt5_accounts
is a pre-existing table, so create_all won't add the columns) and the settings
round-trip that lets ops adjust prefixes without a code change.
"""
import pytest
from sqlalchemy import create_engine, inspect, text

import app.core.database as db_mod
from app.services.account_type import DEMO, REAL, classify_group
from app.services.settings_store import (
    ACCOUNT_TYPE_DEFAULTS,
    get_account_type_settings,
    invalidate_account_type_cache,
    save_account_type_settings,
)


# 迁移前的 mt5_accounts：没有 mt5_group / trade_mode 两列。
# 手抄是故意的——它锚定"升级前长什么样"，不能跟着模型漂移。
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
        conn.execute(text(
            "INSERT INTO mt5_accounts (id, user_id, login, source, balance) "
            "VALUES ('a', 'u1', '500001', 'gateway', 1000.0)"
        ))

    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    try:
        yield eng
    finally:
        eng.dispose()


def test_rev7_adds_the_columns_without_touching_existing_rows(legacy_engine):
    db_mod._migrate_columns()

    cols = {c["name"] for c in inspect(legacy_engine).get_columns("mt5_accounts")}
    assert {"mt5_group", "trade_mode"} <= cols, "rev 7 没把两列补上"

    with legacy_engine.connect() as conn:
        row = conn.execute(
            text("SELECT login, balance, mt5_group, trade_mode FROM mt5_accounts WHERE id='a'")
        ).one()
    assert (row[0], row[1]) == ("500001", 1000.0), "既有数据被动了"
    assert row[2] is None and row[3] is None, (
        "历史行不该被回填——猜一个默认值就可能把模拟盘标成实盘，"
        "正确做法是等下一次账号刷新按组名判出来"
    )


def test_rev7_is_idempotent(legacy_engine):
    db_mod._migrate_columns()
    db_mod._write_schema_rev(0)  # 强制再跑一次完整迁移
    db_mod._migrate_columns()

    with legacy_engine.connect() as conn:
        n = conn.execute(text("SELECT COUNT(*) FROM mt5_accounts")).scalar()
    assert n == 1


class _FakeDB:
    """settings_store 只用到 query/add，不需要真库。"""

    def __init__(self):
        self.rows = []

    def query(self, model):
        return self

    def filter(self, *args):
        return self

    def first(self):
        return self.rows[0] if self.rows else None

    def add(self, row):
        self.rows.append(row)


@pytest.fixture(autouse=True)
def _clean_settings_cache():
    invalidate_account_type_cache()
    yield
    invalidate_account_type_cache()


def test_defaults_apply_when_nothing_is_stored():
    got = get_account_type_settings(_FakeDB())
    assert got == ACCOUNT_TYPE_DEFAULTS
    # 用线上真实的真仓组名，不用通用的 real\ —— 出厂配置刻意是严格白名单
    assert classify_group("MCSA\\I-STD-SLAB-USD", got) == REAL


def test_ops_can_override_prefixes_without_a_code_change():
    """券商命名不守惯例的情况：改设置即可，代码不动。"""
    db = _FakeDB()
    save_account_type_settings(db, {"real_group_prefixes": ["mc-live", "real"]})

    got = get_account_type_settings(db)

    assert classify_group("mc-live\\gold", got) == REAL
    assert classify_group("real\\ecn", got) == REAL


def test_partial_save_keeps_the_other_buckets():
    """只改真仓前缀，不能把模拟/竞赛那两档清空。"""
    db = _FakeDB()
    save_account_type_settings(db, {"real_group_prefixes": ["mc-live"]})

    got = get_account_type_settings(db)

    assert got["demo_group_prefixes"] == ACCOUNT_TYPE_DEFAULTS["demo_group_prefixes"]
    assert classify_group("demo\\forex", got) == DEMO


def test_save_invalidates_the_cache():
    """改完设置要立刻生效，不能等 30 秒 TTL——否则运维改完看不到变化会重复改。"""
    db = _FakeDB()
    assert classify_group("mc-live\\gold", get_account_type_settings(db)) is None

    save_account_type_settings(db, {"real_group_prefixes": ["mc-live"]})

    assert classify_group("mc-live\\gold", get_account_type_settings(db)) == REAL
