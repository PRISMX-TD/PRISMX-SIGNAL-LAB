"""管理后台「操作日志」页的读接口逻辑（设计 2026-10-09 §5）：只读、合并、翻译。

**数据从哪来。** 五张表各管一段，这里不复制任何一行，只在读的时候按时间合并：

  u  users             注册（created_at；Google 注册看 google_linked_at）
  e  activity_events   别处没有记录的事件（绑定解绑、登录、密码、一键平仓、结果更正…）
  o  orders            平台发出的每条交易指令及其结果
  c  closed_trades     MT5 侧的平仓成交（止损止盈触发、爆仓、手机端平仓…）；平台自己发起的
                       平仓腿不单独出行，它的盈亏补到对应的 CLOSE 指令行上。老行 reason 为空，
                       原因从备注推断（_effective_reason）
  a  admin_audit_logs  管理员 / 代理 / 系统的会员与设置变动

**怎么翻页。** 不 COUNT、不 OFFSET。每个源各跑一条「游标范围查询」
`WHERE (created_at, id) < (:ts, :id) ORDER BY created_at DESC, id DESC LIMIT limit+1`，
都落在 (created_at, id) 索引上（rev 38 建的；users 表只有几百行，例外）；heapq 按
(时间倒序, 源顺序) 归并取前 limit 行，每个源的游标前移到它最后被采用的那一行。游标是
base64url(JSON) `{"u": [ts, id] | "end" | null, "e": …}`，同一时间戳的行靠 id 定序，
不漏不重。合并规则里「审计同一次操作」「同账户 60 秒内的爆仓」「同一用户 120 秒内的重复
自动降级」三种组不能被翻页切开：页尾的组还没结束，就沿那一个源继续往下取到组结束（最多
再取 300 行）。代价是下一页可能出现比本页末尾稍新（最多约两分钟）的别的源的行——前端
追加后按 ts 重新排序即可。

**翻译。** 每一行（或每一组）翻成 `{kind, params, status, tags, …}`；句子由前端按
kind + params 拼，这里不出任何给人看的文案。kind 的完整清单在 KINDS，参数契约见
docs/superpowers/specs/2026-10-09-admin-activity-log-contract.md。

**补充信息一律批量。** 本页需要的用户、账户、平仓腿、一键平仓子单、原挂单、名称（邀请链接、
比赛、公告、群发、工单）每一类最多一条 IN 查询，只在本页确实用到时才查。

**零副作用。** 整个请求只读：不调 orders._void_stale_orders、不调
plan_expiry.downgrade_if_expired，不写任何一张表。Postgres 上先
`SET LOCAL statement_timeout = '5s'`，慢查询不会把连接攥住。

Read side of the admin "activity log" page (design 2026-10-09 §5): read-only,
merged, translated. Five tables each own a slice (above) and nothing is copied —
rows are merged by time at read time. Paging is keyset per source on
(created_at, id) with a heapq merge by (time desc, source order); the cursor is
base64url JSON of each source's last consumed row. Three grouping rules (one
admin operation, stop-outs on one account within 60s, duplicate auto-expiries
within 120s) must not be cut by a page boundary, so a page that ends inside such
a group keeps reading that one source until the group ends (≤300 extra rows); a
later page can therefore hold rows from other sources up to ~2 minutes newer
than this page's tail, and the frontend should re-sort on append. Every row (or
group) becomes `{kind, params, status, tags, …}`; sentences are built by the
frontend. Enrichment is one IN query per kind of lookup, only when the page needs
it. Zero side effects; Postgres gets a 5s statement timeout.
"""
from __future__ import annotations

import base64
import binascii
import heapq
import json
import logging
import re
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import String, and_, case, exists, func, literal_column, or_, text, tuple_
from sqlalchemy.orm import Session, aliased

from app.core.config import settings
from app.models import (
    ActivityEvent,
    AdminAuditLog,
    Announcement,
    ClosedTrade,
    Competition,
    CompetitionParticipant,
    EmailCampaign,
    InviteLink,
    MT5Account,
    Order,
    Ticket,
    User,
)
from app.services import activity_log as al
from app.services.auto_manage import (
    AUTO_KIND_BE,
    AUTO_KIND_RESTORE,
    AUTO_KIND_TRAIL,
    AUTO_PREFIX,
    auto_command_kind,
)
from app.services.close_all import CLOSE_ALL_PREFIX, batch_of
from app.services.gateway_binding import is_removed, is_revoked
from app.services.order_payload import GATEWAY_STALE_ORDER_MESSAGE, STALE_ORDER_MESSAGE, order_source_tag
from app.services.stats_time import local_day
from app.services.trade_performance import position_id_of

logger = logging.getLogger("prismx.activity_feed")


# ─────────────────────────────────────────────────────────────────────────────
# kind 清单。activity_events 里的那些沿用 activity_log 的常量（写入方与读接口同一份），
# 其余是从另外四张表翻译出来的。前端按 kind 拼句子，新增 kind 要同时改契约文档。
# The kind catalogue. activity_events kinds reuse activity_log's constants (one
# source for writer and reader); the rest are translated from the other four tables.
# ─────────────────────────────────────────────────────────────────────────────
USER_REGISTER = "user.register"
TRADE_OPEN = "trade.open"
PENDING_PLACE = "pending.place"
PENDING_MODIFY = "pending.modify"
PENDING_CANCEL = "pending.cancel"
TRADE_CLOSE = "trade.close"
AUTO_PARTIAL_TP = "auto.partial_tp"
SLTP_MODIFY = "sltp.modify"
AUTO_SL = "auto.sl"
# orders.action 出现了本模块不认识的值：照样显示，绝不丢 / an orders.action this module
# doesn't know — still shown, never dropped
TRADE_OTHER = "trade.other"
DEAL_CLOSE = "deal.close"
DEAL_STOPOUT_GROUP = "deal.stopout_group"
PLAN_TRIAL_CLAIM = "plan.trial_claim"
PLAN_INVITE_TRIAL = "plan.invite_trial"
PLAN_PAYMENT = "plan.payment"
PLAN_REFUND = "plan.refund"
PLAN_PAYMENT_ISSUE = "plan.payment_issue"
PLAN_AUTO_EXPIRE = "plan.auto_expire"
ADMIN_USER_PLAN = "admin.user_plan"
ADMIN_USER_ROLE = "admin.user_role"
ADMIN_USER_ATTRIBUTION = "admin.user_attribution"
# 一次保存同时改了角色 / 会员 / 归因里的两类以上（设计没单列这种情况，合成一行而不是拆开）
# One save touching more than one of role / plan / attribution (folded into one line)
ADMIN_USER_EDIT = "admin.user_edit"
ADMIN_USER_DISABLE = "admin.user_disable"
ADMIN_USER_ENABLE = "admin.user_enable"
ADMIN_VERIFY_EMAIL = "admin.verify_email"
ADMIN_BULK_EDIT = "admin.bulk_edit"
ADMIN_SETTING = "admin.setting"
ADMIN_INVITE_LINK = "admin.invite_link"
ADMIN_AGENT_ASSIGN = "admin.agent_assign"
AGENT_PLAN = "agent.plan"
ADMIN_COMPETITION = "admin.competition"
ADMIN_COMPETITION_PARTICIPANT = "admin.competition_participant"
ADMIN_ANNOUNCEMENT = "admin.announcement"
ADMIN_EMAIL = "admin.email"
ADMIN_OPS = "admin.ops"
ADMIN_GAMIFICATION = "admin.gamification"
ADMIN_TICKET = "admin.ticket"
ADMIN_OTHER = "admin.other"

# 每个 kind 进页面上的哪个分类 / the page category of every kind
KIND_CATEGORY: dict[str, str] = {
    **al.KIND_CATEGORY,
    USER_REGISTER: "account",
    TRADE_OPEN: "trade",
    PENDING_PLACE: "trade",
    PENDING_MODIFY: "trade",
    PENDING_CANCEL: "trade",
    TRADE_CLOSE: "trade",
    AUTO_PARTIAL_TP: "trade",
    SLTP_MODIFY: "trade",
    AUTO_SL: "trade",
    TRADE_OTHER: "trade",
    DEAL_CLOSE: "trade",
    DEAL_STOPOUT_GROUP: "trade",
    PLAN_TRIAL_CLAIM: "account",
    PLAN_INVITE_TRIAL: "account",
    PLAN_PAYMENT: "account",
    PLAN_REFUND: "account",
    PLAN_PAYMENT_ISSUE: "account",
    PLAN_AUTO_EXPIRE: "account",
    ADMIN_USER_PLAN: "admin",
    ADMIN_USER_ROLE: "admin",
    ADMIN_USER_ATTRIBUTION: "admin",
    ADMIN_USER_EDIT: "admin",
    ADMIN_USER_DISABLE: "admin",
    ADMIN_USER_ENABLE: "admin",
    ADMIN_VERIFY_EMAIL: "admin",
    ADMIN_BULK_EDIT: "admin",
    ADMIN_SETTING: "admin",
    ADMIN_INVITE_LINK: "admin",
    ADMIN_AGENT_ASSIGN: "admin",
    AGENT_PLAN: "admin",
    ADMIN_COMPETITION: "admin",
    ADMIN_COMPETITION_PARTICIPANT: "admin",
    ADMIN_ANNOUNCEMENT: "admin",
    ADMIN_EMAIL: "admin",
    ADMIN_OPS: "admin",
    ADMIN_GAMIFICATION: "admin",
    ADMIN_TICKET: "admin",
    ADMIN_OTHER: "admin",
}

# 这个读接口能吐出的全部 kind（唯一事实来源，前端与契约文档都以它为准）。
# Every kind this feed can emit — the single source of truth.
KINDS: frozenset[str] = frozenset(KIND_CATEGORY)

CATS = ("all", "account", "mt5", "trade", "admin")
SUBS = ("all", "open_close", "sltp")
STATUSES = ("ok", "fail", "unknown", "pending", "cancelled")
TAGS = ("unprotected", "stopout", "revoked", "late", "backfill", "shared_login", "partial", "gone", "auto")
ACTOR_TYPES = ("self", "system", "auto", "broker", "admin", "agent")

# 源的归并顺序（同一时间戳时的先后）/ merge order of the sources on equal timestamps
SOURCES = ("u", "e", "o", "c", "a")
_SRC_RANK = {s: i for i, s in enumerate(SOURCES)}

LIMIT_DEFAULT = 50
LIMIT_MAX = 100
# 页尾的组没结束时，沿该源最多再取多少行 / extra rows a page may read to finish a group
_GROUP_EXTRA_MAX = 300
# 合并 / 丢弃之后整页一行都不剩、但还没到底时，最多再翻几次（只为不给前端一页空列表）。
# Re-reads when grouping left a page empty but sources remain (so the UI never gets a
# blank page with a "load more").
_EMPTY_PAGE_RETRIES = 5

_STATEMENT_TIMEOUT = "5s"

_SO_WINDOW = timedelta(seconds=60)            # 同账户爆仓腿合并窗口 / stop-out grouping window
_AUTO_EXPIRE_WINDOW = timedelta(seconds=120)  # 自动降级去重窗口 / auto-expire de-dup window
_AUDIT_CHAIN = timedelta(seconds=2)           # 无 op_id 的旧审计行合并窗口 / legacy audit chain gap
_GOOGLE_SIGNUP_WINDOW = timedelta(seconds=60) # google_linked_at 与 created_at 相差多少算 Google 注册
# 注册那一刻送的邀请试用并入注册行：Google 注册当场发（同一事务，差几毫秒）；邮箱注册的试用
# 是验证邮箱时才补发的，只有贴着注册时间（旧版本当场发）的才并。
# Folding the invite trial into the sign-up: Google sign-ups grant it in the same
# transaction; e-mail sign-ups get it on verification, so only a grant hugging the
# sign-up time (older builds granted on the spot) is folded.
_TRIAL_FOLD_GOOGLE = timedelta(seconds=60)
_TRIAL_FOLD_EMAIL = timedelta(seconds=5)
_LATE_AFTER = timedelta(minutes=10)           # 平仓腿入库晚于成交多久标「late」
_LEG_SLACK = timedelta(seconds=5)             # 平台平仓腿入库时间可早于指令时间多少（时钟误差）
# 一键平仓子单与 trade.close_all 那一行的时间差上限（只用来收窄「只看异常」的子查询）
# How far a close-all child's created_at may sit from its trade.close_all row
_CLOSE_ALL_CHILD_WINDOW = timedelta(minutes=10)
_VOL_EPS = 1e-9

_PLATFORM_CLOSE_REASONS = ("DEALER", "EXPERT")
_SLTP_REASONS = ("SL", "TP")
_DEAL_REASONS = frozenset({"SL", "TP", "SO", "MOBILE", "CLIENT", "WEB"})
# 2026-09 中旬之前入库的平仓腿 reason 是空的，原因写在备注里：服务器触发的是
# `[sl 4123.45]` / `[tp 1.0850]` / `[so 49.12%/…]`，平台自己平的以 GATEWAY_COMMENT_PREFIX
# 开头（`PRISMX close`）。按备注开头推断（不分大小写），见 _effective_reason。
# Closing legs recorded before mid-September 2026 have no reason; the comment
# tells it (case-insensitive prefix), see _effective_reason.
_COMMENT_REASON_MARKS = (("[SL", "SL"), ("[TP", "TP"), ("[SO", "SO"))
# reason 为空、备注带平台前缀的老腿按 DEALER 算——与「DEALER + 前缀」一样是平台腿
# A blank-reason leg with the platform prefix counts as DEALER, i.e. a platform leg
_LEGACY_PLATFORM_REASON = "DEALER"
_OTHER_REASON = "OTHER"
# 用户自己在 MT5 客户端里平的 / closed by the user in an MT5 app
_SELF_CLOSE_REASONS = frozenset({"MOBILE", "CLIENT", "WEB"})
_ABNORMAL_ORDER_STATUSES = ("REJECTED", "FAILED")
# 成交了但补设 SL/TP 失败时网关写进 message 的标记（gateway_execute.apply_trade_result 按
# 同一个字面量保留这条 message）/ the marker gateway_execute.apply_trade_result keeps
_SLTP_FAILED_MARK = "SL/TP 设置失败"
# 桥接平一张已经不存在的仓位时回 FILLED + 这句话（bridge/mt5_worker.py 的平仓分支）
# A bridge CLOSE on an already-gone position answers FILLED with this message
_GONE_MARK = "position already closed"
# 自动仓管改止损单的指令号带动作（auto_manage.auto_command_kind 读出来）：保本 / 追踪 /
# 补回；旧的 auto_sl_ 分不出是哪种（mode=None）。分批止盈是 auto_tp_。
# Auto-manage stop moves carry their mode in the id (read by auto_manage.
# auto_command_kind); legacy auto_sl_ has none.
_AUTO_SL_MODES = (AUTO_KIND_BE, AUTO_KIND_TRAIL, AUTO_KIND_RESTORE)

# 审计里「被管理员改的用户字段」/ user fields an admin edits
_USER_FIELDS = ("role", "plan", "plan_expires_at", "plan_note", "invite_code")
_PLAN_FIELDS = frozenset({"plan", "plan_expires_at", "plan_note"})
# 账户分类里的系统 / 本人行（与 _account_field_cond 的 SQL 一一对应）
# System / self rows that belong to the account category (mirrors _account_field_cond)
_ACCOUNT_FIELDS_EXACT = ("plan:trial_claim", "plan:invite_trial", "plan:auto_expire", "plan:payment")
_AUTO_EXPIRE_FIELD = "plan:auto_expire"

_LOGIN_RE = re.compile(r"\d{5,12}")
# 搜索框里手机号常带的分隔符（库里的 E.164 不带）/ separators people type in phone numbers
_PHONE_SEP_RE = re.compile(r"[\s\-().]")
_PLAN_VALUE_RE = re.compile(r"^([A-Za-z_]+)\((.*)\)$")
_TRIAL_DAYS_RE = re.compile(r"^(\d+)d$")
_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}")

_EPOCH = datetime(1970, 1, 1)
_ONE_US = timedelta(microseconds=1)


class FeedError(ValueError):
    """参数不合法（分类、时间、游标、key 格式）→ 路由回 400。
    Bad parameters (category, time, cursor, key format) -> 400 at the router."""


_BAD_TEXT = "参数含非法字符 / invalid character in parameters"


def _bad_text(value: Any) -> bool:
    """文本参数里有 NUL 或孤立代理字符（编不成 UTF-8）。psycopg2 拒绝绑定含 NUL 的字符串
    （ValueError；SQLite 照收，所以只在 Postgres 上是 500），孤立代理两种驱动都编码失败
    （只可能从游标 JSON 的 \\u 转义进来）——统一当坏参数 400，不让它们走到数据库。
    A text parameter carrying NUL or a lone surrogate (not UTF-8 encodable).
    psycopg2 refuses to bind a string containing NUL (ValueError; SQLite accepts it,
    so the 500 was Postgres-only) and neither driver can encode a lone surrogate
    (reachable only through the cursor JSON's \\u escapes) — both are bad input
    (400) and never reach the database."""
    if not isinstance(value, str) or not value:
        return False
    if "\x00" in value:
        return True
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return True
    return False


# ─────────────────────────────────────────────────────────────────────────────
# 小工具 / small helpers
# ─────────────────────────────────────────────────────────────────────────────
def _naive_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _us(dt: datetime) -> int:
    return (dt - _EPOCH) // _ONE_US


def _iso(dt: datetime | None) -> str | None:
    return al.iso_utc(dt) if dt is not None else None


def _blank(value):
    """'' → None，其余原样 / '' -> None, anything else unchanged."""
    if isinstance(value, str) and value == "":
        return None
    return value


