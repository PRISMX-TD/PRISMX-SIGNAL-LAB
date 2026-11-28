"""交易报告的附加内容（2026-11-28，rev 58）：周小结、纪律连续记录、本月目标 + 目标人格、
同人格对比、模拟盘预览人格、推荐官的客户看板。

- 周小结、连续记录只挂在**当月实时报告**上，用的是报告已经读出来的最近 90 天的单，不另外查库。
- 本月目标是用户设一次、一直沿用到改掉的（persona_prefs 一行）；当月报告现算达标情况，月底存档时
  把结果写进那个月的存档。
- 同人格对比用 persona_states 里存着的四个主轴数值，同代号不足 PEERS_MIN 人就退到同家族，再不足就不给。
- 模拟盘预览只算人格、不落库、不出月报；页面和分享卡都要标明是模拟盘预览。
- 客户看板只读已经存好的东西（人格、最近两个月的存档评分、最后一次实盘下单时间），不现算报告。

Add-ons to the trading report: weekly digest, discipline streaks, standing monthly goals with a target
persona, same-persona comparison, the demo persona preview and the ambassador customer board.
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime, timedelta, timezone

from app.models import Order, PersonaPref, PersonaReport, PersonaState, User
from app.services import shared_cache
from app.services.persona import engine
from app.services.persona.positions import DEMO, load_positions

PEERS_MIN = 20               # 同人格（或同家族）至少这么多人才给对比 / minimum group size for the comparison
PEERS_CACHE_SECONDS = 3600
BOARD_MAX_CLIENTS = 2000
BOARD_INACTIVE_DAYS = 30     # 这么多天没下实盘单算「没交易了」/ no real order for this long = inactive
BOARD_DROP_POINTS = 10       # 评分比上个月掉这么多算「掉得厉害」/ score drop that counts as sharp


# ---------------------------------------------------------------- 周小结 / weekly digest
def weeks(window_positions, now: datetime) -> list[dict]:
    """本周和上周（周一到周日，UTC）。标签的口径和月报一样，用最近 90 天做参照。
    This week and last week (Monday–Sunday UTC), tagged against the 90-day window like the monthly report."""
    tags = engine.trade_tags(window_positions)
    this = engine.week_start(now)
    out = []
    for i, start in enumerate((this, this - timedelta(days=7))):
        d = engine.week_digest(window_positions, tags, start, start + timedelta(days=7))
        d["current"] = i == 0
        out.append(d)
    return out


def streaks(window_positions, now: datetime) -> list[dict]:
    return engine.streaks(window_positions, engine.trade_tags(window_positions), now)


# ---------------------------------------------------------------- 用户自设 / user prefs
def pref_row(db, user_id: str, create: bool = False) -> PersonaPref | None:
    row = db.query(PersonaPref).filter(PersonaPref.user_id == user_id).first()
    if row is None and create:
        row = PersonaPref(user_id=user_id, loss_enabled=False)
        db.add(row)
        db.flush()           # 会话关着 autoflush：不落一下，同一事务里再查一次会再建一行 / sessions run without autoflush
    return row


def _goals_of(row: PersonaPref | None) -> list[dict]:
    if row is None or not row.goals_json:
        return []
    try:
        data = json.loads(row.goals_json)
    except ValueError:
        return []
    return [g for g in data if isinstance(g, dict) and g.get("key") in engine.GOAL_METRICS] if isinstance(data, list) else []


def clean_goals(goals) -> list[dict]:
    """校验用户提交的目标：键在清单里、数值在范围内、不重复、最多 GOALS_MAX 条。不合规的抛 ValueError。
    Validate submitted goals; raises ValueError on anything out of the menu or range."""
    out: list[dict] = []
    seen = set()
    for g in goals or []:
        key = g.get("key")
        if key not in engine.GOAL_METRICS or key in seen:
            raise ValueError("unknown or repeated goal")
        _, lo, hi = engine.GOAL_METRICS[key]
        try:
            target = float(g.get("target"))
        except (TypeError, ValueError):
            raise ValueError("goal target must be a number") from None
        if target != target or not (lo <= target <= hi):
            raise ValueError("goal target out of range")
        if key not in ("winRate", "payoff"):
            target = round(target) if key != "maxDrawdown" else round(target, 2)
        else:
            target = round(target, 3)
        seen.add(key)
        out.append({"key": key, "target": target})
    if len(out) > engine.GOALS_MAX:
        raise ValueError("too many goals")
    return out


def save_goals(db, user_id: str, goals: list[dict], target_code: str | None, now: datetime) -> None:
    row = pref_row(db, user_id, create=True)
    row.goals_json = json.dumps(goals) if goals else None
    row.target_code = target_code if target_code in engine.CODES else None
    row.goals_set_at = now.replace(tzinfo=None)


def goal_block(db, user_id: str, report: dict, axes: dict | None) -> dict | None:
    """当月（或存档那一刻）的目标达标情况；什么都没设返回 None。axes：用来对目标人格的四个主轴。
    The goals' standing for a report; None when nothing is set. axes: the persona axes for the target."""
    row = pref_row(db, user_id)
    goals = _goals_of(row)
    target = row.target_code if row is not None else None
    if not goals and target not in engine.CODES:
        return None
    return {
        "goals": engine.evaluate_goals(goals, report),
        "target": engine.target_progress(target, axes),
        "setAt": row.goals_set_at.replace(tzinfo=timezone.utc).isoformat() if row.goals_set_at else None,
    }


