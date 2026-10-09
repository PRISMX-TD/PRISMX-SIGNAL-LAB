"""操作日志（管理后台「操作日志」页）的写入工具：activity_events 表的唯一写入口。

**这张表只装别处没有记录的事件。** 交易指令在 orders、MT5 侧平仓在 closed_trades、管理员
改动在 admin_audit_logs，读接口（services/activity_feed.py）按时间把它们和这里合并，不要把
那些事再往这里抄一遍。

**写法只有两种，都不加新的提交：**

1. `log_event(db, kind, …)` —— 搭业务原有的那次提交。
   · 不带 dedupe_key：只 `db.add(ActivityEvent(...))`，随调用方的 commit 一起提交、随
     rollback 一起作废（与 services/audit.log_change 同一个套路）。放在业务 commit 之前
     任意位置都行。
   · 带 dedupe_key（有并发抢跑的路径：桥接两条轮询、撤销、一键平仓）：先 `db.flush()` 让
     业务行先落下、先拿到行锁 / 唯一约束，再在一个 SAVEPOINT 里执行
     `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`。**必须是 commit 前的最后一步。**
     flush 抛出的是业务自己的异常（不调这个函数，commit 时也会原样抛出），这里不吞，
     原样上抛——所以如果调用方在 commit 外面包了 `except IntegrityError`，要把这次调用
     也放进同一个 try 里。
   · 一次要记好几条带键的（一键平仓每个账号一行、桥接一拍建出几个账号）用
     `log_events(db, [...])`：一次 flush + 一个 SAVEPOINT 里一条多行 INSERT，3 条语句而不是
     每行 3 条。
2. `record_after_commit(kind, …, bind=db)` —— 只给「业务已经提交之后才知道」的事件
   （目前只有 trade.corrected）：自己开一个 `engine.begin()` 短事务做一条 Core INSERT。

**绝不抛异常**（上面 flush 那一条除外）：kind 不认识、数据组装出错、序列化失败、INSERT
失败，一律 `logger.warning` 后跳过——日志丢一行可以，业务不能因为日志失败。带 dedupe_key
的那条 INSERT 包在 SAVEPOINT 里：万一它在库里失败（比如唯一索引缺失），回滚的只是这一行，
Postgres 上整笔事务不会被打成「已中止」而让业务的 COMMIT 悄悄变成 ROLLBACK。

**不用任何全局 Session 事件监听器**：deps.py 里每个已登录请求都会开一个 SAVEPOINT，
监听器会被误触发。也不写密码、token、哈希、IP（data 里出现这几个键名会被剔除并告警）。

─────────────────────────────────────────────────────────────────────────────────────
**列的约定 / column conventions**

  user_id     这件事发生在谁身上（被影响的用户）。
  actor_type  'user'（本人）/ 'system'（后台判定）/ 'admin'。本人操作时 actor_id = user_id。
  actor_id    谁做的；system 留 None。
  mt5_login   涉及的 MT5 账号（字符串）；与账号无关的事件留 None。
  ref_id      关联对象：mt5_accounts.id、一键平仓批次号（'ca_<cid>'）、orders.id。
  data        dict → 紧凑 JSON（ensure_ascii=False、无空格），≤ 1000 字；超长时先截短长字符串
              / 长列表，仍超长则存 {"_truncated": true}。时间一律用 iso_utc() 转成
              'YYYY-MM-DDTHH:MM:SS.ffffffZ'；NaN / ±inf 存成 null。键名用下表里的短名。
  dedupe_key  只有下表标了的才带；必须用本模块的 *_key() 拼，运行时与补录逐字一致。

**每种 kind 写什么 / what each kind stores**（读接口把 data 原样拆成 params）

  kind                          actor   mt5_login  ref_id           dedupe_key                 data
  ----------------------------  ------  ---------  ---------------  -------------------------  ------------------------------
  mt5.bind                      user    login      mt5_accounts.id  桥接：新建行                {"ch": "gateway"|"bridge",
                                                                    bridge_bind_new_key，        "revived": bool,
                                                                    复活行                       "name": str|null,
                                                                    bridge_bind_revived_key；    "demo": bool|null,
                                                                    直连不带                     "bal": float|null,
                                                                                                 "server": str|null}
  mt5.reverify                  user    login      mt5_accounts.id  —                          {"ch": "gateway"}
  mt5.unbind                    user    login      mt5_accounts.id  —（补录行：                 {"ch": "gateway"|"bridge",
                                                                    backfill_unbind_key）        "name": str|null,
                                                                                                 "bal": float|null}
                                                                                                 补录行：{"ch", "name", "bf": 1}
  mt5.revoked                   system  login      mt5_accounts.id  revoke_key                 {"reason": "password_changed"}
                                                                                                 补录行另加 "bf": 1
  user.api_token_reset          user    None       None             —                          {}
  trade.close_all               user    login      批次号 'ca_<cid>' close_all_key              {"count": int, "skipped": int}
                                                                                                 补录行：{"count": int, "bf": 1}
  trade.corrected               system  login      orders.id        corrected_key（可选）       {"was": "FAILED"|"CANCELLED",
                                                                                                 "note": "timeout"|
                                                                                                   "timeout_unknown"|null,
                                                                                                 "action": str, "sym": str,
                                                                                                 "side": str, "vol": float,
                                                                                                 "px": float|null,
                                                                                                 "at": str}
  user.login                    user    None       None             —                          {"method": "password"|"google",
                                                                                                 "new_source": bool}
  user.email_verified           user    None       None             —                          {"method": "link"|"reset"}
  user.password_reset_requested user    None       None             —                          {}
  user.password_reset           user    None       None             —                          {}
  user.password_changed         user    None       None             —                          {"first_set": bool}
  user.nickname                 user    None       None             —                          {"old": str|null, "new": str}
  user.phone_set                user    None       None             —                          {}
  auto.settings                 user    None       None             —                          {"changes": [{"field": str,
                                                                                                 "old": any, "new": any}, …]}

  每个键的意思 / what the keys mean:
  · ch       绑定通道：'gateway' = 直连（mt5_accounts.source='gateway'），'bridge' = 桥接程序。
  · revived  mt5.bind 是不是把一条用户删过（revoked_reason='user_removed'）的账号行重新绑回来；
             全新的行是 false。直连：is_new 或删过 → mt5.bind；改密失效后重新验证 → mt5.reverify。
  · name     MT5 账户名（mt5_accounts.account_name / 网关回执的 name）。
  · demo     demo_of(trade_mode)：true = 模拟 / 比赛，false = 实盘，null = 未判定。
  · bal      当时的余额（账户货币，不带符号），读不到就 null。
  · server   券商服务器名；直连行存的是空串，写 null。
  · reason   撤销原因，目前只有 gateway_binding.REASON_PASSWORD_CHANGED。
  · count    trade.close_all：这一行这个账号排下去的子单数（每个账号一行）。
  · skipped  trade.close_all：整批跳过的仓位数（close_all.queue 的返回值，每行都写同一个数）。
  · was      trade.corrected：更正前的状态（UPDATE 之前读出来的 orders.status）。
  · note     trade.corrected：was=FAILED 是哪一种超时作废，按作废时写的 orders.message 判——
             'timeout' = 桥接超时，当时告诉用户「已自动取消，请重新下单」（STALE_ORDER_MESSAGE）；
             'timeout_unknown' = 直连超时，告诉的是「结果未知」（GATEWAY_STALE_ORDER_MESSAGE）；
             其余（券商报的失败、CANCELLED）为 null。页面靠它说出用户当时被告知的是什么。
  · action / sym / side / vol / px   orders.action / symbol / side / volume / filled_price 原值。
  · at       trade.corrected：原指令的下单时间 iso_utc(orders.created_at)；本行 created_at 是更正时间。
  · method   user.login：'password' | 'google'；user.email_verified：'link'（点了验证链接）|
             'reset'（重置密码顺带验证了邮箱）。
  · new_source  user.login：这次是不是新出现的登录来源（rate_limit.remember_login_source 的返回）。
  · first_set   user.password_changed：原来没有密码（Google 注册）、这是第一次设。
  · old / new   user.nickname：旧昵称（第一次设为 null）/ 新昵称。
  · changes  auto.settings：只列真正变了的字段，field 用设置项的字段名，old / new 是原值。
  · bf       1 = 补录（rev 38 迁移从历史表推出来的行），页面上标「补录」。

  写法提醒 / notes for hook writers:
  · ref_id 取新建行的 id 之前先 db.flush()：id 是 ORM 在 flush 时才填的默认值，不 flush 就是
    None。这不算新语句——commit 时本来就要发这条 INSERT，只是提前发了。但撞唯一约束的
    IntegrityError 也随之提前到这次 flush：调用方原来在 commit 外面接 IntegrityError 的
    （比如 gateway_verify 的 409），flush 要放进同一个 try 里。
  · 多个账号的一键平仓按 login 排序后用 log_events 一次写，避免两个事务以相反顺序拿唯一键。
  · 带 dedupe_key 的那次调用之后不要再改业务对象（它已经 flush 过，之后的改动要再 flush 一次，
    commit 会自己做，但顺序上日志就不再是「最后一步」了）。

─────────────────────────────────────────────────────────────────────────────────────
Write-side helpers for the admin activity log; the only writer of activity_events.

The table only holds events nothing else records. Orders, closing deals and admin
edits have their own tables and the reader (services/activity_feed.py) merges them
by time — don't copy those here.

Two ways to write, neither adds a commit:

1. `log_event(db, kind, …)` rides the business's own commit. Without dedupe_key it
   is a plain `db.add`, committed or rolled back with the caller (the
   audit.log_change pattern). With dedupe_key (racy writers: the two bridge loops,
   revocation, close-all) it flushes first so the business rows take their locks and
   unique constraints first, then runs `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`
   inside a SAVEPOINT. It must be the last step before commit. An exception from
   that flush is the business's own (its commit would raise it anyway) and is
   re-raised untouched — if the caller wraps its commit in `except IntegrityError`,
   put this call inside the same try. Several keyed rows at once (close-all's
   accounts, a bridge report's new accounts) go through `log_events(db, [...])`:
   one flush and one multi-row INSERT in one SAVEPOINT, 3 statements instead of 3
   per row.
2. `record_after_commit(kind, …, bind=db)` is only for events known after the
   business committed (today just trade.corrected): one Core INSERT in its own short
   `engine.begin()` transaction.

Never raises (bar the flush above): unknown kind, bad data, serialisation or INSERT
failures are logged as warnings and skipped. The dedupe INSERT runs in a SAVEPOINT
so that, should it ever fail in the database (a missing unique index, say), only
that row is lost — on Postgres the transaction is not left aborted with the
business's COMMIT silently turning into a ROLLBACK.

No global Session event listeners (deps.py opens a SAVEPOINT on every
authenticated request and would trip them). Never store passwords, tokens, hashes
or IPs — such keys are stripped from data with a warning. The table above lists the
exact columns and data keys per kind; "bf": 1 marks rows backfilled by the rev 38
migration.
"""
from __future__ import annotations

