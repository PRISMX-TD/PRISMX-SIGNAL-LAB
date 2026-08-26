"""数据库连接与会话管理 / Database engine and session management."""
import json
import logging
import uuid

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from app.core.config import settings

logger = logging.getLogger("prismx.database")

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
    """创建所有数据表 / Create all tables.

    在 lifespan 里同步阻塞执行,跑完之前 uvicorn 不 bind 端口,所以这里的每一步都
    要够快(生产实测合计 0.7 秒)。新增迁移逻辑时留意别把启动时间拖长。
    Runs synchronously inside the lifespan and uvicorn won't bind the port until it
    returns, so every step here has to stay fast (measured at 0.7s in production).
    Watch out for lengthening startup when adding migration logic.
    """
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


# 迁移版本号。**每次给 _migrate_columns 增加新的迁移步骤时 +1。**
#
# 不加的后果不是报错，而是新迁移在已跑过的库上被静默跳过——建表能力由
# create_all 兜底，但补列、回填、建索引这些全都不会执行，问题会在很久以后
# 以"某列全是 NULL"的形式暴露出来。改这个函数就顺手改这里。
#
# Bump this whenever a new step is added to _migrate_columns. Forgetting doesn't
# raise — the new step is silently skipped on databases that already ran an older
# revision, and the damage surfaces much later as an unexpectedly NULL column.
# rev 2: users.phone / users.phone_required（注册强制记录手机号）
# rev 3: users.invite_code（邀请链接注册归因）+ idx_users_invite_code
# rev 4: notification_prefs.push_window_start/end/tz（推送时段限制）
# rev 5: invite_links.grants_trial（邀请链接注册自动开通试用）
# rev 6: closed_trades.verified（服务端归属核验）+ 去重键改为 (user_id, mt5_login, deal_ticket)
CURRENT_SCHEMA_REV = 6

_SCHEMA_REV_KEY = "schema_rev"


def _read_schema_rev() -> int | None:
    """读已应用的迁移版本号。表不存在或没有该行时返回 None（当成"没跑过"）。
    Read the applied migration revision; None means "never run" (or unreadable)."""
    try:
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT value FROM platform_settings WHERE key = :k"),
                {"k": _SCHEMA_REV_KEY},
            ).fetchone()
    except Exception:
        # 首次部署时 platform_settings 可能还不存在；当成没跑过，走完整迁移。
        # On a first deploy the table may not exist yet; treat as never-run.
        return None
    if not row or row[0] is None:
        return None
    try:
        return int(json.loads(row[0]))
    except (TypeError, ValueError):
        return None


def _write_schema_rev(rev: int) -> None:
    """记下已应用的版本号。写失败不致命——最多下次启动再全量跑一遍。
    Record the applied revision. A failure just means a full re-run next boot."""
    try:
        with engine.begin() as conn:
            updated = conn.execute(
                text("UPDATE platform_settings SET value = :v WHERE key = :k"),
                {"v": json.dumps(rev), "k": _SCHEMA_REV_KEY},
            ).rowcount
            if not updated:
                # id 是 String 主键、由 ORM 的 default=_uuid 生成；这里走裸 SQL
                # 绕过了 ORM，必须自己给值，否则 NOT NULL 约束会拒绝插入。
                # The id column is a String PK filled by the ORM's default; raw SQL
                # bypasses that, so supply one or the NOT NULL constraint rejects it.
                conn.execute(
                    text(
                        "INSERT INTO platform_settings (id, key, value) "
                        "VALUES (:id, :k, :v)"
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "k": _SCHEMA_REV_KEY,
                        "v": json.dumps(rev),
                    },
                )
    except Exception:
        logger.warning("写入 schema_rev 失败，下次启动会重跑一遍迁移", exc_info=True)


