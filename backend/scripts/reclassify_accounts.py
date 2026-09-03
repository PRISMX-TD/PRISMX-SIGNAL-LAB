"""一次性维护脚本：按当前判定规则重新计算所有 MT5 账户的 trade_mode，
纠正规则修改前判错的行——包括从这些行拷贝出去的订单快照。

背景 / Background
-----------------
`account_type.py` 的判定规则不是一成不变的：新券商接入、新组名出现、
或者像这次一样——发现"整台服务器都是实盘"这个假设本身是错的（Make
Capital 的 MakeCapital-Live 混跑模拟与实盘账户，2026-09-03 与券商确认）。
规则改了之后，`mt5_accounts.trade_mode` 里可能还留着旧规则算出来的错误
值，`orders.trade_mode` 也是——那一列是成交时从账号行拷贝的不可变快照
（见 models.py Order.trade_mode 的注释），账号判错了，快照跟着错。

这个脚本把两边都按新规则重新算一遍：账号行按新值覆盖；账号行变化后，
再把该账号名下已成交（status=FILLED）订单的快照同步过去——**从不碰
trade_mode=-1 的哨兵行**，那是账号已被删除时打的标记，永远无来源，不属于
"这个账号的旧快照"，重新计算跟它无关。

为什么"改快照"在这里是对的，而不是"重写历史"：快照的职责是记录成交那一刻
账号"是什么"，不是记录"当时系统以为它是什么"。规则判错时，快照里存的值
从来就不是真的——这不是历史的一部分，是历史记录本身的错误。用新规则重算
是在纠正记录，不是在篡改它曾经发生过的事实（哪笔订单、什么时候成交，这些
都不动）。

用法 / Usage
------------
从 backend/ 目录运行：

    python -m scripts.reclassify_accounts            # 只读预演，打印将要变更的行
    python -m scripts.reclassify_accounts --apply     # 确认无误后写库

可重复运行：判定结果一致的行不受影响，重跑只会重新检查规则下仍然不一致的部分。
"""

from __future__ import annotations

import argparse
import sys

from app.core.database import SessionLocal
from app.models import MT5Account, Order
from app.services.account_type import classify_account
from app.services.settings_store import get_account_type_settings


def _label(mode: int | None) -> str:
    return {0: "DEMO(0)", 1: "CONTEST(1)", 2: "REAL(2)", None: "None"}.get(mode, str(mode))


def main() -> int:
    parser = argparse.ArgumentParser(description="按当前规则重新判定所有 MT5 账户的 trade_mode")
    parser.add_argument(
        "--apply", action="store_true",
        help="真的写库；不加此参数只做只读预演 / actually write, otherwise dry-run",
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        settings = get_account_type_settings(db)
        accounts = db.query(MT5Account).all()

        changed: list[tuple[MT5Account, int | None]] = []
        for row in accounts:
            new = classify_account(row.mt5_group, row.server, row.login, settings)
            if new != row.trade_mode:
                changed.append((row, new))

        print(f"共 {len(accounts)} 个账户，其中 {len(changed)} 个判定结果与库中不一致：\n")
        for row, new in changed:
            print(f"  login={row.login!r:12} source={row.source!r:8} "
                  f"server={row.server!r:22} group={row.mt5_group!r:30} "
                  f"{_label(row.trade_mode)} -> {_label(new)}")

        if not changed:
            print("没有需要变更的账户。")
            return 0

        orders_restamped = 0
        if args.apply:
            for row, new in changed:
                row.trade_mode = new
                # 同步该账户名下已成交订单的快照。永远不碰 -1 哨兵行——那是
                # 账号行已删时打的标记，和"这个账号被重新判定"是两回事。
                # Re-stamp this account's filled orders. Never touch the -1
                # sentinel: that marks an order whose account row is gone,
                # unrelated to this account being reclassified.
                orders = (
                    db.query(Order)
                    .filter(
                        Order.user_id == row.user_id,
                        Order.mt5_login == row.login,
                        Order.status == "FILLED",
                        Order.trade_mode != -1,
                    )
                    .all()
                )
                for o in orders:
                    if o.trade_mode != new:
                        o.trade_mode = new
                        orders_restamped += 1
            db.commit()
            print(f"\n已写库：{len(changed)} 个账户的 trade_mode 已更新，"
                  f"{orders_restamped} 条订单快照已同步。")
        else:
            print(f"\n（预演模式，未写库。加 --apply 会同步更新这 {len(changed)} 个账户，"
                  f"以及它们名下已成交订单的 trade_mode 快照。）")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