import json
import logging
import math
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import ActivityEvent

logger = logging.getLogger("prismx.activity_log")

# ─────────────────────────────────────────────────────────────────────────────
# kind 常量。写入方和读接口都从这里取，别手写字符串——拼错一个字母，那一行就成了读接口
# 不认识的孤儿。
# Kind constants, shared by writers and the reader; a typo'd literal would leave an
# orphan row the reader does not recognise.
# ─────────────────────────────────────────────────────────────────────────────
MT5_BIND = "mt5.bind"
MT5_REVERIFY = "mt5.reverify"
MT5_UNBIND = "mt5.unbind"
MT5_REVOKED = "mt5.revoked"
USER_API_TOKEN_RESET = "user.api_token_reset"
TRADE_CLOSE_ALL = "trade.close_all"
TRADE_CORRECTED = "trade.corrected"
USER_LOGIN = "user.login"
USER_EMAIL_VERIFIED = "user.email_verified"
USER_PASSWORD_RESET_REQUESTED = "user.password_reset_requested"
USER_PASSWORD_RESET = "user.password_reset"
USER_PASSWORD_CHANGED = "user.password_changed"
USER_NICKNAME = "user.nickname"
USER_PHONE_SET = "user.phone_set"
AUTO_SETTINGS = "auto.settings"

