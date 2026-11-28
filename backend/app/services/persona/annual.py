"""年度交易报告（2026-11-28，rev 58）。

- 一年一份，按 UTC 自然年；12 月的月报存完之后（1 月 1 号）由存档循环生成并存进 persona_annual_reports，
  之后不再改。平台 2026 年 7 月才开始有数据，所以 2026 年那份只覆盖下半年，报告里带着实际覆盖的月份。
- 全年成绩、日历、分类报表是用**这一年里平仓的单**重新算的（不是把十二份月报加起来：月报月底会把浮亏单
  按亏损计一次，下个月真平仓又算一次，直接相加会重复）。逐月的评分、人格、徽章取自各月存档，
  和用户当时看到的一致；某个月没有存档就用那个月的单现算。
- 管理员可以随时预览今年到目前为止的那份（live = true），普通用户只看得到存好的。

The annual trading report: one per UTC year, generated after December's monthly archive completes.
Year totals come from the positions closed in that year (not the sum of monthly archives, which count
month-end floating losers once and their real close again); the month-by-month scores, personas and
badges come from the monthly archives. Admins may preview the running year live.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone

from app.models import PersonaAnnualReport, PersonaReport, PersonaState
from app.services.persona import engine, service
from app.services.persona.positions import load_positions

ANNUAL_VERSION = 1
HALF_MIN_TRADES = 10         # 上下半段各至少这么多笔才比较 / each half needs this many trades to compare


def year_bounds(year: int) -> tuple[datetime, datetime]:
    return datetime(year, 1, 1, tzinfo=timezone.utc), datetime(year + 1, 1, 1, tzinfo=timezone.utc)


def valid_year(year: int) -> bool:
    return 2020 <= year <= 2100


def _archives(db, user_id: str, year: int) -> dict:
    rows = (db.query(PersonaReport.period, PersonaReport.code, PersonaReport.report_json)
              .filter(PersonaReport.user_id == user_id, PersonaReport.period.like(f"{year}-%")).all())
    out = {}
    for period, code, raw in rows:
        try:
            rep = json.loads(raw or "{}") or {}
        except ValueError:
            rep = {}
        out[period] = {"code": code, "summary": rep.get("summary") or {}, "badges": rep.get("badges") or []}
    return out


def _run_lengths(ps) -> tuple[int, int]:
    """按平仓顺序的最长连胜、最长连亏。/ Longest winning and losing runs in close order."""
    best_w = best_l = w = l = 0
    for p in sorted(ps, key=lambda q: q.close_at):
        if p.is_win:
            w, l = w + 1, 0
        else:
            w, l = 0, l + 1
        best_w, best_l = max(best_w, w), max(best_l, l)
    return best_w, best_l


def _half(ps, tags) -> dict:
    sm = engine.summary(ps)
    n = len(ps)
    counts = Counter(t for p in ps for t in tags.get((p.login, p.ticket), []))
    return {"trades": n, "winRate": sm["winRate"], "payoff": sm["payoff"], "score": sm["score"],
            "profit": sm["profit"],
            "tagRates": {t: round(counts.get(t, 0) / n, 4) if n else None for t in engine.TAGS}}


def build_annual(db, user_id: str, year: int, now: datetime) -> dict | None:
    """一份年度报告；这一年既没有平仓的单也没有月报存档就返回 None。
    One annual report; None when the year has neither closed positions nor monthly archives."""
    start, end = year_bounds(year)
    until = min(end, now)
    ps = load_positions(db, user_id, start, until) if until > start else []
    arch = _archives(db, user_id, year)
    if not ps and not arch:
        return None
    tags = engine.trade_tags(ps)
    by_month: dict = {}
    for p in ps:
        by_month.setdefault(service.period_of(p.close_at), []).append(p)
    monthly = []
    for m in range(1, 13):
        period = f"{year}-{m:02d}"
        a = arch.get(period)
        mine = by_month.get(period, [])
        if not a and not mine:
            continue
        sm = engine.summary(mine)
        asm = (a or {}).get("summary") or {}
        monthly.append({
            "period": period, "trades": sm["trades"], "profit": sm["profit"], "winRate": sm["winRate"],
            # 评分用存档里的（和当时月报一致），没存档的月份用现算的 / archived score when there is one
            "score": asm.get("score") if asm.get("score") is not None else sm["score"],
            "code": (a or {}).get("code"), "badges": (a or {}).get("badges") or [],
        })
    journey = [{"period": r["period"], "code": r["code"]} for r in monthly if r["code"]]
    code_counts = Counter(j["code"] for j in journey)
    changes = sum(1 for a, b in zip(journey, journey[1:]) if a["code"] != b["code"])
    state = db.query(PersonaState).filter(PersonaState.user_id == user_id).first()
    closed = [p for p in ps if not p.unrealized]
    days = engine.calendar(ps)
    traded = [r for r in monthly if r["trades"]]
    best = max(closed, key=lambda p: p.profit) if closed else None
    worst = min(closed, key=lambda p: p.profit) if closed else None
    longest = max(closed, key=lambda p: p.hold_seconds) if closed else None
    win_run, loss_run = _run_lengths(closed)
    br = engine.breakdowns(ps)

    def top(rows, key="trades"):
        rows = [r for r in rows if r["trades"]]
        return max(rows, key=lambda r: r[key]) if rows else None

    # 前半段和后半段（按有成交的月份对半分）对比：看这一年是进步了还是退步了
    # First half against second half of the traded months: did the year get better or worse.
    halves = None
    periods = [r["period"] for r in traded]
    if len(periods) >= 2:
        cut = periods[(len(periods) + 1) // 2 - 1]
        first = [p for p in closed if service.period_of(p.close_at) <= cut]
        second = [p for p in closed if service.period_of(p.close_at) > cut]
        if len(first) >= HALF_MIN_TRADES and len(second) >= HALF_MIN_TRADES:
            halves = {"split": cut, "first": _half(first, tags), "second": _half(second, tags)}
    return {
        "version": ANNUAL_VERSION,
        "year": year,
        "live": now < end,
        "asOf": until.isoformat(),
        "months": [r["period"] for r in monthly],
        "firstTradeAt": min(p.open_at for p in closed).isoformat() if closed else None,
        "persona": service._state_dict(state) if state else None,
        "summary": engine.summary(ps),
        "calendar": days,
        "monthly": monthly,
        "journey": {"steps": journey, "distinct": len(code_counts), "changes": changes,
                    "mostCommon": code_counts.most_common(1)[0][0] if code_counts else None},
        "breakdowns": br,
        "tags": engine.tag_summary(ps, tags),
        "badges": dict(Counter(b for r in monthly for b in r["badges"])),
        "streaks": [{"key": s["key"], "unit": s["unit"], "best": s["best"]} for s in engine.streaks(ps, tags, until)],
        "halves": halves,
        "records": {
            "bestTrade": service._trade_ref(best) if best is not None and best.profit > 0 else None,
            "worstTrade": service._trade_ref(worst) if worst is not None and worst.profit < 0 else None,
            "longestHold": ({**service._trade_ref(longest), "holdMin": round(longest.hold_seconds / 60.0, 1)}
                            if longest is not None else None),
            "bestDay": max(days, key=lambda d: d["profit"]) if days else None,
            "worstDay": min(days, key=lambda d: d["profit"]) if days else None,
            "busiestDay": max(days, key=lambda d: d["trades"]) if days else None,
            "bestMonth": max(traded, key=lambda r: r["profit"])["period"] if traded else None,
            "worstMonth": min(traded, key=lambda r: r["profit"])["period"] if traded else None,
            "winRun": win_run, "lossRun": loss_run,
            "topSymbol": top(br["symbol"]),
            "bestSymbol": top(br["symbol"], "profit"),
            "topSession": top(br["session"]),
            "topWeekday": top(br["weekday"]),
            "holdHours": round(sum(p.hold_seconds for p in closed) / 3600.0, 1),
        },
    }


def _out(row: PersonaAnnualReport) -> dict:
    try:
        rep = json.loads(row.report_json or "{}")
    except ValueError:
        rep = {}
    rep["archivedAt"] = row.archived_at.replace(tzinfo=timezone.utc).isoformat() if row.archived_at else None
    return rep


def years(db, user_id: str) -> list[int]:
    return sorted((y for (y,) in db.query(PersonaAnnualReport.year)
                   .filter(PersonaAnnualReport.user_id == user_id).all()), reverse=True)


def annual_for(db, user_id: str, year: int, now: datetime, allow_live: bool = False) -> dict | None:
    """存好的那一份；没有的话，allow_live（管理员预览）时现算今年的。
    The stored report; with allow_live (admin preview) the running year is computed instead."""
    row = (db.query(PersonaAnnualReport)
             .filter(PersonaAnnualReport.user_id == user_id, PersonaAnnualReport.year == year).first())
    if row is not None:
        return _out(row)
    if not allow_live or year != now.year:
        return None
    rep = build_annual(db, user_id, year, now)
    if rep is not None:
        rep["archivedAt"] = None
    return rep


def archive_annual(db, user_id: str, year: int, now: datetime) -> PersonaAnnualReport | None:
    """存一个人的年度报告。已经存过直接返回；这一年没有成交的不存。
    Store one user's annual report; idempotent, skipped for a year without trades."""
    existing = (db.query(PersonaAnnualReport)
                  .filter(PersonaAnnualReport.user_id == user_id, PersonaAnnualReport.year == year).first())
    if existing is not None:
        return existing
    _, end = year_bounds(year)
    rep = build_annual(db, user_id, year, min(end, now))
    if rep is None or not rep["summary"]["trades"]:
        return None
    rep["live"] = False
    row = PersonaAnnualReport(user_id=user_id, year=year, report_json=json.dumps(rep, ensure_ascii=False),
                              archived_at=now.replace(tzinfo=None))
    db.add(row)
    db.commit()
    return row


def candidate_users(db, year: int) -> list[str]:
    """这一年有月报存档的人。/ Users with a monthly archive in the year."""
    return sorted({u for (u,) in db.query(PersonaReport.user_id)
                   .filter(PersonaReport.period.like(f"{year}-%")).distinct().all() if u})