def _like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _num(value) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _price(value) -> float | None:
    """止损 / 止盈 / 价格：0 或空都表示「没有」，统一成 None。
    SL / TP / price: 0 and empty both mean "none"."""
    v = _num(value)
    if v is None or abs(v) <= _VOL_EPS:
        return None
    return v


def _same(a: float, b: float) -> bool:
    return abs(a - b) <= _VOL_EPS * max(1.0, abs(a), abs(b))


def _parse_dt(value) -> datetime | None:
    """审计里的时间是 str(datetime)，有的带 +00:00、有的用空格——宽松解析成 naive UTC。
    Audit timestamps are str(datetime), with or without +00:00 / 'T'; parse leniently."""
    if isinstance(value, datetime):
        return _naive_utc(value)
    if not isinstance(value, str) or not _DATETIME_RE.match(value.strip()):
        return None
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return _naive_utc(datetime.fromisoformat(s))
    except (ValueError, OverflowError):
        # OverflowError：换算到 UTC 后超出 1–9999 年 / out of range once shifted to UTC
        return None


def _parse_value(value, *, json_always: bool = False):
    """审计 old/new 文本 → 结构化的值：'' → None；JSON（对象 / 数组 / 带引号的字符串 /
    true·false·null）→ 解析；str(bool) → bool；时间 → ISO（…Z）；其余原样字符串。
    json_always：值一定是 json.dumps 写的（setting:* / gamification:*），数字也解析。
    Audit old/new text -> a structured value (see above). json_always is for fields
    always written through json.dumps, where numbers are parsed as well."""
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    s = value.strip()
    if s == "":
        return None
    if json_always or s[0] in "{[\"" or s in ("true", "false", "null"):
        try:
            return json.loads(s)
        except ValueError:
            pass
    if s == "True":
        return True
    if s == "False":
        return False
    dt = _parse_dt(s)
    if dt is not None:
        return _iso(dt)
    return value


def _as_dict(value) -> dict:
    parsed = _parse_value(value)
    return parsed if isinstance(parsed, dict) else {}


def _plan_value(value) -> tuple[str | None, str | None]:
    """'PRO(2026-11-08 12:00:00+00:00)' / 'FREE(None)' / 'PRO(7d)' → (等级, 括号里的内容)。
    Split the "PLAN(inner)" shape payments and trials write."""
    if not value:
        return None, None
    m = _PLAN_VALUE_RE.match(str(value).strip())
    if not m:
        return str(value), None
    inner = m.group(2).strip()
    return m.group(1), (None if inner in ("", "None") else inner)


def _trial_days(inner: str | None) -> int | None:
    if not inner:
        return None
    m = _TRIAL_DAYS_RE.match(inner)
    return int(m.group(1)) if m else None


def _worst_status(statuses: Iterable[str]) -> str:
    """一组子项的总状态：有处理中就是处理中，否则结果未知 > 失败 > 已撤回 > 成功。
    The combined status of children."""
    seen = set(statuses)
    for s in ("pending", "unknown", "fail", "cancelled"):
        if s in seen:
            return s
    return "ok"


def _scrub_for_json(value):
    """params 里只放 JSON 原生类型 / params hold JSON-native types only."""
    if isinstance(value, datetime):
        return _iso(value)
    if isinstance(value, dict):
        return {str(k): _scrub_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrub_for_json(v) for v in value]
    return value