# activity_events 里会出现的全部 kind。log_event 只收这里面的。
# Every kind activity_events may hold; log_event rejects anything else.
KINDS: frozenset[str] = frozenset({
    MT5_BIND, MT5_REVERIFY, MT5_UNBIND, MT5_REVOKED,
    USER_API_TOKEN_RESET,
    TRADE_CLOSE_ALL, TRADE_CORRECTED,
    USER_LOGIN, USER_EMAIL_VERIFIED,
    USER_PASSWORD_RESET_REQUESTED, USER_PASSWORD_RESET, USER_PASSWORD_CHANGED,
    USER_NICKNAME, USER_PHONE_SET,
    AUTO_SETTINGS,
})

MT5_KINDS: frozenset[str] = frozenset({MT5_BIND, MT5_REVERIFY, MT5_UNBIND, MT5_REVOKED})

# 每个 kind 进页面上的哪个分类（设计 §5.4）。API Token 归「MT5 绑定」：它是桥接程序连平台
# 用的凭证，和绑定是一回事。
# Which page category each kind belongs to (design §5.4). The API token goes with
# MT5 binding: it is the credential the bridge app connects with.
KIND_CATEGORY: dict[str, str] = {
    USER_LOGIN: "account",
    USER_EMAIL_VERIFIED: "account",
    USER_PASSWORD_RESET_REQUESTED: "account",
    USER_PASSWORD_RESET: "account",
    USER_PASSWORD_CHANGED: "account",
    USER_NICKNAME: "account",
    USER_PHONE_SET: "account",
    MT5_BIND: "mt5",
    MT5_REVERIFY: "mt5",
    MT5_UNBIND: "mt5",
    MT5_REVOKED: "mt5",
    USER_API_TOKEN_RESET: "mt5",
    TRADE_CLOSE_ALL: "trade",
    TRADE_CORRECTED: "trade",
    AUTO_SETTINGS: "trade",
}

# 「只看异常」时这张表里算异常的 kind（设计 §5.5）/ kinds that count as abnormal (§5.5)
ABNORMAL_KINDS: frozenset[str] = frozenset({MT5_REVOKED, TRADE_CORRECTED})

ACTOR_USER = "user"
ACTOR_SYSTEM = "system"
ACTOR_ADMIN = "admin"
ACTOR_TYPES: frozenset[str] = frozenset({ACTOR_USER, ACTOR_SYSTEM, ACTOR_ADMIN})

# data 里标记「补录」的键 / the data key that marks a backfilled row
BACKFILL_FLAG = "bf"

# data 序列化后的长度上限（字符）/ cap on the serialised data, in characters
DATA_MAX_CHARS = 1000
# 超长时单个字符串 / 列表先截到这么长 / per-string and per-list cut when over the cap
_SHRINK_STR = 100
_SHRINK_LIST = 20

# 这些键名一律不进日志：设计约定日志里不存密码、token、哈希、IP。按键名精确匹配（不区分
# 大小写），剔除并告警——写进来的地方就是 bug，要让人看见。
# Key names never stored (the design keeps passwords, tokens, hashes and IPs out of
# the log). Exact, case-insensitive match; stripped with a warning because whoever
# passed one has a bug worth seeing.
_SENSITIVE_KEYS = frozenset({
    "password", "password_hash", "new_password", "old_password",
    "token", "api_token", "token_hash", "access_token", "refresh_token",
    "hash", "secret", "ip", "ip_hash", "remote_addr",
})

# 登录事件每人每小时最多记几条（老板 10-09 定的）/ login events kept per user per hour
LOGIN_EVENTS_PER_HOUR = 3
_LOGIN_QUOTA_KEY = "actlog:login:{user}"

# 一轮清扫最多删多少批，防止异常数据让清扫停不下来（每批 5000，够删一百万行）。
# Cap on batches per sweep so odd data can't keep it looping (5000 × 200 = 1M rows).
_PRUNE_MAX_BATCHES = 200
# 补录时一条多行 INSERT 带多少行（10 列 × 200 行 = 2000 个参数，SQLite / Postgres 都远在
# 上限以内）。/ rows per multi-row INSERT in the backfill (2000 parameters).
_BACKFILL_CHUNK = 200


