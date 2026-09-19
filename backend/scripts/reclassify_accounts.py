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
from app.models import (Competition, CompetitionParticipant, LeaderboardSnapshot,
                        MT5Account, Order, UserBadge)
from app.services.account_type import classify_account
from app.services.settings_store import get_account_type_settings


def _label(mode: int | None) -> str:
    return {0: "DEMO(0)", 1: "CONTEST(1)", 2: "REAL(2)", None: "None"}.get(mode, str(mode))


def _print_downstream(db, changed) -> None:
    """列出这批重判会波及、但**脚本不会自动修正**的下游产物。

    为什么必须打出来：`orders.trade_mode` 是榜单与比赛计分的输入，而它们的产物
    是**封存的**——
      · `leaderboard_snapshots` 里已封存的周期榜是当时算完就定格的，不会因为
        订单快照变了而回溯重算；
      · 已 settled 比赛的 `final_rank` / `final_score` 是永久名次，终审跑过就
        不再动（settle_competition 以 status 为闸，不可重跑）；
      · 勋章「发出不收回」（award_badge 只升不降，user_badges 也没有「哪场比赛
        发的」这一列可供回溯）。
    把一批账户从 REAL 降成 DEMO 之后，这些历史产物会与现有数据对不上——不是脚本
    的 bug，是纠错本身的必然代价。这里只负责把「对不上的将会是哪些东西」摊在
    操作者面前，让他先决定要不要继续，而不是事后才发现榜单和名次说不通。

    Lists what this reclassification will invalidate but will *not* repair.
    orders.trade_mode feeds board and competition scoring, and those outputs are
    sealed: archived leaderboard snapshots are never recomputed, a settled
    competition's final ranks are permanent (settle_competition gates on status
    and cannot re-run), and badges are never revoked. Downgrading accounts from
    REAL to DEMO therefore leaves history disagreeing with the data — an
    unavoidable cost of the correction, not a bug. This puts that cost in front of
    the operator beforehand instead of leaving it to be discovered later.
    """
    pairs = {(row.user_id, row.login) for row, _new in changed}
    uids = {u for u, _lg in pairs}

    snaps = (db.query(LeaderboardSnapshot)
               .filter(LeaderboardSnapshot.user_id.in_(uids)).all())
    hit_snaps = [s for s in snaps if (s.user_id, s.mt5_login) in pairs]
    periods = sorted({s.period_key for s in hit_snaps})

    parts = (db.query(CompetitionParticipant, Competition)
               .join(Competition, Competition.id == CompetitionParticipant.competition_id)
               .filter(CompetitionParticipant.user_id.in_(uids),
                       Competition.status == "settled").all())
    hit_comps = [(p, c) for p, c in parts if (p.user_id, p.mt5_login) in pairs]

    badges = db.query(UserBadge).filter(UserBadge.user_id.in_(uids)).count()

    print("\n── 受影响但不会被自动修正的下游产物 ──")
    if periods:
        board_periods = sorted({p for p in periods if not p.startswith("comp:")})
        comp_periods = [p for p in periods if p.startswith("comp:")]
        print(f"  榜单快照 {len(hit_snaps)} 行，跨 {len(periods)} 个周期键")
        if board_periods:
            print(f"    周期榜：{', '.join(board_periods)}")
        if comp_periods:
            print(f"    比赛榜：{', '.join(comp_periods)}")
        print("    → 已封存的周期榜不会回溯重算，名次将与新的 trade_mode 对不上。")
    else:
        print("  榜单快照：无")
    if hit_comps:
        print(f"  已终审比赛中的参赛条目 {len(hit_comps)} 条：")
        for p, c in hit_comps:
            print(f"    「{c.name}」 {c.id} track={c.track} "
                  f"login={p.mt5_login} final_rank={p.final_rank} final_score={p.final_score}")
        print("    → final_rank/final_score 是永久名次，终审不可重跑，这里不会改。")
    else:
        print("  已终审比赛：无")
    print(f"  这些用户名下已发放的勋章共 {badges} 枚 → 勋章发出不收回，一律不动。")


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

        # 下游影响在写库**之前**打印：预演模式下操作者据此决定要不要 --apply，
        # --apply 模式下这份清单跟着这次变更一起留在运维日志里。
        # Printed before writing: in dry-run it informs the decision to apply, and
        # on --apply it lands in the operator's log next to the change itself.
        _print_downstream(db, changed)

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