# ---------------------------------------------------------------- 同人格对比 / same-persona comparison
_PEER_FIELDS = (("medianHoldMin", "tempo", "medianHoldMin"), ("perDay", "tempo", "perDay"),
                ("payoff", "risk", "payoff"), ("holdRatio", "risk", "holdRatio"),
                ("signalShare", "judge", "share"), ("manageShare", "manage", "share"))


def _peer_table(db) -> dict:
    groups: dict = {}
    for code, raw in db.query(PersonaState.code, PersonaState.axes_json).all():
        try:
            axes = json.loads(raw or "{}") or {}
        except ValueError:
            continue
        for key in (code, (code or "")[:2]):
            g = groups.setdefault(key, {"count": 0, "vals": {f[0]: [] for f in _PEER_FIELDS}})
            g["count"] += 1
            for name, axis, field in _PEER_FIELDS:
                v = (axes.get(axis) or {}).get(field)
                if isinstance(v, (int, float)):
                    g["vals"][name].append(float(v))
    return {k: {"count": g["count"],
                "medians": {n: (round(statistics.median(v), 3) if v else None) for n, v in g["vals"].items()}}
            for k, g in groups.items() if g["count"] >= PEERS_MIN}


def peers(db, code: str | None) -> dict | None:
    """同代号的人的中位数；不足 PEERS_MIN 人退到同家族（前两个字母），再不足返回 None。
    Medians over users sharing the code, else the family (first two letters), else None."""
    if code not in engine.CODES:
        return None
    table = shared_cache.cached_json("persona:peers", PEERS_CACHE_SECONDS, lambda: _peer_table(db)) or {}
    for scope, key in (("code", code), ("family", code[:2])):
        g = table.get(key)
        if g:
            return {"scope": scope, "key": key, "family": engine.FAMILIES[code[:2]], "count": g["count"],
                    "medians": g["medians"]}
    return None


# ---------------------------------------------------------------- 模拟盘预览 / demo preview
def demo_preview(db, user_id: str, now: datetime) -> dict:
    """用模拟盘的单按同一套规则算一个人格，只给看、不落库。不够条件时给模拟盘上的进度。
    A persona from demo-account trades under the same rules, shown but never stored."""
    ps = load_positions(db, user_id, now - timedelta(days=engine.WINDOW_DAYS), now, modes=(DEMO,))
    progress = engine.unlock_status(ps)
    if not progress["unlocked"]:
        return {"unlocked": False, "progress": progress}
    persona = engine.compute_persona(ps)
    return {"unlocked": True, "persona": {**persona, "computedAt": now.isoformat()}}


