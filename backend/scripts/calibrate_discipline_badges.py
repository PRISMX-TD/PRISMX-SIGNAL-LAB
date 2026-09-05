"""只读校准脚本：纪律分勋章（纪律标兵 7 天 / 纪律大师 30 天）的分数线该定多少。

背景 / Background
-----------------
两枚勋章的判定是「login="" 聚合行的每日纪律分连续 N 天 ≥ 分数线，且评分仓位数
≥ 门槛」，规则在 badges.DISCIPLINE_BADGE_RULES（2026-09-06 按生产数据定案：标兵
95 分 / 100 单、大师 100 分 / 300 单）。设计文档原来两枚都是 90 分且无仓位门槛，
那是按 2026-08-27 重定口径之前的分布定的；这个脚本就是重新校准用的：

  1. **快照分布**：读库里的 discipline_snapshots 聚合行（默认只看 08-27 之后的，
     那之前是旧口径），打印分位数、各分数线以上的占比；
  2. **达标人数试算**：对 90/95/100 三条线 × 两枚勋章各自的天数与仓位门槛，分别数
     有多少用户会拿到勋章。**复用 badges._discipline_streak 本身**，不另写判定；
  3. **--live**：不看快照，按当前口径给每个窗口内有信号单成交的用户**现算**一遍
     今天的分数（compute_discipline，与快照循环同一函数、不落库），看分布。快照
     还没积累够天数时靠这个。

分数线怎么定不是脚本的事——看完分布由产品拍板，然后改 DISCIPLINE_BADGE_RULES。
只读，不写库。

用法 / Usage
------------
从 backend/ 目录运行（Windows 本机记得 PYTHONUTF8=1）：
    python -m scripts.calibrate_discipline_badges                 # 快照分布 + 达标试算
    python -m scripts.calibrate_discipline_badges --since 2026-09-01
    python -m scripts.calibrate_discipline_badges --live          # 按当前口径现算今天的分
    python -m scripts.calibrate_discipline_badges --verbose       # 逐用户打印

Read-only calibration for the two discipline-streak badges. The 90-point line was
set against the pre-08-27 score distribution; the tech doc requires recalibration on
real data and it never happened. Prints the snapshot distribution, how many users
would qualify at 90/95/100 under each badge's day count and position gate
(reusing badges._discipline_streak),
and optionally a live recomputation of today's scores. Never writes.
"""
import argparse
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import distinct

from app.core.database import SessionLocal
from app.models import DisciplineSnapshot, MT5Account, Order, User
from app.services.discipline import compute_discipline
from app.services.gamification.badges import DISCIPLINE_BADGE_RULES, _discipline_streak
from app.services.settings_store import get_discipline_settings

# 08-27 重定口径：之前的快照分数不可比，默认从这天起看。
# Scores before the 2026-08-27 redefinition aren't comparable; default cutoff.
REDEFINED_ON = "2026-08-27"
THRESHOLDS = (90.0, 95.0, 100.0)


def percentiles(values: list[float]) -> dict[str, float]:
    """min / p25 / p50 / p75 / p90 / max。空列表返回空字典。"""
    if not values:
        return {}
    s = sorted(values)
    n = len(s)

    def at(q: float) -> float:
        i = min(n - 1, max(0, int(round(q * (n - 1)))))
        return s[i]

    return {"min": s[0], "p25": at(0.25), "p50": at(0.5), "p75": at(0.75), "p90": at(0.9), "max": s[-1]}


def summarize_scores(values: list[float]) -> dict:
    """分布摘要：样本数、分位数、各分数线以上的占比。纯函数，便于测试。"""
    n = len(values)
    return {
        "n": n,
        "percentiles": percentiles(values),
        "share_at_or_above": {
            t: (sum(1 for v in values if v >= t) / n if n else 0.0) for t in THRESHOLDS
        },
    }


def snapshot_rows(db, since: str):
    return (db.query(DisciplineSnapshot.user_id, DisciplineSnapshot.date, DisciplineSnapshot.total)
              .filter(DisciplineSnapshot.login == "", DisciplineSnapshot.date >= since)
              .order_by(DisciplineSnapshot.user_id, DisciplineSnapshot.date)
              .all())


def qualifying_users(db, user_ids: list[str]) -> dict[tuple[float, str], list[str]]:
    """每条分数线 × 每枚勋章（各自的天数与仓位门槛）下会拿到勋章的用户。
    走 badges._discipline_streak 本身。"""
    out: dict[tuple[float, str], list[str]] = defaultdict(list)
    for uid in user_ids:
        for t in THRESHOLDS:
            for bid, rule in DISCIPLINE_BADGE_RULES.items():
                if _discipline_streak(db, uid, rule["days"], t, rule["min_positions"]):
                    out[(t, bid)].append(uid)
    return out