def _migrate_columns() -> None:
    """轻量迁移：为已存在的旧表补充新列（SQLite 不会自动加列）。
    Lightweight migration: add new columns to existing tables (SQLite won't).

    版本号快速通道：库里记的版本与 CURRENT_SCHEMA_REV 相同就直接返回。

    这段整体跑在 uvicorn bind 端口**之前**，每多花一秒就是多一秒 502。而它本身
    是一长串 inspect + ALTER + 回填 UPDATE，其中几条是无条件全表 UPDATE（历史
    档位重映射、bars_held 回填），在已经迁移完的库上每次重启都白跑一遍——命中的
    行早就是 0，但查询照发不误。

    所以日常重启走快速通道，只有真正改了 schema（手工把 CURRENT_SCHEMA_REV +1）
    才跑完整迁移。慢通道本身完全没动，全部语句仍然是幂等的，随时可以靠把库里的
    版本号调小来强制重跑。

    Fast path on a revision marker: return immediately when the database already
    records CURRENT_SCHEMA_REV. This whole function runs before uvicorn binds the
    port, so every second here is a second of 502s — and it is a long chain of
    inspect + ALTER + backfill UPDATEs, a few of which are unconditional
    full-table writes that match zero rows on an already-migrated database yet
    still get sent on every restart. The slow path is untouched and every
    statement in it remains idempotent, so lowering the stored revision forces a
    full re-run at any time.
    """
    applied = _read_schema_rev()
    if applied == CURRENT_SCHEMA_REV:
        logger.info("schema_rev=%d 已是最新，跳过列迁移", applied)
        return

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
            # Gateway 成交后的真实仓位号，平仓明细靠它判归属
            # real position id after a gateway fill; closed-trade attribution key
            "mt5_position": "INTEGER",
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
            "baseline_high": "FLOAT",
            "baseline_low": "FLOAT",
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
        # 推送时段限制（用户本地 "HH:MM" 起止 + IANA 时区）。NULL = 不限制，
        # 无需回填——语义上老行本来就是全天可推。
        # Push time-window (user-local "HH:MM" bounds + IANA timezone). NULL
        # means unrestricted, so no backfill: old rows already meant
        # "push all day".
        with engine.begin() as conn:
            for name in ("push_window_start", "push_window_end", "push_window_tz"):
                if name not in notif_cols:
                    conn.execute(text(f"ALTER TABLE notification_prefs ADD COLUMN {name} VARCHAR"))

    # closed_trades 表：① 补 verified 列（服务端归属核验结论，见 models 里的说明）；
    # ② 把去重唯一键从 (user_id, deal_ticket) 换成 (user_id, mt5_login, deal_ticket)。
    #
    # ② 是修一个静默丢数据的 bug：MT5 成交编号只在单个交易服务器内唯一，同一用户
    # 在两家券商各绑一个账号时可能撞号，旧键会把第二个账号那笔**真实**成交当成
    # 重复上报丢掉。新键比旧键更宽松，既有数据必然满足，换键本身不会失败。
    #
    # closed_trades: add the `verified` column, and widen the dedup key to
    # include mt5_login (deal tickets are only unique within one trade server,
    # so a user with two brokers could have a genuine deal silently dropped as a
    # duplicate). The new key is strictly looser, so existing rows always satisfy it.
    if "closed_trades" in inspector.get_table_names():
        ct_cols = {c["name"] for c in inspector.get_columns("closed_trades")}
        if "verified" not in ct_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE closed_trades ADD COLUMN verified BOOLEAN"))
            # 不回填：历史行无从判定归属（当时既没记录核验结论，也不保证订单仍在），
            # NULL 就是"上线前写入、未知"这个语义本身。
            # No backfill: NULL *is* the "written before this column existed" state.

        if is_postgres:
            # 命名约束可直接换。DROP 与 CREATE 分开跑：老库可能已经没有旧约束了。
            with engine.begin() as conn:
                conn.execute(text(
                    "ALTER TABLE closed_trades DROP CONSTRAINT IF EXISTS uq_user_deal_ticket"
                ))
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_user_login_deal_ticket "
                    "ON closed_trades (user_id, mt5_login, deal_ticket)"
                ))
        else:
            # SQLite 把 CREATE TABLE 里的 UNIQUE 约束实现成匿名自动索引，没法单独
            # DROP，只能整表重建。用模型自己的 DDL 建新表（不手抄一遍列定义，避免
            # 和模型漂移），整段跑在一个事务里：中途失败会整体回滚，不会留下半张表。
            # SQLite implements a table-level UNIQUE as an anonymous auto-index
            # that can't be dropped, so the table has to be rebuilt. The new table
            # is created from the model's own DDL (never a hand-copied column list)
            # and the whole dance runs in one transaction.
            # 检测必须走 get_unique_constraints：SQLite 把表级 UNIQUE 实现成
            # sqlite_autoindex_*，而 SQLAlchemy 的 get_indexes 会把这类自动索引
            # 过滤掉——用它检测会永远查不到旧约束，迁移静默不执行。
            # Detection must use get_unique_constraints: a table-level UNIQUE
            # becomes a sqlite_autoindex_*, which get_indexes filters out.
            legacy_key = {"user_id", "deal_ticket"}
            legacy_unique = any(
                set(uc.get("column_names") or []) == legacy_key
                for uc in inspector.get_unique_constraints("closed_trades")
            ) or any(
                idx.get("unique") and set(idx.get("column_names") or []) == legacy_key
                for idx in inspector.get_indexes("closed_trades")
            )
            if legacy_unique:
                from app.models import ClosedTrade  # 局部导入：本模块定义 Base，顶层导入会成环

                carried = [c.name for c in ClosedTrade.__table__.columns if c.name in ct_cols]
                cols_sql = ", ".join(carried)
                with engine.begin() as conn:
                    conn.execute(text("ALTER TABLE closed_trades RENAME TO closed_trades_legacy"))
                    ClosedTrade.__table__.create(bind=conn)
                    conn.execute(text(
                        f"INSERT INTO closed_trades ({cols_sql}) "
                        f"SELECT {cols_sql} FROM closed_trades_legacy"
                    ))
                    conn.execute(text("DROP TABLE closed_trades_legacy"))
                logger.info("closed_trades 已重建：去重键改为 (user_id, mt5_login, deal_ticket)")

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
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_strategy_signals_strategy_result "
            "ON strategy_signals(strategy_id, result)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_strategy_watch_symbol_interval "
            "ON strategy_watch(symbol, interval)"
        ))
        # 离线检测每 2 秒按 last_heartbeat 过滤一次在线账号（见 bridge.py 的
        # offline_monitor_loop）。没有这条索引，那个查询就是每 2 秒一次全表扫描，
        # 扫描量随注册用户数增长——而其中绝大多数账号并不在线。
        # The offline monitor filters live accounts by last_heartbeat every two
        # seconds (see offline_monitor_loop in bridge.py). Without this index that
        # query is a full table scan 30 times a minute, growing with the registered
        # user count — while almost none of those accounts are actually online.
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_mt5_accounts_heartbeat "
            "ON mt5_accounts(last_heartbeat)"
        ))
        # 规则：这一块跑在下面所有「补列」之前，所以**只能**放那些所依赖的列在
        # 旧库里一定已经存在的索引。要给本函数新补的列建索引，请放到对应的补列
        # 语句之后（例：users.invite_code 的索引在下面 users 块尾部）。违反这条
        # 规则的后果是启动即崩（no such column），而这段跑在 uvicorn bind 端口
        # 之前，线上等价于服务器起不来——commit e4bc076 修的就是这个。
        #
        # 已知例外，别照抄：上面 idx_strategy_signals_strategy_result 依赖的
        # strategy_signals.result 正是本函数在下面补的列，它违反了这条规则。这是
        # 早于本规则存在的遗留项，另行跟踪修复，不作为先例——新加的索引一律按
        # 规则来，不要"参考隔壁那条"。
        #
        # RULE: this block runs *before* every column-add below, so it may only
        # contain indexes whose columns are guaranteed to exist on old
        # databases. An index on a column this function itself adds must go
        # after that ADD COLUMN (see users.invite_code at the end of the users
        # block below). Breaking the rule crashes at startup with "no such
        # column", and this runs before uvicorn binds its port — in production
        # that is a server that never comes up. Commit e4bc076 fixed exactly
        # that.
        #
        # KNOWN EXCEPTION — DO NOT COPY: idx_strategy_signals_strategy_result
        # above depends on strategy_signals.result, which this same function
        # adds further down; it violates the rule. It predates the rule, is
        # tracked separately, and is not a precedent — new indexes follow the
        # rule rather than the neighbour.

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
            "token_version": "INTEGER",
            "google_linked_at": datetime_type,
            "phone": "VARCHAR",
            "phone_required": "BOOLEAN",
            "invite_code": "VARCHAR",
        }
        with engine.begin() as conn:
            for name, col_type in user_new.items():
                if name not in user_cols:
                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {col_type}"))
            # google_linked_at 回填：这个字段刚加进来时，无法从历史数据反推
            # "谁的账号最初是通过 Google 验证创建的"——干脆把当前所有已持有
            # 密码的老用户一律回填为已验证（用 created_at 兜底一个时间戳），
            # 即"新规则只管这次上线之后新出现的账号，老用户一个都不因为这次
            # 加固被反悔"。这正是本字段要修的那个问题（见 User 模型该列的
            # 说明）——回填错了方向，等于这次修复上线当天就把所有"Google 用户
            # 后来设了密码"的老用户重新坑一遍。留空（NULL）的分支才是真正
            # 该继续拦截的：这一行永远是 password_hash 非空、google_linked_at
            # 为空的组合，只可能出现在这次上线之后才创建的新密码账号上。
            # google_linked_at backfill: when this column first appears there is
            # no way to recover "which accounts originally came from Google" from
            # history — so every existing password-holding user is backfilled as
            # already-verified (created_at as a stand-in timestamp). In other
            # words: the stricter new rule only governs accounts that appear
            # after this ships; no existing user is retroactively punished by
            # it — which is exactly the bug this column exists to fix (see the
            # column's comment on the User model). Backfilling the other
            # direction would re-inflict the exact "set a password, Google login
            # breaks" bug on every existing Google-then-password user the day
            # this migration runs. The row shape that should keep being blocked
            # (password_hash set, google_linked_at null) can then only arise for
            # brand-new password accounts created after this ships.
            if "google_linked_at" not in user_cols:
                conn.execute(text(
                    "UPDATE users SET google_linked_at = created_at "
                    "WHERE password_hash IS NOT NULL AND google_linked_at IS NULL"
                ))
            # phone_required 回填：与上面 google_linked_at 完全同一种取舍——
            # 强制填手机号这条新规则只管本次上线之后新建的账号，此刻库里已有的
            # 用户一律豁免（产品决定）。把现存行全部置 False 就是在这一刻给
            # 「存量」划线；之后 SQLAlchemy 插入的新行走模型默认值 True。
            #
            # 必须放在 if 里只跑一次：如果每次启动都无条件 UPDATE，那些上线后
            # 新注册、还没补录手机号的用户会被反复豁免掉，强制补录直接失效。
            #
            # phone_required backfill: same tradeoff as google_linked_at above —
            # the mandatory-phone rule governs only accounts created after this
            # ships; everyone already in the table is grandfathered. Setting all
            # existing rows to False is what draws that line, at this instant;
            # rows inserted later take the model default of True.
            #
            # Guarded so it runs exactly once: an unconditional UPDATE on every
            # boot would keep re-exempting users who registered after launch and
            # haven't filled their phone in yet, silently disabling the whole rule.
            if "phone_required" not in user_cols:
                conn.execute(text("UPDATE users SET phone_required = FALSE"))
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
            # 会话版本号：新列刚加时为 NULL，但声明为 NOT NULL；老 token 里没有
            # "tv" 字段，鉴权时按 0 处理，与这里回填的默认值一致。
            # Session/token version: a freshly added column is NULL, but it's
            # declared NOT NULL; old tokens carry no "tv" claim and are treated
            # as version 0 at auth time, matching the backfill here.
            if "token_version" not in user_cols:
                conn.execute(text("UPDATE users SET token_version = 0 WHERE token_version IS NULL"))
            # 邀请链接注册人数按 invite_code 分组统计（admin 列表每次刷新都查）；
            # users 是既存表，create_all 不会给它补索引，必须在这里建。
            #
            # **必须留在上面那个 ADD COLUMN 循环之后**：invite_code 正是由那个
            # 循环补上的列，放到前面那个通用 CREATE INDEX 块里，旧库上就会以
            # "no such column: invite_code" 直接把迁移打断——而迁移跑在 uvicorn
            # bind 端口之前，等于服务器起不来。IF NOT EXISTS 在 SQLite 与
            # Postgres 上都支持，重复启动无害。
            #
            # Registration counts group users by invite_code on every admin list
            # load; users pre-exists, so create_all won't add this index for it.
            #
            # This MUST stay after the ADD COLUMN loop above: invite_code is one
            # of the columns that loop adds, so creating the index in the shared
            # CREATE INDEX block earlier in this function aborts the migration on
            # any pre-existing database with "no such column: invite_code" — and
            # since the migration runs before uvicorn binds its port, that means
            # the server never starts. IF NOT EXISTS is supported on both SQLite
            # and Postgres, so re-running on every boot is harmless.
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code)"
            ))

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
            "one_trade_at_a_time": "BOOLEAN",
            "rules": "TEXT",
            "exit_timeout_bars": "INTEGER",
            "session_filter": "TEXT",
            "daily_signal_cap": "INTEGER",
            "cooldown_minutes": "INTEGER",
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
            # 一次一单默认开启,对已有的启用中策略同样生效(不是只对新建策略);
            # 这是一个刻意收紧的默认行为——防止已经开着仓时还不断重复触发信号。
            # One-trade-at-a-time defaults on for existing enabled strategies
            # too, not just newly created ones — a deliberately tightened
            # default that stops a strategy from repeatedly firing while a
            # position is presumably still open.
            if "one_trade_at_a_time" not in us_cols:
                conn.execute(text(
                    "UPDATE user_strategies SET one_trade_at_a_time = TRUE WHERE one_trade_at_a_time IS NULL"
                ))
            # 回到单品种单周期后，多值时期建下的盯盘行会有一部分不再对应策略自己
            # 声明的 (symbol, interval)。留着它们等于让策略在它已经不声明的组合上
            # 继续被评估，必须删。策略行本身不用改：symbol / interval 两列在多值
            # 时期一直被同步写入（值为数组的首项），始终有效。
            # Back on one symbol and one interval, some watch rows created during
            # the multi-value era no longer match the strategy's own declared
            # (symbol, interval). Leaving them would keep evaluating a strategy on
            # combos it no longer declares, so they're deleted. The strategy rows
            # themselves need no change: the symbol/interval columns were kept
            # written throughout (holding the arrays' first entries) and stay valid.
            conn.execute(text(
                "DELETE FROM strategy_watch WHERE NOT EXISTS ("
                "  SELECT 1 FROM user_strategies s"
                "  WHERE s.id = strategy_watch.strategy_id"
                "    AND s.symbol = strategy_watch.symbol"
                "    AND s.interval = strategy_watch.interval"
                ")"
            ))

        # 遗留策略的停用与 strategy_watch 的回填都要跑 Python 侧逻辑，单独成
        # 函数，各自独立事务，幂等（只改不合法的行 / 只插缺失行）。
        # Disabling legacy strategies and backfilling strategy_watch both need
        # Python-side logic, so they get their own idempotent functions (only
        # touching invalid rows / inserting missing rows) in their own
        # transactions.
        _disable_legacy_strategies()
        _backfill_strategy_watch()

        # 放开历史遗留列的 NOT NULL 约束。止损止盈从 stop_loss_pct / take_profit_pct
        # / take_profit_r（旧结构）改成 method + value 后，这些旧列已不在模型里、
        # 新建策略不再给它们赋值；但生产旧表里它们仍是 NOT NULL，导致 INSERT 因
        # “旧列为 NULL”被 Postgres 拒绝（NotNullViolation），自定义策略无法保存。
        # 对任何“不在当前模型、却仍 NOT NULL”的旧列去掉非空约束即可，幂等
        # （已放开的列下次因 nullable 为真自动跳过）。仅 Postgres：全新 SQLite 库
        # 本就只按当前模型建表，不存在这些遗留列。
        # Relax NOT NULL on legacy leftover columns. After SL/TP moved from
        # stop_loss_pct / take_profit_pct / take_profit_r to method + value, those
        # old columns are gone from the model and no longer written on insert; but
        # in the production table they're still NOT NULL, so an INSERT is rejected
        # for leaving them NULL (Postgres NotNullViolation) and no custom strategy
        # can be saved. Drop NOT NULL on any column not in the current model that
        # is still NOT NULL — idempotent (already-nullable columns are skipped on
        # the next run). Postgres only: a fresh SQLite DB is built straight from
        # the current model and never has these leftovers.
        if is_postgres:
            current_us_cols = {
                "id", "user_id", "template", "name", "symbol", "interval", "params",
                "stop_loss_method", "stop_loss_value", "take_profit_method",
                "take_profit_value", "one_trade_at_a_time", "enabled",
                "last_signal_bar_t", "created_at", "updated_at",
                "rules", "exit_timeout_bars",
                "session_filter", "daily_signal_cap", "cooldown_minutes",
            }
            legacy_notnull = [
                c["name"]
                for c in inspector.get_columns("user_strategies")
                if c["name"] not in current_us_cols and not c["nullable"]
            ]
            if legacy_notnull:
                with engine.begin() as conn:
                    for name in legacy_notnull:
                        conn.execute(text(
                            f'ALTER TABLE user_strategies ALTER COLUMN "{name}" DROP NOT NULL'
                        ))
            # template 从必填变为可空：纯自定义 AST 的策略没有起源模板。旧表里它
            # 仍是 NOT NULL，不放开会让"不选预设直接搭规则"的保存被 Postgres 拒绝。
            # template went from required to nullable: a pure-custom-AST strategy
            # has no originating preset. It's still NOT NULL in an existing table,
            # so without relaxing it, saving a from-scratch rule tree is rejected.
            template_col = next(
                (c for c in inspector.get_columns("user_strategies") if c["name"] == "template"),
                None,
            )
            if template_col is not None and not template_col["nullable"]:
                with engine.begin() as conn:
                    conn.execute(text(
                        "ALTER TABLE user_strategies ALTER COLUMN template DROP NOT NULL"
                    ))

    # strategy_signals 表：补充胜负判定字段,供"一次一单"开关判断上一笔是否
    # 还开着(见 UserStrategy.one_trade_at_a_time 的说明)。
    # strategy_signals: add win/loss resolution columns, used by the
    # "one trade at a time" gate to tell whether the previous trade is still
    # open (see UserStrategy.one_trade_at_a_time's docstring).
    if "strategy_signals" in inspector.get_table_names():
        ss_cols = {c["name"] for c in inspector.get_columns("strategy_signals")}
        ss_new = {
            "result": "VARCHAR",
            "resolved_at": datetime_type,
            "baseline_high": "FLOAT",
            "baseline_low": "FLOAT",
            "interval": "VARCHAR",
            "bars_held": "INTEGER",
        }
        with engine.begin() as conn:
            for name, col_type in ss_new.items():
                if name not in ss_cols:
                    conn.execute(text(f"ALTER TABLE strategy_signals ADD COLUMN {name} {col_type}"))
            if "result" not in ss_cols:
                conn.execute(text("UPDATE strategy_signals SET result = 'PENDING' WHERE result IS NULL"))
            # bars_held 声明为 NOT NULL default 0，新列刚加时为 NULL。
            # bars_held is NOT NULL default 0, but a freshly added column is NULL.
            conn.execute(text("UPDATE strategy_signals SET bars_held = 0 WHERE bars_held IS NULL"))
            # interval 回填：旧信号表没有周期列，唯一可靠来源是它所属策略当时的
            # 单值 interval 列。取不到的留 NULL，由判定逻辑当"周期未知"处理
            # （不参与超时计数），而不是猜一个值。
            # Backfill interval: the old table had no interval column, and the
            # only reliable source is the owning strategy's single-value column.
            # Rows where that's unavailable stay NULL and are treated as
            # "interval unknown" by resolution (excluded from timeout counting)
            # rather than guessed.
            conn.execute(text(
                "UPDATE strategy_signals SET interval = ("
                "  SELECT us.interval FROM user_strategies us WHERE us.id = strategy_signals.strategy_id"
                ") WHERE interval IS NULL"
            ))

    # payments 表：补充 NOWPayments 实际到账金额，用于向少转/漏转的用户如实
    # 展示"已收到部分金额"而不是让钱看起来凭空消失。
    # payments: add the NOWPayments-reported actual amount received, so a
    # user who under-sent sees "partial amount received" instead of the funds
    # appearing to vanish.
    if "payments" in inspector.get_table_names():
        payment_cols = {c["name"] for c in inspector.get_columns("payments")}
        if "actually_paid" not in payment_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE payments ADD COLUMN actually_paid FLOAT"))

    # invite_links：新增「经此链接注册自动开通试用」开关。这张表在此之前从未
    # 改过列，所以本块是它的第一段迁移。回填成 FALSE 而不是留 NULL：NULL 在
    # Python 侧同样是 falsy，行为不会错，但管理页的开关会渲染成未定态、审计
    # 快照会记成 null，把一个状态明确的链接记成状态不明。
    # invite_links: add the "auto-grant trial on signup" switch. First migration
    # this table has ever needed. Backfilled to FALSE rather than left NULL —
    # NULL is falsy so behaviour would be correct, but the admin toggle renders
    # indeterminate and audit snapshots record null for a link whose state is
    # in fact perfectly definite.
    if "invite_links" in inspector.get_table_names():
        invite_cols = {c["name"] for c in inspector.get_columns("invite_links")}
        if "grants_trial" not in invite_cols:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE invite_links ADD COLUMN grants_trial BOOLEAN"))
                conn.execute(text(
                    "UPDATE invite_links SET grants_trial = FALSE WHERE grants_trial IS NULL"
                ))

    # 全部步骤跑完才记版本号：中途抛异常就不写，下次启动会重跑（所有步骤幂等）。
    # Only recorded after every step succeeded: an exception midway leaves the marker
    # untouched so the next boot retries (every step is idempotent).
    _write_schema_rev(CURRENT_SCHEMA_REV)
    logger.info("列迁移完成，schema_rev=%d", CURRENT_SCHEMA_REV)


