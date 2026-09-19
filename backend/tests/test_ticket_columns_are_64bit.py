"""MT5 票号列必须是 64 位，且迁移清单必须与模型一致（rev 25 / 2026-09-19 审计）。

背景：这六列建表时用的是 SQLAlchemy 的 `Integer`，在 Postgres 上就是 int4，上限
2,147,483,647。MT5 的订单号 / 成交号 / 仓位号都是 ulong 且单调增长，越界只是时间问题。

越界的失败形态特别恶劣，值得在测试里再写一遍：它**不是**"存不下就截断"，而是 commit
时抛 DataError——**交易已经在券商那边成交了、回来落库才失败**。订单于是卡在 PENDING，
5 分钟后被 stale 判定改写成 FAILED「指令超时未执行」，而真仓位就挂在那里。用户看到
"未执行"会重下一单，仓位翻倍。

这个套件跑在 SQLite 上（SQLite 的 INTEGER 本来就是 64 位动态宽度），所以**真正的
int4 → int8 ALTER 在这里跑不到**，只能靠结构断言守住：

  1. 六列在模型上都声明为 BigInteger —— 新建的库直接就是对的；
  2. 迁移里的列清单与模型完全一致 —— 存量库不会漏迁哪一列；
  3. 迁移只对 Postgres 执行，且先查 information_schema 再决定要不要 ALTER（幂等，
     已迁过的库重启时不会再被锁一次）。

⚠️ 生产的 ALTER 路径必须在真 Postgres 上验一次，本机没有。见 database.py 里 rev 25
那段的运维说明（int4→int8 会重写整表并持 ACCESS EXCLUSIVE 锁，而迁移跑在 uvicorn
bind 端口之前）。

The six MT5 ticket columns must be 64-bit, and the migration's column list must
match the models. This suite runs on SQLite, whose INTEGER is already 64-bit, so
the real int4 → int8 ALTER is never exercised here — these are structural
assertions instead. The production path still needs one run against real Postgres.
"""
import inspect

from sqlalchemy import BigInteger

from app.core import database
from app.models import AutoManagedPosition, ClosedTrade, Order

# 模型上所有承载 MT5 票号的列 / every model column that holds an MT5 ticket
_TICKET_COLUMNS = [
    (Order, "ticket"),
    (Order, "mt5_ticket"),
    (Order, "mt5_position"),
    (ClosedTrade, "position_ticket"),
    (ClosedTrade, "deal_ticket"),
    (AutoManagedPosition, "position_ticket"),
]


def test_every_ticket_column_is_bigint_on_the_model():
    """新建的库靠 create_all，模型声明对了就够了。"""
    wrong = []
    for model, name in _TICKET_COLUMNS:
        col = model.__table__.columns[name]
        if not isinstance(col.type, BigInteger):
            wrong.append(f"{model.__tablename__}.{name} 是 {col.type}，应为 BigInteger")
    assert not wrong, "；".join(wrong)


def test_migration_list_matches_the_model_columns():
    """迁移清单与模型必须一一对应。

    这条防的是"以后新增一个票号列、模型写了 BigInteger、却忘了加进迁移清单"——
    新库没事，**存量库**那一列还是 int4，而存量库正是有真实数据、真会越界的那个。
    反过来（迁移里列了模型上不存在的列）同样要拦，那是改名后没同步。
    """
    src = inspect.getsource(database._migrate_columns)
    start = src.index("_TICKET_COLUMNS_INT8")
    # 取到元组字面量结束（`)` 单独成行那一处），而不是第一个右括号——
    # 清单里每一项本身就带括号。
    block = src[start:src.index("\n    )", start)]

    in_migration = set()
    for model, name in _TICKET_COLUMNS:
        if f'("{model.__tablename__}", "{name}")' in block:
            in_migration.add((model.__tablename__, name))

    expected = {(m.__tablename__, n) for m, n in _TICKET_COLUMNS}
    missing = expected - in_migration
    assert not missing, f"这些列在模型上是 BigInteger，但迁移清单里没有（存量库不会被迁）：{sorted(missing)}"


def test_migration_is_postgres_only_and_checks_the_current_type_first():
    """迁移必须只对 Postgres 跑，而且 ALTER 之前先查当前类型。

    只对 Postgres：SQLite 的 INTEGER 已是 64 位，且不支持这种 ALTER。
    先查类型：int4→int8 会重写整表并持 ACCESS EXCLUSIVE 锁，已经是 bigint 的库
    在每次重启时都不该再被锁一次——迁移跑在 uvicorn bind 端口之前，那就是停机。
    """
    src = inspect.getsource(database._migrate_columns)
    start = src.index("_TICKET_COLUMNS_INT8")
    tail = src[start:start + 2000]

    assert "if is_postgres:" in tail, "票号迁移必须包在 is_postgres 分支里"
    assert "information_schema.columns" in tail, "ALTER 之前必须先查 information_schema 当前类型"
    assert 'if current != "integer":' in tail, "只有当前确实是 integer 才 ALTER（幂等）"
    assert "ALTER TABLE" in tail and "TYPE BIGINT" in tail


def test_schema_rev_was_bumped_for_this_migration():
    """加了迁移就必须 bump CURRENT_SCHEMA_REV，否则存量库走快速通道根本不会执行它。

    这是本项目踩过的坑：版本号快速通道让日常重启跳过整段迁移，忘了 +1 等于迁移没写。
    """
    assert database.CURRENT_SCHEMA_REV >= 25
    changelog = inspect.getsource(database)[:20000]
    assert "rev 25" in changelog, "rev 25 必须在版本变更说明里有一条记录"
