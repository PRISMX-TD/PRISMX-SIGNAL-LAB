"""交易报告 + 交易人格：读、算、存（方案第 2、3、6、10 节）。

- 人格看最近 90 天，第一次解锁时算一次存进 persona_states，之后每月 1 号（UTC）存档时重算；
  落在缓冲带里的主轴沿用上次的字母。
- 月报按 UTC 自然月：当月实时算（不写点评），月初把上个月存档进 persona_reports（可选 AI 点评）。
- 只算实盘；没下过实盘单的人只拿到「开通实盘」的钩子，下过但不够数的拿到解锁进度。

Trading report + persona: read, compute, store. The persona covers the last 90 days, is computed at
first unlock and recomputed at each month-end archive (axes in their buffer keep the old letter).
Reports are UTC calendar months: the current one is live (no comment), past ones are archived.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from app.models import PersonaReport, PersonaState
from app.services.persona import engine
from app.services.persona.positions import (
    has_real_orders, load_positions, open_losing_positions, utcnow,
)

logger = logging.getLogger("prismx.persona")

TAGGED_TRADES_LIMIT = 60     # 报告里列出的带标签的单最多几笔 / tagged trades listed per report
REPORT_VERSION = 1           # report_json 的格式版本 / report_json format version


# ---------------------------------------------------------------- 月份 / months
def period_of(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m")


def month_bounds(period: str) -> tuple[datetime, datetime]:
    """'2026-11' → [2026-11-01 00:00Z, 2026-12-01 00:00Z)。"""
    y, m = (int(x) for x in period.split("-"))
    start = datetime(y, m, 1, tzinfo=timezone.utc)
    end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=timezone.utc)
    return start, end


def previous_period(period: str) -> str:
    start, _ = month_bounds(period)
    return period_of(start - timedelta(days=1))


def valid_period(period: str) -> bool:
    try:
        y, m = period.split("-")
        return len(y) == 4 and len(m) == 2 and 2020 <= int(y) <= 2100 and 1 <= int(m) <= 12
    except (ValueError, AttributeError):
        return False


# ---------------------------------------------------------------- 人格状态 / persona state
def _window(now: datetime) -> tuple[datetime, datetime]:
    return now - timedelta(days=engine.WINDOW_DAYS), now


def _state_dict(row: PersonaState) -> dict:
    try:
        axes = json.loads(row.axes_json or "{}")
    except ValueError:
        axes = {}
    return {
        "code": row.code,
        "family": engine.FAMILIES.get((row.code or "")[:2]),
        "positions": row.positions or 0,
        "provisional": bool(row.provisional),
        "axes": axes,
        "computedAt": row.computed_at.replace(tzinfo=timezone.utc).isoformat() if row.computed_at else None,
    }


def _save_state(db, user_id: str, persona: dict, now: datetime) -> PersonaState:
    row = db.query(PersonaState).filter(PersonaState.user_id == user_id).first()
    if row is None:
        row = PersonaState(user_id=user_id)
        db.add(row)
    row.code = persona["code"]
    row.axes_json = json.dumps(persona["axes"], ensure_ascii=False)
    row.positions = persona["positions"]
    row.provisional = persona["provisional"]
    row.computed_at = now.replace(tzinfo=None)
    return row


def status(db, user_id: str, now: datetime | None = None) -> dict:
    """人格页的头部状态：demo（没下过实盘）/ locked（进度）/ unlocked（人格）。第一次够条件时就地算一次存下。
    Header state: demo / locked (with progress) / unlocked (with persona). Computed and stored on first unlock."""
    now = now or utcnow()
    row = db.query(PersonaState).filter(PersonaState.user_id == user_id).first()
    if row is not None:
        return {"status": "unlocked", "persona": _state_dict(row)}
    if not has_real_orders(db, user_id):
        return {"status": "demo"}
    since, until = _window(now)
    positions = load_positions(db, user_id, since, until)
    progress = engine.unlock_status(positions)
    if not progress["unlocked"]:
        return {"status": "locked", "progress": progress}
    persona = engine.compute_persona(positions)
    row = _save_state(db, user_id, persona, now)
    db.commit()
    return {"status": "unlocked", "persona": _state_dict(row)}


# ---------------------------------------------------------------- 月报 / monthly report
def _tagged_trades(positions, tags) -> list[dict]:
    rows = []
    for p in sorted(positions, key=lambda q: q.close_at, reverse=True):
        t = tags.get((p.login, p.ticket)) or []
        if not t:
            continue
        rows.append({
            "symbol": p.symbol, "side": p.side, "volume": p.volume,
            "openAt": p.open_at.isoformat(), "closeAt": p.close_at.isoformat(),
            "profit": round(p.profit, 2), "unrealized": p.unrealized, "tags": t,
        })
        if len(rows) >= TAGGED_TRADES_LIMIT:
            break
    return rows


def build_report(db, user_id: str, period: str, now: datetime, persona: dict | None,
                 extra_positions=None, window_positions=None) -> dict:
    """一个月的报告（不含点评）。extra_positions：存档时补进来的浮亏持仓。
    One month's report (no comment). extra_positions: floating losers added at archive time."""
    start, end = month_bounds(period)
    until = min(end, now)
    month = load_positions(db, user_id, start, until) if until > start else []
    month = month + list(extra_positions or [])
    if window_positions is None:
        since, wuntil = _window(until)
        window_positions = load_positions(db, user_id, since, wuntil)
    tags = engine.trade_tags(month, reference=window_positions or month)
    prev = (db.query(PersonaReport)
              .filter(PersonaReport.user_id == user_id, PersonaReport.period == previous_period(period))
              .first())
    change = None
    if prev is not None and persona and prev.code != persona.get("code"):
        change = {"from": prev.code, "to": persona.get("code")}
    return {
        "version": REPORT_VERSION,
        "period": period,
        "live": now < end,
        "asOf": until.isoformat(),
        "persona": persona,
        "summary": engine.summary(month),
        "calendar": engine.calendar(month),
        "breakdowns": engine.breakdowns(month),
        "tags": engine.tag_summary(month, tags),
        "taggedTrades": _tagged_trades(month, tags),
        "badges": engine.badges(month, window_positions),
        "openLosers": sum(1 for p in month if p.unrealized),
        "change": change,
        "previousCode": prev.code if prev is not None else None,
    }