def _disable_legacy_strategies() -> None:
    """把 rules 不符合新条件结构的策略停用（幂等）。

    旧 AST 交给新引擎不会报错，只会对每根 bar 返回 None——策略看着是启用的却
    永远不触发。静默失效比停用更坏：用户不会去检查一条"正常启用"的策略。停用
    后用户在页面上能看到它被停了，重新配置一次即可。这里不尝试自动转换：旧 AST
    的表达能力（嵌套分组、任意操作数、多周期引用）超出新结构，任何自动映射都
    只能是猜测。

    Disable strategies whose `rules` don't match the new condition structure
    (idempotent). A legacy AST doesn't raise in the new engine — it just yields
    None for every bar, leaving a strategy that looks enabled but can never
    fire. Silent failure is worse than being switched off: nobody audits a
    strategy that reads as healthy. Once disabled the user sees it and can
    reconfigure. No automatic conversion is attempted: the old AST's expressive
    range (nested groups, arbitrary operands, cross-interval references) exceeds
    the new structure, so any mapping would be guesswork.
    """
    import json as _json
    import logging as _logging

    from app.services.strategy.conditions import ConditionError, validate_conditions

    log = _logging.getLogger("prismx.migration")
    db = SessionLocal()
    try:
        from app.models import UserStrategy

        changed = 0
        for row in db.query(UserStrategy).filter(UserStrategy.enabled.is_(True)).all():
            try:
                validate_conditions(_json.loads(row.rules or "{}"))
            except (ConditionError, ValueError, TypeError):
                row.enabled = False
                changed += 1
                log.warning("disable_legacy_strategies: disabled strategy %s (legacy rules)", row.id)
        if changed:
            db.commit()
            log.info("disable_legacy_strategies: disabled %d legacy strategy row(s)", changed)
    finally:
        db.close()


def _backfill_strategy_watch() -> None:
    """按每条策略的单个 (品种, 周期) 补齐 strategy_watch 缺失行（幂等）。
    Insert the missing strategy_watch row for each strategy's single
    (symbol, interval) pair (idempotent)."""
    db = SessionLocal()
    try:
        from app.models import StrategyWatch, UserStrategy

        existing = {(w.strategy_id, w.symbol, w.interval) for w in db.query(StrategyWatch).all()}
        added = 0
        for row in db.query(UserStrategy).all():
            if not row.symbol or not row.interval:
                continue
            key = (row.id, row.symbol, row.interval)
            if key in existing:
                continue
            db.add(StrategyWatch(strategy_id=row.id, symbol=row.symbol, interval=row.interval))
            existing.add(key)
            added += 1
        if added:
            db.commit()
    finally:
        db.close()
