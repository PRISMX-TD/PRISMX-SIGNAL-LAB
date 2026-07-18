"""数据库连接与会话管理 / Database engine and session management."""
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from app.core.config import settings

# SQLite 需要 check_same_thread=False 以支持多线程 / SQLite needs this for multithreading
_is_sqlite = settings.DATABASE_URL.startswith("sqlite")
connect_args = {"check_same_thread": False} if _is_sqlite else {}

# 连接池参数仅对 Postgres 等真实连接池生效；SQLite 不使用 QueuePool，传了会报错。
# pool_pre_ping：取用前先探活，跨区/Pooler 断连时自动重连，避免拿到坏连接。
# Pool params apply to real pools (Postgres); SQLite doesn't use QueuePool.
# pool_pre_ping checks a connection before use so a dropped cross-region /
# pooler connection is transparently replaced instead of erroring.
_engine_kwargs: dict = {"connect_args": connect_args}
if not _is_sqlite:
    _engine_kwargs.update(
        pool_size=settings.DB_POOL_SIZE,
        max_overflow=settings.DB_MAX_OVERFLOW,
        pool_recycle=settings.DB_POOL_RECYCLE,
        pool_pre_ping=True,
    )

engine = create_engine(settings.DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    """FastAPI 依赖：提供数据库会话 / FastAPI dependency: yield a DB session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """创建所有数据表 / Create all tables."""
    # 导入模型以注册到 Base / import models so they register on Base
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _migrate_columns()
    _hash_legacy_api_tokens()


def _hash_legacy_api_tokens() -> None:
    """把历史明文 API Token 原地哈希（一次性迁移）。

    新方案数据库只存 SHA-256；旧行以 "prismx_" 开头即为明文，哈希后覆盖。
    用户侧无感：Bridge 里填的明文 token 请求时会先哈希再比对，仍然有效。

    Hash legacy plaintext API tokens in place (one-off migration). The new
    scheme stores only the SHA-256; legacy rows start with "prismx_" and get
    hashed over. Transparent to users: the plaintext token in their bridge
    still authenticates (incoming tokens are hashed before comparison).
    """
    from app.core.security import hash_api_token
    from app.models import User

    db = SessionLocal()
    try:
        legacy = db.query(User).filter(User.api_token.like("prismx\\_%", escape="\\")).all()
        for u in legacy:
            u.api_token = hash_api_token(u.api_token)
        if legacy:
            db.commit()
    finally:
        db.close()


def _migrate_columns() -> None:
    """轻量迁移：为已存在的旧表补充新列（SQLite 不会自动加列）。
    Lightweight migration: add new columns to existing tables (SQLite won't).
    """
    # 跨数据库的列类型映射 / cross-DB column type mapping
    is_postgres = settings.DATABASE_URL.startswith("postgres")
    datetime_type = "TIMESTAMP" if is_postgres else "DATETIME"

    inspector = inspect(engine)

    # 旧 ea_bindings 表已随 EA 接入方式停用：不再迁移、不再读写（生产库保留不删）。
    # The legacy ea_bindings table is retired with the EA integrations: no longer
    # migrated, read or written (kept in place in production).

    # orders 表：补充新列 / add new columns on orders
    if "orders" in inspector.get_table_names():
        order_cols = {c["name"] for c in inspector.get_columns("orders")}
        order_new = {
            "mt5_login": "VARCHAR",
            "delivered_at": datetime_type,
            "action": "VARCHAR",
            "ticket": "INTEGER",
            "sl": "FLOAT",
            "tp": "FLOAT",
            "position_last_seen_open": datetime_type,
        }
        with engine.begin() as conn:
            for name, col_type in order_new.items():
                if name not in order_cols:
                    conn.execute(text(f"ALTER TABLE orders ADD COLUMN {name} {col_type}"))

    # signals 表：补充来源、去重、胜负判定列 / add source, dedup & result columns on signals
    if "signals" in inspector.get_table_names():
        signal_cols = {c["name"] for c in inspector.get_columns("signals")}
        signal_new = {
            "source": "VARCHAR",
            "external_id": "VARCHAR",
            "result": "VARCHAR",
            "resolved_at": datetime_type,
        }
        with engine.begin() as conn:
            for name, col_type in signal_new.items():
                if name not in signal_cols:
                    conn.execute(text(f"ALTER TABLE signals ADD COLUMN {name} {col_type}"))
            # 旧行补默认值：新列刚加时都是 NULL，胜负判定要按 'PENDING' 才能被追踪到。
            # Backfill existing rows: a freshly added column is NULL for old rows,
            # but resolution logic filters on result == 'PENDING' to find them.
            if "result" not in signal_cols:
                conn.execute(text("UPDATE signals SET result = 'PENDING' WHERE result IS NULL"))

    # notification_prefs 表：补充事件类通知白名单（订单成交/拒绝、自动仓管
    # 触发、Bridge 掉线），与既有的指标类别白名单分开存放。
    # notification_prefs: add the event-notification whitelist (order
    # fill/reject, auto-manage trigger, bridge offline), stored separately
    # from the existing indicator-category whitelist.
    if "notification_prefs" in inspector.get_table_names():
        notif_cols = {c["name"] for c in inspector.get_columns("notification_prefs")}
        if "event_types" not in notif_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE notification_prefs ADD COLUMN event_types TEXT"))
        # 品种白名单是新加的第二道过滤维度：老行加这列前从未按品种过滤过，
        # 直接补默认值 "[]" 会让所有已开启通知的老用户瞬间收不到任何推送
        # （与品种维度做"与"时，空白名单恒为假）。回填 __ALL__ 哨兵，保持
        # 老用户升级前后行为不变。
        # The symbol whitelist is a new second filter dimension: existing rows
        # never filtered by symbol before this column existed, so leaving it
        # at the plain "[]" default would silently stop all push for every
        # user who already had notifications on (empty ANDed with symbol is
        # always false). Backfill the __ALL__ sentinel so upgrading doesn't
        # change existing users' behavior.
        if "selected_symbols" not in notif_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE notification_prefs ADD COLUMN selected_symbols TEXT"))
                conn.execute(text(
                    'UPDATE notification_prefs SET selected_symbols = \'["__ALL__"]\' WHERE selected_symbols IS NULL'
                ))

    # 后台清扫/过期扫描用的索引：create_all 不会为已存在的表补索引，这里补。
    # Indexes for the background sweeps: create_all won't add indexes to
    # pre-existing tables, so do it here (IF NOT EXISTS on both dialects).
    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)"))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_signals_status_expire ON signals(status, expire_at)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_signals_symbol_result ON signals(symbol, result)"
        ))

    # users 表：password_hash 改可空（Google 登录用户无密码）。
    # 旧表建表时为 NOT NULL，需放开约束，否则插入无密码用户会被拒。
    # users: make password_hash nullable (Google users have no password).
    if "users" in inspector.get_table_names():
        pw_col = next(
            (c for c in inspector.get_columns("users") if c["name"] == "password_hash"),
            None,
        )
        if pw_col is not None and not pw_col["nullable"] and is_postgres:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"))

        # 用户分级：补充 role / plan 及相关列（旧表建表时没有）。
        # User tiering: add role / plan and related columns (missing on pre-existing tables).
        user_cols = {c["name"] for c in inspector.get_columns("users")}
        user_new = {
            "role": "VARCHAR",
            "plan": "VARCHAR",
            "plan_expires_at": datetime_type,
            "plan_note": "VARCHAR",
            "last_active_at": datetime_type,
            "bridge_version": "VARCHAR",
            "trial_used_at": datetime_type,
            "plan_is_trial": "BOOLEAN",
        }
        with engine.begin() as conn:
            for name, col_type in user_new.items():
                if name not in user_cols:
                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {col_type}"))
            # 旧行补默认值：新列刚加时为 NULL，但 role/plan 声明为 NOT NULL。
            # Backfill existing rows: a freshly added column is NULL, but
            # role/plan are declared NOT NULL.
            if "role" not in user_cols:
                conn.execute(text("UPDATE users SET role = 'user' WHERE role IS NULL"))
            if "plan" not in user_cols:
                conn.execute(text("UPDATE users SET plan = 'FREE' WHERE plan IS NULL"))
            # 等级体系并为两级（FREE/PRO），历史值就地映射（幂等）。
            # Tier system consolidated to two (FREE/PRO);
            # remap legacy values in place (idempotent).
            conn.execute(text("UPDATE users SET plan = 'PRO' WHERE plan IN ('BETA', 'PLUS', 'PARTNER', 'ELITE')"))
            # 免费试用标记：新列刚加时为 NULL，但声明为 NOT NULL。
            # Free-trial flag: a freshly added column is NULL, but it's declared NOT NULL.
            if "plan_is_trial" not in user_cols:
                conn.execute(text("UPDATE users SET plan_is_trial = FALSE WHERE plan_is_trial IS NULL"))

    # user_strategies 表：止损止盈从"百分比距离 + R 倍数"一种固定组合改成
    # 两个方式独立可选，外加策略命名。已启用的策略要按原逻辑等价换算成新
    # 表示，不能让正在跑的策略静默换成别的止损止盈行为。
    # user_strategies: SL/TP moved from one fixed "% distance + R multiple"
    # combo to two independently selectable methods, plus a name field.
    # Backfill existing rows to the equivalent new representation — an
    # already-enabled strategy must not silently switch to different SL/TP
    # behavior on upgrade.
    if "user_strategies" in inspector.get_table_names():
        us_cols = {c["name"] for c in inspector.get_columns("user_strategies")}
        us_new = {
            "name": "VARCHAR",
            "stop_loss_method": "VARCHAR",
            "stop_loss_value": "FLOAT",
            "take_profit_method": "VARCHAR",
            "take_profit_value": "FLOAT",
        }
        with engine.begin() as conn:
            for name, col_type in us_new.items():
                if name not in us_cols:
                    conn.execute(text(f"ALTER TABLE user_strategies ADD COLUMN {name} {col_type}"))
            if "stop_loss_method" not in us_cols:
                if "stop_loss_pct" in us_cols:
                    conn.execute(text(
                        "UPDATE user_strategies SET stop_loss_method = 'percent', stop_loss_value = stop_loss_pct "
                        "WHERE stop_loss_method IS NULL"
                    ))
                else:
                    conn.execute(text(
                        "UPDATE user_strategies SET stop_loss_method = 'percent', stop_loss_value = 1.0 "
                        "WHERE stop_loss_method IS NULL"
                    ))
            if "take_profit_method" not in us_cols:
                if "take_profit_r" in us_cols:
                    conn.execute(text(
                        "UPDATE user_strategies SET take_profit_method = 'rr', take_profit_value = take_profit_r "
                        "WHERE take_profit_method IS NULL"
                    ))
                else:
                    conn.execute(text(
                        "UPDATE user_strategies SET take_profit_method = 'rr', take_profit_value = 2.0 "
                        "WHERE take_profit_method IS NULL"
                    ))