# ─────────────────────────────────────────────────────────────────────────────
# 小工具 / small helpers
# ─────────────────────────────────────────────────────────────────────────────
def utcnow() -> datetime:
    """不带时区的 UTC 当前时间——activity_events.created_at 存的就是这个。
    Naive UTC now, which is what activity_events.created_at holds."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def iso_utc(dt: datetime | None) -> str | None:
    """时间 → 'YYYY-MM-DDTHH:MM:SS.ffffffZ'（UTC，固定带微秒）。不带时区的按 UTC 看
    （库里存的都是 UTC）。data 里的时间和去重键里的时间都走它，格式只有一种。不是 datetime
    的值原样转成字符串——它会被拿去拼去重键，拼键这一步不能抛。
    datetime -> 'YYYY-MM-DDTHH:MM:SS.ffffffZ' (UTC, always with microseconds). Naive
    values are taken as UTC, which is what the database stores. Used for times in data
    and in dedupe keys alike, so there is exactly one format. A non-datetime is just
    stringified: it ends up in dedupe keys, and building a key must never raise."""
    if dt is None:
        return None
    if not isinstance(dt, datetime):
        return str(dt)
    return _naive_utc(dt).isoformat(timespec="microseconds") + "Z"


def demo_of(trade_mode) -> bool | None:
    """mt5_accounts.trade_mode → data 里的 demo：True = 模拟 / 比赛，False = 实盘，
    None = 还没判定（NULL 或 -1）。
    trade_mode -> the "demo" flag: True demo/contest, False real, None undetermined."""
    from app.services.account_type import REAL

    if trade_mode is None:
        return None
    try:
        tm = int(trade_mode)
    except (TypeError, ValueError):
        return None
    if tm < 0:
        return None
    return tm != REAL


def _s(value) -> str | None:
    return None if value is None else str(value)


# ─────────────────────────────────────────────────────────────────────────────
# 去重键：运行时埋点与 rev 38 补录共用，格式改了就是两边各记一条。
# Dedupe keys, shared by the runtime hooks and the rev 38 backfill; change a format
# and both sides record the same event once each.
# ─────────────────────────────────────────────────────────────────────────────
def close_all_key(user_id: str, batch: str, login: str | None) -> str:
    """一键平仓（每个账号一行）：'ca:<user_id>:<批次号>:<login>'，login 为空写空串。
    Close-all, one row per account; an empty login becomes ''."""
    return f"ca:{user_id}:{batch}:{login or ''}"


def revoke_key(account_id: str, pass_change_at) -> str:
    """授权失效：'revoke:<mt5_accounts.id>:<pass_change_at>'。撤销时不改 pass_change_at、
    重新验证会换成新值，所以同一次失效只有一个键，下一次失效是另一个键。
    Revoked binding. Revocation leaves pass_change_at alone and re-verification
    replaces it, so one revocation episode maps to exactly one key."""
    try:
        pca = "" if pass_change_at is None else str(int(pass_change_at))
    except (TypeError, ValueError):
        pca = str(pass_change_at)
    return f"revoke:{account_id}:{pca}"


def bridge_bind_new_key(user_id: str, login, server: str | None) -> str:
    """桥接首次上报建出新账号行：'mt5bind:<user_id>:<login>:<server>:new'。
    A bridge report created a brand-new account row."""
    return f"mt5bind:{user_id}:{login}:{server or ''}:new"


def bridge_bind_revived_key(account_id: str, prior_revoked_at: datetime | None) -> str:
    """桥接复活一条用户删过的账号行：'mt5bind:<mt5_accounts.id>:<复活前的 revoked_at>'。
    prior_revoked_at 必须在 restore_removed 清掉它**之前**读。
    A bridge report revived a user-removed row; read prior_revoked_at *before*
    restore_removed clears it."""
    return f"mt5bind:{account_id}:{iso_utc(prior_revoked_at) or ''}"


def backfill_unbind_key(account_id: str, revoked_at: datetime | None) -> str:
    """rev 38 补录的「最后一次解绑」：'bf:unbind:<mt5_accounts.id>:<revoked_at>'。
    The rev 38 backfilled "last unbind"."""
    return f"bf:unbind:{account_id}:{iso_utc(revoked_at) or ''}"


def corrected_key(order_id: str) -> str:
    """结果更正（可选）：'corrected:<orders.id>'。一条指令最多从失败 / 已撤回更正成成交一次，
    带上它可以让网关（gateway_execute.try_gateway_execute）和桥接（bridge._result_db_work）
    两条回执路径重叠时也只记一条。只有这两处写 trade.corrected：超时清扫里的迟到结算
    （orders._settle_from_gateway）刻意不加语句，极少数并发清扫下一条单会直接变成成交、
    没有更正行。
    Result correction (optional): an order flips to filled at most once, so this
    keeps the overlapping gateway (try_gateway_execute) and bridge (_result_db_work)
    result paths to a single row. Only those two write trade.corrected: the stale
    sweep's late settlement (orders._settle_from_gateway) deliberately adds no
    statement, so in rare concurrent sweeps an order just turns filled with no
    correction row."""
    return f"corrected:{order_id}"


# ─────────────────────────────────────────────────────────────────────────────
# data 序列化 / data encoding
# ─────────────────────────────────────────────────────────────────────────────
def _scrub(value: Any, dropped: list[str]) -> Any:
    """剔掉敏感键名、把 NaN/inf 变成 None、datetime 变成 iso_utc。
    Strip sensitive keys, turn NaN/inf into None and datetimes into iso_utc."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            ks = str(k)
            if ks.lower() in _SENSITIVE_KEYS:
                dropped.append(ks)
                continue
            out[ks] = _scrub(v, dropped)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_scrub(v, dropped) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, datetime):
        return iso_utc(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


def _shrink(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _shrink(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_shrink(v) for v in value[:_SHRINK_LIST]]
    if isinstance(value, str) and len(value) > _SHRINK_STR:
        return value[:_SHRINK_STR] + "…"
    return value


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False, default=str)


def encode_data(data: dict | None) -> str | None:
    """data → 存库的 JSON 文本（≤ DATA_MAX_CHARS，始终是合法 JSON）。不是 dict 抛 TypeError
    （log_event 会接住、告警、跳过）。
    data -> the stored JSON text (≤ DATA_MAX_CHARS, always valid JSON). Raises
    TypeError for a non-dict, which log_event turns into a warning and a skip."""
    if data is None:
        return None
    if not isinstance(data, dict):
        raise TypeError(f"activity data must be a dict, got {type(data).__name__}")
    dropped: list[str] = []
    clean = _scrub(data, dropped)
    if dropped:
        logger.warning("操作日志 data 里出现敏感键名，已剔除 / sensitive keys dropped: %s", dropped)
    text = _dumps(clean)
    if len(text) <= DATA_MAX_CHARS:
        return text
    # 截断 JSON 文本会得到读不回来的半截；先截短里面的长字符串 / 长列表，还不行就只留标记。
    # Cutting the JSON text would leave unparsable half-JSON; shrink long strings and
    # lists first, and if that still doesn't fit keep only a marker.
    text = _dumps(_shrink(clean))
    if len(text) <= DATA_MAX_CHARS:
        return text
    return _dumps({"_truncated": True})


def decode_data(text: str | None) -> dict:
    """读接口用：存库的 data → dict；空 / 坏数据 / 不是对象都返回 {}。
    For the reader: stored data -> dict; {} for empty, corrupt or non-object values."""
    if not text:
        return {}
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _build_row(
    kind: str,
    *,
    user_id,
    mt5_login,
    actor_type: str,
    actor_id,
    ref_id,
    data: dict | None,
    dedupe_key: str | None,
    created_at: datetime | None = None,
) -> dict:
    """拼出一行（列名 → 值）。kind / actor_type 不认识、data 不合法都抛，由调用方接住。
    Assemble one row; raises on an unknown kind / actor_type or bad data."""
    if kind not in KINDS:
        raise ValueError(f"unknown activity kind {kind!r}")
    if actor_type not in ACTOR_TYPES:
        raise ValueError(f"unknown actor_type {actor_type!r}")
    return {
        # id 自己给：多行 INSERT 与 Core 路径都绕开了 ORM 的 Python 侧默认值。
        # Supplied here: the multi-row and Core paths bypass the ORM's Python default.
        "id": str(uuid.uuid4()),
        "created_at": _naive_utc(created_at) if created_at is not None else utcnow(),
        "kind": kind,
        "actor_type": actor_type,
        "actor_id": _s(actor_id),
        "user_id": _s(user_id),
        "mt5_login": _s(mt5_login),
        "ref_id": _s(ref_id),
        "data": encode_data(data),
        # 空串当没给：空串也是一个值，会让所有「没带键」的写入互相去重。
        # An empty key counts as none — "" is a value and would dedupe unrelated rows.
        "dedupe_key": _s(dedupe_key) or None,
    }


def _insert_ignore(dialect_name: str, rows: list[dict]):
    """`INSERT … ON CONFLICT (dedupe_key) DO NOTHING`，按方言取 insert()。只支持生产的
    Postgres 与测试 / 本地的 SQLite。
    The dialect-specific insert-or-ignore on dedupe_key (Postgres and SQLite)."""
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        raise NotImplementedError(f"insert-or-ignore not supported on {dialect_name}")
    return (
        dialect_insert(ActivityEvent.__table__)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["dedupe_key"])
    )


