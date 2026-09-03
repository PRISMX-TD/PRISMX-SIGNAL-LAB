"""一次性维护脚本：追认 rev 6 之前的平仓记录（verified IS NULL）。

背景 / Background
-----------------
`closed_trades.verified` 是 2026-08-27（rev 6）才加的列，之前入库的平仓明细一律
NULL。游戏化统计引擎只认 `verified IS TRUE`（见 services/gamification/stats.py），
所以这批历史数据对等级条件、勋章、排行榜、比赛全部不可见。

但归属校验所需的两边数据都还在：开仓订单在 `orders`，平仓腿在 `closed_trades`。
把同一条规则补量到这批老数据上，就能把它们纳入统计——这不是放宽标准，是把同一把
尺子量到之前没量过的地方。

规则来源刻意复用 `routers.bridge._known_position_ids`（落库时用的同一个函数），
而不是在这里重写一遍：将来那条规则若有调整，本脚本自动跟随，不会产生第二套口径。

匹配上的标 True；对不上的**保持 NULL**，不写 False——它们是「从未校验过」而不是
「校验失败」，且两者对统计引擎的效果相同（都被排除），保留 NULL 便于将来补齐缺失的
开仓订单后重跑。

用法 / Usage
------------
从 backend/ 目录运行：

    python -m scripts.backfill_verified            # 只读预演，打印将要追认的条数
    python -m scripts.backfill_verified --apply    # 确认无误后写库

可重复运行：已是 True 的行不在处理范围内，重跑只会重新检查仍为 NULL 的部分。
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict

from app.core.database import SessionLocal
from app.models import ClosedTrade
from app.routers.bridge import _known_position_ids


def main() -> int:
    parser = argparse.ArgumentParser(description="追认 verified IS NULL 的历史平仓记录")
    parser.add_argument(
        "--apply", action="store_true",
        help="真的写库；不加此参数只做只读预演 / actually write, otherwise dry-run",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        before_true = db.query(ClosedTrade).filter(ClosedTrade.verified.is_(True)).count()
        before_false = db.query(ClosedTrade).filter(ClosedTrade.verified.is_(False)).count()
        pending = db.query(ClosedTrade).filter(ClosedTrade.verified.is_(None)).all()

        print(f"当前: verified=True {before_true} 条 / False {before_false} 条 / "
              f"NULL {len(pending)} 条")
        if not pending:
            print("没有待追认的记录。")
            return 0

        by_user: dict[str, list[ClosedTrade]] = defaultdict(list)
        for row in pending:
            by_user[row.user_id].append(row)

        total_match = total_miss = 0
        print("\n逐用户明细:")
        for uid, legs in sorted(by_user.items(), key=lambda kv: -len(kv[1])):
            logins = {str(leg.mt5_login) for leg in legs}
            known = _known_position_ids(db, uid, logins)
            matched = [
                leg for leg in legs
                if (str(leg.mt5_login), int(leg.position_ticket)) in known
            ]
            miss = len(legs) - len(matched)
            total_match += len(matched)
            total_miss += miss
            print(f"  {uid[:8]}  {len(legs):5d} 条 → 可追认 {len(matched):5d} / "
                  f"对不上 {miss:5d}")
            if args.apply:
                for leg in matched:
                    leg.verified = True

        print(f"\n合计: 可追认 {total_match} 条 / 对不上 {total_miss} 条")
        print("对不上的是无法匹配到平台开仓订单的平仓——多为账户上的场外手动交易，"
              "本就应当排除。")

        if args.apply:
            db.commit()
            after_true = before_true + total_match
            print(f"\n已写库: {total_match} 条标记为 verified=True（对不上的保持 NULL）。")
            print(f"统计引擎可见的平仓记录: {before_true} → {after_true} 条")
            print("下一轮每小时循环（或用户打开成就页）会用这批数据重新判定等级与勋章。")
        else:
            print("\n（预演模式，未写库。确认数字合理后加 --apply 重跑。）")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
