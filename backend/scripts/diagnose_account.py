"""只读诊断：一个账户在各场比赛里的"时间线"——每场比赛的计分下界、基线，
以及该账户每一笔平仓的时刻，逐笔标出落进了哪几场比赛的窗口。

用来回答"为什么新比赛还没交易就有成绩 / 为什么两场比赛分数一样"这类问题：
成绩 = 落在 [max(开赛, 拍基线, 报名) , 结束) 内、整仓平掉且经核验的仓位盈亏
之和 ÷ 基线。两场比赛窗口重叠时同一笔平仓会同时计入两场，这是规则不是错；
但如果一笔明明平在新比赛开始之前却被算进去，就要看这里打印的时刻。

Read-only: an account's timeline across competitions. For each competition the
scoring lower bound and baseline; for each closed trade of the account the close
instant, flagged with which competition windows it falls into.

用法 / Usage（从 backend/ 目录）：
    python -m scripts.diagnose_account --login 100039
"""
import argparse
from datetime import datetime, timezone

from app.core.database import SessionLocal
from app.models import (ClosedTrade, Competition, CompetitionParticipant, MT5Account, Order,
                        PeriodBaseline, User)
from app.services.gamification.competitions import comp_period_key
from app.utils.timeutil import aware as _aware


def _fmt(dt) -> str:
    if dt is None:
        return "—"
    a = _aware(dt)
    return a.strftime("%Y-%m-%d %H:%M:%S UTC") + f"  (raw={dt!r}, tz={'naive' if dt.tzinfo is None else dt.tzinfo})"


def main() -> int:
    ap = argparse.ArgumentParser(description="账户在各场比赛中的时间线（只读）")
    ap.add_argument("--login", required=True, help="MT5 账户号")
    args = ap.parse_args()
    db = SessionLocal()
    try:
        accts = db.query(MT5Account).filter(MT5Account.login == args.login).all()
        if not accts:
            print(f"没有账户 {args.login}")
            return 1
        for a in accts:
            u = db.get(User, a.user_id)
            print(f"账户 {a.login}  user={u.email if u else a.user_id}  trade_mode={a.trade_mode}"
                  f"  balance={a.balance}  server={a.server}")
        uids = {a.user_id for a in accts}
        now = datetime.now(timezone.utc)
        print(f"现在 {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        print()

        parts = (db.query(CompetitionParticipant)
                   .filter(CompetitionParticipant.mt5_login == args.login,
                           CompetitionParticipant.user_id.in_(uids)).all())
        windows = []
        print("── 参赛的比赛 ──")
        for p in parts:
            c = db.get(Competition, p.competition_id)
            key = comp_period_key(c.id)
            b = (db.query(PeriodBaseline)
                   .filter(PeriodBaseline.period_key == key, PeriodBaseline.user_id == p.user_id,
                           PeriodBaseline.mt5_login == args.login).first())
            start, end = _aware(c.starts_at), _aware(c.ends_at)
            parts_lower = [start]
            if b is not None:
                parts_lower.append(_aware(b.taken_at))
            if p.scoring_from is not None:
                parts_lower.append(_aware(p.scoring_from))
            lower = max(parts_lower)
            windows.append((c, lower, end))
            print(f"「{c.name}」 status={c.status} track={c.track} metric={c.metric}")
            print(f"    开赛      {_fmt(c.starts_at)}")
            print(f"    结束      {_fmt(c.ends_at)}")
            print(f"    报名时刻  {_fmt(p.scoring_from)}   (scoring_from)")
            if b is None:
                print("    基线      ——未拍基线，此账户在这场比赛不会有成绩——")
            else:
                print(f"    基线      {b.baseline} (+adjust {b.adjust})  拍于 {_fmt(b.taken_at)}")
            print(f"    ⇒ 计分下界 {lower.strftime('%Y-%m-%d %H:%M:%S UTC')}  上界 {end.strftime('%Y-%m-%d %H:%M:%S UTC')}"
                  f"  disqualified={p.disqualified} final_rank={p.final_rank}")
            print()

        print("── 该账户的平仓腿（按时间）──")
        trades = (db.query(ClosedTrade)
                    .filter(ClosedTrade.mt5_login == args.login, ClosedTrade.user_id.in_(uids))
                    .order_by(ClosedTrade.closed_at).all())
        if not trades:
            print("  （没有任何平仓记录）")
        for t in trades:
            close = _aware(t.closed_at)
            hits = [c.name for c, lo, hi in windows if lo <= close < hi]
            print(f"  pos={t.position_ticket} deal={t.deal_ticket} {t.symbol} {t.side} vol={t.close_volume}"
                  f" profit={t.profit:+.2f} verified={t.verified}")
            print(f"      closed_at {_fmt(t.closed_at)}")
            print(f"      → 落入: {hits if hits else '（不在任何比赛窗口内）'}")
        print()

        print("── 该账户的成交单（open）──")
        orders = (db.query(Order)
                    .filter(Order.mt5_login == args.login, Order.user_id.in_(uids), Order.status == "FILLED")
                    .order_by(Order.created_at).all())
        for o in orders:
            print(f"  ticket={o.mt5_ticket} {o.symbol} {o.side} vol={o.volume} trade_mode={o.trade_mode}"
                  f" created_at {_fmt(o.created_at)}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
