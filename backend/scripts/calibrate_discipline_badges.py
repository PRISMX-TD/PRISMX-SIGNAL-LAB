"""只读校准脚本：纪律分勋章（纪律标兵 7 天 / 纪律大师 30 天）的分数线该定多少。

背景 / Background
-----------------
两枚勋章的判定是「login="" 聚合行的每日纪律分连续 N 天 ≥ 分数线」，分数线定在
90（badges.DISCIPLINE_BADGE_THRESHOLD）。这条线是按 2026-08-27 重定口径**之前**的
分数分布定的；重定之后分数整体上移，技术架构文档 §15 明确要求「开工前必须用真实
数据重新校准」，但三份实施计划都跳过了这一步。这个脚本就是那一步：

  1. **快照分布**：读库里的 discipline_snapshots 聚合行（默认只看 08-27 之后的，
     那之前是旧口径），打印分位数、各分数线以上的占比；
  2. **达标人数试算**：对 80/85/90/95 四条线 × 7/30 天，分别数有多少用户会拿到勋章。
     **复用 badges._discipline_streak 本身**（它现在接受 threshold 参数），不另写判定；
  3. **--live**：不看快照，按当前口径给每个窗口内有信号单成交的用户**现算**一遍
     今天的分数（compute_discipline，与快照循环同一函数、不落库），看分布。快照
     还没积累够天数时靠这个。

分数线怎么定不是脚本的事——看完分布由产品拍板，然后改 DISCIPLINE_BADGE_THRESHOLD。
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
would qualify at 80/85/90/95 for 7/30-day streaks (reusing badges._discipline_streak),
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
from app.services.gamification.badges import DISCIPLINE_BADGE_THRESHOLD, _discipline_streak
from app.services.settings_store import get_discipline_settings

# 08-27 重定口径：之前的快照分数不可比，默认从这天起看。
# Scores before the 2026-08-27 redefinition aren't comparable; default cutoff.
REDEFINED_ON = "2026-08-27"
THRESHOLDS = (80.0, 85.0, 90.0, 95.0)
STREAKS = (7, 30)


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


def qualifying_users(db, user_ids: list[str]) -> dict[tuple[float, int], list[str]]:
    """每条分数线 × 连续天数下会拿到勋章的用户。走 badges._discipline_streak 本身。"""
    out: dict[tuple[float, int], list[str]] = defaultdict(list)
    for uid in user_ids:
        for t in THRESHOLDS:
            for n in STREAKS:
                if _discipline_streak(db, uid, n, threshold=t):
                    out[(t, n)].append(uid)
    return out


def live_scores(db) -> dict[str, float | None]:
    """按当前口径给窗口内有信号单成交的用户现算聚合行分数（不落库）。
    候选集与 discipline.snapshot_all_discipline 同一条件。"""
    cfg = get_discipline_settings(db)
    cutoff = datetime.now(timezone.utc) - timedelta(days=int(cfg["window_days"]))
    user_ids = [
        r[0] for r in db.query(distinct(Order.user_id)).filter(
            Order.signal_id.isnot(None), Order.action == "ORDER",
            Order.status == "FILLED", Order.created_at >= cutoff,
        ).all()
    ]
    out: dict[str, float | None] = {}
    for uid in user_ids:
        bound = [r[0] for r in db.query(MT5Account.login).filter(MT5Account.user_id == uid).all()]
        out[uid] = compute_discipline(db, uid, bound_logins=bound, login=None)["total"]
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
        print(f"当前分数线 DISCIPLINE_BADGE_THRESHOLD = {DISCIPLINE_BADGE_THRESHOLD:g}")

        if args.live:
            scores = live_scores(db)
            _print_summary("现算：今天的聚合行纪律分（当前口径）", [v for v in scores.values() if v is not None])
            unscored = [u for u, v in scores.items() if v is None]
            print(f"   样本不足无法评分的用户：{len(unscored)}")
            if args.verbose:
                for uid, v in sorted(scores.items(), key=lambda kv: (kv[1] is None, -(kv[1] or 0))):
                    print(f"   {emails.get(uid, uid):40s} {'—' if v is None else f'{v:.1f}'}")
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
        print("\n== 达标人数试算（复用 badges._discipline_streak）")
        print("   分数线   连续 7 天（纪律标兵）   连续 30 天（纪律大师）")
        for t in THRESHOLDS:
            mark = "  ← 当前" if t == DISCIPLINE_BADGE_THRESHOLD else ""
            print(f"   ≥{int(t):<6} {len(quals[(t, 7)]):>10} 人 {len(quals[(t, 30)]):>18} 人{mark}")
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
                      + "  ".join(f"≥{int(t)}:{'7' if uid in quals[(t, 7)] else '-'}{'/30' if uid in quals[(t, 30)] else ''}"
                                  for t in THRESHOLDS))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
