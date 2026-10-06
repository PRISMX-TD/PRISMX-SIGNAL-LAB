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


_STATUS_ZH = {
    "ranked": "上榜",
    "disqualified": "已取消资格",
    "no_baseline": "没有基线（报名时没拍到本金）",
    "not_started": "比赛未开始",
    "capital_out_of_range": "报名本金不在本场门槛内",
    "min_trades": "平仓笔数不足",
    "pending": "已够格，等下一轮快照",
}


def _diagnose_comp(ident: str, verbose: bool) -> int:
    """比赛版诊断：逐个参赛账户说清「上没上榜、为什么」。

    判定直接调 `competitions.participant_details`——后台参赛名单用的就是它，它又与
    计分（compute_comp_rows）同一套函数与门槛（2026-10-06 方案 3：分母 = 报名本金，
    出入金只标黄复核，结束时未平的平台单按结束快照浮盈计入）。脚本不再自己算分母，
    以前它按「基线 + 入金调整」算、不看本金上限也不看结束快照，跟真榜对不上。
    没上榜的再用 `_login_detail` 拆仓位漏斗，解释笔数差在哪一级。
    Competition diagnosis per entry. The verdict comes from participant_details — the
    same function the admin participant list uses, itself built on the scoring path —
    so the script can't drift from the real board again. Entries off the board get the
    per-position funnel from _login_detail to show where their trades fell out."""
    from app.models import Competition, CompetitionParticipant
    from app.services.gamification.competitions import (
        CASHFLOW_FLAG_FRAC, comp_gates, comp_period_key, participant_details, track_modes)

    db = SessionLocal()
    try:
        comp = (db.query(Competition).filter(Competition.id == ident).first()
                or db.query(Competition).filter(Competition.name == ident).first())
        if comp is None:
            print(f"找不到比赛：{ident}")
            return 1
        gates = comp_gates(comp, get_gamification_settings(db))
        modes = track_modes(comp.track)
        lo, hi = gates["min_baseline_usd"], gates["max_baseline_usd"]
        if hi is not None and hi == lo:
            cap_desc = f"报名本金须正好 {lo:g} USD"
        else:
            cap_desc = f"报名本金 ≥{lo:g}" + (f" 且 ≤{hi:g}" if hi is not None else "") + " USD"
        start, end = _aware(comp.starts_at), _aware(comp.ends_at)
        print(f"比赛「{comp.name}」 {comp.id}")
        print(f"  状态 {comp.status} · 指标 {comp.metric} · 赛道 {comp.track}"
              f"（计分只认 trade_mode ∈ {modes} 的平台单）")
        print(f"  窗口 {_fmt(start)} → {_fmt(end)}")
        min_trades = (gates["min_trades_return"] if comp.metric == "return_pct"
                      else gates["min_trades_winrate"])
        print(f"  门槛：≥{min_trades} 笔 · {cap_desc}")
        print(f"  口径：平台单盈亏 ÷ 报名本金；资金进出 ≥ 报名本金 {CASHFLOW_FLAG_FRAC:.0%} 只标黄复核，"
              f"不影响计分；结束时未平的平台单按结束快照浮盈计入")
        print()

        parts = (db.query(CompetitionParticipant)
                   .filter(CompetitionParticipant.competition_id == comp.id)
                   .order_by(CompetitionParticipant.registered_at.asc()).all())
        details = participant_details(db, comp, parts)
        baselines = {(b.user_id, b.mt5_login): b for b in
                     db.query(PeriodBaseline).filter(
                         PeriodBaseline.period_key == comp_period_key(comp.id))}

        counts = defaultdict(int)
        for p in parts:
            counts[details[p.id]["status"]] += 1
        print("── 汇总 ──")
        print(f"  参赛行 {len(parts)}")
        for st in ("ranked", "pending", "min_trades", "capital_out_of_range",
                   "no_baseline", "not_started", "disqualified"):
            if counts.get(st):
                print(f"  · {_STATUS_ZH[st]:<24} {counts[st]:>4}")
        flagged = [p for p in parts if details[p.id].get("cashflowFlagged")]
        if flagged:
            print(f"  · 资金进出需复核（不影响计分）     {len(flagged):>4}")
        if comp.status in ("ended", "settled"):
            missing = [p for p in parts if not p.disqualified and not details[p.id].get("endCaptured")]
            print(f"  · 结束持仓快照未拍到              {len(missing):>4}"
                  + ("   ← 比赛循环每分钟重试；一直不动查网关" if missing else ""))
        print()

        def _line(p, d):
            bal = lambda v: "—" if v is None else f"{v:.2f}"
            flow = d.get("netCashflow")
            flow_s = "—" if flow is None else f"{flow:+.2f}" + ("（需复核）" if d.get("cashflowFlagged") else "")
            return (f"报名本金 {bal(d.get('balanceAtSignup'))} · 计分起点余额 "
                    f"{bal(d.get('balanceAtScoringStart'))} · 当前余额 {bal(d.get('balance'))}"
                    f" · 资金进出 {flow_s}")

        print("── 没上榜的 ──")
        for p in parts:
            d = details[p.id]
            if d["status"] == "ranked":
                continue
            print(f"  {p.mt5_login}  {_STATUS_ZH.get(d['status'], d['status'])}"
                  + (f" · 计分 {d['sample']} 笔（需 {d['minTrades']}）" if d.get("sample") is not None else ""))
            print(f"      {_line(p, d)}")
            if p.disqualified and p.disqualify_reason:
                print(f"      取消原因：{p.disqualify_reason}")
            b = baselines.get((p.user_id, p.mt5_login))
            if d["status"] in ("min_trades", "pending") and b is not None:
                lower = max(start, _aware(b.taken_at),
                            *([_aware(p.scoring_from)] if p.scoring_from else []))
                f = _login_detail(db, p.user_id, p.mt5_login, lower, end, b.taken_at, modes)
                why = []
                if f["orders"] == 0:
                    why.append(f"名下没有该赛道（trade_mode ∈ {modes}）的平台单")
                else:
                    if f["with_legs"] < f["orders"]:
                        why.append(f"{f['orders'] - f['with_legs']} 单还没有已核验的平仓腿（未平或挂单未触发）")
                    if f["resolved"] < f["with_legs"]:
                        why.append(f"{f['with_legs'] - f['resolved']} 单只平了一部分")
                    if f["before_lower"]:
                        why.append(f"{f['before_lower']} 笔平在计分起点 {_fmt(lower)} 之前")
                    if f["after_end"]:
                        why.append(f"{f['after_end']} 笔平在比赛结束之后（结束快照拍到才计入）")
                if f["unverified_legs"]:
                    why.append(f"{f['unverified_legs']} 条平仓腿未核验（仓位号对不上，多半是 MT5 里自己下的单）")
                if why:
                    print(f"      → {'；'.join(why)}")
        print()

        ranked = sorted((p for p in parts if details[p.id]["status"] == "ranked"),
                        key=lambda p: details[p.id]["liveRank"] or 0)
        print(f"── 上榜 {len(ranked)} ──")
        for p in ranked:
            d = details[p.id]
            if not (verbose or d.get("cashflowFlagged")):
                continue
            score = d.get("liveScore")
            score_s = "—" if score is None else (f"{score * 100:+.2f}%" if comp.metric == "return_pct"
                                                  else f"{score * 100:.1f}%")
            print(f"  #{d['liveRank']} {p.mt5_login}  {score_s} · {d['sample']} 笔")
            print(f"      {_line(p, d)}")
        if not verbose:
            print("  （只列出资金进出需复核的；--verbose 列出全部）")
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
        # 「本期盈亏为正」在真榜里是可配开关（boards.compute_board_rows 读
        # gates["winrate_require_profit"]，默认关）。这里必须一起读出来：写死成
        # 恒定生效会让诊断报出的入榜人数比真榜少，而本脚本的整个卖点就是「复用
        # 榜单自己的函数、不出现两套实现的漂移」（见模块 docstring）。
        # The "period P&L must be positive" gate is a setting on the real board
        # (boards.compute_board_rows reads gates["winrate_require_profit"], off by
        # default), so it has to be read here too. Hard-coding it as always-on made
        # this script report fewer entrants than the live board — the exact
        # two-implementations drift the module docstring promises not to have.
        wr_require_profit = gates["winrate_require_profit"]

        wr_desc = f"≥{min_wr} 笔" + ("且本期盈亏为正" if wr_require_profit else "（不要求本期盈亏为正）")
        print(f"周期 {key}：{_fmt(start)} → {_fmt(end)}"
              f"（{'进行中' if end > now else '已封存'}，现在 {_fmt(now)}）")
        print(f"门槛：收益榜 ≥{min_ret} 笔 · 分母 ≥{min_baseline:g} USD ；胜率榜 {wr_desc}")
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
                # 与 boards.compute_board_rows 同一个条件：
                # sample >= min_trades_winrate and (total > 0 or not wr_require_profit)
                if len(profits) >= min_wr and (sum(profits) > 0 or not wr_require_profit):
                    on_wr.append(row)

        print("── 有基线账户的计分漏斗 ──")
        print(f"  有基线                            {len(details):>4}")
        print(f"  ├ 分母不达标（<{min_baseline:g} USD）        {len(drop_denom):>4}")
        print(f"  ├ 本期整仓笔数 <{min_ret}                {len(drop_no_trade):>4}")
        print(f"  └ 进入收益榜                      {len(on_ret):>4}")
        print(f"     其中同时进入胜率榜（{wr_desc}）  {len(on_wr):>4}")
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
