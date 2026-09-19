"""只读体检：rev 25（MT5 票号列 int4 → int8）上线前该知道的两件事。

**为什么要先跑这个**：rev 25 会把六列从 int4 改成 int8。int4→int8 在 Postgres 上
不是 binary-coercible，`ALTER TABLE ... TYPE BIGINT` 会**重写整张表**并持
ACCESS EXCLUSIVE 锁；而迁移是在 uvicorn 绑定端口**之前**同步跑的，所以那段时间
后端整个不可用，下单链路也跟着断。停多久完全取决于表有多少行——这个脚本就是
来量它的。

顺带回答第二个问题：券商现在的票号离 int4 上限（2,147,483,647）还有多远。越界的
后果不是"存不下就截断"，而是 commit 抛 DataError——**交易已经在券商那边成交了**，
回来落库才失败，订单被记成「指令超时未执行」，用户看到失败就重下，仓位翻倍。
离得越近，这次迁移越不能拖。

Read-only pre-flight for rev 25. Reports (a) how many rows each affected table has,
since int4→int8 rewrites the table under an exclusive lock while the service is not
yet listening, and (b) how close current MT5 tickets are to the int4 ceiling.

用法 / Usage（在 VPS 上，从 backend/ 目录，用服务自己的 venv）：
    cd ~/PRISMX-SIGNAL-LAB/backend
    .venv/bin/python -m scripts.check_ticket_migration

本机对着开发库跑也可以，但 SQLite 上没有意义（SQLite 的 INTEGER 本来就是 64 位，
不需要也不会执行这次迁移）。
"""
from sqlalchemy import text

from app.core.config import settings
from app.core.database import CURRENT_SCHEMA_REV, SessionLocal, engine

# 与 core/database.py 的 _TICKET_COLUMNS_INT8 一一对应。
# 这里刻意再写一遍而不是 import：这是个诊断脚本，要能如实反映"库里现在是什么"，
# 万一将来两边不一致，看到的应当是差异本身，而不是被同一个常量掩盖过去。
TICKET_COLUMNS = [
    ("orders", "ticket"),
    ("orders", "mt5_ticket"),
    ("orders", "mt5_position"),
    ("closed_trades", "position_ticket"),
    ("closed_trades", "deal_ticket"),
    ("auto_managed_positions", "position_ticket"),
]

INT4_MAX = 2_147_483_647

# 重写速度的粗略量级，用来把行数换算成"大概停多久"。真实速度取决于磁盘、行宽、
# 是否有索引要跟着重建，所以这里给的是一个**保守**的数量级，不是承诺。
# A deliberately conservative rows-per-second figure for turning row counts into a
# rough duration. Real speed depends on disk, row width and index rebuilds.
ROWS_PER_SECOND_PESSIMISTIC = 50_000


def main() -> int:
    is_postgres = settings.DATABASE_URL.startswith("postgres")
    print(f"schema_rev（代码里的目标版本）= {CURRENT_SCHEMA_REV}")
    print(f"数据库 = {'PostgreSQL' if is_postgres else 'SQLite（本次迁移不会执行）'}\n")

    db = SessionLocal()
    try:
        # ---- 1. 当前列类型：还没迁的才需要担心停机 ----
        print("── 列类型 ───────────────────────────────────────────────")
        pending = []
        if is_postgres:
            for table, column in TICKET_COLUMNS:
                row = db.execute(
                    text(
                        "SELECT data_type FROM information_schema.columns "
                        "WHERE table_name = :t AND column_name = :c"
                    ),
                    {"t": table, "c": column},
                ).first()
                current = row[0] if row else "（列不存在）"
                mark = "需要迁移" if current == "integer" else "已是 64 位"
                if current == "integer":
                    pending.append((table, column))
                print(f"  {table}.{column:<16} {current:<10} {mark}")
        else:
            print("  SQLite 的 INTEGER 已是 64 位动态宽度，这次迁移只对 Postgres 执行。")
        print()

        # ---- 2. 表有多大：决定停机时长 ----
        print("── 表规模与预估停机 ─────────────────────────────────────")
        tables = sorted({t for t, _ in TICKET_COLUMNS})
        total_seconds = 0.0
        for table in tables:
            if is_postgres:
                # 先用 reltuples（统计信息，瞬间返回）；它是估算值，-1 表示从没
                # ANALYZE 过，这时才退回 count(*)。对大表不要无脑 count。
                est = db.execute(
                    text("SELECT reltuples::bigint FROM pg_class WHERE relname = :t"),
                    {"t": table},
                ).scalar()
                if est is None or est < 0:
                    est = db.execute(text(f"SELECT count(*) FROM {table}")).scalar()
                    note = "（精确计数）"
                else:
                    note = "（统计估算）"
                size = db.execute(
                    text("SELECT pg_size_pretty(pg_total_relation_size(:t))"),
                    {"t": table},
                ).scalar()
            else:
                est = db.execute(text(f"SELECT count(*) FROM {table}")).scalar()
                note, size = "（精确计数）", "—"
            affected = any(t == table for t, _ in pending)
            seconds = (est or 0) / ROWS_PER_SECOND_PESSIMISTIC if affected else 0.0
            total_seconds += seconds
            tail = f"≈{seconds:.0f} 秒" if affected else "无需重写"
            print(f"  {table:<24} {est:>12,} 行 {note}  {size:>10}  {tail}")

        print()
        if not is_postgres:
            print("  （本机不是 Postgres，上面的时长不适用。）")
        elif not pending:
            print("  ✅ 六列都已是 64 位，这次重启不会有迁移停机。")
        else:
            print(f"  ⚠ 预估停机 ≈ {total_seconds:.0f} 秒（保守估计，期间下单与网页全断）。")
            print("     能接受就直接推 main；不能接受就在维护窗口手工执行下面这几条，")
            print("     跑完再推——迁移是幂等的，会自动跳过：")
            for table, column in pending:
                print(f"       ALTER TABLE {table} ALTER COLUMN {column} TYPE BIGINT;")
        print()

        # ---- 3. 离 int4 上限还有多远：决定这件事有多急 ----
        print("── 票号量级（离 int4 上限 2,147,483,647 还有多远）───────")
        probes = [
            ("orders", "mt5_ticket"),
            ("orders", "mt5_position"),
            ("closed_trades", "position_ticket"),
            ("closed_trades", "deal_ticket"),
        ]
        worst = 0
        for table, column in probes:
            try:
                mx = db.execute(text(f"SELECT max({column}) FROM {table}")).scalar()
            except Exception as e:  # 列不存在等情况，诊断脚本不该因此中断
                print(f"  {table}.{column:<16} 查不到（{e.__class__.__name__}）")
                continue
            if mx is None:
                print(f"  {table}.{column:<16} 表里还没有数据")
                continue
            pct = mx / INT4_MAX * 100
            worst = max(worst, pct)
            print(f"  {table}.{column:<16} 最大 {mx:>14,}   已用掉上限的 {pct:5.1f}%")

        print()
        if worst == 0:
            print("  库里还没有票号数据，无法判断紧迫性。")
        elif worst >= 80:
            print(f"  🔴 已用掉 {worst:.1f}%，随时可能越界。这件事应当最优先处理。")
        elif worst >= 50:
            print(f"  🟠 已用掉 {worst:.1f}%，建议尽快安排。")
        else:
            print(f"  🟢 已用掉 {worst:.1f}%，暂时安全，但越界是迟早的事，别把这条一直往后推。")
        return 0
    finally:
        db.close()
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