def report_out(row: PersonaReport) -> dict:
    try:
        rep = json.loads(row.report_json or "{}")
    except ValueError:
        rep = {}
    comment = None
    if row.ai_comment_json:
        try:
            comment = json.loads(row.ai_comment_json)
        except ValueError:
            comment = None
    rep["comment"] = comment
    rep["archivedAt"] = row.archived_at.replace(tzinfo=timezone.utc).isoformat() if row.archived_at else None
    return rep


def months(db, user_id: str, now: datetime | None = None) -> list[str]:
    """能看的月份：当月 + 已存档的月份，新的在前。/ Current month plus archived ones, newest first."""
    now = now or utcnow()
    archived = [p for (p,) in db.query(PersonaReport.period)
                                  .filter(PersonaReport.user_id == user_id).all()]
    out = {period_of(now), *archived}
    return sorted(out, reverse=True)


def report_for(db, user_id: str, period: str, now: datetime | None = None) -> dict | None:
    """某个月的报告：存档过的读存档；当月实时算；更早又没存档的返回 None。
    Archived months come from the archive, the current month is computed live, other months are None."""
    now = now or utcnow()
    row = (db.query(PersonaReport)
             .filter(PersonaReport.user_id == user_id, PersonaReport.period == period).first())
    if row is not None:
        return report_out(row)
    if period != period_of(now):
        return None
    st = db.query(PersonaState).filter(PersonaState.user_id == user_id).first()
    persona = _state_dict(st) if st else None
    rep = build_report(db, user_id, period, now, persona)
    rep["comment"] = None
    rep["archivedAt"] = None
    return rep


# ---------------------------------------------------------------- 月底存档 / month-end archive
def archive_user(db, user_id: str, period: str, now: datetime, open_rows=None,
                 ai_enabled: bool = False) -> PersonaReport | None:
    """把 period 那个月存档，并用最近 90 天重算人格。没解锁的人不存档。已存过的直接返回。
    Archive `period` and recompute the persona over the last 90 days. Skips users who aren't unlocked."""
    existing = (db.query(PersonaReport)
                  .filter(PersonaReport.user_id == user_id, PersonaReport.period == period).first())
    if existing is not None:
        return existing
    _, end = month_bounds(period)
    cut = min(end, now)
    losers = open_losing_positions(db, user_id, open_rows or [], cut) if open_rows else []
    since, until = _window(cut)
    window = load_positions(db, user_id, since, until) + losers
    state = db.query(PersonaState).filter(PersonaState.user_id == user_id).first()
    progress = engine.unlock_status(window)
    if state is None and not progress["unlocked"]:
        return None
    if progress["unlocked"]:
        persona = engine.compute_persona(window, previous_code=state.code if state else None)
        state = _save_state(db, user_id, persona, now)
        db.flush()
    persona_d = _state_dict(state)
    rep = build_report(db, user_id, period, cut, persona_d, extra_positions=losers, window_positions=window)
    rep["live"] = False
    row = PersonaReport(user_id=user_id, period=period, code=persona_d["code"],
                        report_json=json.dumps(rep, ensure_ascii=False), ai_status="off",
                        archived_at=now.replace(tzinfo=None))
    if ai_enabled and rep["summary"]["trades"]:
        from app.services.persona import ai_comment
        comment, model = ai_comment.generate(rep)
        row.ai_model = model
        row.ai_status = "ok" if comment else "failed"
        row.ai_comment_json = json.dumps(comment, ensure_ascii=False) if comment else None
    db.add(row)
    db.commit()
    return row


def candidate_users(db, period: str) -> list[str]:
    """要存档的人：那个月或之前 90 天里有实盘成交的，加上已经有人格的。
    Users to archive: real-account activity in the window, plus everyone with a persona."""
    from app.models import Order
    from app.services.gamification.stats import REAL
    start, end = month_bounds(period)
    since = (end - timedelta(days=engine.WINDOW_DAYS + 60)).replace(tzinfo=None)
    ids = {u for (u,) in db.query(Order.user_id).filter(
        Order.trade_mode == REAL, Order.created_at >= since, Order.created_at < end.replace(tzinfo=None),
    ).distinct().all()}
    ids |= {u for (u,) in db.query(PersonaState.user_id).all()}
    return sorted(i for i in ids if i)
