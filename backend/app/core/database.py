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
# rev 7: mt5_accounts.mt5_group / trade_mode（账户实盘判定）
# rev 8: 修 closed_trades 重建：SQLite 索引撞名导致重建中途失败、数据滞留在
#        closed_trades_legacy 里。必须 +1——中招的库在第二次启动时会因为"新表已经
#        是新键"而跳过整段并写下 rev 7，此后一路走快速通道，数据永远搬不回来。
# rev 9: mt5_accounts.pass_change_at / revoked_at / revoked_reason
#        （gateway 绑定的撤销机制：券商侧改密码后作废旧绑定）
# rev 10 — users 昵称/隐私/佩戴 4 列、orders.trade_mode 快照 + 存量回填、user_active_days 等新表、游戏化索引
# rev 11 — users.equipped_badges（可佩戴 3 枚，有序，首枚 = equipped_badge 那枚默认；从旧列回填）
# rev 12 — competitions.min_baseline_usd / min_trades（每场比赛可覆盖入榜门槛；track 列已存在，本次起真正启用 real/demo）
# rev 13 — mt5_accounts.server_utc_offset（gateway 服务器时区偏移持久化，重启不再丢；不回填，NULL=从未观测）
CURRENT_SCHEMA_REV = 13

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


def _rebuild_closed_trades_sqlite() -> None:
    """把 SQLite 上的 closed_trades 重建成新的去重键。**可中断、可重入。**

    为什么要重建：SQLite 把表级 UNIQUE 实现成匿名自动索引，没法单独 DROP。

    ⚠ 这段**不能**写成"整段包在一个事务里，中途失败就整体回滚"。有两个 SQLite
    特性联手让那种写法必然出事，2026-08-27 线上就是这么丢的数据：

    ① **索引名在 SQLite 里是全库唯一的，而 `ALTER TABLE ... RENAME` 不重命名索引**
       ——它们跟着改名后的表走，名字原样占着。紧接着用模型 DDL 建新表时，模型里
       声明的具名索引（ix_closed_trades_user_id、idx_closed_trades_position）就
       撞上了还挂在 legacy 表上的同名索引，直接抛
       `index ix_closed_trades_user_id already exists`。

    ② **pysqlite 只在 DML 之前隐式开事务，DDL 是直接自动提交的**。所以 RENAME 和
       CREATE TABLE 在异常发生时早就落库了，`engine.begin()` 的回滚撤不掉它们。

    两条叠起来的结果：第一次启动崩掉、服务起不来，closed_trades 变成空表、数据
    全留在 closed_trades_legacy；**第二次启动反而"成功"**——新表已经是新键，
    legacy_unique 判定为 False，整段被跳过，然后写下 schema_rev，此后一路走快速
    通道，那批数据再也没被搬回来过。

    所以这里改成：每一步都先看库里的当前状态再决定做不做，从任何一步中断后重入
    都能继续；并且**只有逐行核对过条数才删 legacy**——宁可留着一张多余的表，
    也不能再出现"表删了、数据没搬全"。

    Rebuild closed_trades on SQLite onto the wider dedup key. **Resumable.**

    This must NOT be written as "wrap it all in one transaction and let a failure
    roll back". Two SQLite behaviours combine to break that, and did so in
    production on 2026-08-27:

    1. Index names are database-global and `ALTER TABLE ... RENAME` does not
       rename a table's indexes — they follow the renamed table while keeping
       their names, so creating the new table from the model's DDL collides with
       the still-present originals.
    2. pysqlite only opens a transaction implicitly before DML; DDL autocommits.
       The RENAME and CREATE TABLE are therefore already durable when the error
       is raised, and `engine.begin()`'s rollback cannot undo them.

    The result was a failed first start with an empty closed_trades and every row
    stranded in closed_trades_legacy — followed by a *successful* second start
    that skipped the whole block (the new table already had the new key) and
    recorded the revision, after which the fast path meant the rows were never
    recovered.

    Hence: every step checks the database's current state before acting, so an
    interrupted run resumes cleanly, and **legacy is dropped only after the row
    counts have been reconciled** — better a stray table than a repeat of
    "dropped the table, didn't finish copying".
    """
    from app.models import ClosedTrade  # 局部导入：本模块定义 Base，顶层导入会成环

    with engine.begin() as conn:
        insp = inspect(conn)
        tables = set(insp.get_table_names())

        # 步骤 1：把旧表挪到 legacy。上一次已经挪过就跳过。
        # Step 1: move the old table aside, unless a previous run already did.
        if "closed_trades_legacy" not in tables:
            conn.execute(text("ALTER TABLE closed_trades RENAME TO closed_trades_legacy"))
            tables.discard("closed_trades")
            tables.add("closed_trades_legacy")

        # 步骤 2：把跟着改名走过去的具名索引删掉，腾出名字。这一步就是原来炸掉的
        # 地方。自动索引（sqlite_autoindex_*）不用管——get_indexes 本来就把它们
        # 过滤掉了，而且它们会随 DROP TABLE 一起消失。
        # Step 2: drop the named indexes that travelled with the rename, freeing
        # their names. This is exactly where the original blew up. Auto-indexes
        # need no handling: get_indexes filters them out and they die with the
        # table.
        for idx in insp.get_indexes("closed_trades_legacy"):
            name = idx.get("name")
            if name and not name.startswith("sqlite_autoindex"):
                conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))

        # 步骤 3：建新表。上一次已经建出来了就只补索引——那次失败正是卡在建索引，
        # 表本身是建成了的。
        # Step 3: create the new table, or if a previous run already created it
        # (the failure was during index creation, after CREATE TABLE), just make
        # sure its indexes are all there.
        if "closed_trades" not in tables:
            ClosedTrade.__table__.create(bind=conn)
        else:
            # 表已经在了，但**必须核实它带的是新去重键**。这整个迁移存在的理由就是
            # 那个键（旧键太窄，会把第二个券商账号的真实成交当重复丢掉），一张没有
            # 键的表会让同一个 bug 悄悄回来。真实的半途失败留下的表是模型 DDL 建的、
            # 键是对的；但人工抢修出来的表未必，所以这里不假设。
            # The table exists, but its dedup key must be verified: that key is the
            # entire point of this migration (the old one was narrow enough to drop
            # a second broker account's genuine fills as duplicates), and a table
            # without it would quietly reintroduce the same bug. A table left by a
            # genuine half-finished run was created from the model DDL and has the
            # right key — one produced by a hand repair might not, so do not assume.
            want = {c.name for c in ClosedTrade.__table__.columns
                    if c.name in ("user_id", "mt5_login", "deal_ticket")}
            has_key = any(
                set(uc.get("column_names") or []) == want
                for uc in insp.get_unique_constraints("closed_trades")
            ) or any(
                idx.get("unique") and set(idx.get("column_names") or []) == want
                for idx in insp.get_indexes("closed_trades")
            )
            n_existing = conn.execute(text("SELECT COUNT(*) FROM closed_trades")).scalar_one()
            if not has_key and n_existing == 0:
                # 空表，重建成模型该有的样子最干净。
                # Empty, so recreating it exactly as the model declares is cleanest.
                conn.execute(text("DROP TABLE closed_trades"))
                ClosedTrade.__table__.create(bind=conn)
            elif not has_key:
                # 非空又没键：不敢猜里面的行该怎么归并，留着 legacy 交给人。
                # Non-empty and keyless: merging is a judgement call, so keep legacy
                # and hand it to a person.
                logger.error(
                    "closed_trades 已有 %d 行但缺少去重键，已中止重建并保留 "
                    "closed_trades_legacy，请人工核对后再处理", n_existing,
                )
                return
            else:
                for index in ClosedTrade.__table__.indexes:
                    index.create(bind=conn, checkfirst=True)

        # 步骤 4：搬数据。列取 legacy 表实际有的那些与模型的交集——重入时
        # closed_trades 已是新表，从它取列会漏掉 legacy 里的历史列。
        # 幂等靠**显式按主键排除已搬过的行**，不用 INSERT OR IGNORE：OR IGNORE 会把
        # 所有约束冲突一并吞掉（NOT NULL、CHECK、外键都算），一旦哪天列对不上，
        # 表现就是「一行没搬进来、也没有任何报错」——正是这次事故的那种失败方式。
        # 写成 NOT IN 之后，重复行照样跳过，而真正的错误会当场抛出来。
        # Step 4: copy. Columns come from what legacy actually has, intersected
        # with the model — on a resume, closed_trades is the new table and reading
        # columns from it would miss legacy's historical ones. Idempotency comes
        # from explicitly excluding already-copied primary keys rather than from
        # INSERT OR IGNORE, which swallows *every* constraint violation (NOT NULL,
        # CHECK and foreign keys included): the day the columns stop lining up that
        # would present as "nothing copied, nothing logged" — this incident's exact
        # failure mode. With NOT IN, duplicates are still skipped while a genuine
        # error raises on the spot.
        legacy_cols = {c["name"] for c in insp.get_columns("closed_trades_legacy")}
        carried = [c.name for c in ClosedTrade.__table__.columns if c.name in legacy_cols]
        cols_sql = ", ".join(f'"{c}"' for c in carried)
        conn.execute(text(
            f"INSERT INTO closed_trades ({cols_sql}) "
            f"SELECT {cols_sql} FROM closed_trades_legacy "
            f"WHERE id NOT IN (SELECT id FROM closed_trades)"
        ))

        # 步骤 5：核对条数，够了才删 legacy。不够就把表留着并告警——那批行还在，
        # 人工可以捞回来；删掉就真没了。
        # Step 5: reconcile the counts, and only then drop legacy. If they do not
        # match, keep the table and warn: the rows are still recoverable by hand,
        # whereas dropping makes the loss permanent.
        n_legacy = conn.execute(text("SELECT COUNT(*) FROM closed_trades_legacy")).scalar_one()
        n_new = conn.execute(text("SELECT COUNT(*) FROM closed_trades")).scalar_one()
        if n_new >= n_legacy:
            conn.execute(text("DROP TABLE closed_trades_legacy"))
            logger.info(
                "closed_trades 已重建：去重键改为 (user_id, mt5_login, deal_ticket)，搬入 %d 行",
                n_new,
            )
        else:
            logger.error(
                "closed_trades 重建未搬全（legacy %d 行 / 新表 %d 行），"
                "已保留 closed_trades_legacy 供人工核对，请勿手工删除",
                n_legacy, n_new,
            )


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
            "trade_mode": "INTEGER",
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

    # mt5_accounts 表：补组名与账户类型（实盘/模拟判定，见 services/account_type.py），
    # 以及 gateway 绑定的撤销三列（见下方注释）。
    # 两列都可空、都没有回填：历史行的类型只能等下一次账号刷新时按组名判出来
    # （gateway 每轮资金刷新都会重写这两列），猜一个默认值反而会把模拟盘记成实盘。
    # mt5_accounts: add the broker group name and the derived account type. Both
    # nullable with no backfill — existing rows get classified on the next account
    # refresh; guessing a default here could mark demo accounts as real.
    # competitions 表：每场比赛可覆盖的两个门槛（留空 = 用全局设置）。
    # 两列都可空、不回填——NULL 本身就是"跟随全局"的语义，回填任何具体值都会把
    # 存量比赛从"跟随"钉死成"覆盖"。track 列建表时就有（默认 "real"），本次起
    # 真正启用，存量行的 "real" 恰好就是过去写死的行为，同样不需要动。
    # competitions: two per-competition gate overrides (NULL = use the global
    # settings). Both nullable with no backfill — NULL *is* the "follow global"
    # semantic, and writing any concrete value would freeze existing competitions
    # into an override. The track column already exists (default "real") and only
    # becomes meaningful now; "real" on existing rows is exactly the old hardcoded
    # behaviour, so it needs no backfill either.
    if "competitions" in inspector.get_table_names():
        comp_cols = {c["name"] for c in inspector.get_columns("competitions")}
        with engine.begin() as conn:
            if "min_baseline_usd" not in comp_cols:
                conn.execute(text("ALTER TABLE competitions ADD COLUMN min_baseline_usd FLOAT"))
            if "min_trades" not in comp_cols:
                conn.execute(text("ALTER TABLE competitions ADD COLUMN min_trades INTEGER"))

    if "mt5_accounts" in inspector.get_table_names():
        acc_cols = {c["name"] for c in inspector.get_columns("mt5_accounts")}
        with engine.begin() as conn:
            if "mt5_group" not in acc_cols:
                conn.execute(text("ALTER TABLE mt5_accounts ADD COLUMN mt5_group VARCHAR"))
            if "trade_mode" not in acc_cols:
                conn.execute(text("ALTER TABLE mt5_accounts ADD COLUMN trade_mode INTEGER"))
            # gateway 绑定的撤销依据（见 models.MT5Account 的说明）。
            #
            # 三列全部可空、**一律不回填**。pass_change_at 尤其不能猜：回填一个
            # 当前值等于宣布"历史绑定的密码从没变过"，而这些行恰恰是在没有任何
            # 校验的年代绑上来的，它们的密码有没有被改过我们根本不知道。留 NULL
            # 让校验逻辑走"没有信号"分支——首次读到券商侧的值时才记下来，此后
            # 的改动才会被撤销。旧绑定因此得不到追溯保护，这是刻意的取舍：
            # 追溯的唯一实现方式是把所有人一次性踢下线，代价大于收益。
            #
            # Revocation columns for gateway bindings. All nullable and never
            # backfilled — least of all pass_change_at: seeding it with the
            # current value would assert "this binding's password never changed",
            # about rows created back when nothing was ever checked. NULL keeps
            # them on the "no signal" path until the first reading is recorded,
            # so only later changes revoke. Existing bindings get no retroactive
            # protection, deliberately: the only way to have it would be to
            # revoke everyone at once.
            if "pass_change_at" not in acc_cols:
                conn.execute(text("ALTER TABLE mt5_accounts ADD COLUMN pass_change_at BIGINT"))
            if "revoked_at" not in acc_cols:
                conn.execute(text(
                    f"ALTER TABLE mt5_accounts ADD COLUMN revoked_at {datetime_type}"
                ))
            if "revoked_reason" not in acc_cols:
                conn.execute(text("ALTER TABLE mt5_accounts ADD COLUMN revoked_reason VARCHAR"))
            # rev 13：服务器时区偏移持久化。不回填——猜一个值等于把可能错的时间
            # 写成"确定"，NULL 让读取逻辑走"从未观测"分支，首次扫到开仓腿时才记下。
            # rev 13: persisted server zone offset. Never backfilled — NULL keeps
            # the "never observed" path until the first IN leg is seen.
            if "server_utc_offset" not in acc_cols:
                conn.execute(text("ALTER TABLE mt5_accounts ADD COLUMN server_utc_offset INTEGER"))

    # orders.trade_mode 存量回填：必须排在上面的 mt5_accounts 补列之后——回填
    # 语句读 mt5_accounts.trade_mode，旧库上这一列要等 rev 7 那段 ALTER 跑完才
    # 存在，提前查会以 "no such column" 打断迁移（同 idx_* 建在补列之前那类
    # 坑，只是这次踩在 UPDATE 上而不是 CREATE INDEX 上）。
    #
    # rev 10 回填：按 (user_id, mt5_login) 从现存账号行盖章存量 FILLED 订单（设计 §1.2）。
    # 幂等：只补 orders.trade_mode 仍为 NULL 的行，重跑不会覆盖已回填/已由
    # 网关成交路径写入的值。
    #
    # orders.trade_mode backfill: must come after the mt5_accounts ADD COLUMN
    # above — it reads mt5_accounts.trade_mode, which doesn't exist on a legacy
    # database until rev 7's ALTER runs; querying it earlier fails with "no such
    # column" (the same bug class as an index built before its column, just on
    # an UPDATE instead of a CREATE INDEX).
    #
    # Idempotent: only backfills rows where orders.trade_mode is still NULL, so
    # re-running never clobbers a value already backfilled or written by the
    # gateway fill path.
    if "orders" in inspector.get_table_names() and "mt5_accounts" in inspector.get_table_names():
        with engine.begin() as conn:
            conn.execute(text(
                "UPDATE orders SET trade_mode = ("
                " SELECT a.trade_mode FROM mt5_accounts a"
                " WHERE a.user_id = orders.user_id AND a.login = orders.mt5_login"
                "   AND a.trade_mode IS NOT NULL LIMIT 1)"
                " WHERE orders.trade_mode IS NULL AND orders.status = 'FILLED'"
                "   AND orders.mt5_login IS NOT NULL"
            ))

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
            # DROP，只能整表重建。
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
            # 上一次重建死在半路会留下 closed_trades_legacy：数据全在它里面，而
            # closed_trades 是一张空的新表。**这时 legacy_unique 是 False**（新表
            # 已经是新键了），只看它会以为"没什么要做的"，数据就永远留在 legacy 里。
            # A half-finished rebuild leaves closed_trades_legacy holding the data
            # while closed_trades is a new empty table. legacy_unique is then False
            # — the new table already carries the new key — so keying only off it
            # would conclude "nothing to do" and strand the rows forever.
            leftover = "closed_trades_legacy" in inspector.get_table_names()
            if legacy_unique or leftover:
                _rebuild_closed_trades_sqlite()

    # 建索引不在这里，统一放到本函数末尾的索引块（搜 "统一索引块"）。
    # Index creation lives in the single block at the end of this function
    # (search for "统一索引块"), not here.

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
            "nickname": "VARCHAR",
            "nickname_public": "BOOLEAN",
            "leaderboard_opt_out": "BOOLEAN",
            "equipped_badge": "VARCHAR",
            "equipped_badges": "VARCHAR",
        }
        with engine.begin() as conn:
            for name, col_type in user_new.items():
                if name not in user_cols:
                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {name} {col_type}"))
            # equipped_badges 回填：佩戴从「一枚」扩成「有序三枚，首枚为默认」，
            # 老行那一枚就是新列表的唯一一枚。只在本次刚加列时跑一次——之后
            # 用户主动卸下全部会把新列写成空串，无条件 UPDATE 会把它当成
            # 「还没回填」再塞回旧列的值，把卸下的勋章又戴回去。
            # equipped_badges backfill: equipping grows from one badge to an
            # ordered three (first = default), so an existing row's single badge
            # becomes the sole entry. Guarded to run only when the column is
            # first added: unequipping everything later writes an empty string,
            # and an unconditional UPDATE would read that as "not backfilled"
            # and re-equip the badge the user just took off.
            if "equipped_badges" not in user_cols:
                conn.execute(text(
                    "UPDATE users SET equipped_badges = equipped_badge "
                    "WHERE equipped_badge IS NOT NULL"
                ))
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
            # rev 10：nickname_public / leaderboard_opt_out 声明为 NOT NULL，
            # 旧行补列后为 NULL，回填为各自的模型默认值 False。
            # rev 10: nickname_public / leaderboard_opt_out are declared NOT
            # NULL; backfill existing rows to their model default of False.
            conn.execute(text("UPDATE users SET nickname_public = FALSE WHERE nickname_public IS NULL"))
            conn.execute(text("UPDATE users SET leaderboard_opt_out = FALSE WHERE leaderboard_opt_out IS NULL"))

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

    # ── 统一索引块 ────────────────────────────────────────────────────────────
    # create_all 只给**新建**的表建索引，已存在的表不会补，所以这些要手工建。
    #
    # 全部索引集中放在这里、排在上面所有补列之后，是一条结构性约束，不是排版偏好：
    # 只要索引整体位于补列之后，任何一条索引都不可能引用到"还没补上的列"，这类
    # bug 就写不出来了。反过来的代价是实打实的——建索引若跑在补列之前，旧库上会以
    # "no such column" 直接打断整段迁移，而迁移是在 uvicorn bind 端口之前同步跑的，
    # 线上等价于服务器起不来，且**只在还原旧备份/旧快照时才发作**（已迁移过的库走
    # 版本号快速通道，根本不执行到这里），偏偏那是最不该出事的时刻。
    #
    # 这个坑踩过三次：users.invite_code（commit e4bc076）、signals.result 与
    # strategy_signals.result（后两条一度被标为"已知例外、另行跟踪"，实际一直没修）。
    # 靠注释提醒挡不住第四次，所以 tests/test_migration_index_order.py 里有一条
    # 结构性断言直接对源码检查这个顺序——往上面任何位置塞 CREATE INDEX 都会让它失败。
    #
    # ── The single index block ───────────────────────────────────────────────
    # create_all only builds indexes for tables it creates, so pre-existing
    # tables need these by hand.
    #
    # Keeping every index here, after every ADD COLUMN above, is a structural
    # constraint rather than a formatting preference: with index creation wholly
    # after column addition, no index can reference a column that hasn't been
    # added yet, and the bug class becomes unwritable. The cost of the inverse is
    # concrete — an index created before its column aborts the entire migration
    # on an old database with "no such column", and since the migration runs
    # synchronously before uvicorn binds its port, that is a server that never
    # comes up. It fires *only* when restoring an old backup or snapshot (already
    # migrated databases take the schema_rev fast path and never reach here),
    # which is precisely the worst moment for it.
    #
    # This has bitten three times: users.invite_code (commit e4bc076), plus
    # signals.result and strategy_signals.result — the latter two were labelled a
    # "known exception, tracked separately" and then simply never fixed. Comments
    # did not prevent the third, so tests/test_migration_index_order.py asserts
    # the ordering against the source directly: adding a CREATE INDEX anywhere
    # above will fail it.
    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)"))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_signals_status_expire ON signals(status, expire_at)"
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
        # 以下三条建在本函数补出来的列上，正是上面说的那类——必须留在这里。
        # These three sit on columns this function adds; they are exactly the case
        # described above and must stay in this block.
        #
        # 判定扫描按 (symbol, result) / (strategy_id, result) 找待判定信号；
        # 邀请注册人数按 invite_code 分组（admin 列表每次刷新都查）。
        # Resolution scans find pending signals by (symbol, result) and
        # (strategy_id, result); the admin list groups signups by invite_code.
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_signals_symbol_result ON signals(symbol, result)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_strategy_signals_strategy_result "
            "ON strategy_signals(strategy_id, result)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code)"
        ))
        # rev 10 游戏化索引：胜率/连续活跃统计按 (user_id, closed_at) 与
        # (mt5_login, closed_at) 扫 closed_trades；升级条件之一按
        # (user_id, status, created_at) 扫 orders。
        # rev 10 gamification indexes: win-rate/streak stats scan closed_trades
        # by (user_id, closed_at) and (mt5_login, closed_at); one upgrade
        # condition scans orders by (user_id, status, created_at).
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_closed_trades_user_closed "
            "ON closed_trades(user_id, closed_at)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_closed_trades_login_closed "
            "ON closed_trades(mt5_login, closed_at)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_orders_user_status_created "
            "ON orders(user_id, status, created_at)"
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