def live_scores(db) -> dict[str, tuple[float | None, int]]:
    """按当前口径给窗口内有信号单成交的用户现算聚合行 (分数, 评分仓位数)（不落库）。
    候选集与 discipline.snapshot_all_discipline 同一条件。"""
    cfg = get_discipline_settings(db)
    cutoff = datetime.now(timezone.utc) - timedelta(days=int(cfg["window_days"]))
    user_ids = [
        r[0] for r in db.query(distinct(Order.user_id)).filter(
            Order.signal_id.isnot(None), Order.action == "ORDER",
            Order.status == "FILLED", Order.created_at >= cutoff,
        ).all()
    ]
    out: dict[str, tuple[float | None, int]] = {}
    for uid in user_ids:
        bound = [r[0] for r in db.query(MT5Account.login).filter(MT5Account.user_id == uid).all()]
        r = compute_discipline(db, uid, bound_logins=bound, login=None)
        out[uid] = (r["total"], int(r.get("positions") or 0))
    return out


def _print_summary(title: str, values: list[float]) -> None:
    s = summarize_scores(values)
    print(f"\n== {title}  样本 {s['n']}")
    if not s["n"]:
        print("   （没有数据）")
        return
    p = s["percentiles"]
    print("   分位数  min {min:.1f} | p25 {p25:.1f} | p50 {p50:.1f} | p75 {p75:.1f} | p90 {p90:.1f} | max {max:.1f}".format(**p))
    print("   分数线以上占比  " + "  ".join(f"≥{int(t)}: {v:5.1%}" for t, v in s["share_at_or_above"].items()))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--since", default=REDEFINED_ON, help=f"只看这天起的快照（默认 {REDEFINED_ON}，重定口径日）")
    ap.add_argument("--live", action="store_true", help="按当前口径现算今天的分数，不看快照")
    ap.add_argument("--verbose", action="store_true", help="逐用户打印")
    args = ap.parse_args(argv)

    db = SessionLocal()
    try:
        emails = dict(db.query(User.id, User.email).all())
        print("当前规则 DISCIPLINE_BADGE_RULES：" + "；".join(
            f"{bid} ≥{r['threshold']:g} 分连续 {r['days']} 天且 ≥{r['min_positions']} 单"
            for bid, r in DISCIPLINE_BADGE_RULES.items()))

        if args.live:
            scores = live_scores(db)
            _print_summary("现算：今天的聚合行纪律分（当前口径）", [v for v, _n in scores.values() if v is not None])
            unscored = [u for u, (v, _n) in scores.items() if v is None]
            print(f"   样本不足无法评分的用户：{len(unscored)}")
            for bid, r in DISCIPLINE_BADGE_RULES.items():
                eligible = sum(1 for v, n in scores.values() if v is not None and v >= r["threshold"] and n >= r["min_positions"])
                print(f"   按今天的分数与仓位数满足 {bid} 门槛（≥{r['threshold']:g} 分且 ≥{r['min_positions']} 单）的用户：{eligible}")
            if args.verbose:
                for uid, (v, n) in sorted(scores.items(), key=lambda kv: (kv[1][0] is None, -(kv[1][0] or 0))):
                    print(f"   {emails.get(uid, uid):40s} {'—' if v is None else f'{v:.1f}':>6}  评分仓位 {n}")
            return 0

        rows = snapshot_rows(db, args.since)
        per_user: dict[str, list[tuple[str, float | None]]] = defaultdict(list)
        for uid, d, total in rows:
            per_user[uid].append((d, total))
        scored = [t for _u, _d, t in rows if t is not None]
        _print_summary(f"快照：{args.since} 起的聚合行日分（{len(per_user)} 个用户，{len(rows)} 行）", scored)
        if rows:
            days = sorted({d for _u, d, _t in rows})
            print(f"   覆盖日期 {days[0]} → {days[-1]}（{len(days)} 天）")

        quals = qualifying_users(db, list(per_user))
        print("\n== 达标人数试算（复用 badges._discipline_streak，含各自的仓位门槛）")
        print("   分数线   纪律标兵（7 天 / ≥100 单）   纪律大师（30 天 / ≥300 单）")
        for t in THRESHOLDS:
            marks = "  ← " + " / ".join(bid for bid, r in DISCIPLINE_BADGE_RULES.items() if r["threshold"] == t) \
                if any(r["threshold"] == t for r in DISCIPLINE_BADGE_RULES.values()) else ""
            print(f"   ≥{int(t):<6} {len(quals[(t, 'discipline_90_7')]):>14} 人 {len(quals[(t, 'discipline_90_30')]):>22} 人{marks}")
        if not rows:
            print("\n   快照为空：纪律分快照循环每 6 小时写一次，或改用 --live 看当前口径的现算分布。")

        if args.verbose and per_user:
            print("\n== 逐用户")
            for uid, items in per_user.items():
                vals = [t for _d, t in items if t is not None]
                best = max(vals) if vals else None
                print(f"   {emails.get(uid, uid):40s} 天数 {len(items):3d}  "
                      f"最高 {'—' if best is None else f'{best:.1f}'}  "
                      f"均值 {'—' if not vals else f'{sum(vals) / len(vals):.1f}'}  "
                      + "  ".join(f"≥{int(t)}:{'标兵' if uid in quals[(t, 'discipline_90_7')] else '-'}"
                                  f"{'/大师' if uid in quals[(t, 'discipline_90_30')] else ''}"
                                  for t in THRESHOLDS))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