# ─────────────────────────────────────────────────────────────────────────────
# 写入 / writing
# ─────────────────────────────────────────────────────────────────────────────
def log_event(
    db: Session,
    kind: str,
    *,
    user_id: str | None = None,
    mt5_login: str | None = None,
    actor_type: str = ACTOR_USER,
    actor_id: str | None = None,
    ref_id: str | None = None,
    data: dict | None = None,
    dedupe_key: str | None = None,
) -> None:
    """在调用方的事务里记一条操作日志，随调用方的 commit 提交。见模块说明。

    不带 dedupe_key：只 db.add，放在 commit 前任意位置。带 dedupe_key：flush（业务异常原样
    上抛）+ SAVEPOINT 里的 insert-or-ignore，必须是 commit 前最后一步。其余任何失败都只告警。

    Record one event inside the caller's transaction, committed by the caller's
    commit; see the module docstring. Without dedupe_key it is a plain db.add.
    With one: flush (business errors re-raised as-is) then insert-or-ignore inside a
    SAVEPOINT, as the last step before commit. Every other failure only warns.
    """
    try:
        row = _build_row(
            kind, user_id=user_id, mt5_login=mt5_login, actor_type=actor_type,
            actor_id=actor_id, ref_id=ref_id, data=data, dedupe_key=dedupe_key,
        )
    except Exception:
        logger.warning("操作日志组装失败，已跳过 / activity row skipped: kind=%r", kind, exc_info=True)
        return

    if row["dedupe_key"] is None:
        try:
            db.add(ActivityEvent(**row))
        except Exception:
            logger.warning("操作日志写入失败，已跳过 / activity add failed: kind=%s", kind, exc_info=True)
        return

    _write_keyed(db, [row])


# log_events 每项除 "kind" 外认的键（就是 log_event 的关键字参数）。
# The keys log_events accepts per item besides "kind" (log_event's keyword arguments).
_EVENT_FIELDS = frozenset({
    "user_id", "mt5_login", "actor_type", "actor_id", "ref_id", "data", "dedupe_key",
})