# ---------------------------------------------------------------- 推荐官客户看板 / ambassador board
def agent_board(db, agent_user_id: str, now: datetime) -> dict:
    """直属客户的汇总：各人格几个、谁没交易了、谁的评分掉得厉害。只读存好的数据。
    Summary of direct customers: persona mix, who went quiet, whose score dropped. Stored data only."""
    clients = (db.query(User.id, User.email, User.nickname)
                 .filter(User.agent_user_id == agent_user_id).limit(BOARD_MAX_CLIENTS).all())
    ids = [c.id for c in clients]
    if not ids:
        return {"total": 0, "withPersona": 0, "families": {}, "codes": {}, "inactive": 0, "dropped": 0, "clients": []}
    states = {u: code for u, code in db.query(PersonaState.user_id, PersonaState.code)
                                         .filter(PersonaState.user_id.in_(ids)).all()}
    scores: dict = {}
    reps = (db.query(PersonaReport.user_id, PersonaReport.period, PersonaReport.report_json)
              .filter(PersonaReport.user_id.in_(ids)).order_by(PersonaReport.period.desc()).all())
    for uid, period, raw in reps:
        got = scores.setdefault(uid, [])
        if len(got) >= 2:
            continue
        try:
            sm = (json.loads(raw or "{}") or {}).get("summary") or {}
        except ValueError:
            sm = {}
        got.append({"period": period, "score": sm.get("score"), "trades": sm.get("trades") or 0})
    from sqlalchemy import func
    from app.services.gamification.stats import REAL
    last = dict(db.query(Order.user_id, func.max(Order.created_at))
                  .filter(Order.user_id.in_(ids), Order.trade_mode == REAL, Order.action.in_(["ORDER", "PENDING"]))
                  .group_by(Order.user_id).all())
    rows = []
    families: dict = {}
    codes: dict = {}
    inactive = dropped = 0
    for c in clients:
        code = states.get(c.id)
        sc = scores.get(c.id) or []
        latest = sc[0] if sc else None
        prev = sc[1] if len(sc) > 1 else None
        delta = None
        if latest and prev and latest["score"] is not None and prev["score"] is not None:
            delta = latest["score"] - prev["score"]
        last_at = last.get(c.id)
        idle = (now.replace(tzinfo=None) - last_at).days if last_at else None
        is_inactive = last_at is not None and idle >= BOARD_INACTIVE_DAYS
        is_dropped = delta is not None and delta <= -BOARD_DROP_POINTS
        if code:
            fam = engine.FAMILIES.get(code[:2])
            families[fam] = families.get(fam, 0) + 1
            codes[code] = codes.get(code, 0) + 1
        inactive += is_inactive
        dropped += is_dropped
        rows.append({
            "email": c.email, "nickname": c.nickname, "code": code,
            "family": engine.FAMILIES.get(code[:2]) if code else None,
            "period": latest["period"] if latest else None,
            "score": latest["score"] if latest else None,
            "scoreDelta": delta,
            "trades": latest["trades"] if latest else None,
            "lastTradeAt": last_at.replace(tzinfo=timezone.utc).isoformat() if last_at else None,
            "idleDays": idle, "inactive": is_inactive, "dropped": is_dropped,
        })
    # 要先联系的排前面：评分掉得厉害的、没交易了的，然后按最近交易时间
    # Who to contact first: sharp drops, then the quiet ones, then by last trade.
    rows.sort(key=lambda r: (not r["dropped"], not r["inactive"], -(r["idleDays"] or 0) if r["inactive"] else 0,
                             r["lastTradeAt"] is None, r["email"] or ""))
    return {"total": len(rows), "withPersona": len(states), "families": families, "codes": codes,
            "inactive": inactive, "dropped": dropped, "inactiveDays": BOARD_INACTIVE_DAYS,
            "dropPoints": BOARD_DROP_POINTS, "clients": rows}
