"""只读诊断脚本：把「为什么榜上只有这几个账户」拆成漏斗，逐层打印卡在哪里。

背景 / Background
-----------------
收益榜的一行要过七道关：账户是实盘 → 有余额（才能拍基线）→ 属主没退榜 →
本周期有基线 → 分母（基线 + 入金调整）达门槛 → 名下有「整仓平掉且经服务端
核验」的仓位 → 最后一腿的平仓时间落在 [max(期初, 拍基线时刻), 期末) 内。
任何一关没过，这个账户就不在榜上，而页面上只看得到结果、看不到卡在哪一关。

这个脚本按同一套函数（`board_gates` / `_resolved_in_period` / `period_bounds`）
重算一遍，逐关打印人数与流失原因——**刻意复用榜单自己的函数**，不另写一份
判定逻辑：诊断结果与真实榜单永远同源，不会出现「脚本说该上榜、榜上却没有」
这种两套实现漂移出来的假象。

只读，不写库。

用法 / Usage
------------
从 backend/ 目录运行：

    python -m scripts.diagnose_board                  # 当前周榜
    python -m scripts.diagnose_board --period month   # 当前月榜
    python -m scripts.diagnose_board --key 2026-W36   # 指定周期键
    python -m scripts.diagnose_board --verbose        # 逐个账户打印明细
    python -m scripts.diagnose_board --comp "比赛名"   # 改为诊断一场比赛
"""
import argparse
import sys
from collections import defaultdict
from datetime import datetime, timezone

from app.core.database import SessionLocal
from app.models import ClosedTrade, LeaderboardSnapshot, MT5Account, PeriodBaseline, User
from app.services.gamification.boards import REAL, _aware, _resolved_in_period, board_gates
from app.services.gamification.periods import month_key, period_bounds, week_key
from app.services.gamification.stats import _filled_orders, _legs_by_position, _resolve
from app.services.settings_store import get_gamification_settings
from app.services.trade_performance import position_id_of

_VOL_EPS = 1e-6


def _fmt(dt) -> str:
    return _aware(dt).strftime("%Y-%m-%d %H:%M UTC") if dt else "—"


def _login_detail(db, uid, login, start, end, taken_at, modes=(REAL,)):
    """一个账户的仓位漏斗：成交单 → 有核验腿 → 整仓平掉 → 落在归期窗口内。
    与 `_resolved_in_period` 同口径，只是把中间各级的数量也留下来。"""
    orders = [o for o in _filled_orders(db, uid, cutoff=None)
              if o.trade_mode in modes and o.mt5_login == login and position_id_of(o)]
    keys = {(o.mt5_login, position_id_of(o)) for o in orders}
    legs_map = _legs_by_position(db, uid, keys)
    with_legs = [o for o in orders if legs_map.get((o.mt5_login, position_id_of(o)))]
    resolved = _resolve(orders, legs_map)
    lower = max(start, _aware(taken_at))
    in_window, before_lower, after_end = [], 0, 0
    for o, p in resolved:
        last_close = _aware(max(l.closed_at for l in legs_map[(o.mt5_login, position_id_of(o))]))
        if last_close < lower:
            before_lower += 1
        elif last_close >= end:
            after_end += 1
        else:
            in_window.append(p)
    # 未核验的腿数：解释「有平仓记录却算不出整仓」最常见的一种
    unverified = (db.query(ClosedTrade)
                    .filter(ClosedTrade.user_id == uid, ClosedTrade.mt5_login == login,
                            ClosedTrade.verified.isnot(True)).count())
    return {"orders": len(orders), "with_legs": len(with_legs), "resolved": len(resolved),
            "in_window": in_window, "before_lower": before_lower, "after_end": after_end,
            "unverified_legs": unverified, "lower": lower}