def log_events(db: Session, events: list[dict]) -> None:
    """一次记多条**带 dedupe_key** 的事件（一键平仓的每个账号、桥接一拍里新建的几个账号）：
    一次 flush + 一个 SAVEPOINT 里一条多行 INSERT … ON CONFLICT DO NOTHING，而不是每行各来一遍
    flush + SAVEPOINT + INSERT + RELEASE——N 个账号从 3N 条语句降到 3 条，且都在业务那次
    commit 之前，平仓指令早一点放出去。

    events 每项就是 log_event 的关键字参数再加 "kind"（{"kind": …, "user_id": …, …}），按给定
    顺序写：Postgres 按 VALUES 的顺序逐行取唯一键，调用方排好序（按 login），两个事务就不会
    以相反顺序去抢同一组键。同一批里重复的键只留第一条。规矩同 log_event 带键的那一支：必须是
    commit 前最后一步；flush 抛的业务异常原样上抛；其余失败（某一条组装出错、INSERT 失败）
    只告警——组装出错的那一条跳过，INSERT 失败则这一批日志都丢（SAVEPOINT 回滚，业务不受影响）。
    不带 dedupe_key 的项按 log_event 的老办法 db.add。

    Record several dedupe-keyed events at once (close-all's accounts, the accounts
    one bridge report created): one flush plus one multi-row INSERT … ON CONFLICT DO
    NOTHING inside one SAVEPOINT instead of flush + SAVEPOINT + INSERT + RELEASE per
    row — 3 statements instead of 3N, all ahead of the business commit. Each item is
    log_event's keyword arguments plus "kind", written in the given order: Postgres
    takes the unique keys row by row in VALUES order, so a caller sorting by login
    keeps two transactions from taking the same keys in opposite orders. A key
    repeated within the batch keeps its first row. Same rules as log_event's keyed
    branch: last step before commit, the flush's business errors propagate, anything
    else only warns (a row that fails to compose is skipped; a failed INSERT loses
    this batch's rows only, rolled back to the SAVEPOINT). Unkeyed items fall back to
    log_event's plain db.add.
    """
    keyed: list[dict] = []
    seen: set[str] = set()
    for ev in events:
        kind = None
        try:
            kw = dict(ev)
            kind = kw.pop("kind", None)
            extra = set(kw) - _EVENT_FIELDS
            if extra:
                raise TypeError(f"unexpected activity fields {sorted(extra)}")
            row = _build_row(
                kind,
                user_id=kw.get("user_id"),
                mt5_login=kw.get("mt5_login"),
                actor_type=kw.get("actor_type", ACTOR_USER),
                actor_id=kw.get("actor_id"),
                ref_id=kw.get("ref_id"),
                data=kw.get("data"),
                dedupe_key=kw.get("dedupe_key"),
            )
        except Exception:
            logger.warning("操作日志组装失败，已跳过 / activity row skipped: kind=%r", kind, exc_info=True)
            continue
        if row["dedupe_key"] is None:
            # 没带键（空串也算没带，_build_row 的规矩）：log_event 的普通写法，只 db.add。
            # No key (an empty one counts as none, _build_row's rule): plain db.add.
            try:
                db.add(ActivityEvent(**row))
            except Exception:
                logger.warning("操作日志写入失败，已跳过 / activity add failed: kind=%s", kind, exc_info=True)
            continue
        if row["dedupe_key"] in seen:
            continue
        seen.add(row["dedupe_key"])
        keyed.append(row)
    if keyed:
        _write_keyed(db, keyed)


def _write_keyed(db: Session, rows: list[dict]) -> None:
    """带 dedupe_key 的行：flush（业务异常原样上抛）+ 一个 SAVEPOINT 里的 insert-or-ignore。
    行多时按 _BACKFILL_CHUNK 切成几条多行 INSERT，仍在同一个 SAVEPOINT 里。
    Keyed rows: flush (business errors propagate) then insert-or-ignore inside one
    SAVEPOINT, chunked by _BACKFILL_CHUNK when there are many."""
    # 业务行先落下、先拿锁：两条并发的同一件事里，输家在这一步就撞上业务自己的唯一约束 /
    # 行锁，而不是在日志这一行上。这里抛的是业务异常，原样上抛（见模块说明）。
    # Business rows first, so a concurrent duplicate trips over the business's own
    # unique constraint / row lock here rather than over the log row. Whatever this
    # raises is the business's error and propagates unchanged (see module docstring).
    db.flush()
    try:
        dialect_name = db.get_bind().dialect.name
        stmts = [
            _insert_ignore(dialect_name, rows[i:i + _BACKFILL_CHUNK])
            for i in range(0, len(rows), _BACKFILL_CHUNK)
        ]
        with db.begin_nested():
            for stmt in stmts:
                db.execute(stmt)
    except Exception:
        logger.warning(
            "操作日志去重写入失败，已跳过 / activity insert-or-ignore failed: kinds=%s keys=%s",
            sorted({r["kind"] for r in rows}), [r["dedupe_key"] for r in rows], exc_info=True,
        )


def _resolve_bind(bind) -> Engine | Connection:
    if bind is None:
        # 运行时取模块属性而不是导入时绑定名字：测试会替换 database.engine。
        # Looked up at call time, not bound at import: tests swap database.engine.
        from app.core import database

        return database.engine
    if isinstance(bind, Session):
        return bind.get_bind()
    return bind


