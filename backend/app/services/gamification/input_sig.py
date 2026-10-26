"""榜单重算的输入指纹：输入没变就不重算（2026-10-18，Supabase Egress）。

比赛榜每 20 秒（用户轮询）+ 每 60 秒（后台循环）重算一次，周期榜每 5 分钟一次；每次
重算都把每个参赛 / 有基线用户的开仓单与平仓腿**整行**读回来逐人计分——116 人的模拟赛
一轮就是几千行，而大部分时候（尤其周末休市）这些行一行都没变。这是 10-04 开赛以后
Egress 抬高的主因之一。

这里在库里把「计分会读到的全部输入」算成一个指纹（每行整行文本取 64 位哈希求和 + 行数，
结果只有几十字节回到应用），与上次重算时记下的指纹比对：完全一致 → 名次必然与快照里的
一样，跳过重算。指纹里同时带上快照表本身（名次 / 账户 / 分数 / 笔数，不含 computed_at），
所以管理员删行、另一个 worker 抢写这类「表被别人改了」的情况也会让指纹对不上、照常重算。
Python 侧的输入（游戏化设置、比赛行）一并进指纹。

只在 Postgres 上启用（hashtextextended）；其余数据库返回 None = 永远重算，行为与以前相同。
记下的指纹带 TTL（SIG_TTL_SECONDS），过期后至少重算一次，作为兜底。

Input fingerprints for board recomputes: skip the recompute when nothing it reads has
changed (2026-10-18, Supabase egress). The competition board was recomputed every 20s
(user polling) and 60s (loop), the standing boards every 5 minutes, each time reading
every participant's opening orders and closing legs in full — thousands of rows per
pass for a 116-entry contest, almost never changed (weekends especially). The
fingerprint covers every input the scoring reads (sum of 64-bit row-text hashes plus
a count per table, computed in the database so only a few bytes come back), the
snapshot table itself (rank/account/score/sample, not computed_at) and the Python-side
inputs (settings, the competition row). Equal fingerprint → the ranking must equal the
stored snapshot → skip. Postgres only; elsewhere None means "always recompute".
"""
from __future__ import annotations

import hashlib
import json
import logging

from sqlalchemy import text

from app.services import shared_state

logger = logging.getLogger("prismx.gamification")

# 记下的指纹多久后作废、强制重算一次（兜底，也让 replace_snapshot_rows 的
# computed_at 每小时刷新照旧发生）。
# How long a stored fingerprint lives before a forced recompute (a backstop; it also
# keeps replace_snapshot_rows' hourly computed_at touch happening as before).
SIG_TTL_SECONDS = 1800

# 一张表的指纹：行数 + 整行文本哈希之和。和满足交换律，不用排序；64 位哈希求和的碰撞
# 概率可忽略。/ One table's fingerprint: count + sum of row-text hashes. The sum is
# order-free (no sort needed); collisions of summed 64-bit hashes are negligible.
_AGG = "count(*)::text || ':' || coalesce(sum(hashtextextended({row}::text, 0)::numeric), 0)::text"

_SNAPSHOT_SQL = (
    "SELECT " + _AGG.format(row="(s.board, s.rank, s.user_id, s.mt5_login, s.score, s.sample)")
    + " FROM leaderboard_snapshots s WHERE s.period_key = :key"
)

# 订单行去掉两列再算：position_last_seen_open 是持仓在线时每分钟刷一次的「还开着」
# 时间戳，updated_at 随之变；计分从不读这两列，带上它们交易时段指纹每分钟都会变，
# 跳过就形同虚设。其余列（含计分用不到的）都保留，宁可多算不可漏算。
# Orders are hashed without two columns: position_last_seen_open is re-stamped every
# minute while a position is open (and updated_at with it), scoring never reads either,
# and keeping them would change the fingerprint every minute during trading hours.
# Every other column stays in, used or not — over-inclusive is safe, omission is not.
_ORDER_ROW = "(to_jsonb(o) - 'position_last_seen_open' - 'updated_at')"

_COMP_INPUT_SQL = f"""
SELECT
  (SELECT {_AGG.format(row="c")} FROM competitions c WHERE c.id = :cid),
  (SELECT {_AGG.format(row="p")} FROM competition_participants p WHERE p.competition_id = :cid),
  (SELECT {_AGG.format(row="(u.id, u.disabled_at IS NOT NULL)")} FROM users u WHERE u.id IN
      (SELECT user_id FROM competition_participants WHERE competition_id = :cid)),
  (SELECT {_AGG.format(row="b")} FROM period_baselines b WHERE b.period_key = :key),
  (SELECT {_AGG.format(row=_ORDER_ROW)} FROM orders o WHERE o.user_id IN
      (SELECT user_id FROM competition_participants WHERE competition_id = :cid)),
  (SELECT {_AGG.format(row="t")} FROM closed_trades t WHERE t.user_id IN
      (SELECT user_id FROM competition_participants WHERE competition_id = :cid))
"""

