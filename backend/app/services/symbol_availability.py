"""哪些券商组做不了哪些品种——从网关自己的拒单里学（2026-11-16 体验报告 H2）。

Make Capital 的 demo\\STD-USD 组没有比特币（见 2026-10-11 的排查）。网关在发单前就能认出
来，回 `MT_RET_ERR_NOTFOUND: 该账号所在组(demo\\STD-USD)没有开通 BTCUSD,无法下单`，但那是在
用户滑完确认之后；而且整句原样透给用户，组名、错误码都是他看不懂的东西。

这里做两件事：
  1. 把那句拒单换成一句人话（friendly_message），存进 orders.message；
  2. 按「组 × 品种」记下来（同一组的所有账号都一样），随账号列表下发 blockedSymbols，
     前端在下单票上提前说明并禁用下单——同组里任何一个人撞过一次，其余人就不必再撞。

来源是 orders 表本身：近 BLOCK_WINDOW_DAYS 天里被这类原因拒掉的单，按 mt5_login 连到
mt5_accounts.mt5_group。不加表、不加列；进程内缓存 CACHE_TTL_SECONDS 秒，新的拒单当场并入。
券商哪天给这个组开通了，窗口一过就自动放开（期间用户下单仍会走到网关，网关才是权威）。

Which broker groups can't trade which symbols, learned from the gateway's own
rejections (QA report H2). The raw rejection reached the user only after the swipe and
read as an error code plus a group name. This module rewrites it into plain words and
remembers group × symbol pairs (every account in a group behaves the same), shipped with
the account list as blockedSymbols so the ticket can warn and disable up front. Source of
truth is the orders table itself; cached in-process, merged on the spot for new rejections.
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import MT5Account, Order
from app.services.symbol_aliases import broker_symbol

# 网关 SymbolMissingResult 的文案与本模块改写后的文案共有的标记 / shared marker of both wordings
MISSING_MARKER = "没有开通"
BLOCK_WINDOW_DAYS = 30
CACHE_TTL_SECONDS = 600

# 网关原文：`[MT_RET_ERR_NOTFOUND: ]该账号所在组(demo\STD-USD)没有开通 BTCUSD,无法下单`
_GATEWAY_MISSING = re.compile(r"所在组\((?P<group>[^)]*)\)\s*没有开通\s*(?P<symbol>[A-Za-z0-9]+)")

_lock = threading.Lock()
_blocked: dict[str, set[str]] = {}
_loaded_at = 0.0


def canonical_symbol(symbol: str | None) -> str:
    """去后缀、换成券商叫法（BTCUSDT.s → BTCUSD），前端 baseSymbol 同一规则。"""
    base = re.split(r"[._\-#]", (symbol or "").strip().upper())[0]
    return broker_symbol(base) if base else ""


def _group_key(group: str | None) -> str:
    return (group or "").strip().lower()


def parse_gateway_missing(message: str | None) -> tuple[str, str] | None:
    """网关「组没有开通」拒单 → (组名, 品种)；不是这一类返回 None。"""
    m = _GATEWAY_MISSING.search(message or "")
    if not m:
        return None
    return m.group("group"), canonical_symbol(m.group("symbol"))


def friendly_message(symbol: str) -> str:
    """给用户看的那一句：不提组名、不带错误码，告诉他能做什么。"""
    return (
        f"你的账户类型没有开通 {symbol}，本次指令未发出。请换一个品种，或换一个支持该品种的账户 / "
        f"{symbol} isn't available for this account type, so nothing was sent. "
        f"Pick another symbol or an account that offers it."
    )


def note_blocked(group: str | None, symbol: str | None) -> None:
    """新的拒单当场并入缓存，不等下一次重读。"""
    g, s = _group_key(group), canonical_symbol(symbol)
    if not g or not s:
        return
    with _lock:
        _blocked.setdefault(g, set()).add(s)


def _reload(db: Session) -> None:
    global _blocked, _loaded_at
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=BLOCK_WINDOW_DAYS)
    rows = (
        db.query(MT5Account.mt5_group, Order.symbol)
        .join(MT5Account, MT5Account.login == Order.mt5_login)
        .filter(
            Order.status == "REJECTED",
            Order.created_at >= since,
            Order.message.like(f"%{MISSING_MARKER}%"),
            MT5Account.mt5_group.isnot(None),
        )
        .distinct()
        .all()
    )
    fresh: dict[str, set[str]] = {}
    for group, symbol in rows:
        g, s = _group_key(group), canonical_symbol(symbol)
        if g and s:
            fresh.setdefault(g, set()).add(s)
    with _lock:
        _blocked = fresh
        _loaded_at = time.monotonic()


def blocked_symbols(db: Session, group: str | None) -> list[str]:
    """这个组已知做不了的品种（券商基础名，排好序）。读失败只是不提示，绝不挡账号列表。"""
    global _loaded_at
    g = _group_key(group)
    if not g:
        return []
    if time.monotonic() - _loaded_at > CACHE_TTL_SECONDS:
        try:
            _reload(db)
        except Exception:  # noqa: BLE001 — 提示是锦上添花，读不到就当没有，过一个周期再试
            # 失败的语句会让 Postgres 事务进入 aborted 状态，调用方后面的查询都会跟着失败。
            # A failed statement aborts the Postgres transaction; roll back so the caller's
            # later queries still work.
            db.rollback()
            with _lock:
                _loaded_at = time.monotonic()
    with _lock:
        return sorted(_blocked.get(g, ()))


def reset_cache() -> None:
    """测试用 / for tests."""
    global _blocked, _loaded_at
    with _lock:
        _blocked = {}
        _loaded_at = 0.0