def record_after_commit(
    kind: str,
    *,
    user_id: str | None = None,
    mt5_login: str | None = None,
    actor_type: str = ACTOR_SYSTEM,
    actor_id: str | None = None,
    ref_id: str | None = None,
    data: dict | None = None,
    dedupe_key: str | None = None,
    bind: Session | Engine | Connection | None = None,
) -> None:
    """业务**已经提交之后**才记的事件（目前只有 trade.corrected）：自己开一个短事务做一条
    INSERT，失败只告警。注意 actor_type 默认是 'system'。

    bind 传调用方手里的 Session（或 Engine）：测试里会话绑的是一次性的库，不传就会写到
    database.engine 指向的那个库。带 dedupe_key 时同样是 insert-or-ignore。

    For events only known after the business committed (today: trade.corrected).
    One INSERT in its own short transaction; a failure only warns. Note actor_type
    defaults to 'system'. Pass the caller's Session (or an Engine) as bind — in tests
    sessions are bound to throwaway databases, and omitting it writes to whatever
    database.engine points at. With dedupe_key it is insert-or-ignore too.
    """
    try:
        row = _build_row(
            kind, user_id=user_id, mt5_login=mt5_login, actor_type=actor_type,
            actor_id=actor_id, ref_id=ref_id, data=data, dedupe_key=dedupe_key,
        )
        target = _resolve_bind(bind)
        if row["dedupe_key"] is None:
            stmt = insert(ActivityEvent.__table__).values(row)
        else:
            stmt = _insert_ignore(target.dialect.name, [row])
        if isinstance(target, Connection):
            ctx = target.begin_nested() if target.in_transaction() else target.begin()
            with ctx:
                target.execute(stmt)
        else:
            with target.begin() as conn:
                conn.execute(stmt)
    except Exception:
        logger.warning("操作日志（提交后）写入失败，已跳过 / after-commit activity failed: kind=%r",
                       kind, exc_info=True)


def login_event_allowed(user_id: str) -> bool:
    """登录事件限流：同一个人一小时内最多记 LOGIN_EVENTS_PER_HOUR 条（设计 §4.2 user.login）。
    计数在 shared_state（多 worker 共用），读写出错按「不记」处理——少一条登录记录无所谓，
    不能让登录因为它变慢或失败。
    Login-event throttle: at most LOGIN_EVENTS_PER_HOUR per user per hour, counted in
    shared_state across workers. Any error means "don't record" — a missing login row
    is fine, a slower or failed login is not."""
    try:
        from app.services import shared_state

        n = shared_state.incr_with_ttl(_LOGIN_QUOTA_KEY.format(user=user_id), 3600)
        return n <= LOGIN_EVENTS_PER_HOUR
    except Exception:
        logger.warning("登录事件限流计数失败，本次不记 / login quota check failed", exc_info=True)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# 保留期清扫 / retention
# ─────────────────────────────────────────────────────────────────────────────
def prune_expired(
    db: Session,
    *,
    retention_days: int | None = None,
    batch_size: int = 5000,
    now: datetime | None = None,
) -> int:
    """删掉早于保留期的 activity_events，每批 batch_size 行、每批单独提交，返回删除总行数。

    分批是为了不在一条大 DELETE 里长时间持锁、把 WAL 撑大；每批按 created_at 取最老的那些
    id（走 idx_activity_events_created），所以不会全表扫描。保留天数默认取
    settings.ACTIVITY_RETENTION_DAYS，≤ 0 表示不清理。

    Delete activity_events older than the retention window in batches of
    batch_size, committing each batch, and return the total deleted. Batching keeps
    each DELETE short (no long lock, no WAL burst); each batch picks the oldest ids by
    created_at through idx_activity_events_created, so nothing scans the table.
    Defaults to settings.ACTIVITY_RETENTION_DAYS; ≤ 0 disables it.
    """
    days = settings.ACTIVITY_RETENTION_DAYS if retention_days is None else retention_days
    if not days or days <= 0:
        return 0
    cutoff = _naive_utc(now or datetime.now(timezone.utc)) - timedelta(days=int(days))
    table = ActivityEvent.__table__
    total = 0
    for _ in range(_PRUNE_MAX_BATCHES):
        oldest = (
            select(table.c.id)
            .where(table.c.created_at < cutoff)
            .order_by(table.c.created_at)
            .limit(batch_size)
        )
        n = db.execute(table.delete().where(table.c.id.in_(oldest))).rowcount or 0
        if not n:
            break
        db.commit()
        total += n
        if n < batch_size:
            break
    return total


# ─────────────────────────────────────────────────────────────────────────────
# rev 38 补录（设计 §3.5）/ rev 38 backfill (design §3.5)
# ─────────────────────────────────────────────────────────────────────────────
def _insert_ignore_chunks(conn: Connection, rows: list[dict]) -> int:
    inserted = 0
    dialect_name = conn.dialect.name
    for i in range(0, len(rows), _BACKFILL_CHUNK):
        chunk = rows[i:i + _BACKFILL_CHUNK]
        inserted += conn.execute(_insert_ignore(dialect_name, chunk)).rowcount or 0
    return inserted