_BOARD_INPUT_SQL = f"""
SELECT
  (SELECT {_AGG.format(row="b")} FROM period_baselines b WHERE b.period_key = :key),
  (SELECT {_AGG.format(row="(u.id, u.leaderboard_opt_out, u.disabled_at IS NOT NULL)")} FROM users u WHERE u.id IN
      (SELECT user_id FROM period_baselines WHERE period_key = :key)),
  (SELECT {_AGG.format(row=_ORDER_ROW)} FROM orders o WHERE o.user_id IN
      (SELECT user_id FROM period_baselines WHERE period_key = :key)),
  (SELECT {_AGG.format(row="t")} FROM closed_trades t WHERE t.user_id IN
      (SELECT user_id FROM period_baselines WHERE period_key = :key))
"""


def _enabled(db) -> bool:
    try:
        return db.get_bind().dialect.name == "postgresql"
    except Exception:  # noqa: BLE001
        return False


def _py_part(value) -> str:
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _store_key(kind: str, key: str) -> str:
    return f"scoresig:{kind}:{key}"


def input_signature(db, kind: str, key: str, params: dict, py_inputs) -> str | None:
    """计分输入的指纹（会先 flush，让本会话里未提交的对账 / 基线改动也算进去）。
    kind: "comp" | "board"。非 Postgres 或出错返回 None。
    Fingerprint of the scoring inputs (flushes first so this session's pending
    reconcile / baseline writes count). None off Postgres or on error."""
    if not _enabled(db):
        return None
    sql = _COMP_INPUT_SQL if kind == "comp" else _BOARD_INPUT_SQL
    try:
        db.flush()
        row = db.execute(text(sql), params).one()
    except Exception:  # noqa: BLE001 —— 算不出就当没有指纹，照常重算 / no fingerprint: recompute
        logger.debug("scoring input signature failed: %s %s", kind, key, exc_info=True)
        return None
    return "|".join([*(str(v) for v in row), _py_part(py_inputs)])


def snapshot_signature(db, key: str) -> str | None:
    """快照表本身（不含 computed_at）的指纹；调用前须已 flush 本会话的写入。
    Fingerprint of the snapshot rows themselves (computed_at excluded)."""
    if not _enabled(db):
        return None
    try:
        db.flush()
        return str(db.execute(text(_SNAPSHOT_SQL), {"key": key}).scalar())
    except Exception:  # noqa: BLE001
        logger.debug("snapshot signature failed: %s", key, exc_info=True)
        return None


def unchanged(db, kind: str, key: str, inputs: str | None,
              period_key: str | None = None) -> dict | None:
    """输入与快照都与上次重算时一致 → 返回上次记下的附加信息（dict），否则 None。
    `period_key` 是快照表里的键（比赛是 comp:<id>），缺省同 key。
    When both the inputs and the snapshot (rows under `period_key`, default `key`)
    match the last recompute, return the extra info stored with it; otherwise None."""
    if inputs is None:
        return None
    try:
        stored = shared_state.kv_get_json(_store_key(kind, key))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(stored, dict) or stored.get("inputs") != inputs:
        return None
    snap = snapshot_signature(db, period_key or key)
    if snap is None or stored.get("snapshot") != snap:
        return None
    return stored.get("extra") or {}


def remember(kind: str, key: str, inputs: str | None, snapshot: str | None,
             extra: dict | None = None) -> None:
    """重算并**提交之后**调用：记下这次的输入指纹与写完后的快照指纹。
    Call after the recompute has committed: store its input and snapshot fingerprints."""
    if inputs is None or snapshot is None:
        return
    try:
        shared_state.kv_set_json(_store_key(kind, key),
                                 {"inputs": inputs, "snapshot": snapshot, "extra": extra or {}},
                                 SIG_TTL_SECONDS)
    except Exception:  # noqa: BLE001
        logger.debug("scoring signature store failed: %s %s", kind, key, exc_info=True)


def forget(kind: str, key: str) -> None:
    try:
        shared_state.kv_delete(_store_key(kind, key))
    except Exception:  # noqa: BLE001
        pass