def _diagnose_comp(ident: str, verbose: bool) -> int:
    """比赛版漏斗：参赛行 → 有基线 → 分母达标 → 本场整仓笔数 → 上榜。
    与周期榜的区别都在这里显式打印：赛道（决定哪些账户与哪些成交单参与）、
    本场门槛（可覆盖全局）、计分窗口（开赛 / 报名 / 拍基线三者取晚）。
    Competition funnel: participants → baseline → denominator → resolved trades →
    on board. The competition-specific parts are printed explicitly: the track
    (which accounts and which fills count), this competition's gates (may override
    the global ones), and the scoring window (latest of start / registration /
    baseline)."""
    from app.models import Competition, CompetitionParticipant
    from app.services.gamification.competitions import (
        comp_gates, comp_period_key, track_modes)

    db = SessionLocal()
    try:
        comp = (db.query(Competition).filter(Competition.id == ident).first()
                or db.query(Competition).filter(Competition.name == ident).first())
        if comp is None:
            print(f"找不到比赛：{ident}")
            return 1
        gates = comp_gates(comp, get_gamification_settings(db))
        modes = track_modes(comp.track)
        min_trades = (gates["min_trades_return"] if comp.metric == "return_pct"
                      else gates["min_trades_winrate"])
        key = comp_period_key(comp.id)
        start, end = _aware(comp.starts_at), _aware(comp.ends_at)
        print(f"比赛「{comp.name}」 {comp.id}")
        print(f"  状态 {comp.status} · 指标 {comp.metric} · 赛道 {comp.track}"
              f"（计分只认 trade_mode ∈ {modes} 的成交单）")
        print(f"  窗口 {_fmt(start)} → {_fmt(end)}")
        print(f"  门槛：≥{min_trades} 笔 · 分母 ≥{gates['min_baseline_usd']:g} USD"
              f"（{'本场自定义' if comp.min_trades is not None or comp.min_baseline_usd is not None else '跟随全局'}）")
        print()

        parts = (db.query(CompetitionParticipant)
                   .filter(CompetitionParticipant.competition_id == comp.id).all())
        live = [p for p in parts if not p.disqualified]
        baselines = {(b.user_id, b.mt5_login): b for b in
                     db.query(PeriodBaseline).filter(PeriodBaseline.period_key == key)}
        with_base = [p for p in live if (p.user_id, p.mt5_login) in baselines]
        print("── 参赛漏斗 ──")
        print(f"  参赛行                            {len(parts):>4}"
              f"   （被取消资格 {len(parts) - len(live)}）")
        print(f"  └ 有基线                          {len(with_base):>4}"
              f"   （无基线 {len(live) - len(with_base)}）")
        print()

        on_board, dropped = [], []
        for p in with_base:
            b = baselines[(p.user_id, p.mt5_login)]
            lower = max(start, _aware(b.taken_at),
                        *([_aware(p.scoring_from)] if p.scoring_from else []))
            d = _login_detail(db, p.user_id, p.mt5_login, lower, end, b.taken_at, modes)
            denom = b.baseline + b.adjust
            row = {"p": p, "b": b, "denom": denom, "d": d, "lower": lower}
            (on_board if len(d["in_window"]) >= min_trades and denom >= gates["min_baseline_usd"]
             and denom > 0 else dropped).append(row)
        print(f"── 结果 ──  上榜 {len(on_board)} · 未上榜 {len(dropped)}")
        print()
        for row in dropped:
            p, d = row["p"], row["d"]
            reason = []
            if d["orders"] == 0:
                reason.append(f"名下没有该赛道（trade_mode ∈ {modes}）的成交单")
            else:
                if d["with_legs"] < d["orders"]:
                    reason.append(f"{d['orders'] - d['with_legs']} 单没有已核验的平仓腿")
                if d["resolved"] < d["with_legs"]:
                    reason.append(f"{d['with_legs'] - d['resolved']} 单未整仓平掉")
                if d["before_lower"]:
                    reason.append(f"{d['before_lower']} 笔平在计分起点之前")
                if d["after_end"]:
                    reason.append(f"{d['after_end']} 笔平在比赛结束之后")
            if row["denom"] < gates["min_baseline_usd"]:
                reason.append(f"分母 {row['denom']:.2f} 不足 {gates['min_baseline_usd']:g}")
            print(f"  {p.mt5_login}  本场 {len(d['in_window'])} 笔（需 {min_trades}）"
                  f" · 分母 {row['denom']:.2f} · 计分起点 {_fmt(row['lower'])}")
            print(f"      → {'；'.join(reason) if reason else '无明显原因，需人工细查'}")
        if verbose:
            for row in on_board:
                p, d = row["p"], row["d"]
                print(f"  [上榜] {p.mt5_login}  {len(d['in_window'])} 笔 · 盈亏 "
                      f"{sum(d['in_window']):+.2f} · 分母 {row['denom']:.2f}")
        return 0
    finally:
        db.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="排行榜入榜漏斗诊断（只读）")
    ap.add_argument("--period", choices=("week", "month"), default="week")
    ap.add_argument("--key", help="直接指定周期键，如 2026-W36 或 2026-09")
    ap.add_argument("--verbose", action="store_true", help="逐个账户打印明细")
    ap.add_argument("--comp", help="改为诊断一场比赛（传比赛 id 或名称）")
    args = ap.parse_args()

    if args.comp:
        return _diagnose_comp(args.comp, args.verbose)

    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc)
        key = args.key or (week_key(now) if args.period == "week" else month_key(now))
        start, end = period_bounds(key)
        gates = board_gates(get_gamification_settings(db))
        min_baseline = gates["min_baseline_usd"]
        min_ret = gates["min_trades_return"]
        min_wr = gates["min_trades_winrate"]

        print(f"周期 {key}：{_fmt(start)} → {_fmt(end)}"
              f"（{'进行中' if end > now else '已封存'}，现在 {_fmt(now)}）")
        print(f"门槛：收益榜 ≥{min_ret} 笔 · 分母 ≥{min_baseline:g} USD ；胜率榜 ≥{min_wr} 笔且本期盈亏为正")
        print()

        accounts = db.query(MT5Account).all()
        opted_out = {r[0] for r in db.query(User.id).filter(User.leaderboard_opt_out.is_(True))}
        baselines = {(b.user_id, b.mt5_login): b for b in
                     db.query(PeriodBaseline).filter(PeriodBaseline.period_key == key)}

        real = [a for a in accounts if a.trade_mode == REAL]
        with_balance = [a for a in real if a.balance is not None]
        not_opted = [a for a in with_balance if a.user_id not in opted_out]
        with_base = [a for a in not_opted if (a.user_id, a.login) in baselines]

        print("── 账户漏斗 ──")
        print(f"  全部 MT5 账户                     {len(accounts):>4}")
        print(f"  ├ 判为实盘（trade_mode=2）        {len(real):>4}"
              f"   （模拟/未判定 {len(accounts) - len(real)}）")
        print(f"  ├ 有余额（能拍基线）              {len(with_balance):>4}"
              f"   （余额为空 {len(real) - len(with_balance)}）")
        print(f"  ├ 属主未退榜                      {len(not_opted):>4}"
              f"   （退榜 {len(with_balance) - len(not_opted)}）")
        print(f"  └ 本周期已有基线                  {len(with_base):>4}"
              f"   （无基线 {len(not_opted) - len(with_base)}）")
        print()

        # 有基线的账户：再走仓位漏斗
        by_user = defaultdict(dict)
        for a in with_base:
            by_user[a.user_id][a.login] = baselines[(a.user_id, a.login)]

        drop_denom, drop_no_trade, on_ret, on_wr = [], [], [], []
        details = []
        for uid, blmap in by_user.items():
            taken = {lg: b.taken_at for lg, b in blmap.items()}
            profits_by_login = _resolved_in_period(db, uid, set(blmap), key, taken)
            for lg, b in blmap.items():
                profits = profits_by_login.get(lg, [])
                denom = b.baseline + b.adjust
                row = {"uid": uid, "login": lg, "denom": denom, "sample": len(profits),
                       "total": sum(profits), "baseline": b.baseline, "adjust": b.adjust,
                       "taken_at": b.taken_at}
                details.append(row)
                if not (denom >= min_baseline and denom > 0):
                    drop_denom.append(row)
                    continue
                if len(profits) < min_ret:
                    drop_no_trade.append(row)
                else:
                    on_ret.append(row)
                if len(profits) >= min_wr and sum(profits) > 0:
                    on_wr.append(row)

        print("── 有基线账户的计分漏斗 ──")
        print(f"  有基线                            {len(details):>4}")
        print(f"  ├ 分母不达标（<{min_baseline:g} USD）        {len(drop_denom):>4}")
        print(f"  ├ 本期整仓笔数 <{min_ret}                {len(drop_no_trade):>4}")
        print(f"  └ 进入收益榜                      {len(on_ret):>4}")
        print(f"     其中同时进入胜率榜（≥{min_wr} 笔且盈利为正）  {len(on_wr):>4}")
        print()

        snap = (db.query(LeaderboardSnapshot)
                  .filter(LeaderboardSnapshot.period_key == key)
                  .all())
        snap_ret = [r for r in snap if r.board == "return_pct"]
        snap_wr = [r for r in snap if r.board == "win_rate"]
        print(f"── 已落库快照 ──  收益榜 {len(snap_ret)} 行 · 胜率榜 {len(snap_wr)} 行")
        if len(snap_ret) != len(on_ret):
            print(f"  ⚠ 快照与现算不一致（现算 {len(on_ret)}）——快照是上一轮循环的结果，"
                  f"下一轮（每小时）会对齐；若持续不一致才是问题。")
        print()

        # 卡在「本期整仓笔数不足」的账户最值得看：到底是没交易，还是交易了但没算进来
        if drop_no_trade:
            print("── 有基线、分母达标，但本期算不出足够整仓的账户 ──")
            for row in sorted(drop_no_trade, key=lambda r: r["login"]):
                d = _login_detail(db, row["uid"], row["login"], start, end, row["taken_at"])
                reason = []
                if d["orders"] == 0:
                    reason.append("名下没有实盘成交单")
                else:
                    if d["with_legs"] < d["orders"]:
                        reason.append(f"{d['orders'] - d['with_legs']} 单没有已核验的平仓腿")
                    if d["resolved"] < d["with_legs"]:
                        reason.append(f"{d['with_legs'] - d['resolved']} 单未整仓平掉（部分平仓）")
                    if d["before_lower"]:
                        reason.append(f"{d['before_lower']} 笔平在拍基线/期初之前"
                                      f"（不计入，窗口自 {_fmt(d['lower'])} 起）")
                    if d["after_end"]:
                        reason.append(f"{d['after_end']} 笔平在期末之后")
                if d["unverified_legs"]:
                    reason.append(f"另有 {d['unverified_legs']} 条未核验的平仓记录")
                print(f"  {row['login']}  本期 {row['sample']} 笔"
                      f"（需 {min_ret}）· 分母 {row['denom']:.2f}"
                      f" · 基线拍于 {_fmt(row['taken_at'])}")
                print(f"      → {'；'.join(reason) if reason else '无明显原因，需人工细查'}")
            print()

        if drop_denom:
            print("── 分母不达标的账户 ──")
            for row in sorted(drop_denom, key=lambda r: r["login"]):
                print(f"  {row['login']}  分母 {row['denom']:.2f}"
                      f"（基线 {row['baseline']:.2f} + 入金调整 {row['adjust']:.2f}）")
            print()

        if args.verbose and details:
            print("── 全部有基线账户明细 ──")
            for row in sorted(details, key=lambda r: (-r["sample"], r["login"])):
                print(f"  {row['login']}  本期 {row['sample']} 笔 · 盈亏 {row['total']:+.2f}"
                      f" · 分母 {row['denom']:.2f} · 基线拍于 {_fmt(row['taken_at'])}")
            print()

        print("提示：账户漏斗第一行掉得最多时，多半是「实盘判定」——只有 trade_mode=2 的账户"
              "参与榜单，模拟盘不上榜（Make Capital 按登录号段 6 开头判实盘）。")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