# ─────────────────────────────────────────────────────────────────────────────
# 游标 / cursor
# ─────────────────────────────────────────────────────────────────────────────
def encode_cursor(state: dict[str, Any]) -> str:
    """{源: [ts, id] | "end" | None} → base64url(JSON)（不带 = 补齐）。
    {source: [ts, id] | "end" | None} -> unpadded base64url(JSON)."""
    out: dict[str, Any] = {}
    for name, value in state.items():
        if isinstance(value, tuple):
            out[name] = [value[0].isoformat(timespec="microseconds"), value[1]]
        else:
            out[name] = value
    raw = json.dumps(out, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def decode_cursor(cursor: str | None, names: Iterable[str]) -> dict[str, Any]:
    """反过来；缺的源当「从头开始」。格式不对一律 FeedError（400）。
    The inverse; a missing source starts from the top. Malformed -> FeedError."""
    state: dict[str, Any] = {n: None for n in names}
    if not cursor:
        return state
    try:
        pad = "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(cursor + pad).decode())
    except (ValueError, binascii.Error, UnicodeDecodeError) as e:
        raise FeedError("游标无效 / invalid cursor") from e
    if not isinstance(data, dict):
        raise FeedError("游标无效 / invalid cursor")
    for name in state:
        value = data.get(name)
        if value is None or value == "end":
            state[name] = value
            continue
        if (
            not isinstance(value, list) or len(value) != 2
            or not isinstance(value[0], str) or not isinstance(value[1], str)
            # id 原样进 keyset 元组：带 NUL / 孤立代理在 Postgres 上是 500（见 _bad_text）
            # The id goes straight into the keyset tuple: NUL / lone surrogates would 500
            or _bad_text(value[0]) or _bad_text(value[1])
        ):
            raise FeedError("游标无效 / invalid cursor")
        try:
            # 换算到 UTC 也放在 try 里：偏移把日期推出 1–9999 年时是 OverflowError
            # The UTC shift stays inside the try: an offset pushing the date out of
            # years 1-9999 raises OverflowError, not ValueError
            ts = _naive_utc(datetime.fromisoformat(value[0]))
        except (ValueError, OverflowError) as e:
            raise FeedError("游标无效 / invalid cursor") from e
        state[name] = (ts, value[1])
    return state


def parse_time(value: str | None, name: str) -> datetime | None:
    """since / until：ISO（UTC，带不带 Z 都行；不带时区按 UTC）→ naive UTC。
    ISO (UTC; Z optional; naive taken as UTC) -> naive UTC."""
    if value is None or str(value).strip() == "":
        return None
    s = str(value).strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    try:
        return _naive_utc(datetime.fromisoformat(s))
    except (ValueError, OverflowError) as e:
        # OverflowError：如 0001-01-01T00:00:00+01:00，换算成 UTC 落到公元 1 年之前——同样是 400
        # OverflowError: e.g. 0001-01-01T00:00:00+01:00 falls before year 1 in UTC — still a 400
        raise FeedError(f"{name} 不是合法的 ISO 时间 / {name} is not an ISO datetime") from e


def _set_timeout(db: Session) -> None:
    """Postgres：本事务内每条语句最多 5 秒。SQLite 没有这个设置。
    Postgres: cap every statement of this transaction at 5s. SQLite has no such knob."""
    if db.get_bind().dialect.name == "postgresql":
        db.execute(text(f"SET LOCAL statement_timeout = '{_STATEMENT_TIMEOUT}'"))


# ─────────────────────────────────────────────────────────────────────────────
# 筛选范围 / filter scope
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class _Scope:
    # None = 不按用户筛；列表 = 只看这些人 / None = no user filter
    user_ids: list[str] | None = None
    login: str | None = None
    # 这个 MT5 账号在 mt5_accounts 里的全部持有人（含已解绑）/ every holder of the login
    holders: list[str] | None = None
    empty: bool = False

    @property
    def user_filtered(self) -> bool:
        return self.user_ids is not None

    def trade_user_ids(self) -> list[str] | None:
        """orders / closed_trades / activity_events 用的用户集合：按用户筛时就是它；只按
        账号筛时用持有人，让查询走 user_id 索引（设计 §5.5）。
        The user set for the per-user sources: the user filter, or — for a login-only
        filter — the login's holders so the query uses the user_id index."""
        if self.user_ids is not None:
            return self.user_ids
        if self.login is not None and self.holders:
            return self.holders
        return None


def _login_holders(db: Session, login: str) -> list[str]:
    """这个 MT5 账号的全部持有人（含已解绑）。mt5_accounts 里一行都没有时再看 closed_trades
    （走 (mt5_login, closed_at) 索引）：2026-09-06 改软删之前，删账号是物理删行，那些老账号
    只剩平仓记录上的 user_id。
    Every holder of a login, removed ones included. With no mt5_accounts row at all,
    fall back to closed_trades (indexed on (mt5_login, closed_at)): before soft
    deletes (2026-09-06) removing an account deleted the row, so old logins survive
    only on their closing deals."""
    holders = {r[0] for r in db.query(MT5Account.user_id).filter(MT5Account.login == login).all()}
    if not holders:
        holders = {
            r[0] for r in db.query(ClosedTrade.user_id).filter(ClosedTrade.mt5_login == login).distinct().all()
        }
    return sorted(u for u in holders if u)


def _search_users(db: Session, cond) -> list[str]:
    # 最多 20 个、最新注册的优先。created_at 为空的老用户排最后：Postgres 倒序默认 NULLS FIRST
    # （SQLite 是排最后），不写明的话它们在 Postgres 上永远占住名额、把最新的人挤出去。
    # Newest 20 first; NULL created_at (legacy users) last on both engines — Postgres
    # defaults to NULLS FIRST for DESC (SQLite puts them last), which would let them
    # always take slots and push the newest users out of the cap.
    return [
        r[0]
        for r in db.query(User.id)
        .filter(cond)
        .order_by(User.created_at.desc().nulls_last(), User.id.desc())
        .limit(20)
        .all()
    ]


def _resolve_scope(db: Session, q: str | None, user_id: str | None, login: str | None) -> _Scope:
    """把 q / user_id / login 解析成一组用户 + 一个账号（设计 §5.5）。
    q：5–12 位纯数字（去掉空格 / 横线 / 括号 / 点之后）先按 MT5 账号；这个账号没有任何持有人
    时退回按手机号包含查人（管理员常把手机号不带「+」整串粘进来）。其余按 邮箱前缀 / 昵称包含 /
    手机号包含 查人（最多 20 个；手机号按去掉分隔符的写法比，库里存的是不带分隔符的 E.164）。
    账号查不到任何持有人 → 直接空页：不再拿一个没人用过的账号号去扫 orders（orders 没有
    mt5_login 索引，只有 user_id IN 持有人才走得了索引）。
    Resolve q / user_id / login (design §5.5). A 5-12 digit q (after dropping spaces,
    dashes, brackets and dots) is a login first; a login nobody holds falls back to
    a phone-number search (admins paste phones without the '+'). Anything else
    searches users by e-mail prefix, nickname or phone substring (max 20; phones are
    compared without separators, as stored in E.164). A login with no holder at all
    is an empty page outright — orders has no mt5_login index, so it must never be
    scanned for a login no one holds."""
    scope = _Scope()
    user_id = (user_id or "").strip() or None
    login = (login or "").strip() or None
    q = (q or "").strip() or None
    if user_id:
        scope.user_ids = [user_id]
    if q:
        qd = _PHONE_SEP_RE.sub("", q)
        found: list[str] | None = None
        if _LOGIN_RE.fullmatch(qd):
            holders = _login_holders(db, qd)
            if holders:
                if login and login != qd:
                    scope.empty = True
                    return scope
                login = qd
                scope.holders = holders
            else:
                # 没人持有这个账号号：多半是不带「+」的手机号 / no holder: most likely a phone without '+'
                found = _search_users(db, User.phone.like("%" + _like_escape(qd) + "%", escape="\\"))
        else:
            esc = _like_escape(q)
            phone = _like_escape(qd) if qd else esc
            found = _search_users(db, or_(
                User.email.ilike(esc + "%", escape="\\"),
                User.nickname.ilike("%" + esc + "%", escape="\\"),
                User.phone.like("%" + phone + "%", escape="\\"),
            ))
        if found is not None:
            scope.user_ids = found if scope.user_ids is None else [u for u in scope.user_ids if u in found]
            if not scope.user_ids:
                scope.empty = True
                return scope
    if login:
        scope.login = login
        if scope.holders is None:
            scope.holders = _login_holders(db, login)
        if not scope.holders:
            # 没人持有过这个账号：它不可能有任何可归属的行 / nobody ever held it: nothing to show
            scope.empty = True
            return scope
        if scope.user_ids is not None:
            scope.user_ids = [u for u in scope.user_ids if u in scope.holders]
            if not scope.user_ids:
                scope.empty = True
    return scope


# ─────────────────────────────────────────────────────────────────────────────
# 数据源 / sources
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class _Row:
    src: str
    ts: datetime
    id: str
    obj: Any


class _Source:
    """一个源 = 一条带筛选条件的「按 (created_at, id) 倒序」查询。
    One source: a filtered query ordered by (created_at, id) descending."""

    def __init__(self, name: str, db: Session, entity, ts_col, id_col, conds: list):
        self.name = name
        self.db = db
        self.entity = entity if isinstance(entity, (list, tuple)) else (entity,)
        self.ts_col = ts_col
        self.id_col = id_col
        self.conds = [ts_col.isnot(None), *conds]

    def fetch(self, after: tuple[datetime, str] | None, n: int) -> list[_Row]:
        q = self.db.query(*self.entity).filter(*self.conds)
        if after is not None:
            q = q.filter(tuple_(self.ts_col, self.id_col) < tuple_(after[0], after[1]))
        rows = q.order_by(self.ts_col.desc(), self.id_col.desc()).limit(n).all()
        return [_Row(self.name, _naive_utc(r.created_at), r.id, r) for r in rows]


def _account_field_cond():
    f = AdminAuditLog.field
    return or_(f.in_(_ACCOUNT_FIELDS_EXACT), f.like("plan:refund%"), f.like("payment:%"))


def _is_account_field(f: str) -> bool:
    return f in _ACCOUNT_FIELDS_EXACT or f.startswith("plan:refund") or f.startswith("payment:")


def _is_abnormal_audit_field(f: str) -> bool:
    return f == "account:disable" or f.startswith("plan:refund") or (f.startswith("payment:") and "mismatch" in f)


def _comment_prefix() -> str:
    """平台下单 / 平仓时写进备注的前缀（大写）；空 = 没配。每次现读（测试会改它）。
    The platform's comment prefix, upper-cased; '' = not configured. Read per call."""
    return (settings.GATEWAY_COMMENT_PREFIX or "").strip().upper()


def _effective_reason(t) -> str:
    """平仓腿的「有效 reason」：reason 有值就用它（大写）；为空（2026-09 中旬之前的老行）就看
    备注开头（不分大小写）：
      平台前缀（前缀没配时跳过） → DEALER（平台自己平的，与「DEALER + 前缀」同样是平台腿）
      `[sl` → SL；`[tp` → TP；`[so` → SO；其余（含空备注） → OTHER。
    前缀先判：默认前缀 PRISMX 与三种 `[xx` 不会重叠；万一配得重叠，以前缀为准——与
    _effective_reason_sql 逐条同序，列表、子分类、只看异常、爆仓合并、盈亏配对全用这一个口径。
    A leg's effective reason: its reason (upper-cased) when set; for blank-reason
    legacy rows (before mid-September 2026) the comment's start, case-insensitive:
    the platform prefix (skipped when unset) -> DEALER (a platform leg, like DEALER +
    prefix); `[sl` -> SL, `[tp` -> TP, `[so` -> SO; anything else (empty included) ->
    OTHER. The prefix is checked first (PRISMX never overlaps the `[xx` marks), in
    the same order as _effective_reason_sql — the one rule behind the list, the
    sub-tabs, the abnormal filter, stop-out grouping and P&L matching."""
    reason = (t.reason or "").upper()
    if reason:
        return reason
    comment = (t.comment or "").upper()
    prefix = _comment_prefix()
    if prefix and comment.startswith(prefix):
        return _LEGACY_PLATFORM_REASON
    for mark, inferred in _COMMENT_REASON_MARKS:
        if comment.startswith(mark):
            return inferred
    return _OTHER_REASON


def _comment_starts_sql(mark: str):
    # COALESCE：备注为空时是 FALSE 而不是 NULL / FALSE rather than NULL on a NULL comment
    return func.upper(func.coalesce(ClosedTrade.comment, "")).like(_like_escape(mark) + "%", escape="\\")


def _effective_reason_sql():
    """_effective_reason 的 SQL 版（CASE，分支同序），结果永远不是 NULL——取反、NOT IN 都安全
    （`NULL IN (…)` 是 NULL，取 NOT 还是 NULL，以前 reason 为空的行会被整行滤掉）。只当筛选条件
    用，created_at 上不套函数，(created_at, id) 索引照走。
    _effective_reason in SQL (a CASE with the same branches in the same order).
    Never NULL, so negations are safe (`NOT (NULL IN …)` is NULL and used to drop
    blank-reason rows). A filter only — created_at stays bare for the index."""
    ct = ClosedTrade
    whens = [(and_(ct.reason.isnot(None), ct.reason != ""), func.upper(ct.reason))]
    prefix = _comment_prefix()
    if prefix:
        whens.append((_comment_starts_sql(prefix), _LEGACY_PLATFORM_REASON))
    whens += [(_comment_starts_sql(mark), inferred) for mark, inferred in _COMMENT_REASON_MARKS]
    return case(*whens, else_=_OTHER_REASON)


def _platform_leg_cond():
    """平台自己发起的平仓腿：有效 reason 是 DEALER / EXPERT 且备注以 GATEWAY_COMMENT_PREFIX 开头
    （不分大小写，与 routers/gateway 的归属判断同口径）。也就是
    `备注 LIKE 前缀% AND (reason 为空 OR reason IN ('DEALER','EXPERT'))`——reason 为空的老平台腿
    也算，盈亏补到对应的 CLOSE 指令上，不再单独冒出一行「其它」、指令那边一直「盈亏同步中」。
    前缀配成空 = 只看 reason（reason 为空的腿这时没有任何平台证据，不算）。永远不是 NULL。
    A platform-initiated closing leg: effective reason DEALER / EXPERT and a comment
    starting with the prefix, i.e. `comment LIKE prefix% AND (reason blank OR reason
    IN (DEALER, EXPERT))` — legacy blank-reason platform legs included, so their P&L
    lands on the CLOSE command instead of an extra "other" line. An empty prefix
    means reason alone (a blank reason then carries no platform evidence). Never NULL.

    直接写成上面那条式子而不套 CASE：每次列表都要跑它，EXPLAIN 里好读；与 _is_platform_leg
    逐行一致由测试守着。
    Written as the formula above rather than via the CASE (it runs on every list
    query and reads better in EXPLAIN); a test keeps it equal to _is_platform_leg."""
    ct = ClosedTrade
    blank = or_(ct.reason.is_(None), ct.reason == "")
    # FALSE AND NULL 是 FALSE：reason 为空时整个是 FALSE，不是 NULL / never NULL on a NULL reason
    reason_ok = and_(~blank, func.upper(ct.reason).in_(_PLATFORM_CLOSE_REASONS))
    prefix = _comment_prefix()
    if not prefix:
        return reason_ok
    return and_(_comment_starts_sql(prefix), or_(blank, reason_ok))


def _is_platform_leg(leg) -> bool:
    """_platform_leg_cond 的 Python 版 / _platform_leg_cond in Python."""
    if _effective_reason(leg) not in _PLATFORM_CLOSE_REASONS:
        return False
    prefix = _comment_prefix()
    return not prefix or (leg.comment or "").upper().startswith(prefix)


def _shift_minutes(col, minutes: int, dialect: str):
    """SQL 里给时间列加减几分钟（Postgres 用 interval，SQLite 用 datetime()）。
    A timestamp column shifted by N minutes in SQL (interval on Postgres, datetime() on SQLite)."""
    if dialect == "postgresql":
        return col + literal_column(f"interval '{int(minutes)} minutes'")
    return func.datetime(col, f"{int(minutes):+d} minutes")


def _close_all_failed_exists(dialect: str = "postgresql"):
    """「一键平仓行有失败子单」：同一用户、子单号以 <批次号># 开头、状态 REJECTED/FAILED、
    （行带账号时）同一账号。批次号里有 `_`，拼 LIKE 前在 SQL 里转义。
    子单的 created_at 限在这一行前后 _CLOSE_ALL_CHILD_WINDOW 内：子单只在 close_all.queue 那一个
    请求里建（与这一行同一个事务，相差几毫秒；并发重放补排也只晚几秒），补录行的时间就是最早
    那张子单的时间。有了这个范围，相关子查询在 idx_orders_user_status_created
    (user_id, status, created_at) 上只扫一小段，而不是这个用户全部的失败单。
    A close-all row with a failed child; the batch id contains `_`, escaped in SQL.
    Children are bounded to ±_CLOSE_ALL_CHILD_WINDOW around the row: they are created
    only in close_all.queue's request (same transaction as the row; a concurrent
    replay's top-up is seconds later) and the backfill times its row at the earliest
    child. The bound turns the correlated subquery into a short range on
    idx_orders_user_status_created instead of all of the user's failed orders."""
    o2 = aliased(Order)
    ev = ActivityEvent
    pattern = func.replace(
        func.replace(func.replace(ev.ref_id, "\\", "\\\\", type_=String), "%", "\\%", type_=String),
        "_", "\\_", type_=String,
    ) + "#%"
    window = int(_CLOSE_ALL_CHILD_WINDOW.total_seconds() // 60)
    return exists().where(
        o2.user_id == ev.user_id,
        o2.status.in_(_ABNORMAL_ORDER_STATUSES),
        o2.created_at >= _shift_minutes(ev.created_at, -window, dialect),
        o2.created_at <= _shift_minutes(ev.created_at, window, dialect),
        o2.client_order_id.like(pattern, escape="\\"),
        or_(ev.mt5_login.is_(None), o2.mt5_login == ev.mt5_login),
    )


def _event_kinds(cat: str, sub: str) -> list[str] | None:
    """activity_events 在这个分类下要哪些 kind；None = 全要。交易的两个子分类里：
    「止盈止损」没有事件；「开平仓」只要一键平仓与结果更正——自动仓管设置既不是开平仓也不是
    改止损，只出现在「交易 · 全部」里。
    The activity_events kinds wanted for a category; None = all. Under trade, the
    SL/TP tab has no events and open/close takes close-all and corrections only;
    auto-manage settings belong to neither sub-tab, only to trade · all."""
    if cat == "all":
        return None
    kinds = sorted(k for k, c in al.KIND_CATEGORY.items() if c == cat)
    if cat == "trade":
        if sub == "sltp":
            return []
        if sub == "open_close":
            return [al.TRADE_CLOSE_ALL, al.TRADE_CORRECTED]
    return kinds


def _sources(
    db: Session, cat: str, sub: str, abnormal: bool, scope: _Scope,
    since: datetime | None, until: datetime | None,
) -> "OrderedDict[str, _Source]":
    """按分类 / 子分类 / 筛选决定查哪几个源、各带什么条件（只查需要的源）。
    Which sources a request needs and their filters — unneeded sources aren't queried."""
    if cat != "trade":
        sub = "all"
    out: OrderedDict[str, _Source] = OrderedDict()
    trade_ids = scope.trade_user_ids()

    def bounds(col) -> list:
        conds = []
        if since is not None:
            conds.append(col >= since)
        if until is not None:
            conds.append(col < until)
        return conds

    # u：注册。只按账号筛 / 只看异常时没有它 / sign-ups; none for login or abnormal filters
    if cat in ("all", "account") and not abnormal and scope.login is None:
        conds = bounds(User.created_at)
        if scope.user_ids is not None:
            conds.append(User.id.in_(scope.user_ids))
        out["u"] = _Source(
            "u", db, (User.id, User.created_at, User.google_linked_at, User.invite_code),
            User.created_at, User.id, conds,
        )

    # e：activity_events
    kinds = _event_kinds(cat, sub)
    if cat != "admin" and kinds != []:
        ev = ActivityEvent
        conds = bounds(ev.created_at)
        if kinds is not None:
            conds.append(ev.kind.in_(kinds))
        if trade_ids is not None:
            conds.append(ev.user_id.in_(trade_ids))
        if scope.login is not None:
            conds.append(ev.mt5_login == scope.login)
        if abnormal:
            conds.append(or_(
                ev.kind.in_(sorted(al.ABNORMAL_KINDS)),
                and_(ev.kind == al.TRADE_CLOSE_ALL, _close_all_failed_exists(db.get_bind().dialect.name)),
            ))
        out["e"] = _Source("e", db, ev, ev.created_at, ev.id, conds)

    # o：交易指令 / trade commands
    if cat in ("all", "trade"):
        conds = bounds(Order.created_at)
        if not abnormal:
            # 一键平仓子单由 trade.close_all 那一行代表；只看异常时失败 / 未知的子单也单独出现。
            # Close-all children are represented by the trade.close_all row; with the
            # abnormal filter on, failed / unknown children show up on their own too.
            conds.append(~Order.client_order_id.like(_like_escape(CLOSE_ALL_PREFIX) + "%", escape="\\"))
        if sub == "sltp":
            conds.append(Order.action == "MODIFY")
        elif sub == "open_close":
            conds.append(or_(Order.action.is_(None), Order.action != "MODIFY"))
        if trade_ids is not None:
            conds.append(Order.user_id.in_(trade_ids))
        if scope.login is not None:
            conds.append(Order.mt5_login == scope.login)
        if abnormal:
            conds.append(or_(
                Order.status.in_(_ABNORMAL_ORDER_STATUSES),
                Order.message.like("%" + _like_escape(_SLTP_FAILED_MARK) + "%", escape="\\"),
            ))
        out["o"] = _Source("o", db, Order, Order.created_at, Order.id, conds)

    # c：MT5 侧平仓成交（不含平台自己发起的平仓腿）。子分类、只看异常都按「有效 reason」
    # （老行 reason 为空时从备注推断，见 _effective_reason），与翻译、爆仓合并同口径。
    # MT5-side closing deals (platform legs excluded); sub-tabs and the abnormal
    # filter use the effective reason, like the translation and stop-out grouping.
    if cat in ("all", "trade"):
        ct = ClosedTrade
        conds = bounds(ct.created_at)
        conds.append(~_platform_leg_cond())
        if sub == "sltp":
            conds.append(_effective_reason_sql().in_(_SLTP_REASONS))
        elif sub == "open_close":
            conds.append(_effective_reason_sql().notin_(_SLTP_REASONS))
        if trade_ids is not None:
            conds.append(ct.user_id.in_(trade_ids))
        if scope.login is not None:
            conds.append(ct.mt5_login == scope.login)
        if abnormal:
            conds.append(_effective_reason_sql() == "SO")
        out["c"] = _Source("c", db, ct, ct.created_at, ct.id, conds)

    # a：审计 / admin audit
    if cat in ("all", "account", "admin") and scope.login is None:
        a = AdminAuditLog
        conds = bounds(a.created_at)
        if cat == "account":
            conds.append(_account_field_cond())
        elif cat == "admin":
            conds.append(~_account_field_cond())
        if scope.user_ids is not None:
            conds.append(or_(a.target_user_id.in_(scope.user_ids), a.admin_user_id.in_(scope.user_ids)))
        if abnormal:
            conds.append(or_(
                a.field == "account:disable",
                a.field.like("plan:refund%"),
                a.field.like("payment:%mismatch%"),
            ))
        out["a"] = _Source("a", db, a, a.created_at, a.id, conds)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 翻页与归并 / paging and merging
# ─────────────────────────────────────────────────────────────────────────────
def _floor_audit(rows: list[_Row]) -> datetime | None:
    """审计源：页里的组最远还可能接上多旧的行（同一次操作 / 旧行链 2 秒；自动降级 120 秒，
    以留下的那一条为准）。与 _group_audit 同一套窗口。
    How far back the audit groups on this page may still reach (same windows as
    _group_audit)."""
    floors: list[datetime] = []
    kept: dict[str, datetime] = {}
    for r in rows:
        a = r.obj
        f = a.field or ""
        if f == _AUTO_EXPIRE_FIELD:
            k = kept.get(a.target_user_id)
            if k is None or k - r.ts > _AUTO_EXPIRE_WINDOW:
                kept[a.target_user_id] = r.ts
        elif a.op_id or _audit_family(f) is not None:
            floors.append(r.ts - _AUDIT_CHAIN)
    floors.extend(ts - _AUTO_EXPIRE_WINDOW for ts in kept.values())
    return min(floors) if floors else None


def _floor_deals(rows: list[_Row]) -> datetime | None:
    """平仓源：每个账号当前那组爆仓（以组里最新一条为准）往前 60 秒。
    Deals: 60s before the head of each account's latest stop-out group."""
    heads: dict[str, datetime] = {}
    for r in rows:
        t = r.obj
        if _effective_reason(t) != "SO":
            continue
        h = heads.get(t.mt5_login)
        if h is None or h - r.ts > _SO_WINDOW:
            heads[t.mt5_login] = r.ts
    return min(h - _SO_WINDOW for h in heads.values()) if heads else None


_FLOORS = {"a": _floor_audit, "c": _floor_deals}


def _page(
    sources: "OrderedDict[str, _Source]", state: dict[str, Any], limit: int,
) -> tuple[dict[str, list[_Row]], dict[str, Any], bool]:
    """取一页：各源 LIMIT limit+1 → 归并取前 limit 行 → 审计 / 平仓源把页尾没结束的组补齐
    → 算新游标。返回 (各源本页的行, 新游标状态, 是否全部到底)。
    One page: limit+1 rows per source, merge the first `limit`, finish groups the
    page ends inside, compute the new cursor. Returns (rows per source, new state,
    everything exhausted)."""
    buffers: dict[str, list[_Row]] = {}
    may_have_more: dict[str, bool] = {}
    for name, src in sources.items():
        pos = state.get(name)
        if pos == "end":
            buffers[name] = []
            may_have_more[name] = False
            continue
        rows = src.fetch(pos, limit + 1)
        buffers[name] = rows
        may_have_more[name] = len(rows) == limit + 1

    # 归并：同一时间戳按源顺序；同一源内保持数据库给的 (ts DESC, id DESC) 次序（heapq.merge
    # 对相等的键保持各输入内部的先后）。
    # Merge: ties broken by source order; within a source the database's
    # (ts DESC, id DESC) order is kept (heapq.merge is stable per input).
    taken = {name: 0 for name in buffers}
    picked = 0
    for r in heapq.merge(*buffers.values(), key=lambda r: (-_us(r.ts), _SRC_RANK[r.src])):
        if picked >= limit:
            break
        taken[r.src] += 1
        picked += 1

    out: dict[str, list[_Row]] = {}
    new_state: dict[str, Any] = {}
    for name, rows in buffers.items():
        used = rows[: taken[name]]
        pool = rows[taken[name]:]
        more = may_have_more[name]
        floor_fn = _FLOORS.get(name)
        if floor_fn is not None and used:
            used, pool, more = _extend(sources[name], used, pool, more, floor_fn)
        out[name] = used
        if not pool and not more:
            new_state[name] = "end"
        elif used:
            new_state[name] = (used[-1].ts, used[-1].id)
        else:
            new_state[name] = state.get(name)
    done = all(v == "end" for v in new_state.values())
    return out, new_state, done


def _extend(src: _Source, used: list[_Row], pool: list[_Row], more: bool, floor_fn):
    """页尾的组没结束：沿这个源继续取，直到下一行比所有未结束组的窗口都旧（最多再取
    _GROUP_EXTRA_MAX 行）。先用已经取到内存里的剩余行，不够再分批查库。
    Keep reading this source while the next row is still inside some open group's
    window (≤ _GROUP_EXTRA_MAX extra rows), using rows already in memory first."""
    used = list(used)
    pool = list(pool)
    extra = 0
    while extra < _GROUP_EXTRA_MAX:
        floor = floor_fn(used)
        if floor is None:
            break
        if not pool:
            if not more:
                break
            n = min(100, _GROUP_EXTRA_MAX - extra) + 1
            last = used[-1]
            pool = src.fetch((last.ts, last.id), n)
            more = len(pool) == n
            if not pool:
                break
        nxt = pool[0]
        if nxt.ts < floor:
            break
        used.append(pool.pop(0))
        extra += 1
    return used, pool, more


# ─────────────────────────────────────────────────────────────────────────────
# 中间形态：一行或一组 → _Proto，补充信息之后再定稿成输出的 Item。
# Intermediate form: a row or a group -> _Proto, finalised into an Item after
# enrichment.
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class _Proto:
    key: str
    src: str
    ts: datetime
    kind: str
    seq: int = 0
    params: dict = field(default_factory=dict)
    status: str = "ok"
    tags: list = field(default_factory=list)
    abnormal: bool = False
    # self / system / auto / broker / admin / agent；"role" = 按操作人当前角色在定稿时判
    actor_type: str = "self"
    actor_id: str | None = None
    user_id: str | None = None
    login: str | None = None
    at: datetime | None = None
    users_count: int | None = None
    children: list | None = None
    obj: Any = None
    # (user_id, login, ticket)：这一行涉及的仓位 / the position this row concerns
    pos: tuple | None = None
    leg: Any = None
    drop: bool = False
    # 平仓腿：同一成交在页内的其它持有人（共享账号）/ other holders of a shared deal on the page
    dup_users: list = field(default_factory=list)
    # 审计组：按 (目标, 字段族) 分好的子组 / audit groups split by (target, family)
    audit_rows: list | None = None
    family: str | None = None


def _walk(protos: Iterable[_Proto]):
    for p in protos:
        yield p
        if p.children:
            yield from p.children


# ── orders ──────────────────────────────────────────────────────────────────
def _order_status(o: Order) -> str:
    """orders.status → 页面状态。FAILED 在本仓库是「不知道成没成」，所以是 unknown；桥接
    超时作废（STALE_ORDER_MESSAGE，「已自动取消」）算 cancelled。
    orders.status -> page status. FAILED means "outcome unknown" here, except the
    bridge's stale void, which told the user the command was cancelled."""
    st = (o.status or "").upper()
    if st in ("FILLED", "PLACED"):
        return "ok"
    if st == "REJECTED":
        return "fail"
    if st == "CANCELLED":
        return "cancelled"
    if st == "PENDING":
        return "pending"
    if st == "FAILED" and (o.message or "") == STALE_ORDER_MESSAGE:
        return "cancelled"
    return "unknown"


def _order_note(o: Order) -> str | None:
    """券商原话之外的一个结构化说明，前端据此出固定文案（原话只在详情里给）。
    A structured note next to the raw broker message."""
    msg = o.message or ""
    if (o.status or "").upper() == "CANCELLED":
        return "user_cancelled"
    if msg == STALE_ORDER_MESSAGE:
        return "timeout"
    if msg == GATEWAY_STALE_ORDER_MESSAGE:
        return "timeout_unknown"
    if _SLTP_FAILED_MARK in msg:
        return "sltp_failed"
    if _GONE_MARK in msg.lower():
        return "gone"
    return None


def _order_kind(o: Order) -> str:
    action = (o.action or "ORDER").upper()
    auto = (o.client_order_id or "").startswith(AUTO_PREFIX)
    if action == "ORDER":
        return TRADE_OPEN
    if action == "PENDING":
        return PENDING_PLACE
    if action == "MODIFY_PENDING":
        return PENDING_MODIFY
    if action == "CANCEL_PENDING":
        return PENDING_CANCEL
    if action == "CLOSE":
        return AUTO_PARTIAL_TP if auto else TRADE_CLOSE
    if action == "MODIFY":
        return AUTO_SL if auto else SLTP_MODIFY
    return TRADE_OTHER


def _order_position(o: Order) -> tuple | None:
    action = (o.action or "ORDER").upper()
    t = position_id_of(o) if action in ("ORDER", "PENDING") else o.ticket
    if not t or not o.mt5_login:
        return None
    return (o.user_id, str(o.mt5_login), int(t))


def _order_proto(o: Order) -> _Proto:
    kind = _order_kind(o)
    auto = (o.client_order_id or "").startswith(AUTO_PREFIX)
    p = _Proto(
        key=f"o:{o.id}", src="o", ts=_naive_utc(o.created_at), kind=kind,
        user_id=o.user_id, login=_blank(o.mt5_login), obj=o, pos=_order_position(o),
    )
    p.status = _order_status(o)
    p.actor_type = "auto" if auto else "self"
    if auto:
        p.tags.append("auto")
    unprotected = _SLTP_FAILED_MARK in (o.message or "")
    if unprotected and kind == TRADE_OPEN:
        p.tags.append("unprotected")
    if _GONE_MARK in (o.message or "").lower() and kind in (TRADE_CLOSE, AUTO_PARTIAL_TP):
        p.tags.append("gone")
    p.abnormal = (o.status or "").upper() in _ABNORMAL_ORDER_STATUSES or unprotected
    return p


# ── closed_trades ───────────────────────────────────────────────────────────
def _deal_proto(t: ClosedTrade) -> _Proto:
    reason = _effective_reason(t)
    created = _naive_utc(t.created_at)
    closed = _naive_utc(t.closed_at)
    p = _Proto(
        key=f"d:{t.id}", src="c", ts=created, kind=DEAL_CLOSE,
        user_id=t.user_id, login=t.mt5_login, obj=t, at=closed,
        pos=(t.user_id, str(t.mt5_login), int(t.position_ticket)) if t.position_ticket is not None else None,
    )
    p.actor_type = "self" if reason in _SELF_CLOSE_REASONS else "broker"
    if reason == "SO":
        p.tags.append("stopout")
        p.abnormal = True
    if created is not None and closed is not None and created - closed > _LATE_AFTER:
        p.tags.append("late")
    return p


# ── activity_events ─────────────────────────────────────────────────────────
# 每种事件 params 的键（契约固定，缺的补 None）/ the fixed params keys per event kind
_EVENT_PARAM_KEYS: dict[str, tuple[str, ...]] = {
    al.MT5_BIND: ("ch", "revived", "name", "demo", "bal", "server"),
    al.MT5_REVERIFY: ("ch",),
    al.MT5_UNBIND: ("ch", "name", "bal"),
    al.MT5_REVOKED: ("reason",),
    al.USER_API_TOKEN_RESET: (),
    al.TRADE_CORRECTED: ("was", "action", "sym", "side", "vol", "px", "at", "note"),
    al.USER_LOGIN: ("method", "new_source"),
    al.USER_EMAIL_VERIFIED: ("method",),
    al.USER_PASSWORD_RESET_REQUESTED: (),
    al.USER_PASSWORD_RESET: (),
    al.USER_PASSWORD_CHANGED: ("first_set",),
    al.USER_NICKNAME: ("old", "new"),
    al.USER_PHONE_SET: (),
    al.AUTO_SETTINGS: ("changes",),
}


def _event_proto(e: ActivityEvent) -> _Proto:
    data = al.decode_data(e.data)
    p = _Proto(
        key=f"e:{e.id}", src="e", ts=_naive_utc(e.created_at), kind=e.kind,
        user_id=e.user_id, login=_blank(e.mt5_login), obj=e,
    )
    if e.actor_type == al.ACTOR_SYSTEM:
        p.actor_type = "system"
    elif e.actor_type == al.ACTOR_ADMIN:
        p.actor_type, p.actor_id = "admin", e.actor_id
    else:
        p.actor_type = "self"
    if data.get(al.BACKFILL_FLAG):
        p.tags.append("backfill")
    if e.kind == al.MT5_REVOKED:
        p.tags.append("revoked")
    p.abnormal = e.kind in al.ABNORMAL_KINDS
    keys = _EVENT_PARAM_KEYS.get(e.kind)
    if keys is not None:
        p.params = {k: _blank(data.get(k)) for k in keys}
    elif e.kind != al.TRADE_CLOSE_ALL:
        # 将来新加的 kind：data 原样（去掉补录标记）/ a future kind: data as stored
        p.params = {k: _blank(v) for k, v in data.items() if k != al.BACKFILL_FLAG}
    return p


# ── users ───────────────────────────────────────────────────────────────────
def _register_proto(u) -> _Proto:
    return _Proto(
        key=f"u:{u.id}", src="u", ts=_naive_utc(u.created_at), kind=USER_REGISTER,
        user_id=u.id, obj=u,
    )


# ── admin_audit_logs ────────────────────────────────────────────────────────
def _audit_family(f: str) -> str | None:
    """字段 → 字段族（同族的行才会合成一行）；系统 / 本人的会员行返回 None（各自一行）。
    认不出来的字段落进 "other:<field>"，最终是 admin.other——绝不丢。
    field -> family (rows group only within a family); account-category system rows
    return None (one line each). Unknown fields become "other:<field>" (admin.other)."""
    if f in _USER_FIELDS:
        return "user"
    if _is_account_field(f):
        return None
    parts = f.split(":")
    head = parts[0]
    if head == "account" and len(parts) == 2 and parts[1] in ("disable", "enable", "verify_email"):
        return f
    if head == "setting" and len(parts) >= 2:
        return "setting"
    if head == "gamification" and len(parts) >= 2:
        return "gamification"
    if head == "ops" and len(parts) >= 2:
        return "ops"
    if head == "announcement" and len(parts) == 2 and parts[1] in ("create", "update", "delete"):
        return "announcement"
    if head == "email" and len(parts) == 2 and parts[1] in ("send", "cancel", "resume"):
        return "email"
    if head == "invite" and len(parts) == 2:
        return f"invite:{parts[1]}"
    if head == "invite" and len(parts) == 3 and parts[2] == "agent":
        return f"invite:{parts[1]}:agent"
    if head == "agent" and len(parts) == 3 and parts[2] in ("plan", "plan_expires_at", "extend_days"):
        return f"agent:{parts[1]}"
    if head == "competition" and len(parts) == 4 and parts[1] == "participant" and parts[3] in ("disqualified", "nameHidden"):
        return f"competition:participant:{parts[2]}"
    if head == "competition" and len(parts) == 3 and parts[1] == "settle":
        return f"competition:{parts[2]}"
    if head == "competition" and len(parts) == 3 and parts[1] not in ("participant", "settle"):
        return f"competition:{parts[1]}"
    if head == "ticket" and len(parts) == 3:
        return f"ticket:{parts[1]}"
    return f"other:{f}"


# 没有目标用户的平台级操作（target_user_id 是操作者自己占位）→ user 留空
# Platform-wide families whose target_user_id is just the actor standing in
def _placeholder_family(family: str) -> bool:
    return (
        family in ("setting", "gamification", "ops", "announcement", "email")
        or (family.startswith("invite:") and not family.endswith(":agent"))
        or (family.startswith("competition:") and not family.startswith("competition:participant:"))
    )


def _system_kind(f: str) -> str:
    if f == "plan:trial_claim":
        return PLAN_TRIAL_CLAIM
    if f == "plan:invite_trial":
        return PLAN_INVITE_TRIAL
    if f == "plan:payment":
        return PLAN_PAYMENT
    if f == "plan:refund":
        return PLAN_REFUND
    if f == _AUTO_EXPIRE_FIELD:
        return PLAN_AUTO_EXPIRE
    return PLAN_PAYMENT_ISSUE


def _family_kind(family: str, fields: set[str]) -> str:
    if family == "user":
        if fields <= _PLAN_FIELDS:
            return ADMIN_USER_PLAN
        if fields == {"role"}:
            return ADMIN_USER_ROLE
        if fields == {"invite_code"}:
            return ADMIN_USER_ATTRIBUTION
        return ADMIN_USER_EDIT
    if family == "account:disable":
        return ADMIN_USER_DISABLE
    if family == "account:enable":
        return ADMIN_USER_ENABLE
    if family == "account:verify_email":
        return ADMIN_VERIFY_EMAIL
    if family == "setting":
        return ADMIN_SETTING
    if family == "gamification":
        return ADMIN_GAMIFICATION
    if family == "ops":
        return ADMIN_OPS
    if family == "announcement":
        return ADMIN_ANNOUNCEMENT
    if family == "email":
        return ADMIN_EMAIL
    if family.startswith("invite:"):
        return ADMIN_AGENT_ASSIGN if family.endswith(":agent") else ADMIN_INVITE_LINK
    if family.startswith("agent:"):
        return AGENT_PLAN
    if family.startswith("competition:participant:"):
        return ADMIN_COMPETITION_PARTICIPANT
    if family.startswith("competition:"):
        return ADMIN_COMPETITION
    if family.startswith("ticket:"):
        return ADMIN_TICKET
    return ADMIN_OTHER


def _tz_noise(a: AdminAuditLog) -> bool:
    """plan_expires_at 的新旧值只差时区写法（'+00:00'、'T'）→ 不是一次真修改，丢掉。
    plan_expires_at rows whose old / new differ only in timezone formatting."""
    f = a.field or ""
    if f != "plan_expires_at" and not (f.startswith("agent:") and f.endswith(":plan_expires_at")):
        return False
    if not a.old_value or not a.new_value:
        return False
    old, new = _parse_dt(a.old_value), _parse_dt(a.new_value)
    return old is not None and new is not None and old == new


def _group_audit(rows: list[_Row]) -> list[list[_Row]]:
    """审计行 → 组（每组新的在前），按页面顺序。
      · 同一个 op_id 一组；
      · 没有 op_id 的旧行：同操作人 + 同字段族 + 相邻两行相隔 ≤ 2 秒；
      · 系统 / 本人的会员行各自一组；自动降级同一用户 120 秒内只留最新那条；
      · 只差时区写法的 plan_expires_at 行丢掉。
    Audit rows -> groups (newest first) in page order: one per op_id; legacy rows by
    actor + family chained within 2s; account-category rows alone, with duplicate
    auto-expiries within 120s dropped; timezone-noise expiry rows dropped."""
    groups: list[list[_Row]] = []
    by_op: dict[str, list[_Row]] = {}
    legacy: dict[tuple, tuple[list[_Row], datetime]] = {}
    expire_kept: dict[str, datetime] = {}
    for r in rows:
        a = r.obj
        f = a.field or ""
        if _tz_noise(a):
            continue
        if f == _AUTO_EXPIRE_FIELD:
            k = expire_kept.get(a.target_user_id)
            if k is not None and k - r.ts <= _AUTO_EXPIRE_WINDOW:
                continue
            expire_kept[a.target_user_id] = r.ts
            groups.append([r])
            continue
        if a.op_id:
            g = by_op.get(a.op_id)
            if g is None:
                g = []
                by_op[a.op_id] = g
                groups.append(g)
            g.append(r)
            continue
        family = _audit_family(f)
        if family is None:
            groups.append([r])
            continue
        key = (a.admin_user_id, family)
        open_ = legacy.get(key)
        if open_ is not None and open_[1] - r.ts <= _AUDIT_CHAIN:
            open_[0].append(r)
            legacy[key] = (open_[0], r.ts)
        else:
            g = [r]
            groups.append(g)
            legacy[key] = (g, r.ts)
    return groups


def _audit_single(rows: list[_Row], key: str) -> _Proto:
    """同一目标、同一字段族的一组审计行 → 一个 proto（params 留到定稿时填）。
    One (target, family) slice of audit rows -> one proto."""
    head = rows[0].obj
    f = head.field or ""
    family = _audit_family(f)
    if family is None:
        kind = _system_kind(f)
    else:
        kind = _family_kind(family, {r.obj.field for r in rows})
    p = _Proto(key=key, src="a", ts=rows[0].ts, kind=kind, audit_rows=[r.obj for r in rows], family=family)
    if family is None:
        p.actor_type = "self" if f == "plan:trial_claim" else "system"
        p.user_id = head.target_user_id
    else:
        if family.startswith("agent:"):
            p.actor_type = "agent"
        elif family.startswith("invite:") and not family.endswith(":agent"):
            p.actor_type = "role"
        else:
            p.actor_type = "admin"
        p.actor_id = head.admin_user_id
        if _placeholder_family(family):
            p.user_id = None
        elif family.startswith("other:") and head.target_user_id == head.admin_user_id:
            p.user_id = None
        else:
            p.user_id = head.target_user_id
    p.abnormal = any(_is_abnormal_audit_field(r.obj.field or "") for r in rows)
    return p


def _audit_proto(group: list[_Row]) -> _Proto:
    """一组审计行 → proto。组里不止一个 (目标, 字段族) → admin.bulk_edit，children 每个
    目标一行。
    An audit group -> proto; more than one (target, family) slice -> admin.bulk_edit
    with one child per slice."""
    head = group[0]
    key = f"a:{head.id}" if len(group) == 1 else f"g:{head.id}"
    slices: OrderedDict[tuple, list[_Row]] = OrderedDict()
    for r in group:
        a = r.obj
        family = _audit_family(a.field or "") or f"sys:{a.id}"
        slices.setdefault((a.target_user_id, family), []).append(r)
    if len(slices) == 1:
        return _audit_single(group, key)
    children = [_audit_single(rows, f"a:{rows[0].id}") for rows in slices.values()]
    targets = {t for (t, fam) in slices if not _placeholder_family(fam)}
    p = _Proto(
        key=key, src="a", ts=head.ts, kind=ADMIN_BULK_EDIT,
        actor_type="admin", actor_id=head.obj.admin_user_id,
        users_count=len(targets) or None, children=children,
        audit_rows=[r.obj for r in group],
    )
    p.abnormal = any(c.abnormal for c in children)
    return p


# ─────────────────────────────────────────────────────────────────────────────
# 页内合并规则（设计 §5.6 的 2 / 4 / 5；1 / 3 在 _group_audit，6 在定稿时）
# In-page grouping rules (§5.6 2 / 4 / 5; 1 and 3 live in _group_audit, 6 at finalise)
# ─────────────────────────────────────────────────────────────────────────────
def _collapse_shared_deals(protos: list[_Proto]) -> None:
    """规则 5：不按用户筛时，同一 (账号, 成交号) 只留一行（同一账号绑给了几个人，每人名下
    都有一份）。被收掉的那几行的用户记进 dup_users，定稿时列进 holders。
    Rule 5: without a user filter, one line per (login, deal) — a login bound to
    several users has a copy under each."""
    seen: dict[tuple, _Proto] = {}
    for p in protos:
        if p.kind != DEAL_CLOSE or p.drop:
            continue
        k = (p.login, p.obj.deal_ticket)
        first = seen.get(k)
        if first is None:
            seen[k] = p
        else:
            first.dup_users.append(p.user_id)
            p.drop = True


def _group_stopouts(protos: list[_Proto]) -> list[_Proto]:
    """规则 2：同一账号 60 秒内（以组里最新一条为准）的多条爆仓腿 → deal.stopout_group。
    Rule 2: stop-out legs of one account within 60s of the group's newest leg."""
    members: dict[str, list[_Proto]] = {}
    heads: dict[str, _Proto] = {}
    for p in protos:
        if p.drop or p.kind != DEAL_CLOSE or _effective_reason(p.obj) != "SO":
            continue
        head = heads.get(p.login)
        if head is not None and head.ts - p.ts <= _SO_WINDOW:
            members[head.key].append(p)
        else:
            heads[p.login] = p
            members[p.key] = [p]
    out: list[_Proto] = []
    for p in protos:
        group = members.get(p.key)
        if group is None or len(group) < 2 or group[0] is not p:
            out.append(p)
            continue
        g = _Proto(
            key=f"s:{p.obj.id}", src="c", ts=p.ts, kind=DEAL_STOPOUT_GROUP, seq=p.seq,
            actor_type="broker", user_id=p.user_id, login=p.login, at=p.at,
            children=group, tags=["stopout"], abnormal=True,
        )
        if any("late" in m.tags for m in group):
            g.tags.append("late")
        # 组员（除了组头）在后面遍历到时已经是 drop，最后统一滤掉
        # Members after the head are dropped here and filtered out at the end
        for m in group[1:]:
            m.drop = True
        out.append(g)
    return out


def _merge_auto_trails(protos: list[_Proto]) -> list[_Proto]:
    """规则 4（页内）：同一仓位、同一北京日、中间没有这个仓位的别的事的连续追踪止损 →
    一行，moves = 次数，children = 每一次。key = `t:<最新那次的 id>:<最早那次的 id>`：详情
    按这两头把这一段原样取回来，不在整段历史上重新合并——列表看到的是筛选后的、一页之内的
    行，重新合并会得出另一组（「改止损」子分类藏掉了中间的分批止盈，或这一串被翻页切开）。
    Rule 4 (in-page): consecutive trailing-stop moves of one position on one Beijing
    day, with nothing else about that position in between, fold into one line. The
    key names both ends (`t:<newest id>:<oldest id>`) so the detail view takes back
    exactly this run instead of re-merging the full history, which can come out
    different (a filter hid an order in between, or a page boundary cut the run)."""
    last_for_pos: dict[tuple, _Proto] = {}
    out: list[_Proto] = []
    for p in protos:
        if p.drop:
            out.append(p)
            continue
        pos = p.pos
        is_trail = p.src == "o" and p.kind == AUTO_SL and auto_command_kind(p.obj.client_order_id) == AUTO_KIND_TRAIL
        if pos is not None and is_trail:
            prev = last_for_pos.get(pos)
            if prev is not None and prev.params.get("_trail") and local_day(prev.ts) == local_day(p.ts):
                if prev.children is None:
                    # 第一次合并：原来那一行变成组头，它自己的副本成为第一个子项
                    # First merge: the line becomes the group head, a copy of it the first child
                    prev.children = [replace(prev, children=None, params={}, tags=list(prev.tags))]
                prev.children.append(p)
                # 行是新的在前，刚并进来的这次就是目前最早的 / newest first, so p is the oldest so far
                prev.key = f"t:{prev.obj.id}:{p.obj.id}"
                continue
            p.params["_trail"] = True
        if pos is not None:
            last_for_pos[pos] = p
        out.append(p)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 批量补充 / batched enrichment
# ─────────────────────────────────────────────────────────────────────────────
class _Ctx:
    """本页的查表结果。每个 load_* 只在本页真的需要时才发一条 IN 查询。
    Lookups for one page; each load_* sends one IN query, only when needed."""

    def __init__(self, db: Session, window: tuple[datetime | None, datetime | None] = (None, None),
                 fold_trials: bool = False):
        self.db = db
        self.window = window
        # 本次请求里注册行可见时，Google 注册那一刻的邀请试用并进注册行、不再单独出现
        # When sign-ups are visible in this request, the invite trial granted at a
        # Google sign-up is folded into it rather than shown on its own
        self.fold_trials = fold_trials
        self.users: dict[str, Any] = {}
        self.accounts: dict[str, list[MT5Account]] = defaultdict(list)
        self._logins_loaded: set[str] = set()
        self.legs: dict[tuple, list[ClosedTrade]] = {}
        self.ca_children: dict[tuple, list[Order]] = defaultdict(list)
        self.pending_orig: dict[tuple, Order] = {}
        self.invite_labels: dict[str, str] = {}
        self.comp_names: dict[str, str] = {}
        self.participants: dict[str, Any] = {}
        self.announcements: dict[str, str] = {}
        self.campaigns: dict[str, Any] = {}
        self.tickets: dict[str, Any] = {}
        self.register_trials: dict[str, list[AdminAuditLog]] = defaultdict(list)

    # 一键平仓子单 / close-all children
    def load_close_all_children(self, protos: list[_Proto]) -> None:
        pairs = {
            (p.user_id, p.obj.ref_id)
            for p in protos
            if p.src == "e" and p.kind == al.TRADE_CLOSE_ALL and p.user_id and p.obj.ref_id
        }
        if not pairs:
            return
        conds = [
            and_(Order.user_id == uid, Order.client_order_id.like(_like_escape(batch) + "#%", escape="\\"))
            for uid, batch in sorted(pairs)
        ]
        for o in self.db.query(Order).filter(or_(*conds)).order_by(Order.created_at.asc(), Order.id.asc()):
            self.ca_children[(o.user_id, batch_of(o.client_order_id))].append(o)
        for p in protos:
            if p.src != "e" or p.kind != al.TRADE_CLOSE_ALL:
                continue
            kids = self.ca_children.get((p.user_id, p.obj.ref_id), [])
            if p.login:
                kids = [o for o in kids if str(o.mt5_login or "") == p.login]
            p.children = [_order_proto(o) for o in kids]

    # 撤挂单对应的原挂单 / the original pending order of a cancel
    def load_pending_originals(self, protos: list[_Proto]) -> None:
        pairs = {
            (p.user_id, int(p.obj.ticket))
            for p in _walk(protos)
            if p.src == "o" and p.kind == PENDING_CANCEL and p.obj.ticket
        }
        if not pairs:
            return
        uids = sorted({u for u, _ in pairs})
        tickets = sorted({t for _, t in pairs})
        rows = (
            self.db.query(Order)
            .filter(Order.user_id.in_(uids), Order.action == "PENDING", Order.mt5_ticket.in_(tickets))
            .order_by(Order.created_at.asc())
            .all()
        )
        for o in rows:
            self.pending_orig[(o.user_id, int(o.mt5_ticket))] = o

    # 审计行里引用到的名称 / names referenced by audit rows
    def load_names(self, protos: list[_Proto]) -> None:
        comp_ids: set[str] = set()
        pids: set[str] = set()
        ann_ids: set[str] = set()
        camp_ids: set[str] = set()
        ticket_ids: set[str] = set()
        for p in _walk(protos):
            for a in p.audit_rows or ():
                parts = (a.field or "").split(":")
                fam = p.family or ""
                if fam.startswith("competition:participant:"):
                    pids.add(parts[2])
                elif fam.startswith("competition:"):
                    comp_ids.add(fam.split(":", 1)[1])
                elif fam == "announcement":
                    aid = _as_dict(a.new_value).get("id")
                    if aid:
                        ann_ids.add(str(aid))
                elif fam == "email":
                    cid = _as_dict(a.new_value).get("id")
                    if cid:
                        camp_ids.add(str(cid))
                elif fam.startswith("ticket:"):
                    ticket_ids.add(parts[1])
        if pids:
            for row in self.db.query(
                CompetitionParticipant.id, CompetitionParticipant.competition_id,
                CompetitionParticipant.mt5_login, CompetitionParticipant.user_id,
            ).filter(CompetitionParticipant.id.in_(sorted(pids))):
                self.participants[row.id] = row
                comp_ids.add(row.competition_id)
        if comp_ids:
            self.comp_names = dict(
                self.db.query(Competition.id, Competition.name).filter(Competition.id.in_(sorted(comp_ids))).all()
            )
        if ann_ids:
            for row in self.db.query(Announcement.id, Announcement.title_zh, Announcement.title_en).filter(
                Announcement.id.in_(sorted(ann_ids))
            ):
                self.announcements[row.id] = row.title_zh or row.title_en or None
        if camp_ids:
            for row in self.db.query(
                EmailCampaign.id, EmailCampaign.subject_zh, EmailCampaign.subject_en, EmailCampaign.kind
            ).filter(EmailCampaign.id.in_(sorted(camp_ids))):
                self.campaigns[row.id] = row
        if ticket_ids:
            for row in self.db.query(Ticket.id, Ticket.title, Ticket.user_id).filter(Ticket.id.in_(sorted(ticket_ids))):
                self.tickets[row.id] = row

    # MT5 账户：不过滤已解绑（要显示「已解绑」）/ accounts, removed ones included
    def load_accounts(self, protos: list[_Proto]) -> None:
        logins = {p.login for p in _walk(protos) if p.login}
        for p in _walk(protos):
            if p.family and p.family.startswith("competition:participant:"):
                part = self.participants.get(p.family.rsplit(":", 1)[1])
                if part is not None and part.mt5_login:
                    p.login = str(part.mt5_login)
                    logins.add(p.login)
        logins -= self._logins_loaded
        if not logins:
            return
        self._logins_loaded |= logins
        for acc in self.db.query(MT5Account).filter(MT5Account.login.in_(sorted(logins))).all():
            self.accounts[str(acc.login)].append(acc)

    # 平仓腿：这页涉及的仓位的全部腿（走 idx_closed_trades_position）/ every leg of the page's positions
    def load_legs(self, protos: list[_Proto], extra_positions: Iterable[tuple] = ()) -> None:
        wanted = {
            p.pos for p in _walk(protos)
            if p.pos is not None and (p.kind in (DEAL_CLOSE, TRADE_CLOSE, AUTO_PARTIAL_TP))
        }
        wanted.update(extra_positions)
        wanted = {w for w in wanted if w not in self.legs}
        if not wanted:
            return
        for w in wanted:
            self.legs[w] = []
        rows = (
            self.db.query(ClosedTrade)
            .filter(tuple_(ClosedTrade.user_id, ClosedTrade.mt5_login, ClosedTrade.position_ticket).in_(sorted(wanted)))
            .all()
        )
        for t in rows:
            self.legs.setdefault((t.user_id, str(t.mt5_login), int(t.position_ticket)), []).append(t)
        for legs in self.legs.values():
            legs.sort(key=lambda t: (_naive_utc(t.closed_at) or _EPOCH, t.deal_ticket or 0, t.id))

    # 注册那一刻送的邀请试用 / the invite trial granted at sign-up
    def load_register_trials(self, protos: list[_Proto]) -> None:
        uids = sorted({p.user_id for p in protos if p.kind == USER_REGISTER and p.user_id})
        if not uids:
            return
        for a in self.db.query(AdminAuditLog).filter(
            AdminAuditLog.target_user_id.in_(uids), AdminAuditLog.field == "plan:invite_trial"
        ):
            self.register_trials[a.target_user_id].append(a)

    def load_users(self, protos: list[_Proto]) -> None:
        ids: set[str] = set()
        for p in _walk(protos):
            for uid in (p.user_id, p.actor_id, *p.dup_users):
                if uid:
                    ids.add(uid)
            for a in p.audit_rows or ():
                ids.update(x for x in (a.admin_user_id, a.target_user_id) if x)
            if p.family and p.family.startswith("ticket:"):
                t = self.tickets.get(p.family.split(":", 1)[1])
                if t is not None and t.user_id:
                    ids.add(t.user_id)
            if p.family and p.family.startswith("competition:participant:"):
                part = self.participants.get(p.family.rsplit(":", 1)[1])
                if part is not None and part.user_id:
                    ids.add(part.user_id)
        for accs in self.accounts.values():
            ids.update(a.user_id for a in accs if a.user_id)
        ids -= set(self.users)
        if not ids:
            return
        for row in self.db.query(
            User.id, User.email, User.nickname, User.role, User.invite_code, User.created_at, User.google_linked_at,
        ).filter(User.id.in_(sorted(ids))):
            self.users[row.id] = row

    def load_invite_labels(self, protos: list[_Proto]) -> None:
        codes: set[str] = set()
        for p in _walk(protos):
            if p.kind == USER_REGISTER and p.obj is not None and p.obj.invite_code:
                codes.add(p.obj.invite_code)
            for a in p.audit_rows or ():
                f = a.field or ""
                if f == "invite_code":
                    codes.update(v for v in (a.old_value, a.new_value) if v)
                elif f.startswith("invite:") or f.startswith("agent:"):
                    codes.add(f.split(":")[1])
                elif f == "plan:invite_trial":
                    u = self.users.get(a.target_user_id)
                    if u is not None and u.invite_code:
                        codes.add(u.invite_code)
        codes.discard("")
        codes -= set(self.invite_labels)
        if not codes:
            return
        # 含已软删的链接：老用户的归因照样要显示名字 / soft-deleted links included
        self.invite_labels.update(
            self.db.query(InviteLink.code, InviteLink.label).filter(InviteLink.code.in_(sorted(codes))).all()
        )

    # ── 查表结果的读法 / readers ──
    def user_ref(self, uid: str | None) -> dict | None:
        if not uid:
            return None
        u = self.users.get(uid)
        return {"id": uid, "nickname": u.nickname if u else None, "email": u.email if u else None}

    def account_row(self, uid: str | None, login: str | None) -> MT5Account | None:
        """同一账号可能有多行（不同用户 / 服务器）：先挑这个用户自己的、没解绑的。
        A login may have several rows; prefer this user's, not removed."""
        rows = self.accounts.get(login or "", [])
        if not rows:
            return None

        def rank(a: MT5Account) -> tuple:
            return (a.user_id != uid, is_removed(a))

        return sorted(rows, key=rank)[0]

    def holders(self, login: str | None) -> list[str]:
        """这个账号当前（未解绑）的全部持有人 / current (not removed) holders of a login."""
        return sorted({a.user_id for a in self.accounts.get(login or "", []) if not is_removed(a)})


def _enrich(db: Session, protos: list[_Proto], ctx: _Ctx) -> None:
    """按依赖顺序批量查表（每类最多一条 IN）。
    Batched lookups in dependency order (at most one IN query per kind)."""
    ctx.load_close_all_children(protos)
    ctx.load_pending_originals(protos)
    ctx.load_names(protos)
    ctx.load_accounts(protos)
    ctx.load_legs(protos)
    ctx.load_register_trials(protos)
    ctx.load_users(protos)
    ctx.load_invite_labels(protos)
    _match_platform_legs(list(_walk(protos)), ctx)


def _expected_leg_volume(o: Order) -> float | None:
    """这条平仓指令应该配到多少手的腿：部分平 = 请求手数；全平（volume 为 0 或 ≥ 平之前的仓位
    手数）= 仓位手数；都不知道为 None（rev 38 之前的全平旧行）。
    The lots this close's leg should carry: the requested lots for a partial close,
    the position's lots for a full one (volume 0 or ≥ pos_volume); None when
    neither is known (pre-rev-38 full closes)."""
    vol = _num(o.volume) or 0.0
    pos = _num(o.pos_volume)
    if pos is not None and pos > _VOL_EPS and (vol <= _VOL_EPS or vol >= pos - _VOL_EPS):
        return pos
    return vol if vol > _VOL_EPS else None


def _leg_created(t: ClosedTrade) -> datetime:
    return _naive_utc(t.created_at) or _EPOCH


def _match_platform_legs(protos: list[_Proto], ctx: _Ctx) -> None:
    """把平台自己发起的平仓腿配给 CLOSE 指令（盈亏补到指令行上）。同一仓位里按指令时间先后：
      1. 仓位已经不在的指令（桥接回「Position already closed」）什么都没平，不配；
      2. 先在「入库时间 ≥ 指令时间」、还没被用过的腿里挑：手数等于这条指令该平的手数（部分平 =
         请求手数，全平 = 平之前的仓位手数）的那条；没有就取最早一条，但跳过手数正好等于本页
         另一条还没配上的指令该平手数的腿；
      3. 一条都没有，才退到「指令时间前 5 秒内」（只为时钟误差）：知道该平几手时手数必须相等，
         不知道时同样跳过别的指令该得的腿，取离指令最近的一条。
    配不到就是「盈亏同步中」。列表只看得到本页的指令，所以第 2 步只往指令之后找、第 3 步收得
    很窄——不然一条较新的平仓会把上一页（更旧）那条平仓的腿抢过来，同一笔盈亏显示两次。
    Pair platform closing legs with CLOSE commands, per position in command order:
      1. a command on an already-gone position closed nothing and gets no leg;
      2. among unused legs recorded at or after the command, the one whose lots equal
         what this command should close (requested lots for a partial close, the
         position's lots for a full one); else the earliest, skipping legs whose
         lots exactly fit another still-unmatched command on the page;
      3. only when none exists, legs up to 5s before the command (clock skew only):
         lots must match when known; when unknown, other commands' legs are skipped
         as well and the closest one wins.
    No leg -> P&L still syncing. The list only sees this page's commands, hence the
    forward-only search and the narrow fallback: otherwise a newer close would take
    an older close's leg from the next page and one P&L would show twice."""
    by_pos: dict[tuple, list[_Proto]] = defaultdict(list)
    for p in protos:
        if p.kind in (TRADE_CLOSE, AUTO_PARTIAL_TP) and p.pos is not None \
                and (p.obj.status or "").upper() == "FILLED" \
                and _GONE_MARK not in (p.obj.message or "").lower():
            by_pos[p.pos].append(p)
    for pos, cmds in by_pos.items():
        legs = [t for t in ctx.legs.get(pos, []) if _is_platform_leg(t)]
        legs.sort(key=lambda t: (_leg_created(t), t.deal_ticket or 0))
        cmds = sorted(cmds, key=lambda p: (p.ts, p.obj.id))
        wants = [_expected_leg_volume(p.obj) for p in cmds]
        used: set[str] = set()

        def fits(t: ClosedTrade, want: float | None) -> bool:
            return want is not None and _same(float(t.close_volume or 0.0), want)

        def owed_elsewhere(t: ClosedTrade, me: int) -> bool:
            # 手数正好是本页另一条还没配上的指令该平的 / exactly what another unmatched command should close
            return any(j != me and cmds[j].leg is None and fits(t, wants[j]) for j in range(len(cmds)))

        for i, p in enumerate(cmds):
            want = wants[i]
            free = [t for t in legs if t.id not in used]
            after = [t for t in free if _leg_created(t) >= p.ts]
            pick = next((t for t in after if fits(t, want)), None)
            if pick is None:
                pick = next((t for t in after if not owed_elsewhere(t, i)), None)
            if pick is None:
                early = [t for t in free if p.ts - _LEG_SLACK <= _leg_created(t) < p.ts]
                if want is not None:
                    early = [t for t in early if fits(t, want)]
                else:
                    early = [t for t in early if not owed_elsewhere(t, i)]
                pick = early[-1] if early else None
            if pick is not None:
                used.add(pick.id)
                p.leg = pick


# ─────────────────────────────────────────────────────────────────────────────
# 定稿：proto → 输出的 Item / finalise: proto -> output Item
# ─────────────────────────────────────────────────────────────────────────────
def _sltp_op(prev, new) -> str:
    """set（无→有）/ move（有→另一个值）/ remove（有→无）/ same（没变）/ changed（原值未知）。
    set / move / remove / same / changed (previous value unknown)."""
    if prev is None:
        return "changed"
    p = float(prev or 0.0)
    n = float(new or 0.0)
    if _same(p, n):
        return "same"
    if abs(p) <= _VOL_EPS:
        return "set"
    if abs(n) <= _VOL_EPS:
        return "remove"
    return "move"


def _pending_sltp_op(value) -> str:
    """改挂单时止损 / 止盈这一项：keep（没传，保留现值）/ remove（传 0，清除）/ set（设成新值）。
    One SL/TP field of a pending-order edit: keep (not sent) / remove (0) / set."""
    v = _num(value)
    if v is None:
        return "keep"
    return "remove" if abs(v) <= _VOL_EPS else "set"


def _order_params(p: _Proto, ctx: _Ctx) -> dict:
    o: Order = p.obj
    common = {"msg": _blank(o.message), "note": _order_note(o)}
    sym, side = o.symbol, o.side
    if p.kind == TRADE_OPEN:
        return {
            "sym": sym, "side": side, "vol": _num(o.volume), "px": _num(o.filled_price),
            "sl": _price(o.sl), "tp": _price(o.tp), "src": order_source_tag(o), **common,
        }
    if p.kind == PENDING_PLACE:
        return {
            "sym": sym, "side": side, "vol": _num(o.volume), "price": _price(o.price),
            "ptype": o.pending_type, "sl": _price(o.sl), "tp": _price(o.tp), "src": order_source_tag(o), **common,
        }
    if p.kind == PENDING_MODIFY:
        # 改挂单的三项都是「没传 = 保留券商上的现值」（落库 NULL），止损止盈传 0 = 清除：
        # 必须把「没动」和「清掉了」分开，否则只拖了触发价也会被说成「不设止损、不设止盈」。
        # Each field is "not sent = keep the broker's value" (stored NULL) and SL/TP 0
        # clears: "untouched" and "cleared" must stay apart, or a trigger-only drag
        # reads as "no stop loss, no take profit".
        return {
            "ticket": o.ticket, "sym": sym, "price": _price(o.price),
            "sl": _price(o.sl), "tp": _price(o.tp),
            "sl_op": _pending_sltp_op(o.sl), "tp_op": _pending_sltp_op(o.tp), **common,
        }
    if p.kind == PENDING_CANCEL:
        # 撤单指令里的 side / volume 是占位值，信息从原挂单补（orders.cancel_pending_order）
        # A cancel carries placeholder side / volume; take them from the original order
        orig = ctx.pending_orig.get((o.user_id, int(o.ticket))) if o.ticket else None
        return {
            "ticket": o.ticket, "sym": sym,
            "side": orig.side if orig else None, "vol": _num(orig.volume) if orig else None,
            "price": _price(orig.price) if orig else None, "ptype": orig.pending_type if orig else None,
            **common,
        }
    if p.kind in (TRADE_CLOSE, AUTO_PARTIAL_TP):
        return _close_params(p, ctx, common)
    if p.kind == SLTP_MODIFY:
        return {
            "sym": sym, "side": side, "pos_vol": _num(o.pos_volume),
            "sl": _price(o.sl), "tp": _price(o.tp),
            "prev_sl": _price(o.prev_sl), "prev_tp": _price(o.prev_tp),
            "sl_op": _sltp_op(o.prev_sl, o.sl), "tp_op": _sltp_op(o.prev_tp, o.tp), **common,
        }
    if p.kind == AUTO_SL:
        mode = auto_command_kind(o.client_order_id)
        return {
            "mode": mode if mode in _AUTO_SL_MODES else None, "sym": sym, "side": side,
            "sl": _price(o.sl), "prev_sl": _price(o.prev_sl), "moves": 1, **common,
        }
    return {"action": o.action, "sym": sym, "side": side, "vol": _num(o.volume), **common}


# 桥接平仓回执的原话（bridge/mt5_worker.py 的平仓分支）/ the bridge's close receipt messages
_BRIDGE_CLOSE_MESSAGES = frozenset({"position closed", _GONE_MARK})


def _went_through_bridge(o: Order) -> bool:
    """这条平仓指令的回执是不是桥接写的：桥接成交回执的 message 是固定的两句英文，mt5_ticket
    放的是仓位号（= ticket）；网关成交会清空 message、mt5_ticket 放平仓单号或成交号。
    Was this close answered by the bridge? A bridge receipt carries one of two fixed
    messages and puts the position id (= ticket) in mt5_ticket; a gateway fill
    clears the message and stores the closing order or deal ticket."""
    if (o.message or "").strip().lower() in _BRIDGE_CLOSE_MESSAGES:
        return True
    return bool(o.mt5_ticket) and bool(o.ticket) and int(o.mt5_ticket) == int(o.ticket)


def _went_through_gateway(o: Order) -> bool:
    return (
        (o.status or "").upper() == "FILLED" and not (o.message or "").strip()
        and bool(o.mt5_ticket) and bool(o.ticket) and int(o.mt5_ticket) != int(o.ticket)
    )


def _partial_without_pos_volume(o: Order, login: str | None, ctx: _Ctx) -> bool | None:
    """pos_volume 不知道、volume > 0 时是不是部分平。网关保留请求手数（0 = 全平），所以网关单
    volume > 0 一定是部分平；桥接回执会把 volume 改写成实际成交手数，全平也会变成 > 0，说不准。
    订单行上没有通道字段：先看回执的指纹，看不出来再看这个用户在这个账号上的**全部**账户行
    （含已解绑）——只要有过桥接行，这条就可能是桥接发的，给 None。不能只看账户现在的通道：
    先走桥接、后改直连的账号，旧的桥接全平会被说成「部分平仓」。
    Partial or not with pos_volume unknown and volume > 0. The gateway keeps the
    requested lots (0 = full), so a gateway volume > 0 is surely partial; a bridge
    receipt rewrites volume to the filled lots, so even a full close reads > 0 —
    unknown. Orders carry no channel: use the receipt's fingerprint first, then
    every account row of this user on this login, removed ones included — any
    bridge row means the order may have gone through the bridge (None). The
    account's *current* channel is not enough: a login moved from bridge to gateway
    would show its old bridge full closes as partial."""
    if _went_through_bridge(o):
        return None
    if _went_through_gateway(o):
        return True
    sources = {a.source for a in ctx.accounts.get(login or "", []) if a.user_id == o.user_id}
    return True if "gateway" in sources and "bridge" not in sources else None


def _close_params(p: _Proto, ctx: _Ctx, common: dict) -> dict:
    """全平还是部分平：volume = 0 或 ≥ pos_volume 是全平。判断用 pos_volume——桥接回执会把
    volume 改写成实际成交手数。pos_volume 不知道时见 _partial_without_pos_volume（网关单
    volume > 0 一定是部分平，可能走过桥接的说不准）。仓位已经不在了就什么都没平：没有盈亏。
    Full vs partial: volume 0 or ≥ pos_volume is full. Judged by pos_volume — a bridge
    receipt rewrites volume. With pos_volume unknown see _partial_without_pos_volume
    (gateway volume > 0 is surely partial; anything that may be bridge is unknown).
    A gone position closed nothing, so it has no P&L."""
    o: Order = p.obj
    vol_req = _num(o.volume) or 0.0
    pos_vol = _num(o.pos_volume)
    gone = _GONE_MARK in (o.message or "").lower()
    leg = None if gone else p.leg
    if vol_req <= _VOL_EPS:
        partial = False
    elif pos_vol is not None and pos_vol > _VOL_EPS:
        partial = vol_req < pos_vol - _VOL_EPS
    else:
        partial = _partial_without_pos_volume(o, p.login, ctx)
    if vol_req > _VOL_EPS:
        vol = vol_req
    elif pos_vol:
        vol = pos_vol
    else:
        vol = _num(leg.close_volume) if leg is not None else None
    remain = round(pos_vol - vol_req, 8) if partial and pos_vol else None
    # 仓位已经不在了就什么都没平：不再标「部分平仓」，免得句子说成「平掉了一部分」
    # Nothing was closed on a gone position, so it isn't tagged as a partial close
    if partial and not gone:
        p.tags.append("partial")
    return {
        "sym": o.symbol, "side": o.side, "vol": vol, "pos_vol": pos_vol, "remain": remain,
        "partial": partial,
        "px": _num(o.filled_price) or (_num(leg.close_price) if leg is not None else None),
        "pnl": _num(leg.profit) if leg is not None else None,
        "pnl_pending": p.status == "ok" and leg is None and not gone,
        "gone": gone, **common,
    }


def _deal_params(p: _Proto, ctx: _Ctx) -> dict:
    t: ClosedTrade = p.obj
    # 老行 reason 为空时是从备注推断的 / inferred from the comment on blank-reason legacy rows
    reason = _effective_reason(t)
    legs = ctx.legs.get(p.pos, []) if p.pos is not None else []
    ids = [x.id for x in legs]
    leg_n = len(legs) or 1
    leg_k = ids.index(t.id) + 1 if t.id in ids else 1
    holders = set(ctx.holders(t.mt5_login)) | {t.user_id, *p.dup_users}
    holders.discard(None)
    if len(holders) > 1:
        p.tags.append("shared_login")
    return {
        "reason": reason if reason in _DEAL_REASONS else "OTHER",
        "sym": t.symbol, "side": t.side, "vol": _num(t.close_volume), "px": _num(t.close_price),
        "pnl": _num(t.profit), "leg_k": leg_k, "leg_n": leg_n,
        "holders": [ctx.user_ref(u) for u in sorted(holders)] if len(holders) > 1 else None,
    }


def _close_all_params(p: _Proto) -> dict:
    data = al.decode_data(p.obj.data)
    kids = p.children or []
    counts = {s: sum(1 for c in kids if c.status == s) for s in STATUSES}
    pnls = [c.params.get("pnl") for c in kids if c.params.get("pnl") is not None]
    p.status = _worst_status(c.status for c in kids) if kids else "ok"
    # 与子指令同一条规则（也与「只看异常」的 SQL 一致）：桥接超时作废的子单页面状态是
    # cancelled，但它照样是 FAILED、照样异常——只数 fail / unknown 会漏掉它。
    # Same rule as the children (and the abnormal filter's SQL): a child voided as
    # stale on the bridge shows as cancelled yet is FAILED and abnormal.
    p.abnormal = any(c.abnormal for c in kids)
    return {
        "count": data.get("count") if data.get("count") is not None else len(kids),
        "skipped": data.get("skipped"),
        "filled": counts["ok"], "failed": counts["fail"], "unknown": counts["unknown"],
        "pending": counts["pending"], "cancelled": counts["cancelled"],
        "pnl": round(sum(pnls), 8) if pnls else None,
        "pnl_pending": any(c.params.get("pnl_pending") for c in kids),
    }


def _register_trial_row(u, rows: list[AdminAuditLog], google: bool) -> AdminAuditLog | None:
    created = _naive_utc(u.created_at)
    if created is None:
        return None
    window = _TRIAL_FOLD_GOOGLE if google else _TRIAL_FOLD_EMAIL
    for a in rows:
        ts = _naive_utc(a.created_at)
        if ts is not None and abs(ts - created) <= window:
            return a
    return None


def _is_google_signup(u) -> bool:
    created = _naive_utc(u.created_at)
    linked = _naive_utc(getattr(u, "google_linked_at", None))
    return created is not None and linked is not None and abs(linked - created) <= _GOOGLE_SIGNUP_WINDOW


def _register_params(p: _Proto, ctx: _Ctx) -> dict:
    u = p.obj
    google = _is_google_signup(u)
    trial = _register_trial_row(u, ctx.register_trials.get(u.id, []), google)
    plan, inner = _plan_value(trial.new_value) if trial is not None else (None, None)
    code = u.invite_code or None
    return {
        "method": "google" if google else "email",
        "invite_code": code,
        "invite_label": ctx.invite_labels.get(code) if code else None,
        "trial_plan": plan,
        "trial_days": _trial_days(inner),
    }


def _trial_folded(p: _Proto, ctx: _Ctx) -> bool:
    """规则 6：这条 plan:invite_trial 是不是注册那一刻送的（已经并进注册行）。只有本次请求
    里那条注册行看得见（u 源在查、时间窗包含注册时间）时才收掉，不然它就无处可见了。
    Rule 6: was this invite trial granted at sign-up (already folded into the
    sign-up line)? Only folded when that sign-up line is visible in this request."""
    if not ctx.fold_trials:
        return False
    a = p.audit_rows[0]
    u = ctx.users.get(a.target_user_id)
    if u is None:
        return False
    created = _naive_utc(u.created_at)
    since, until = ctx.window
    if created is None or (since is not None and created < since) or (until is not None and created >= until):
        return False
    return _register_trial_row(u, [a], _is_google_signup(u)) is not None


def _changes(rows: list[AdminAuditLog]) -> "OrderedDict[str, tuple[str | None, str | None]]":
    """同一组里每个字段的 (最早的旧值, 最新的新值)；rows 新的在前。
    Per field: (oldest old value, newest new value); rows are newest first."""
    out: OrderedDict[str, list] = OrderedDict()
    for a in rows:
        f = a.field or ""
        if f not in out:
            out[f] = [a.old_value, a.new_value]
        else:
            out[f][0] = a.old_value
    return OrderedDict((k, (v[0], v[1])) for k, v in out.items())


def _pair(ch: dict, f: str, *, dt: bool = False) -> list | None:
    if f not in ch:
        return None
    old, new = ch[f]
    if dt:
        return [_iso(_parse_dt(old)) if old else None, _iso(_parse_dt(new)) if new else None]
    return [_blank(old), _blank(new)]


# 比赛字段里哪些是数字 / 时间（log_change 一律 str()，读回来按字段还原类型）
# Competition fields' value types (log_change str()s everything)
_COMP_NUMERIC = {"minBaselineUsd", "maxBaselineUsd", "minTrades"}
_COMP_TIME = {"regOpensAt", "regClosesAt", "startsAt", "endsAt"}


def _comp_value(f: str, value):
    v = _blank(value)
    if v is None:
        return None
    if f in _COMP_NUMERIC:
        n = _num(v)
        return int(n) if n is not None and f == "minTrades" and n == int(n) else n
    if f in _COMP_TIME:
        dt = _parse_dt(v)
        return _iso(dt) if dt is not None else v
    if f == "publicView":
        return v in ("True", "true", "1")
    return v


def _audit_params(p: _Proto, ctx: _Ctx) -> dict:
    rows = p.audit_rows
    head = rows[0]
    ch = _changes(rows)
    kind = p.kind
    fam = p.family or ""

    if kind == ADMIN_USER_PLAN:
        return {"plan": _pair(ch, "plan"), "expires": _pair(ch, "plan_expires_at", dt=True), "note": _pair(ch, "plan_note")}
    if kind == ADMIN_USER_ROLE:
        old, new = ch["role"]
        return {"old": _blank(old), "new": _blank(new)}
    if kind == ADMIN_USER_ATTRIBUTION:
        old, new = (_blank(v) for v in ch["invite_code"])
        return {
            "old": old, "new": new,
            "old_label": ctx.invite_labels.get(old) if old else None,
            "new_label": ctx.invite_labels.get(new) if new else None,
        }
    if kind == ADMIN_USER_EDIT:
        inv = _pair(ch, "invite_code")
        return {
            "role": _pair(ch, "role"), "plan": _pair(ch, "plan"),
            "expires": _pair(ch, "plan_expires_at", dt=True), "note": _pair(ch, "plan_note"),
            "invite": inv,
            "invite_label": [ctx.invite_labels.get(c) if c else None for c in inv] if inv else None,
        }
    if kind == ADMIN_USER_DISABLE:
        old, new = _as_dict(ch["account:disable"][0]), _as_dict(ch["account:disable"][1])
        return {"reason": _blank(new.get("reason")), "was_disabled": bool(old.get("disabledAt"))}
    if kind == ADMIN_USER_ENABLE:
        return {"prev_reason": _blank(_as_dict(ch["account:enable"][0]).get("reason"))}
    if kind == ADMIN_VERIFY_EMAIL:
        return {}
    if kind in (ADMIN_SETTING, ADMIN_GAMIFICATION):
        changes = []
        for f, (old, new) in ch.items():
            parts = f.split(":")
            group = parts[1] if kind == ADMIN_SETTING and len(parts) >= 3 else None
            key = ":".join(parts[2:]) if group is not None else ":".join(parts[1:])
            entry = {"key": key, "old": _parse_value(old, json_always=True), "new": _parse_value(new, json_always=True)}
            if kind == ADMIN_SETTING:
                entry = {"group": group, **entry}
            changes.append(entry)
        single = changes[0] if len(changes) == 1 else None
        out = {
            "key": single["key"] if single else None,
            "old": single["old"] if single else None,
            "new": single["new"] if single else None,
            "changes": changes,
        }
        if kind == ADMIN_SETTING:
            groups = {c["group"] for c in changes}
            out = {"group": groups.pop() if len(groups) == 1 else None, **out}
        return out
    if kind == ADMIN_INVITE_LINK:
        code = fam.split(":", 1)[1]
        old_raw, new_raw = ch[f"invite:{code}"]
        old_j, new_j = _as_dict(old_raw), _as_dict(new_raw)
        mode = None
        if "deleted" in new_j:
            action, mode, label = "delete", new_j.get("deleted"), old_j.get("label")
            changes = []
        elif not old_raw:
            action, label = "create", new_j.get("label")
            changes = [
                {"field": k, "old": None, "new": v}
                for k, v in new_j.items() if k != "label" and v not in (None, False, "")
            ]
        else:
            action, label = "update", new_j.get("label") or old_j.get("label")
            changes = [
                {"field": k, "old": old_j.get(k), "new": new_j.get(k)}
                for k in list(OrderedDict.fromkeys([*old_j, *new_j]))
                if old_j.get(k) != new_j.get(k)
            ]
        return {
            "action": action, "code": code, "label": label or ctx.invite_labels.get(code),
            "mode": mode, "changes": changes,
        }
    if kind == ADMIN_AGENT_ASSIGN:
        code = fam.split(":")[1]
        old, new = ch[f"invite:{code}:agent"]
        target = ctx.user_ref(head.target_user_id)
        return {
            "code": code, "label": ctx.invite_labels.get(code),
            "agent": target if new else None, "old_agent": target if old and not new else None,
        }
    if kind == AGENT_PLAN:
        code = fam.split(":", 1)[1]
        plan = ch.get(f"agent:{code}:plan")
        exp = ch.get(f"agent:{code}:plan_expires_at")
        days = ch.get(f"agent:{code}:extend_days")
        n_days = _num(days[1]) if days else None
        return {
            "code": code, "label": ctx.invite_labels.get(code),
            "plan": _blank(plan[1]) if plan else None, "old_plan": _blank(plan[0]) if plan else None,
            "days": int(n_days) if n_days is not None else None,
            "old_expires": _iso(_parse_dt(exp[0])) if exp and exp[0] else None,
            "new_expires": _iso(_parse_dt(exp[1])) if exp and exp[1] else None,
        }
    if kind == ADMIN_COMPETITION:
        comp_id = fam.split(":", 1)[1]
        name = ctx.comp_names.get(comp_id)
        action = "update"
        changes = []
        for f, (old, new) in ch.items():
            parts = f.split(":")
            if parts[1] == "settle":
                action = "settle" if action == "update" else action
                continue
            sub = parts[2]
            if sub == "create":
                action, name = "create", _blank(new) or name
            elif sub == "delete":
                action, name = "delete", _blank(old) or name
            else:
                changes.append({"field": sub, "old": _comp_value(sub, old), "new": _comp_value(sub, new)})
                if sub == "name" and _blank(new):
                    name = name or new
        return {"comp_id": comp_id, "name": name, "action": action, "changes": changes}
    if kind == ADMIN_COMPETITION_PARTICIPANT:
        pid = fam.rsplit(":", 1)[1]
        part = ctx.participants.get(pid)
        comp_id = part.competition_id if part is not None else None
        action, reason, hidden = "update", None, None
        dq = ch.get(f"competition:participant:{pid}:nameHidden")
        if dq is not None:
            hidden = (dq[1] or "") == "True"
            action = "hide_name" if hidden else "show_name"
        dis = ch.get(f"competition:participant:{pid}:disqualified")
        if dis is not None:
            flag, _, why = (dis[1] or "").partition(":")
            action = "disqualify" if flag == "True" else "requalify"
            reason = None if why in ("", "None") else why
        return {
            "comp_id": comp_id, "name": ctx.comp_names.get(comp_id) if comp_id else None,
            "participant_id": pid, "action": action, "reason": reason, "name_hidden": hidden,
        }
    if kind == ADMIN_ANNOUNCEMENT:
        f = head.field or ""
        action = f.split(":", 1)[1]
        new_j, old_j = _as_dict(head.new_value), _as_dict(head.old_value)
        if action == "delete":
            title = _blank(head.old_value)
        else:
            title = ctx.announcements.get(str(new_j.get("id"))) if new_j.get("id") else None
        return {
            "action": action, "title": title,
            "published": new_j.get("published") if "published" in new_j else None,
            "was_published": old_j.get("published") if "published" in old_j else None,
        }
    if kind == ADMIN_EMAIL:
        action = (head.field or "").split(":", 1)[1]
        new_j = _as_dict(head.new_value)
        cid = str(new_j["id"]) if new_j.get("id") else None
        camp = ctx.campaigns.get(cid) if cid else None
        return {
            "action": action, "campaign_id": cid,
            "count": new_j.get("recipients"),
            "subject": (camp.subject_zh or camp.subject_en) if camp is not None else None,
            "mail_kind": new_j.get("kind") or (camp.kind if camp is not None else None),
        }
    if kind == ADMIN_OPS:
        rest = (head.field or "").split(":", 1)[1]
        action, _, target = rest.partition(":")
        return {"action": action, "target": target or None, "result": _blank(head.new_value)}
    if kind == ADMIN_TICKET:
        tid = fam.split(":", 1)[1]
        t = ctx.tickets.get(tid)
        changes = [
            {"field": f.split(":")[2], "old": _blank(old), "new": _blank(new)} for f, (old, new) in ch.items()
        ]
        single = changes[0] if len(changes) == 1 else None
        return {
            "ticket_id": tid, "subject": t.title if t is not None else None,
            "field": single["field"] if single else None,
            "old": single["old"] if single else None, "new": single["new"] if single else None,
            "changes": changes,
        }
    if kind == PLAN_TRIAL_CLAIM:
        plan, inner = _plan_value(head.new_value)
        days = _trial_days(inner)
        ts = _naive_utc(head.created_at)
        return {"plan": plan, "days": days, "expires_at": _iso(ts + timedelta(days=days)) if days and ts else None}
    if kind == PLAN_INVITE_TRIAL:
        plan, inner = _plan_value(head.new_value)
        u = ctx.users.get(head.target_user_id)
        code = u.invite_code if u is not None and u.invite_code else None
        return {"plan": plan, "days": _trial_days(inner), "invite_code": code,
                "invite_label": ctx.invite_labels.get(code) if code else None}
    if kind in (PLAN_PAYMENT, PLAN_REFUND):
        old_plan, old_exp = _plan_value(head.old_value)
        new_plan, new_exp = _plan_value(head.new_value)
        old_iso = _iso(_parse_dt(old_exp)) if old_exp else None
        new_iso = _iso(_parse_dt(new_exp)) if new_exp else None
        if kind == PLAN_PAYMENT:
            return {"old_plan": old_plan, "new_plan": new_plan, "old_expires": old_iso, "expires_at": new_iso}
        return {"old_plan": old_plan, "new_plan": new_plan, "old_expires": old_iso, "new_expires": new_iso}
    if kind == PLAN_PAYMENT_ISSUE:
        f = head.field or ""
        return {"field": f.split(":", 1)[1], "old": _parse_value(head.old_value), "new": _parse_value(head.new_value)}
    if kind == PLAN_AUTO_EXPIRE:
        return {"old_plan": _blank(head.old_value), "new_plan": _blank(head.new_value)}
    # admin.other：认不出来的字段原样给出 / unknown fields, as stored
    changes = [{"field": f, "old": _parse_value(old), "new": _parse_value(new)} for f, (old, new) in ch.items()]
    single = changes[0] if len(changes) == 1 else None
    return {
        "field": single["field"] if single else None,
        "old": single["old"] if single else None,
        "new": single["new"] if single else None,
        "changes": changes,
    }


def _bulk_params(p: _Proto) -> dict:
    seen: OrderedDict[tuple, dict] = OrderedDict()
    for a in p.audit_rows:
        f = a.field or ""
        new = _iso(_parse_dt(a.new_value)) if f.endswith("plan_expires_at") and a.new_value else _parse_value(a.new_value)
        k = (f, json.dumps(new, sort_keys=True, default=str))
        seen.setdefault(k, {"field": f, "new": new})
    return {"users_count": p.users_count, "changes": list(seen.values())}


def _finalize(p: _Proto, ctx: _Ctx, *, child: bool = False) -> dict | None:
    """proto → 输出的 Item；返回 None = 这一行被合并规则收掉了。
    proto -> output Item; None when a grouping rule folded it away."""
    if p.src == "o":
        if p.kind == AUTO_SL and p.children:
            kids = [_finalize(c, ctx, child=True) for c in p.children]
            kids = [k for k in kids if k is not None]
            newest, oldest = p.children[0], p.children[-1]
            base = _order_params(newest, ctx)
            base["prev_sl"] = _price(oldest.obj.prev_sl)
            base["moves"] = len(p.children)
            p.params = base
            p.status = _worst_status(c.status for c in p.children)
            p.abnormal = any(c.abnormal for c in p.children)
            return _item(p, ctx, kids)
        p.params = _order_params(p, ctx)
    elif p.src == "c":
        if p.kind == DEAL_STOPOUT_GROUP:
            kids = [_finalize(c, ctx, child=True) for c in p.children]
            kids = [k for k in kids if k is not None]
            pnls = [k["params"]["pnl"] for k in kids if k["params"].get("pnl") is not None]
            p.params = {"count": len(kids), "pnl": round(sum(pnls), 8) if pnls else None}
            for k in kids:
                if "shared_login" in k["tags"] and "shared_login" not in p.tags:
                    p.tags.append("shared_login")
            return _item(p, ctx, kids)
        p.params = _deal_params(p, ctx)
    elif p.src == "e":
        if p.kind == al.TRADE_CLOSE_ALL:
            kids = [_finalize(c, ctx, child=True) for c in (p.children or [])]
            p.params = _close_all_params(p)
            return _item(p, ctx, [k for k in kids if k is not None])
    elif p.src == "u":
        p.params = _register_params(p, ctx)
    elif p.src == "a":
        if p.kind == ADMIN_BULK_EDIT:
            kids = [_finalize(c, ctx, child=True) for c in p.children]
            p.params = _bulk_params(p)
            return _item(p, ctx, [k for k in kids if k is not None])
        if p.kind == PLAN_INVITE_TRIAL and not child and _trial_folded(p, ctx):
            return None
        if p.family and p.family.startswith("ticket:"):
            t = ctx.tickets.get(p.family.split(":", 1)[1])
            if t is not None and t.user_id:
                p.user_id = t.user_id
            elif p.user_id == p.actor_id:
                p.user_id = None
        if p.kind == ADMIN_COMPETITION_PARTICIPANT:
            part = ctx.participants.get(p.family.rsplit(":", 1)[1])
            if part is not None and part.user_id:
                p.user_id = part.user_id
        p.params = _audit_params(p, ctx)
    return _item(p, ctx, None)


def _auth_lost(acc) -> bool:
    """账户列「授权失效」标签：券商侧改了密码、平台暂停用它下单（gateway 撤销且不是用户自己解绑）。

    gateway_binding.is_revoked 对「用户解绑」的直连行同样返回 True（mark_removed 也写
    revoked_at），它回答的是「这条绑定还能不能下单」。日志里两件事要分开说：解绑的显示
    「已解绑」，只有真的授权失效才显示「授权失效」——否则每个解绑过的直连账户都会被误标。
    The account cell's 授权失效 tag: a gateway binding revoked because the broker-side
    password changed. is_revoked is also True for user-removed gateway rows (mark_removed
    sets revoked_at too) — it answers "can this binding trade" — so on its own it would
    tag every unlinked gateway account as revoked.
    """
    return is_revoked(acc) and not is_removed(acc)


def _item(p: _Proto, ctx: _Ctx, children: list | None) -> dict:
    actor_type = p.actor_type
    if actor_type == "role":
        u = ctx.users.get(p.actor_id)
        actor_type = "admin" if u is not None and u.role == "admin" else "agent"
    if actor_type in ("admin", "agent") and p.actor_id:
        u = ctx.users.get(p.actor_id)
        actor = {"type": actor_type, "id": p.actor_id,
                 "name": u.nickname if u else None, "email": u.email if u else None}
    else:
        actor = {"type": actor_type, "id": None, "name": None, "email": None}
    account = None
    if p.login:
        acc = ctx.account_row(p.user_id, p.login)
        if acc is not None:
            account = {
                "channel": acc.source if acc.source in ("gateway", "bridge") else None,
                "demo": al.demo_of(acc.trade_mode),
                "removed": is_removed(acc),
                "revoked": _auth_lost(acc),
            }
    params = {k: v for k, v in p.params.items() if not k.startswith("_")}
    return {
        "key": p.key,
        "ts": _iso(p.ts),
        "at": _iso(p.at),
        "cat": KIND_CATEGORY.get(p.kind, "account"),
        "kind": p.kind,
        "params": _scrub_for_json(params),
        "status": p.status,
        "tags": list(dict.fromkeys(p.tags)),
        "abnormal": bool(p.abnormal),
        "actor": actor,
        "user": ctx.user_ref(p.user_id) if p.users_count is None else None,
        "users_count": p.users_count,
        "login": p.login,
        "account": account,
        "children": children,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 组装一页 / assemble a page
# ─────────────────────────────────────────────────────────────────────────────
def _protos_from_rows(rows_by_src: dict[str, list[_Row]], *, user_filtered: bool) -> list[_Proto]:
    protos: list[_Proto] = []
    for name, rows in rows_by_src.items():
        if name == "a":
            groups = _group_audit(rows)
            index = {r.id: i for i, r in enumerate(rows)}
            for g in groups:
                p = _audit_proto(g)
                p.seq = index[g[0].id]
                protos.append(p)
            continue
        for i, r in enumerate(rows):
            if name == "o":
                p = _order_proto(r.obj)
            elif name == "c":
                p = _deal_proto(r.obj)
            elif name == "e":
                p = _event_proto(r.obj)
            else:
                p = _register_proto(r.obj)
            p.seq = i
            protos.append(p)
    protos.sort(key=lambda p: (-_us(p.ts), _SRC_RANK[p.src], p.seq))
    if not user_filtered:
        _collapse_shared_deals(protos)
    protos = _group_stopouts(protos)
    protos = _merge_auto_trails(protos)
    return [p for p in protos if not p.drop]


def _safe_finalize(p: _Proto, ctx: _Ctx, *, child: bool = False) -> dict | None:
    """定稿出错（某一行的数据格式出乎意料）不能让整页 500：审计行退回 admin.other 原样显示，
    其它行保留 kind、params 有多少给多少，并告警。
    A row with unexpected data must not 500 the whole page: audit rows fall back to
    admin.other with raw values, other rows keep their kind with whatever params
    were built; either way a warning is logged."""
    try:
        return _finalize(p, ctx, child=child)
    except Exception:
        logger.warning("操作日志翻译失败，已降级显示 / activity item fell back: key=%s kind=%s",
                       p.key, p.kind, exc_info=True)
    if p.audit_rows:
        p.kind = ADMIN_OTHER
        changes = [{"field": a.field, "old": _blank(a.old_value), "new": _blank(a.new_value)} for a in p.audit_rows]
        p.params = {"field": None, "old": None, "new": None, "changes": changes}
        p.users_count = None
    return _item(p, ctx, None)


def _build(db: Session, rows_by_src: dict[str, list[_Row]], *, user_filtered: bool,
           window: tuple, fold_trials: bool) -> list[dict]:
    protos = _protos_from_rows(rows_by_src, user_filtered=user_filtered)
    ctx = _Ctx(db, window, fold_trials)
    _enrich(db, protos, ctx)
    items = []
    for p in protos:
        it = _safe_finalize(p, ctx)
        if it is not None:
            items.append(it)
    return items


def list_activity(
    db: Session,
    *,
    cat: str = "all",
    sub: str = "all",
    abnormal: bool = False,
    q: str | None = None,
    user_id: str | None = None,
    login: str | None = None,
    since: str | None = None,
    until: str | None = None,
    cursor: str | None = None,
    limit: int = LIMIT_DEFAULT,
) -> dict:
    """GET /admin/activity 的全部逻辑：返回 {"items": Item[], "next": 游标 | None}，不返回总数。
    The whole of GET /admin/activity: {"items": Item[], "next": cursor | None}."""
    if any(_bad_text(v) for v in (cat, sub, q, user_id, login, since, until, cursor)):
        raise FeedError(_BAD_TEXT)
    cat = (cat or "all").strip()
    sub = (sub or "all").strip()
    if cat not in CATS:
        raise FeedError(f"未知分类 / unknown cat: {cat}")
    if sub not in SUBS:
        raise FeedError(f"未知子分类 / unknown sub: {sub}")
    try:
        limit = max(1, min(int(limit or LIMIT_DEFAULT), LIMIT_MAX))
    except (TypeError, ValueError) as e:
        raise FeedError("limit 不是数字 / limit is not a number") from e
    since_dt = parse_time(since, "since")
    until_dt = parse_time(until, "until")

    _set_timeout(db)
    scope = _resolve_scope(db, q, user_id, login)
    if scope.empty:
        return {"items": [], "next": None}
    sources = _sources(db, cat, sub, bool(abnormal), scope, since_dt, until_dt)
    if not sources:
        return {"items": [], "next": None}
    state = decode_cursor(cursor, sources.keys())
    if all(v == "end" for v in state.values()):
        return {"items": [], "next": None}

    items: list[dict] = []
    done = False
    for _ in range(_EMPTY_PAGE_RETRIES):
        rows_by_src, state, done = _page(sources, state, limit)
        items = _build(
            db, rows_by_src, user_filtered=scope.user_filtered,
            window=(since_dt, until_dt), fold_trials="u" in sources,
        )
        if items or done:
            break
    return {"items": items, "next": None if done else encode_cursor(state)}


# ─────────────────────────────────────────────────────────────────────────────
# 详情：GET /admin/activity/item?key=… / detail
# ─────────────────────────────────────────────────────────────────────────────
def _order_raw(o: Order) -> dict:
    return {
        "client_order_id": o.client_order_id, "action": o.action, "status": o.status,
        "symbol": o.symbol, "side": o.side, "volume": o.volume, "pos_volume": o.pos_volume,
        "ticket": o.ticket, "mt5_login": o.mt5_login, "mt5_ticket": o.mt5_ticket, "mt5_position": o.mt5_position,
        "filled_price": o.filled_price, "price": o.price, "pending_type": o.pending_type,
        "sl": o.sl, "tp": o.tp, "prev_sl": o.prev_sl, "prev_tp": o.prev_tp,
        "message": o.message, "source": o.source, "src": order_source_tag(o), "signal_id": o.signal_id,
        "batch": batch_of(o.client_order_id), "trade_mode": o.trade_mode,
        "created_at": _iso(_naive_utc(o.created_at)), "updated_at": _iso(_naive_utc(o.updated_at)),
    }


def _deal_raw(t: ClosedTrade) -> dict:
    return {
        "deal_ticket": t.deal_ticket, "position_ticket": t.position_ticket, "reason": t.reason,
        "comment": t.comment, "verified": t.verified, "symbol": t.symbol, "side": t.side,
        "close_volume": t.close_volume, "close_price": t.close_price, "profit": t.profit,
        "gross_profit": t.gross_profit, "commission": t.commission, "swap": t.swap,
        "sl": t.sl, "tp": t.tp, "open_time": _iso(_naive_utc(t.open_time)), "open_price": t.open_price,
        "closed_at": _iso(_naive_utc(t.closed_at)), "created_at": _iso(_naive_utc(t.created_at)),
    }


def _audit_raw(rows: list[AdminAuditLog], ctx: _Ctx) -> dict:
    return {
        "rows": [
            {
                "id": a.id, "field": a.field, "old": a.old_value, "new": a.new_value,
                "actor": ctx.user_ref(a.admin_user_id), "target": ctx.user_ref(a.target_user_id),
                "op_id": a.op_id, "created_at": _iso(_naive_utc(a.created_at)),
            }
            for a in rows
        ]
    }


def _event_raw(e: ActivityEvent) -> dict:
    return {
        "kind": e.kind, "actor_type": e.actor_type, "actor_id": e.actor_id, "ref_id": e.ref_id,
        "mt5_login": e.mt5_login, "data": al.decode_data(e.data), "created_at": _iso(_naive_utc(e.created_at)),
    }


def _user_raw(u) -> dict:
    return {
        "created_at": _iso(_naive_utc(u.created_at)),
        "google_linked_at": _iso(_naive_utc(u.google_linked_at)),
        "invite_code": u.invite_code,
    }


def _audit_row_filter(db: Session, cat: str | None, abnormal: bool, q: str | None, user_id: str | None):
    """列表当时的筛选在审计行上的同一套判断（与 _sources 里审计源的条件一一对应），给详情还原
    「列表上那一组」用。全在 Python 里判断；只有带 q 时多一条查人的查询。没有筛选返回 None。
    The list's filters as a predicate on audit rows (mirroring the audit source in
    _sources), so the detail rebuilds the group the list showed. Pure Python; a q
    costs one user lookup. None when nothing filters."""
    preds = []
    if cat == "account":
        preds.append(lambda a: _is_account_field(a.field or ""))
    elif cat == "admin":
        preds.append(lambda a: not _is_account_field(a.field or ""))
    if abnormal:
        preds.append(lambda a: _is_abnormal_audit_field(a.field or ""))
    if q or user_id:
        scope = _resolve_scope(db, q, user_id, None)
        # 搜的是账号号时列表根本不查审计源；搜不到人时列表是空的——这两种都不按用户筛
        # A login search skips the audit source and an empty scope lists nothing: no user filter then
        if scope.login is None and not scope.empty and scope.user_ids is not None:
            ids = set(scope.user_ids)
            preds.append(lambda a: a.target_user_id in ids or a.admin_user_id in ids)
    if not preds:
        return None
    return lambda a: all(f(a) for f in preds)


def _resolve_audit_group(db: Session, head: AdminAuditLog, keep=None) -> list[AdminAuditLog]:
    """详情里还原列表上的那一组。有 op_id：同一操作人名下同一 op_id 的全部行（走
    admin_user_id 索引，op_id 本身没有索引）；没有：同一操作人前后 5 分钟的行重新按同一套
    规则分组，取包含这一行的那组。keep = 列表当时的筛选（_audit_row_filter）：先按它滤掉列表
    上看不到的行再分组，抽屉才与被点的那一行一致（按用户筛时批量操作只剩这个人的那几行）。
    Rebuild the list's group for the detail view: rows of the same op_id under the
    same actor (admin_user_id index; op_id has none), or — for legacy rows — the
    actor's rows within ±5 minutes regrouped by the same rules. `keep` is the list's
    filter (_audit_row_filter), applied before grouping so the drawer matches the
    clicked row (a user-filtered bulk edit keeps only that user's rows)."""
    q = db.query(AdminAuditLog).filter(AdminAuditLog.admin_user_id == head.admin_user_id)
    if head.op_id:
        q = q.filter(AdminAuditLog.op_id == head.op_id)
    else:
        ts = _naive_utc(head.created_at)
        q = q.filter(
            AdminAuditLog.op_id.is_(None),
            AdminAuditLog.created_at >= ts - timedelta(minutes=5),
            AdminAuditLog.created_at <= ts + timedelta(minutes=5),
        )
    rows = q.order_by(AdminAuditLog.created_at.desc(), AdminAuditLog.id.desc()).all()
    if keep is not None:
        rows = [a for a in rows if a.id == head.id or keep(a)]
    # 同一套分组规则（含丢掉只差时区写法的行）/ same grouping rules, noise rows dropped too
    wrapped = [_Row("a", _naive_utc(a.created_at), a.id, a) for a in rows]
    for g in _group_audit(wrapped):
        if any(r.id == head.id for r in g):
            return [r.obj for r in g]
    return [head]


def _position_rows(db: Session, pos: tuple) -> tuple[list[Order], list[ClosedTrade]]:
    """一个仓位的全部指令（这个用户名下，走 user_id 索引）与全部平仓腿
    （idx_closed_trades_position）。
    Every command (the user's, via the user_id index) and every closing leg
    (idx_closed_trades_position) of one position."""
    uid, login, ticket = pos
    orders = (
        db.query(Order)
        .filter(
            Order.user_id == uid,
            or_(Order.mt5_login == login, Order.mt5_login.is_(None)),
            or_(Order.ticket == ticket, Order.mt5_position == ticket, Order.mt5_ticket == ticket),
        )
        .order_by(Order.created_at.asc(), Order.id.asc())
        .all()
    )
    legs = (
        db.query(ClosedTrade)
        .filter(ClosedTrade.user_id == uid, ClosedTrade.mt5_login == login, ClosedTrade.position_ticket == ticket)
        .all()
    )
    legs.sort(key=lambda t: (_naive_utc(t.closed_at) or _EPOCH, t.deal_ticket or 0, t.id))
    return orders, legs


def _position_protos(orders: list[Order], legs: list[ClosedTrade], pos: tuple) -> list[_Proto]:
    """仓位的指令 + 非平台平仓腿 → proto（平台腿的盈亏已经补在 CLOSE 指令上）。
    The position's commands plus its non-platform legs."""
    protos = [_order_proto(o) for o in orders]
    protos += [_deal_proto(t) for t in legs if not _is_platform_leg(t)]
    for p in protos:
        if p.src == "o" and p.pos is None:
            p.pos = pos
    return protos


def _position_steps(db: Session, ctx: _Ctx, pos: tuple, rows: tuple | None = None) -> dict:
    """「这笔仓位的完整经过」：两条带索引的查询——这个用户名下指向该仓位的全部指令（user_id
    索引）、该仓位的全部平仓腿（idx_closed_trades_position）。平台平仓腿不单列，盈亏已经
    补在 CLOSE 指令上；total_pnl 是全部腿的盈亏之和。rows = 已经查过的 _position_rows 结果
    （t: 详情先查过一次），不再重复查。
    The position's full story: two indexed queries (the user's commands touching it,
    and its closing legs). Platform legs are folded into the CLOSE commands;
    total_pnl sums every leg. `rows` reuses an earlier _position_rows result."""
    ticket = pos[2]
    orders, legs = rows if rows is not None else _position_rows(db, pos)
    ctx.legs[pos] = legs
    protos = _position_protos(orders, legs, pos)
    ctx.load_pending_originals(protos)
    ctx.load_accounts(protos)
    ctx.load_users(protos)
    _match_platform_legs(protos, ctx)
    protos.sort(key=lambda p: (p.at or p.ts, p.ts))
    steps = [it for it in (_safe_finalize(p, ctx, child=True) for p in protos) if it is not None]
    total = round(sum(float(t.profit or 0.0) for t in legs), 8) if legs else None
    return {"ticket": ticket, "steps": steps, "total_pnl": total}


def _is_trail_order(o: Order) -> bool:
    return _order_kind(o) == AUTO_SL and auto_command_kind(o.client_order_id) == AUTO_KIND_TRAIL


def _trail_run(orders: list[Order], newest: Order, oldest_id: str, abnormal_only: bool) -> list[Order]:
    """t:<最新>:<最早> 那一串：这笔仓位里 (created_at, id) 落在两头之间（含两头）的全部追踪
    止损，新的在前。列表合并的就是这一段——中间只可能有被筛选藏掉的别的指令，而追踪止损本身
    只会被「只看异常」藏掉，所以 abnormal_only 时也只留异常的那几次。
    The run a `t:<newest>:<oldest>` key names: every trailing move of the position
    whose (created_at, id) lies between both ends inclusive, newest first. That is
    exactly what the list merged — anything else in between was hidden by a filter,
    and trailing moves themselves are only hidden by the abnormal filter, hence
    abnormal_only."""
    oldest = next((x for x in orders if x.id == oldest_id), None)
    lo_ts, hi_ts = _naive_utc(oldest.created_at) if oldest else None, _naive_utc(newest.created_at)
    if oldest is None or lo_ts is None or hi_ts is None:
        return []
    lo, hi = (lo_ts, oldest.id), (hi_ts, newest.id)
    run = []
    for x in orders:
        ts = _naive_utc(x.created_at)
        if ts is None or not _is_trail_order(x) or not (lo <= (ts, x.id) <= hi):
            continue
        if abnormal_only and x.id not in (oldest.id, newest.id) and not _order_proto(x).abnormal:
            continue
        run.append(x)
    run.sort(key=lambda x: (_naive_utc(x.created_at), x.id), reverse=True)
    return run


def _trail_group(run: list[Order], pos: tuple) -> _Proto:
    """一串追踪止损 → 与 _merge_auto_trails 同形状的合并行（组头的副本是第一个子项）。
    A run of trailing moves -> the same merged shape _merge_auto_trails builds."""
    ps = [_order_proto(x) for x in run]
    for c in ps:
        c.pos = c.pos or pos
    head = ps[0]
    if len(ps) > 1:
        head.children = [replace(head, children=None, params={}, tags=list(head.tags)), *ps[1:]]
    return head


def get_item(
    db: Session, key: str, *, cat: str | None = None, abnormal: bool = False,
    q: str | None = None, user_id: str | None = None,
) -> dict | None:
    """GET /admin/activity/item 的全部逻辑。key 格式见 Item.key；找不到返回 None（404），
    格式不对抛 FeedError（400）。cat / abnormal / q / user_id = 列表当时的筛选（可选）：合并行
    （g: 审计组、t: 追踪止损）按它还原成列表上的那一组，抽屉不会与被点的那一行对不上。返回的
    item.key 恒等于请求的 key。
    The whole of GET /admin/activity/item. None when not found (404); a malformed
    key raises FeedError (400). cat / abnormal / q / user_id are the list's filters
    (optional): merged rows (g: audit groups, t: trailing runs) are rebuilt as the
    list showed them, so the drawer never contradicts the clicked row. item.key
    always equals the requested key."""
    if any(_bad_text(v) for v in (key, cat, q, user_id)):
        raise FeedError(_BAD_TEXT)
    prefix, sep, ident = (key or "").partition(":")
    if not sep or not ident or prefix not in ("o", "t", "d", "s", "e", "u", "a", "g"):
        raise FeedError("key 格式不对 / malformed key")
    cat = (cat or "").strip() or None
    if cat is not None and cat not in CATS:
        raise FeedError(f"未知分类 / unknown cat: {cat}")
    _set_timeout(db)
    ctx = _Ctx(db)
    protos: list[_Proto] = []
    raw: dict = {}
    pos: tuple | None = None
    pos_rows: tuple | None = None

    if prefix in ("o", "t"):
        oid, _, oldest_id = ident.partition(":") if prefix == "t" else (ident, "", "")
        o = db.get(Order, oid)
        if o is None:
            return None
        protos = [_order_proto(o)]
        raw = _order_raw(o)
        pos = protos[0].pos
        if prefix == "t" and pos is not None:
            pos_rows = _position_rows(db, pos)
            orders, legs = pos_rows
            ctx.legs[pos] = legs
            if oldest_id:
                # 合并过的追踪止损：按 key 里的两头原样取回列表上那一串（不在整段历史上重新合并）
                # A merged trailing run: take back exactly the run the key names (no re-merge)
                run = _trail_run(orders, o, oldest_id, bool(abnormal))
                if run:
                    protos = [_trail_group(run, pos)]
            else:
                # 旧格式 t:<id>：在这笔仓位的全部经过上重跑同一条合并规则，取以它为组头的那组
                # Old-style t:<id>: rerun the rule over the position's history
                # 先反转再稳定排序：同一时间戳按 id 倒序，与列表一致 / ties in id-desc order, as listed
                hist = sorted(reversed(_position_protos(orders, legs, pos)), key=lambda p: (-_us(p.ts), _SRC_RANK[p.src]))
                merged = [p for p in _merge_auto_trails(hist) if p.key.startswith(f"t:{oid}:")]
                if merged:
                    protos = merged
    elif prefix == "d":
        t = db.get(ClosedTrade, ident)
        if t is None:
            return None
        protos = [_deal_proto(t)]
        raw = _deal_raw(t)
        pos = protos[0].pos
    elif prefix == "s":
        head = db.get(ClosedTrade, ident)
        if head is None:
            return None
        ts = _naive_utc(head.created_at)
        legs = (
            db.query(ClosedTrade)
            .filter(
                ClosedTrade.mt5_login == head.mt5_login, _effective_reason_sql() == "SO",
                ClosedTrade.created_at >= ts - _SO_WINDOW, ClosedTrade.created_at <= ts,
            )
            .order_by(ClosedTrade.created_at.desc(), ClosedTrade.id.desc())
            .all()
        )
        # 组头排第一（同一时间戳的别的腿不能抢走组头）/ the requested head first
        legs.sort(key=lambda t: t.id != head.id)
        protos = [_deal_proto(t) for t in legs] or [_deal_proto(head)]
        _collapse_shared_deals(protos)
        protos = [p for p in _group_stopouts(protos) if not p.drop][:1]
        raw = {"legs": [_deal_raw(t) for t in legs]}
    elif prefix == "e":
        e = db.get(ActivityEvent, ident)
        if e is None:
            return None
        protos = [_event_proto(e)]
        raw = _event_raw(e)
        if e.kind == al.TRADE_CORRECTED and e.ref_id:
            ref = db.get(Order, e.ref_id)
            if ref is not None:
                pos = _order_position(ref)
    elif prefix == "u":
        u = db.query(
            User.id, User.created_at, User.google_linked_at, User.invite_code,
        ).filter(User.id == ident).first()
        if u is None:
            return None
        protos = [_register_proto(u)]
        raw = _user_raw(u)
    else:
        head = db.get(AdminAuditLog, ident)
        if head is None:
            return None
        if prefix == "a":
            fam = _audit_family(head.field or "")
            if fam is None:
                # 系统 / 本人的会员行在列表上永远各自一行 / account-category rows are always alone
                rows = [head]
            else:
                # 批量操作的 child（a:<这个人那几行里最新的一行>）：还原这个人、这个字段族的全部行，
                # 与列表上那一行一样；单独成行的 a: 还原出来也就是它自己。这一片与列表筛选无关：
                # 按人筛保留的正是这个人的全部行，分类 / 异常筛选不会拆开同一个字段族。
                # A bulk child (a:<newest row of this user's slice>): rebuild this user's
                # rows of this family, as the list showed; a standalone a: rebuilds to
                # itself. The slice doesn't depend on the list's filters.
                rows = [
                    a for a in _resolve_audit_group(db, head)
                    if a.target_user_id == head.target_user_id and _audit_family(a.field or "") == fam
                ] or [head]
        else:
            rows = _resolve_audit_group(db, head, _audit_row_filter(db, cat, bool(abnormal), q, user_id))
        wrapped = [_Row("a", _naive_utc(a.created_at), a.id, a) for a in rows]
        protos = [_audit_proto(wrapped)]

    if not protos:
        return None
    _enrich(db, protos, ctx)
    if prefix in ("a", "g"):
        raw = _audit_raw(protos[0].audit_rows, ctx)
    item = _safe_finalize(protos[0], ctx, child=True)
    if item is None:
        return None
    # 永远回请求的那个 key（合并行重建出来的组头 key 可能不同）/ always the requested key
    item["key"] = key

    p = protos[0]
    user = None
    if p.user_id:
        u = db.query(
            User.id, User.nickname, User.email, User.phone, User.plan, User.plan_expires_at, User.role, User.created_at,
        ).filter(User.id == p.user_id).first()
        if u is not None:
            user = {
                "id": u.id, "nickname": u.nickname, "email": u.email, "phone": u.phone, "plan": u.plan,
                "plan_expires_at": _iso(_naive_utc(u.plan_expires_at)), "role": u.role,
                "created_at": _iso(_naive_utc(u.created_at)),
            }
    account = None
    if p.login:
        acc = ctx.account_row(p.user_id, p.login)
        if acc is not None:
            from app.services.deps import is_account_online

            account = {
                "login": p.login,
                "channel": acc.source if acc.source in ("gateway", "bridge") else None,
                "demo": al.demo_of(acc.trade_mode),
                "removed": is_removed(acc),
                "revoked": _auth_lost(acc),
                "online": bool(is_account_online(acc)),
                "server": acc.server or None,
                "name": acc.account_name or None,
                "holders": [ctx.user_ref(u) for u in ctx.holders(p.login)],
            }
    position = _position_steps(db, ctx, pos, pos_rows) if pos is not None else None
    return {"item": item, "user": user, "account": account, "raw": raw, "position": position}