def _backfill_close_all(engine: Engine) -> int:
    """(a) 历史一键平仓：orders 里 ca_ 前缀的子单按 (用户, 批次, 账号) 分组成一行 trade.close_all。
    时间取组内最早的子单，键与运行时同格式，所以运行时已经记过的批次不会再补一行。
    (a) Historical close-all: ca_ children grouped by (user, batch, login) into one
    trade.close_all each, timed at the earliest child, keyed exactly as at runtime."""
    from app.models import Order
    from app.services.close_all import CLOSE_ALL_PREFIX, batch_of

    o = Order.__table__
    pattern = CLOSE_ALL_PREFIX.replace("\\", "\\\\").replace("_", "\\_").replace("%", "\\%") + "%"
    groups: dict[tuple[str, str, str | None], list] = {}
    with engine.begin() as conn:
        for uid, cid, login, created in conn.execute(
            select(o.c.user_id, o.c.client_order_id, o.c.mt5_login, o.c.created_at)
            .where(o.c.client_order_id.like(pattern, escape="\\"))
        ):
            batch = batch_of(cid)
            if not uid or not batch or created is None:
                continue
            key = (str(uid), batch, str(login) if login else None)
            g = groups.get(key)
            if g is None:
                groups[key] = [_naive_utc(created), 1]
            else:
                g[1] += 1
                if _naive_utc(created) < g[0]:
                    g[0] = _naive_utc(created)
        rows = [
            _build_row(
                TRADE_CLOSE_ALL, user_id=uid, mt5_login=login, actor_type=ACTOR_USER,
                actor_id=uid, ref_id=batch, data={"count": n, BACKFILL_FLAG: 1},
                dedupe_key=close_all_key(uid, batch, login), created_at=first,
            )
            for (uid, batch, login), (first, n) in sorted(groups.items(), key=lambda kv: kv[1][0])
        ]
        return _insert_ignore_chunks(conn, rows)


def _backfill_unbind(engine: Engine) -> int:
    """(b) 已解绑账号：每条 revoked_reason='user_removed' 的行补它最后一次解绑（mt5.unbind，
    时间 = revoked_at）。只在这个 (用户, 账号) 还没有任何 mt5.* 事件时补——有了就说明运行时
    已经在记，补录只会制造一条重复的旧事。
    (b) Removed accounts: one mt5.unbind per user_removed row at revoked_at, only
    where the (user, login) has no mt5.* event yet — otherwise the runtime hooks are
    already recording it and a backfilled row would just duplicate history."""
    from app.models import MT5Account
    from app.services.gateway_binding import REASON_USER_REMOVED

    a = MT5Account.__table__
    e = ActivityEvent.__table__
    with engine.begin() as conn:
        have = {
            (str(u), str(l))
            for u, l in conn.execute(
                select(e.c.user_id, e.c.mt5_login).where(e.c.kind.in_(sorted(MT5_KINDS)))
            )
        }
        rows = []
        for acc_id, uid, login, source, name, revoked_at in conn.execute(
            select(a.c.id, a.c.user_id, a.c.login, a.c.source, a.c.account_name, a.c.revoked_at)
            .where(a.c.revoked_reason == REASON_USER_REMOVED, a.c.revoked_at.isnot(None))
        ):
            if (str(uid), str(login)) in have:
                continue
            rows.append(_build_row(
                MT5_UNBIND, user_id=uid, mt5_login=login, actor_type=ACTOR_USER,
                actor_id=uid, ref_id=acc_id,
                data={"ch": source, "name": name, BACKFILL_FLAG: 1},
                dedupe_key=backfill_unbind_key(acc_id, revoked_at), created_at=revoked_at,
            ))
        return _insert_ignore_chunks(conn, rows)


def _backfill_revoked(engine: Engine) -> int:
    """(c) 当前授权失效：revoked_reason='password_changed' 的行补一条 mt5.revoked（系统），
    键与运行时 revoke_key 同格式，上线后运行时再撤销同一次不会重复。
    (c) Current revocations: one system mt5.revoked per password_changed row, keyed
    like the runtime revoke_key so the two never double up."""
    from app.models import MT5Account
    from app.services.gateway_binding import REASON_PASSWORD_CHANGED

    a = MT5Account.__table__
    with engine.begin() as conn:
        rows = [
            _build_row(
                MT5_REVOKED, user_id=uid, mt5_login=login, actor_type=ACTOR_SYSTEM,
                actor_id=None, ref_id=acc_id,
                data={"reason": REASON_PASSWORD_CHANGED, BACKFILL_FLAG: 1},
                dedupe_key=revoke_key(acc_id, pass_change_at), created_at=revoked_at,
            )
            for acc_id, uid, login, pass_change_at, revoked_at in conn.execute(
                select(a.c.id, a.c.user_id, a.c.login, a.c.pass_change_at, a.c.revoked_at)
                .where(a.c.revoked_reason == REASON_PASSWORD_CHANGED, a.c.revoked_at.isnot(None))
            )
        ]
        return _insert_ignore_chunks(conn, rows)


def backfill_activity_events(engine: Engine) -> dict[str, int]:
    """rev 38 补录三类历史事件，返回每类实际插入的行数。幂等：全部带确定性 dedupe_key、
    ON CONFLICT DO NOTHING，两个 worker 同时跑、重跑都不会多出一行。每类各自一个事务。

    量级（2026-10-09 生产）：一键平仓子单几千行、账号 179 行，全部是带条件的单表读 +
    每 200 行一条多行 INSERT，合计远低于一秒。异常向上抛，由 database._backfill_activity_events
    兜住（不挡启动）。

    Backfill three kinds of historical events for rev 38 and return how many rows
    each actually inserted. Idempotent — deterministic dedupe keys with ON CONFLICT
    DO NOTHING, so two workers racing or a re-run add nothing. One transaction per
    kind. Production volume is a few thousand close-all children and 179 accounts:
    filtered single-table reads plus one multi-row INSERT per 200 rows, well under a
    second. Errors propagate to database._backfill_activity_events, which keeps them
    from blocking startup.
    """
    from sqlalchemy import inspect as sa_inspect

    counts = {"close_all": 0, "unbind": 0, "revoked": 0}
    if not sa_inspect(engine).has_table(ActivityEvent.__tablename__):
        return counts
    counts["close_all"] = _backfill_close_all(engine)
    counts["unbind"] = _backfill_unbind(engine)
    counts["revoked"] = _backfill_revoked(engine)
    return counts
