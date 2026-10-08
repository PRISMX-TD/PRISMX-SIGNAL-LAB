"""比赛计分（设计 §1.7/§1.8）：按参赛条目过滤 + scoring_from 下限 + metric 门槛，
快照写入 leaderboard_snapshots（board=comp.metric, period_key=comp:<id>）。

复用 boards.py 的 `_resolved_in_period`/`reconcile_deposits`——两者都新增了可选
`bounds` 参数（默认 None 时行为与 Phase 2 完全一致），比赛这边显式传
(comp.starts_at, comp.ends_at)，因为比赛 key（`comp:<id>`）不是 `period_bounds`
能解析的自然周/月格式。
"""
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from app.models import (
    Competition, CompetitionParticipant, LeaderboardSnapshot, MT5Account, PeriodBaseline, User,
)
from .badges import award_badge
from .badge_judges import campaigner_tier, finished_competition_count
from app.services.account_type import CONTEST, DEMO
from .boards import REAL, BASELINE_EPS, _aware, _resolved_in_period, baseline_in_range, board_gates, reconcile_deposits, replace_snapshot_rows


TRACKS = ("real", "demo")
# 赛道 → 允许参赛的 trade_mode 集合。demo 赛道收模拟与赛区账户（都不是真金白银）；
# trade_mode 为 NULL（尚未判定）的账户两个赛道都不收——宁可不让报名，也不能把
# 一个还没判出类型的账户放进以本金论英雄的榜里。
# Track → the trade_mode values it accepts. The demo track takes both demo and
# contest accounts (neither is real money). Accounts with a NULL trade_mode (not yet
# classified) are accepted by neither: better to refuse entry than to admit an
# unclassified account to a board scored on capital.
_TRACK_MODES = {"real": (REAL,), "demo": (DEMO, CONTEST)}

# 每人每场最多能报几个条目（设计 §1.7 的反刷榜闸）。
#
# 为什么必须有这道闸：名次是按「条目」（login）出行的，不是按人。同一个人报进
# N 个账户、两两反向对冲下单，总有一个账户跑出漂亮的收益率——期望为零的操作
# 却能稳定拿到榜首，奖金场就是被这么套的。
#
# 两个赛道给不同的值，因为成本不同：模拟账户可以零成本无限开，所以 demo 赛道
# 每人只认一个条目——这只挡住「一个人自己多开账户互相对冲」。两个人串通、各报一个
# 账户反向下单照样能做（对一方必赚），这道闸管不到；那一类靠管理端完整性报告里的
# 对冲嫌疑配对（competition_integrity / hedge_pairs）加终审闸门由人来把关。实盘每开
# 一个账户都要真金白银入金，对冲的代价是真实的点差与手续费，所以留 3 个——足够覆盖
# 「一个人确实同时在几家/几个账户上跑不同策略」这类正当用法，又把批量对冲的成本抬到
# 不划算。
#
# How many entries one user may have in one competition (the anti-gaming gate
# from §1.7). Ranks are per entry (login), not per person, so one user entering N
# accounts and hedging them against each other is guaranteed to leave one account
# at the top of the board — a zero-expectation trick that reliably wins prizes.
# The demo track allows one entry per user because demo accounts are free. That
# stops a single user hedging their own accounts, but NOT two colluding users who
# each enter one account and trade opposite sides; that case is surfaced by the
# admin integrity report's hedge pairs (competition_integrity / hedge_pairs) and
# the settle gate, and decided by a human. A real account costs real money and
# the hedge pays real spread and commission, so three entries are allowed —
# enough for the legitimate "I really do run a few accounts" case while keeping
# bulk hedging uneconomical.
MAX_ENTRIES_DEMO = 1
MAX_ENTRIES_REAL = 3
_TRACK_MAX_ENTRIES = {"real": MAX_ENTRIES_REAL, "demo": MAX_ENTRIES_DEMO}


def track_modes(track: str) -> tuple[int, ...]:
    return _TRACK_MODES.get(track or "real", _TRACK_MODES["real"])


def max_entries_per_user(track: str) -> int:
    return _TRACK_MAX_ENTRIES.get(track or "real", MAX_ENTRIES_REAL)


def comp_gates(comp: Competition, gset: dict) -> dict:
    """这场比赛实际生效的门槛：比赛自己配了就用自己的，没配回落全局。

    形状与 `board_gates()` 完全一致，因为下游（`compute_comp_rows` 与比赛详情
    页的 gates 回显）就是照那份形状读的——"页面上写的门槛"与"计算时用的门槛"
    必须永远是同一个来源，这条约定见 `board_gates` 的说明。

    The gates actually in force for this competition: its own values when set,
    otherwise the global ones. Shape is identical to `board_gates()` because
    that's what the consumers read — the number shown on the page and the number
    used to compute rows must come from one source (see `board_gates`).
    """
    gates = dict(board_gates(gset))
    if comp.min_baseline_usd is not None:
        gates["min_baseline_usd"] = float(comp.min_baseline_usd)
    # 本金上限只有比赛有（周期榜没有这一说），None = 不设上限。
    # Only competitions have a capital ceiling (standing boards don't); None = none.
    gates["max_baseline_usd"] = (float(comp.max_baseline_usd)
                                 if comp.max_baseline_usd is not None else None)
    if comp.min_trades is not None:
        n = max(1, int(comp.min_trades))
        gates["min_trades_return"] = n
        gates["min_trades_winrate"] = n
    return gates


def comp_period_key(comp_id: str) -> str:
    return f"comp:{comp_id}"


# 资金进出超过报名本金的这个比例，后台参赛名单标黄、等管理员人工复核（不自动出榜）。
# Net cash flow beyond this share of the signup capital is flagged for admin review
# in the participant list (it no longer drops the row by itself).
CASHFLOW_FLAG_FRAC = 0.05


def comp_return_score(b, resolved, min_baseline: float, max_baseline: float | None):
    """比赛收益率：平台单盈亏合计 ÷ **报名时的本金**（基线），比赛期间的入金、出金、
    平台外交易一律不改分母（2026-10-06 起，方案 3）。报名本金不在本场门槛内 → None。

    与周期榜的 return_score（逐仓按当时本金）刻意分开：比赛要的是「人人同一个起点、
    规则一句话说得清」，以前按当时本金算时，余额与平仓行错拍、手续费零头、MT5 里自己
    下的单都会让限额比赛整行掉榜。出入金不再影响成绩，改由后台标黄人工复核
    （CASHFLOW_FLAG_FRAC）。
    Competition return: platform P/L / the signup capital (baseline); deposits,
    withdrawals and off-platform trading never move the denominator. Kept apart
    from the standing boards' per-position capital on purpose: one starting line
    for everyone and a one-sentence rule. Cash flow is flagged for admin review."""
    base = float(b.baseline or 0.0)
    if base <= 0 or not baseline_in_range(base, min_baseline, max_baseline):
        return None
    return sum(pr for _o, _c, pr in resolved) / base, len(resolved)


def _load_end_positions(p) -> tuple[datetime, dict[str, float]] | None:
    """参赛条目的结束持仓快照：(拍照时刻, {仓位号: 浮动盈亏})；没拍到 / 坏数据 -> None。"""
    raw = getattr(p, "end_positions", None)
    if not raw:
        return None
    try:
        snap = json.loads(raw)
        at = _aware(datetime.fromisoformat(snap["at"]))
        pnl = {str(k): float(v) for k, v in (snap.get("pnl") or {}).items()}
    except (ValueError, TypeError, KeyError):
        return None
    return at, pnl


def _end_valuation(db, comp: Competition, p, modes) -> list[tuple]:
    """比赛结束时还没平完的平台单，按结束快照计入：返回 [(开仓时刻, ends_at, 盈亏)]。

    盈亏 = 结束前已平掉的部分 + 结束到拍照之间平掉的部分 + 拍照时的浮动盈亏。结束前
    已整仓平掉的仓位不在这里（_resolved_in_period 已经算过）；拍照时不在持仓里、结束后
    也没有平仓腿的（没触发的挂单等）跳过。没有快照 -> 空（还没拍到，下一轮再来）。

    这条补的是两个洞：① 亏损单拖着不平就永远不计入；② 结束时还开着、之后才平的单
    以前整笔丢失（只认最后一腿落在 ends_at 之前）。
    Platform positions still open at the end, valued from the end snapshot:
    realised parts + floating P/L at capture. Closes two holes: holding a loser open
    to keep it off the score, and positions open at the end being dropped forever.
    """
    from app.services.trade_performance import position_id_of
    from .stats import _VOL_EPS, _filled_orders, _legs_by_position
    snap = _load_end_positions(p)
    if snap is None:
        return []
    capture_at, floating = snap
    ends_at = _aware(comp.ends_at)
    by_pid = {}
    for o in _filled_orders(db, p.user_id, logins={p.mt5_login}, modes=modes, before=ends_at):
        pid = position_id_of(o)
        if pid and pid not in by_pid:
            by_pid[pid] = o
    legs_map = _legs_by_position(db, p.user_id, {(p.mt5_login, pid) for pid in by_pid})
    out = []
    for pid, o in by_pid.items():
        legs = legs_map.get((p.mt5_login, pid), [])
        before = [l for l in legs if _aware(l.closed_at) < ends_at]
        if before and sum(l.close_volume or 0 for l in before) + _VOL_EPS >= (o.volume or 0):
            continue                                # 结束前已整仓平掉 / fully closed in time
        late = [l for l in legs if ends_at <= _aware(l.closed_at) <= capture_at]
        fl = floating.get(str(pid))
        if fl is None and not late:
            continue                                # 结束时并不持有 / not held at the end
        value = sum(l.profit or 0 for l in before + late) + (fl or 0.0)
        out.append((_aware(o.created_at) if o.created_at else ends_at, ends_at, value))
    return out


def _opened_since(resolved: list[tuple], lower: datetime) -> list[tuple]:
    """比赛只算计分起点之后**下单**的仓位：resolved 里 (开仓时刻, 平仓时刻, 盈亏) 按开仓时刻
    过滤，开仓时刻 = 平台订单的下单时间（挂单按挂出时间，赛前挂好、赛中才触发的也不算）。

    以前只看平仓时刻落在比赛期内、开仓多早都行：赛前开好单等浮盈，再报名（报名本金只看
    余额、不含浮盈），赛中一平，赛前赚的那段整笔算进成绩；亏的单则报名前平掉。比赛有奖，
    这个口子必须堵。周期榜不受影响（只有比赛调用这里）。
    Competitions only score positions *ordered* at or after the scoring start: the
    (opened, closed, profit) tuples are filtered on the open instant, which is the platform
    order's creation time (a pending order counts from when it was placed, so one placed
    before the start and triggered later does not count). Previously only the close had to
    fall inside the window, so a player could open before signing up, let it run (the signup
    capital is balance and excludes floating P/L), sign up and close it, banking pre-contest
    gains — and close losers before signing up. The standing boards are unaffected.
    """
    return [r for r in resolved if r[0] is not None and _aware(r[0]) >= lower]


def compute_comp_rows(db, comp: Competition) -> list[dict]:
    """比赛未取消资格的参赛条目 + `period_baselines(comp:<id>)`：按 `boards.
    _resolved_in_period` 的语义计算——有效下界 = max(比赛开赛, 基线 taken_at,
    条目 scoring_from)、上界 = 比赛结束。按 comp.metric 应用门槛（含
    min_baseline_usd），返回 `{userId, login, score, sample}` 未排名行。

    只有参赛条目登记的账户（login）计分——同一用户名下未登记进这场比赛的其它
    账户不得混入（哪怕它恰好也在 period_baselines 里留了同 key 的脏行）。
    """
    from app.services.settings_store import get_gamification_settings
    gset = get_gamification_settings(db)
    # 比赛用的是所选 metric 的完整周期榜规则，默认与 boards.py 同步（同一个
    # board_gates()，两处不会分叉）；本场比赛单独配了门槛时由 comp_gates 覆盖。
    # A competition uses its metric's full board rules, by default in lockstep with
    # boards.py (same board_gates(), so the two can't diverge); comp_gates applies
    # this competition's own overrides on top when it has any.
    gates = comp_gates(comp, gset)
    min_baseline = gates["min_baseline_usd"]
    max_baseline = gates["max_baseline_usd"]
    min_trades_return = gates["min_trades_return"]
    min_trades_winrate = gates["min_trades_winrate"]
    wr_require_profit = gates["winrate_require_profit"]
    period_key = comp_period_key(comp.id)
    starts_at = _aware(comp.starts_at)
    ends_at = _aware(comp.ends_at)

    participants = (db.query(CompetitionParticipant)
                       .filter(CompetitionParticipant.competition_id == comp.id,
                               CompetitionParticipant.disqualified.is_(False)).all())
    if not participants:
        return []

    baselines = {(b.user_id, b.mt5_login): b for b in
                 db.query(PeriodBaseline).filter(PeriodBaseline.period_key == period_key)}

    by_user = defaultdict(list)
    for p in participants:
        by_user[p.user_id].append(p)
    modes = track_modes(comp.track)

    rows = []
    for uid, plist in by_user.items():
        logins = set()
        taken = {}
        baseline_by_login = {}
        part_by_login = {}
        for p in plist:
            b = baselines.get((uid, p.mt5_login))
            if b is None:
                continue                            # 未拍基线：不出行
            lower = max(starts_at, _aware(b.taken_at),
                        *([_aware(p.scoring_from)] if p.scoring_from is not None else []))
            taken[p.mt5_login] = lower
            baseline_by_login[p.mt5_login] = b
            part_by_login[p.mt5_login] = p
            logins.add(p.mt5_login)
        if not logins:
            continue
        # modes：按本场赛道取（real 赛只算实盘单、demo 赛只算模拟单）。不传的话
        # _resolved_in_period 默认只认实盘，模拟赛的成交会被整个滤掉。
        # modes: taken from this competition's track (a real competition scores only
        # live fills, a demo one only demo fills). Without it _resolved_in_period
        # defaults to real-only and a demo competition's fills all get filtered out.
        profits_by_login = _resolved_in_period(db, uid, logins, period_key, taken,
                                                bounds=(starts_at, ends_at),
                                                modes=modes)
        for lg in logins:
            b = baseline_by_login[lg]
            # 结束快照里还开着的平台单（只有比赛结束、拍到快照后才有）。
            # Platform positions open at the end (only once ended and captured).
            resolved = _opened_since(
                profits_by_login.get(lg, []) + _end_valuation(db, comp, part_by_login[lg], modes),
                taken[lg])
            profits = [pr for _o, _c, pr in resolved]
            sample = len(profits)
            total = sum(profits)
            if comp.metric == "return_pct":
                # 分母固定为报名本金，出入金不影响（见 comp_return_score）。
                # Fixed signup-capital denominator (see comp_return_score).
                scored = comp_return_score(b, resolved, min_baseline, max_baseline)
                if sample >= min_trades_return and scored is not None:
                    rows.append({"userId": uid, "login": lg,
                                "score": scored[0], "sample": sample})
            elif comp.metric == "win_rate":
                # 盈亏正闸同 boards.py：现在是可配开关 winrate_require_profit（默认关）。
                # Same as boards.py: a principled profit-positive gate,
                # deliberately not a setting.
                if sample >= min_trades_winrate and (total > 0 or not wr_require_profit):
                    wins = sum(1 for pr in profits if pr > 0)
                    rows.append({"userId": uid, "login": lg,
                                "score": wins / sample, "sample": sample})
    return rows


def participant_details(db, comp: Competition, participants: list) -> dict[str, dict]:
    """管理端参赛名单的逐行明细：participant.id -> {报名时余额、计分起点余额、当前余额 /
    净值、资金进出、计分笔数、实时名次 / 收益、没上榜的原因}。

    与 compute_comp_rows 同一套口径（同一个 _resolved_in_period / return_score /
    门槛），所以这里说的「为什么没上榜」就是计分时真正卡住的那一条。只读，不写库。
    Per-row detail for the admin participant table, computed with exactly the
    scoring path's functions and gates, so the stated reason for being off the
    board is the one that actually applies. Read-only.

    status：ranked | disqualified | no_baseline | not_started | capital_out_of_range
            | min_trades | pending（够格了，等下一轮快照）
    """
    from app.models import ClosedTrade
    from app.services.settings_store import get_gamification_settings
    if not participants:
        return {}
    gates = comp_gates(comp, get_gamification_settings(db))
    min_baseline, max_baseline = gates["min_baseline_usd"], gates["max_baseline_usd"]
    min_trades = (gates["min_trades_return"] if comp.metric == "return_pct"
                  else gates["min_trades_winrate"])
    period_key = comp_period_key(comp.id)
    starts_at, ends_at = _aware(comp.starts_at), _aware(comp.ends_at)
    now = datetime.now(timezone.utc)

    uids = {p.user_id for p in participants}
    logins = {p.mt5_login for p in participants}
    baselines = {(b.user_id, b.mt5_login): b for b in
                 db.query(PeriodBaseline).filter(PeriodBaseline.period_key == period_key)}
    accounts = {(a.user_id, a.login): a for a in
                db.query(MT5Account).filter(MT5Account.user_id.in_(uids),
                                            MT5Account.login.in_(logins))}
    board = {r.mt5_login: r for r in
             db.query(LeaderboardSnapshot).filter(LeaderboardSnapshot.period_key == period_key)}
    closes = defaultdict(list)                     # (uid, login) -> [(closed_at, profit)]
    for uid, lg, closed_at, profit in (
            db.query(ClosedTrade.user_id, ClosedTrade.mt5_login, ClosedTrade.closed_at,
                     ClosedTrade.profit)
              .filter(ClosedTrade.user_id.in_(uids), ClosedTrade.mt5_login.in_(logins))):
        closes[(uid, lg)].append((_aware(closed_at), float(profit or 0.0)))

    from .boards import capital_at
    out: dict[str, dict] = {}
    for p in participants:
        key = (p.user_id, p.mt5_login)
        b, acct, snap = baselines.get(key), accounts.get(key), board.get(p.mt5_login)
        d = {
            "balanceAtSignup": float(b.baseline) if b is not None else None,
            "balanceAtScoringStart": None,
            "balance": acct.balance if acct is not None else None,
            "equity": acct.equity if acct is not None else None,
            "accountOnline": bool(acct.online) if acct is not None else None,
            "accountRevoked": bool(acct is None or acct.revoked_at is not None),
            "netCashflow": float(b.adjust or 0.0) if b is not None else None,
            # 资金进出（含平台外交易）超过报名本金的 CASHFLOW_FLAG_FRAC：标黄人工复核。
            # Cash flow (incl. off-platform trading) beyond the flag share: review.
            "cashflowFlagged": _cashflow_flagged(b),
            "endCaptured": p.end_positions is not None,
            "sample": None,
            "minTrades": min_trades,
            "liveRank": snap.rank if snap is not None else None,
            "liveScore": snap.score if snap is not None else None,
            "status": None,
        }
        out[p.id] = d
        if p.disqualified:
            d["status"] = "disqualified"
            continue
        if b is None:
            d["status"] = "no_baseline"
            continue
        lower = max(starts_at, _aware(b.taken_at),
                    *([_aware(p.scoring_from)] if p.scoring_from is not None else []))
        if now >= lower:
            # 计分起点余额 = 那一刻的本金 + 报名到起点之间已平仓的盈亏。
            # Balance at the scoring start = capital then + P/L closed between signup and it.
            pre = sum(pr for at, pr in closes[key] if _aware(b.taken_at) <= at < lower)
            d["balanceAtScoringStart"] = round(capital_at(b, lower) + pre, 2)
        if now < starts_at:
            d["status"] = "not_started"
            continue
        modes = track_modes(comp.track)
        resolved = _opened_since(
            _resolved_in_period(db, p.user_id, {p.mt5_login}, period_key,
                                {p.mt5_login: lower}, bounds=(starts_at, ends_at),
                                modes=modes).get(p.mt5_login, [])
            + _end_valuation(db, comp, p, modes),
            lower)
        d["sample"] = len(resolved)
        if snap is not None:
            d["status"] = "ranked"
        elif (comp.metric == "return_pct"
              and comp_return_score(b, resolved, min_baseline, max_baseline) is None):
            d["status"] = "capital_out_of_range"    # 报名本金本身不在门槛内 / signup capital off-gate
        elif len(resolved) < min_trades:
            d["status"] = "min_trades"
        else:
            d["status"] = "pending"                 # 下一轮快照才会出现 / next snapshot
    return out


# ---- 完整性检查（设计 2026-10-08 §1.14）/ integrity checks ----------------------
# 对冲嫌疑：同一场里两个不同条目，在各自计分起点之后、60 秒内对同一品种下了方向相反
# 的平台单。两人串通各报一个账户互相对冲时，一方必赚——条目上限挡不住这一类（见
# MAX_ENTRIES_DEMO 的说明），只能报出来交给人判断。同一个人的两个条目也算（实盘赛
# 每人可报 3 个）。
# Hedge suspicion: two different entries in one competition placing opposite-side
# platform orders on the same symbol within 60s, after their scoring starts.
HEDGE_WINDOW_SECONDS = 60
# 终审闸门只看前 N 名：奖金与勋章都在头部，尾部的标记不挡终审。
# The settle gate only looks at the top N, where prizes and badges are.
SETTLE_FLAG_TOP_N = 10


def _cashflow_flagged(b) -> bool:
    """资金进出（含平台外交易）超过报名本金的 CASHFLOW_FLAG_FRAC → 标黄人工复核。
    participant_details 与完整性报告共用，口径只此一份。"""
    if b is None:
        return False
    base = float(b.baseline or 0.0)
    return base > 0 and abs(float(b.adjust or 0.0)) >= CASHFLOW_FLAG_FRAC * base


def _direction(side) -> int:
    """BUY / BUY_LIMIT / BUY_STOP… → +1；SELL… → -1；其它 0（不参与配对）。"""
    s = (side or "").upper()
    if s.startswith("BUY"):
        return 1
    if s.startswith("SELL"):
        return -1
    return 0


def entry_flags(db, comp: Competition, participants: list) -> dict[str, dict]:
    """逐条目标记：participant.id -> {"kinds": [...], "detail": {...}}（每个条目都有，kinds 可空）。

    cashflowFlagged：同 participant_details。
    accountRevoked：没有未软删的账户行，或主账户行（有 gateway 行取它）已撤销。
    nonGateway：没有未软删的 gateway 行，或同 login 还挂着未软删的非 gateway 行
                （报名闸 §1.11 之前报上的老条目、或报名后又接了桥接）。
    Per-entry flags; every participant gets an entry, kinds may be empty."""
    from app.services.gateway_binding import not_removed
    if not participants:
        return {}
    uids = {p.user_id for p in participants}
    logins = {p.mt5_login for p in participants}
    accts: dict[tuple[str, str], list] = defaultdict(list)
    for a in (db.query(MT5Account)
                .filter(MT5Account.user_id.in_(list(uids)), MT5Account.login.in_(list(logins)),
                        not_removed())):
        accts[(a.user_id, a.login)].append(a)
    baselines = {(b.user_id, b.mt5_login): b for b in
                 db.query(PeriodBaseline).filter(
                     PeriodBaseline.period_key == comp_period_key(comp.id))}
    out: dict[str, dict] = {}
    for p in participants:
        key = (p.user_id, p.mt5_login)
        rows = accts.get(key, [])
        gw = next((a for a in rows if a.source == "gateway"), None)
        primary = gw if gw is not None else (rows[0] if rows else None)
        b = baselines.get(key)
        kinds: list[str] = []
        if _cashflow_flagged(b):
            kinds.append("cashflowFlagged")
        if primary is None or primary.revoked_at is not None:
            kinds.append("accountRevoked")
        if gw is None or any(a.source != "gateway" for a in rows):
            kinds.append("nonGateway")
        out[p.id] = {"kinds": kinds, "detail": {
            "balanceAtSignup": float(b.baseline) if b is not None else None,
            "netCashflow": float(b.adjust or 0.0) if b is not None else None,
            "sources": sorted({a.source or "" for a in rows}),
            "revokedReason": primary.revoked_reason if primary is not None else None,
            "hedgePairs": 0,
        }}
    return out


def hedge_pairs(db, comp: Competition, participants: list) -> list[dict]:
    """对冲嫌疑配对（见 HEDGE_WINDOW_SECONDS 的说明）。只看平台单（OPENED_POSITION：成交的
    市价单 + 已挂出的挂单），每条订单只认它自己条目的计分起点之后、比赛结束之前的部分。
    同一对条目、同一品种多次撞上只报一行，count 计次数，at 取第一次。
    Hedge-suspect pairs; one row per (entry pair, symbol), counting occurrences."""
    from app.models import Order
    from app.services.order_payload import OPENED_POSITION
    if len(participants) < 2:
        return []
    by_key = {(p.user_id, p.mt5_login): p for p in participants}
    starts_at, ends_at = _aware(comp.starts_at), _aware(comp.ends_at)
    lower = {k: (max(starts_at, _aware(p.scoring_from)) if p.scoring_from is not None
                 else starts_at)
             for k, p in by_key.items()}
    q = (db.query(Order.user_id, Order.mt5_login, Order.symbol, Order.side, Order.created_at)
           .filter(OPENED_POSITION,
                   Order.user_id.in_(list({k[0] for k in by_key})),
                   Order.mt5_login.in_(list({k[1] for k in by_key})),
                   Order.created_at.isnot(None),
                   Order.created_at >= min(lower.values())))
    if ends_at is not None:
        q = q.filter(Order.created_at <= ends_at)
    events = []
    for uid, login, symbol, side, created_at in q:
        key = (uid, login)
        p = by_key.get(key)
        at = _aware(created_at)
        d = _direction(side)
        if p is None or d == 0 or at < lower[key] or (ends_at is not None and at > ends_at):
            continue
        events.append((at, p, (symbol or "").upper(), d, (side or "").upper()))
    events.sort(key=lambda e: e[0])
    window = timedelta(seconds=HEDGE_WINDOW_SECONDS)
    found: dict[tuple, dict] = {}
    for i, (t1, p1, s1, d1, side1) in enumerate(events):
        for t2, p2, s2, d2, side2 in events[i + 1:]:
            if t2 - t1 > window:
                break
            if p2.id == p1.id or s2 != s1 or d2 != -d1:
                continue
            key = (min(p1.id, p2.id), max(p1.id, p2.id), s1)
            hit = found.get(key)
            if hit is None:
                hit = found[key] = {
                    "a": {"participantId": p1.id, "login": p1.mt5_login, "side": side1},
                    "b": {"participantId": p2.id, "login": p2.mt5_login, "side": side2},
                    "symbol": s1, "at": t1.isoformat(), "count": 0,
                    "sameUser": p1.user_id == p2.user_id,
                }
            hit["count"] += 1
    return sorted(found.values(), key=lambda h: h["at"])


def competition_integrity(db, comp: Competition) -> dict:
    """管理端完整性报告：{flags: [{participantId, login, displayName, kinds, detail}],
    pairs: [{a, b, symbol, at, count, sameUser}]}。只看未取消资格的条目；只读。
    出现在配对里的条目额外带 hedgePair 标记。
    Admin integrity report over non-disqualified entries; read-only."""
    from . import identity
    participants = (db.query(CompetitionParticipant)
                      .filter(CompetitionParticipant.competition_id == comp.id,
                              CompetitionParticipant.disqualified.is_(False))
                      .order_by(CompetitionParticipant.registered_at.asc()).all())
    if not participants:
        return {"flags": [], "pairs": []}
    flags = entry_flags(db, comp, participants)
    pairs = hedge_pairs(db, comp, participants)
    users = {u.id: u for u in
             db.query(User).filter(User.id.in_(list({p.user_id for p in participants})))}

    def _name(uid: str) -> str:
        u = users.get(uid)
        return identity.display_name(u.nickname if u else None, u.email if u else None)

    by_id = {p.id: p for p in participants}
    for h in pairs:
        for side in ("a", "b"):
            pid = h[side]["participantId"]
            h[side]["displayName"] = _name(by_id[pid].user_id)
            f = flags[pid]
            if "hedgePair" not in f["kinds"]:
                f["kinds"].append("hedgePair")
            f["detail"]["hedgePairs"] += 1
    return {
        "flags": [{"participantId": p.id, "login": p.mt5_login, "displayName": _name(p.user_id),
                   "kinds": flags[p.id]["kinds"], "detail": flags[p.id]["detail"]}
                  for p in participants if flags[p.id]["kinds"]],
        "pairs": pairs,
    }


def top_entry_flags(db, comp: Competition, rows: list[dict],
                    top_n: int = SETTLE_FLAG_TOP_N) -> list[dict]:
    """终审闸门用：已排名 rows（带 rank）里前 top_n 名中带完整性标记的条目
    （competition_integrity 的 flags 子集）。
    For the settle gate: flagged entries among the top_n ranked rows."""
    top = {r["login"] for r in rows if r.get("rank") is not None and r["rank"] <= top_n}
    if not top:
        return []
    return [f for f in competition_integrity(db, comp)["flags"] if f["login"] in top]


def _snapshot_one_comp(db, comp: Competition, force: bool = False) -> list[dict]:
    """单场比赛的算行 + 排名 + 快照原子替换（delete-then-insert），不 commit——
    commit 时机由调用方决定：`snapshot_competitions` 每场比赛提交一次；
    `settle_competition` 把这一步并入终审第一段事务，不单独提交。

    返回排好名次的行（在 `compute_comp_rows` 的行基础上原地加了 `rank`），供
    调用方直接使用，不必再回查一遍 `leaderboard_snapshots`。
    """
    key = comp_period_key(comp.id)
    rows = compute_comp_rows(db, comp)
    # 排序键与周期榜完全一致，并列名次同样不存在——理由见 boards.snapshot_boards
    # 同一处的说明（名次必须唯一，下面 settle_competition 才能按 rank == 1 发出
    # 恰好一枚冠军金牌）。
    # Same sort key as the standing board, and likewise no ties — see the note at
    # the same spot in boards.snapshot_boards (ranks must be unique so
    # settle_competition awards exactly one champion on rank == 1).
    rows.sort(key=lambda r: (-r["score"], -r["sample"], r["login"]))
    # 名次没变就不 delete+insert（见 boards.replace_snapshot_rows）；settle 用 force=True 强制写。
    # Skip delete+insert when the ranking is unchanged; settle_competition forces a write.
    replace_snapshot_rows(db, comp.metric, key, rows, force=force)   # 同时写入 r["rank"]
    return rows


# 按需刷新的节流：榜单页会被多个用户同时轮询，每次都重算一遍聚合查询没有
# 意义——同一场比赛 REFRESH_MIN_INTERVAL 秒内只真正算一次，其余请求直接读刚
# 落盘的快照。
#
# 节流状态走 shared_state（配了 REDIS_URL 就跨进程，没配退回进程内内存，行为与
# 原来的模块级 dict 一致）。原来是进程内 dict，多 worker 下每个 worker 各算各
# 的：N 个 worker = N 倍重算，而且两个 worker 可以同时进到下面的
# delete-then-insert，一方 commit 就会撞 leaderboard_snapshots 的唯一约束
# (board, period_key, user_id, mt5_login)，把用户端的 GET /competitions/{id}
# 打成 500。
#
# 用 incr_with_ttl 而不是「读一次再写一次」：自增在两种后端上都是原子的，先到
# 的那个请求拿到 1、真的去算，同一窗口内的其余请求拿到 >1 直接读快照——这正是
# 单靠 get+set 会在并发下漏掉的那一格。
#
# Throttle for on-demand refreshes, kept in shared_state (cross-process when
# REDIS_URL is set, in-process memory otherwise — identical to the module-level
# dict this replaces). As a per-process dict each worker throttled on its own: N
# workers meant N recomputes, and two of them could enter the delete-then-insert
# below at once, so one commit would hit the leaderboard_snapshots unique
# constraint and turn a user's GET /competitions/{id} into a 500.
# incr_with_ttl rather than get-then-set: the increment is atomic on both
# backends, so the first request in a window gets 1 and does the work while the
# rest get >1 and read the snapshot — exactly the race a get+set pair loses.
REFRESH_MIN_INTERVAL = 20.0
_REFRESH_KEY_PREFIX = "comp-refresh:"


def _refresh_throttle_key(comp_id: str) -> str:
    return f"{_REFRESH_KEY_PREFIX}{comp_id}"


def refresh_comp_board(db, comp: Competition, force: bool = False) -> bool:
    """把这场比赛的榜单快照重算一遍并落盘，返回是否真的算了。

    进行中的比赛才有必要刷（未开始没有行、已结束/已终审的行不该再动）；
    `force=True` 由管理端「立即刷新」按钮使用，跳过节流但仍守状态这一关。

    Recomputes and persists this competition's board snapshot; returns whether it
    actually ran. Only a running competition is worth refreshing (an upcoming one
    has no rows, and an ended/settled one's rows must not move). `force=True` comes
    from the admin "refresh now" button: it skips the throttle but still respects
    the status guard.
    """
    from app.services import shared_state

    if comp.status != "running":
        return False
    if not force:
        try:
            n = shared_state.incr_with_ttl(_refresh_throttle_key(comp.id),
                                            int(REFRESH_MIN_INTERVAL))
        except Exception:  # noqa: BLE001 — Redis 抖：视为 n>1，跳过本轮 / Redis blip: skip this round
            n = 2
        if n > 1:
            return False
    try:
        _snapshot_one_comp(db, comp)
        db.commit()
    except IntegrityError:
        # delete-then-insert 撞唯一约束 (board, period_key, user_id, mt5_login)：
        # 节流已经把常态挡掉，剩下的是「节流键刚过期 + 两个 worker 同时进来」这
        # 类窄窗口。这条路径挂在用户端的 GET 上，别人已经写好的快照就是我们要写
        # 的那一份，回滚、报告「这次没算」即可——绝不能让读榜变成 500。
        # The delete-then-insert hit the unique constraint: the throttle covers
        # the common case, leaving only the narrow window where it just expired
        # and two workers entered together. This runs on a user-facing GET and the
        # snapshot the other worker wrote is the one we were about to write, so
        # roll back and report "did not run" — reading a board must never 500.
        db.rollback()
        return False
    return True


def advance_competition_statuses(db, now: datetime) -> dict:
    """按 `starts_at` / `ends_at` 自动推进比赛状态：upcoming→running、running→ended。

    **为什么必须自动推进**：`snapshot_competitions` 只处理 running/ended，所以一场
    过了 `starts_at` 却还挂在 upcoming 的比赛**一行快照都不产生**——用户打开比赛页
    看到的是一张永远空的榜，而报名窗口照常开着。同理 running 不推到 ended 就永远
    进不了终审。这两件事此前完全依赖管理员记得手动点一下状态，忘一次就是一场
    比赛静默失效。

    **哪些状态不碰**：
      · draft：草稿对用户端根本不存在，什么时候发布是运营决定，不是时间决定；
      · settled：终局状态，只能由管理员终审（`settle_competition`）写入。
        自动推进绝不越过 ended→settled 这条线——终审要发勋章、定永久名次，
        还要守 §5.3 的 24 小时宽限期，那必须是人按下去的。

    推进到 running 时对 `enrollment == "auto"` 的比赛顺带自动入场，与管理端
    PATCH 推进状态时的行为一致（auto_enroll 幂等，重复调用安全）。

    Advances competition status by the clock: upcoming→running once `starts_at`
    has passed, running→ended once `ends_at` has. Without this a competition left
    in upcoming produces no snapshot rows at all (snapshot_competitions only
    handles running/ended), so entrants stare at a permanently empty board, and a
    competition left in running can never be settled — both previously depended on
    an admin remembering to click. draft and settled are never touched: publishing
    a draft is an operational decision, and settling is a permanent, badge-awarding
    action that must stay in human hands (see settle_competition and its §5.3
    grace period). Advancing to running also auto-enrolls, matching what the admin
    PATCH does; auto_enroll is idempotent.
    """
    now = _aware(now)
    started = ended = 0
    just_started = []
    comps = (db.query(Competition)
               .filter(Competition.status.in_(("upcoming", "running"))).all())
    for comp in comps:
        if comp.status == "upcoming" and _aware(comp.starts_at) is not None \
                and now >= _aware(comp.starts_at):
            comp.status = "running"
            started += 1
            just_started.append(comp)
        # 不用 elif：一场已经结束的比赛可能整段都没被扫到（循环停过、比赛很短），
        # 这一趟要能把它从 upcoming 一路推到 ended，而不是每趟只走一格。
        # Not elif: a short competition, or one whose window elapsed while the loop
        # was down, must go all the way from upcoming to ended in a single pass.
        if comp.status == "running" and _aware(comp.ends_at) is not None \
                and now >= _aware(comp.ends_at):
            comp.status = "ended"
            ended += 1
    if started or ended:
        db.commit()
    # 自动入场只对「这一趟刚推成 running」的比赛做，不对全部 running 的比赛做：
    # auto_enroll 要全表扫一遍 MT5Account，而这条循环 60 秒一趟——对每场进行中
    # 的比赛每分钟扫一次全账户表不划算。入场时机与管理端 PATCH 推进状态时一致
    # （都是「刚开赛那一下」）。放在 commit 之后：auto_enroll 内部逐账户 commit，
    # 状态先落盘，入场中途失败不会把状态推进一起回滚掉。
    # Auto-enrollment runs only for competitions advanced in *this* pass, not for
    # every running one: auto_enroll scans the whole MT5Account table and this loop
    # ticks every 60s. That matches when the admin PATCH path enrolls (the moment
    # it starts). It runs after the commit because auto_enroll commits per account,
    # so the status change is already persisted and a mid-enrollment failure can't
    # roll the advance back with it.
    enrolled = 0
    for comp in just_started:
        if comp.enrollment == "auto":
            enrolled += auto_enroll(db, comp, now)
    return {"started": started, "ended": ended, "autoEnrolled": enrolled}


def snapshot_competitions(db, now: datetime) -> dict:
    """对 status in ("running", "ended")（未 settled）的比赛算行、排名、快照。

    running：先 `reconcile_deposits(db, comp_key, now=now, bounds=(starts_at,
    ends_at))`（基线拍照在报名/自动入场时完成，快照不补拍），再算行。
    ended（未 settled）：只重算计分，不再对账（与周期榜「结束周期不对账」的
    语义一致）。settled/draft/upcoming 绝不触碰。

    单场比赛的算行/排名/快照替换逻辑复用 `_snapshot_one_comp`——`settle_competition`
    终审前刷新快照走的是同一份实现，不重复维护两套。
    """
    comps = (db.query(Competition)
               .filter(Competition.status.in_(("running", "ended"))).all())
    total_rows = 0
    for comp in comps:
        key = comp_period_key(comp.id)
        starts_at = _aware(comp.starts_at)
        ends_at = _aware(comp.ends_at)
        if comp.status == "running":
            reconcile_deposits(db, key, now=now, bounds=(starts_at, ends_at))
        rows = _snapshot_one_comp(db, comp)
        total_rows += len(rows)
        db.commit()
    return {"comps": len(comps), "rows": total_rows}


# 报名时经网关实时读一次资金（设计 2026-10-08 §1.12）。库里的 balance 是轮询写的，
# 最长有一个轮询周期的陈旧——精确金额赛差一分钱就是门槛内外之别，所以报名这一下
# 必须读实时值；读不到宁可 503 让用户重试，也绝不回落到旧值。
# Live funds read at signup (§1.12): the stored balance lags by up to a poll, which
# matters for exact-amount competitions. Unreachable → 503, never the stale value.
LIVE_FUNDS_TIMEOUT = 20.0
MSG_FUNDS_UNAVAILABLE = ("暂时无法核对账户资金，请稍后再试 / "
                         "Unable to verify account funds right now, please try again later")


def read_live_funds(acct) -> tuple[float, float]:
    """经网关实时读 (balance, equity)。register 端点是同步 def（跑在线程池里），所以走
    run_on_main_loop 把协程排进主循环——与 routers/gateway.refresh_gateway_account 同一种调法。
    Reads (balance, equity) live from the gateway via run_on_main_loop, since the
    register endpoint is a sync def running in the threadpool."""
    from app.services import gateway_client as gw
    try:
        rsp = gw.run_on_main_loop(gw.get_account(int(acct.login)), timeout=LIVE_FUNDS_TIMEOUT)
    except Exception:  # noqa: BLE001 — 超时 / 连接错误一律当「读不到」/ any failure = unreadable
        rsp = None
    if rsp is None:
        raise HTTPException(status_code=503, detail=MSG_FUNDS_UNAVAILABLE)
    return float(rsp.balance or 0.0), float(rsp.equity or 0.0)


MSG_GATEWAY_ONLY = ("比赛仅接受直连（账号密码绑定）的账户，请先在绑定页直连该账户 / "
                    "Competitions only accept direct-connect accounts; "
                    "bind this account with its password first")
MSG_BRIDGE_DUPLICATE = ("该账户同时通过桥接程序连接，请先在账户页删除桥接连接再报名 / "
                        "This account is also connected through the bridge app; "
                        "remove that connection before entering")
MSG_ACCOUNT_REVOKED = ("账户授权已失效，请重新验证后再报名 / "
                       "This account's authorization has lapsed; re-verify it before entering")
MSG_ENTRY_TAKEN = ("该账户已被其他用户报名，请联系客服 / "
                   "This account has already been entered by another user, please contact support")


def register_participant(db, comp: Competition, user: User, mt5_login: str,
                          now: datetime) -> CompetitionParticipant:
    """报名参赛（设计 §1.7/§1.8；2026-10-08 §1.11–§1.13）：仅 `enrollment=="signup"` 的比赛
    可报名，报名窗口内（`reg_opens_at <= now < reg_closes_at`；任一边未配置视为窗口未开放）。

    账户闸（§1.11）：必须是本人名下、`source='gateway'`、`revoked_at IS NULL`、未软删，且本人
    没有同 login 的未删除桥接行——桥接行的成交与资金都是用户自己电脑上报的，比赛只认
    服务端从券商直接读到的那条通道。类型须与赛道相符（real 收实盘 / demo 收模拟）且余额已同步。

    撞号（§1.13）：同一场里这个 login 已被别人报名 → 409；是本人的 → 原样返回（幂等）。

    参赛行 + `period_baselines(comp:<id>)` 基线在同一事务内一并插入、一次 commit——中途崩溃
    不会留下有参赛行却没基线的半截状态。撞唯一约束（并发重复报名）→ 回滚后按上面的撞号规则处理。
    """
    if comp.enrollment != "signup":
        raise HTTPException(status_code=400, detail="本比赛为自动参赛 / This competition auto-enrolls")
    if comp.status not in ("upcoming", "running"):
        raise HTTPException(status_code=400,
                            detail="比赛已结束，无法报名 / Competition already finished")

    now = _aware(now)
    opens, closes = _aware(comp.reg_opens_at), _aware(comp.reg_closes_at)
    if opens is None or closes is None or not (opens <= now < closes):
        raise HTTPException(status_code=400, detail="不在报名窗口内 / Registration window closed")

    from app.services.gateway_binding import not_removed
    track_detail = ("仅实盘账户可参赛 / Only real accounts may enter" if comp.track == "real"
                    else "仅模拟账户可参赛 / Only demo accounts may enter")
    rows = (db.query(MT5Account)
              .filter(MT5Account.user_id == user.id, MT5Account.login == mt5_login,
                      not_removed()).all())
    if not rows:
        raise HTTPException(status_code=400, detail=track_detail)
    acct = next((r for r in rows if r.source == "gateway"), None)
    if acct is None:
        raise HTTPException(status_code=400, detail=MSG_GATEWAY_ONLY)
    if any(r.source != "gateway" for r in rows):
        raise HTTPException(status_code=400, detail=MSG_BRIDGE_DUPLICATE)
    if acct.revoked_at is not None:
        raise HTTPException(status_code=400, detail=MSG_ACCOUNT_REVOKED)
    if acct.trade_mode not in track_modes(comp.track):
        raise HTTPException(status_code=400, detail=track_detail)
    if acct.balance is None:
        raise HTTPException(status_code=400,
                            detail="账户余额未同步，请先连接账户 / Account balance not synced yet")

    # 撞号 / 幂等：先查已有条目，免得为一个早已报上的账户再去网关读一次资金。
    # Taken / idempotent: check before any gateway read.
    existing = (db.query(CompetitionParticipant)
                  .filter(CompetitionParticipant.competition_id == comp.id,
                          CompetitionParticipant.mt5_login == mt5_login).first())
    if existing is not None:
        if existing.user_id != user.id:
            raise HTTPException(status_code=409, detail=MSG_ENTRY_TAKEN)
        return existing

    # 每人每场的条目上限（见 _TRACK_MAX_ENTRIES 的说明）。只数「别的 login」——
    # 重复报同一个账户是上面的幂等路径。被取消资格的条目照数：取消资格不退还名额，
    # 否则「报满 → 故意违规 → 腾出名额再报」就成了绕过这道闸的后门。
    # Per-user entry cap (see _TRACK_MAX_ENTRIES). Only *other* logins are counted;
    # disqualified entries still count so a disqualification never frees a slot.
    cap = max_entries_per_user(comp.track)
    existing_entries = (db.query(CompetitionParticipant)
                          .filter(CompetitionParticipant.competition_id == comp.id,
                                  CompetitionParticipant.user_id == user.id,
                                  CompetitionParticipant.mt5_login != mt5_login).count())
    if existing_entries >= cap:
        raise HTTPException(
            status_code=400,
            detail=(f"每人每场最多报名 {cap} 个账户 / "
                    f"At most {cap} account(s) per person per competition"))

    # 本金门槛在报名时就挡（与计分同一个 comp_gates，两边不分叉），用的是网关实时读到的
    # 资金。上下限相等 = 只收这一个金额，且要求无持仓（净值与余额差在 BASELINE_EPS 内）——
    # 否则带着浮盈 / 浮亏报名，报名本金（余额）就不是这个人真实的起点。
    # Capital gates at signup on the live funds, same comp_gates as scoring. Equal
    # bounds = that exact amount *and* flat (equity within BASELINE_EPS of balance).
    from app.services.settings_store import get_gamification_settings
    gates = comp_gates(comp, get_gamification_settings(db))
    min_baseline, max_baseline = gates["min_baseline_usd"], gates["max_baseline_usd"]
    balance, equity = read_live_funds(acct)
    if max_baseline is not None and min_baseline == max_baseline:
        if not baseline_in_range(balance, min_baseline, max_baseline):
            raise HTTPException(
                status_code=400,
                detail=(f"本场只接受资金正好 {max_baseline:g} USD 的账户 / "
                        f"This competition only accepts accounts with exactly {max_baseline:g} USD"))
        if abs(equity - balance) > BASELINE_EPS:
            raise HTTPException(
                status_code=400,
                detail=(f"本场要求报名时无持仓且资金正好 {max_baseline:g} USD，请先平仓 / "
                        f"This competition requires exactly {max_baseline:g} USD and no open "
                        f"positions at signup; close all positions first"))
    if min_baseline and not baseline_in_range(balance, min_baseline, None):
        raise HTTPException(
            status_code=400,
            detail=(f"账户余额低于本场最低参赛金额 {min_baseline:g} USD / "
                    f"Account balance is below this competition's minimum of {min_baseline:g} USD"))
    if max_baseline is not None and not baseline_in_range(balance, 0.0, max_baseline):
        raise HTTPException(
            status_code=400,
            detail=(f"账户余额高于本场最高参赛金额 {max_baseline:g} USD / "
                    f"Account balance is above this competition's maximum of {max_baseline:g} USD"))

    key = comp_period_key(comp.id)
    scoring_from = max(_aware(comp.starts_at), now)
    # 公开比赛报名即同意公开昵称（报名弹窗写明，设计 §1.8）；其余比赛不表态（NULL = 匿名）。
    # 局部 import：public_board 反过来依赖本模块。
    # Entering a public competition consents to the nickname being shown (the dialog
    # says so, §1.8); otherwise undecided (NULL = anonymous). Local import:
    # public_board depends on this module.
    from .public_board import initial_public_name
    public_name = initial_public_name(db, comp)
    db.add(CompetitionParticipant(competition_id=comp.id, user_id=user.id, mt5_login=mt5_login,
                                  scoring_from=scoring_from, public_name=public_name))
    db.add(PeriodBaseline(user_id=user.id, mt5_login=mt5_login, period_key=key,
                          baseline=balance, taken_at=now))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = (db.query(CompetitionParticipant)
                      .filter(CompetitionParticipant.competition_id == comp.id,
                              CompetitionParticipant.mt5_login == mt5_login).first())
        if existing is not None:
            # 并发撞号：别人抢先报上了同一个 login → 409；是本人的 → 幂等返回。
            # Concurrent collision: someone else's entry → 409; our own → idempotent.
            if existing.user_id != user.id:
                raise HTTPException(status_code=409, detail=MSG_ENTRY_TAKEN)
            return existing
        # 撞的不是参赛行的唯一约束，而是 period_baselines 的——孤儿基线（此前
        # 某次写入只落了基线没落参赛行，成因不追究，防御性兜底）：基线已在，
        # 复用它（不重拍 taken_at），只补插参赛行。
        db.add(CompetitionParticipant(competition_id=comp.id, user_id=user.id,
                                      mt5_login=mt5_login, scoring_from=scoring_from,
                                      public_name=public_name))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail="报名状态异常，请联系管理员 / Registration state error, contact admin")

    return (db.query(CompetitionParticipant)
              .filter(CompetitionParticipant.competition_id == comp.id,
                      CompetitionParticipant.mt5_login == mt5_login).first())


def auto_enroll(db, comp: Competition, now: datetime) -> int:
    """自动入场（设计 §1.7/§1.8）：类型与赛道相符（real 收实盘 / demo 收模拟）、余额非 NULL、属主
    未退榜的账户逐个写参赛行 + 拍基线，`scoring_from = comp.starts_at`（自动参赛的
    比赛没有报名，起点即开赛）。已入场（撞唯一约束）静默跳过——幂等，可反复调用
    （由状态推进到 running 的 admin 端点触发，Task 5）。返回新入场数。
    """
    if comp.enrollment != "auto":
        return 0    # 防误用：signup 比赛不该被批量拉入参赛（无声吞掉，不抛错）

    now = _aware(now)
    key = comp_period_key(comp.id)
    scoring_from = _aware(comp.starts_at)
    opted_out = {r[0] for r in db.query(User.id).filter(User.leaderboard_opt_out.is_(True))}
    already = {p.mt5_login for p in
               db.query(CompetitionParticipant).filter(
                   CompetitionParticipant.competition_id == comp.id)}
    from app.services.gateway_binding import not_removed
    accounts = (db.query(MT5Account)
                  .filter(MT5Account.trade_mode.in_(track_modes(comp.track)),
                          MT5Account.balance.isnot(None), not_removed()).all())
    # 逐账户 commit 与 `boards.ensure_baselines` 同一个取舍：下面的 IntegrityError
    # 就是幂等手段（已入场的静默跳过），批量提交会让一行撞约束毁掉整批，需要
    # 另设幂等设计——理由详见 ensure_baselines 里的那段说明。
    # Per-account commit, same trade-off as boards.ensure_baselines: the
    # IntegrityError below is the idempotency mechanism, and batching would let
    # one colliding row take out the whole batch. See the note there.
    enrolled = 0
    for acct in accounts:
        if acct.user_id in opted_out or acct.login in already:
            continue
        db.add(CompetitionParticipant(competition_id=comp.id, user_id=acct.user_id,
                                      mt5_login=acct.login, scoring_from=scoring_from))
        db.add(PeriodBaseline(user_id=acct.user_id, mt5_login=acct.login, period_key=key,
                              baseline=acct.balance, taken_at=now))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue
        already.add(acct.login)
        enrolled += 1
    return enrolled


def settle_competition(db, comp: Competition, admin_id: str,
                        now: datetime | None = None, acknowledge_flags: bool = False) -> dict:
    """终审（设计 §1.7/§1.9，Phase 3 Task 4；§5.3 宽限期，Task F）：不可重跑，
    一切以 status 为闸。

    §5.3：比赛结束（`ends_at`，计分上界）后 24 小时内不可终审——留出宽限期让
    迟到入库的平仓行与结束持仓快照（capture_end_positions，结束时还开着的平台单
    按当时浮动盈亏计入，见 _end_valuation）都收进最后一次快照。宽限期从 `ends_at` 起算，不是从 status 被人工推到
    "ended" 那一刻起算：管理端状态推进是人工操作，可能早于/晚于 ends_at，
    只有 ends_at 才是 §5.3 里定义的计分截止点。
    Grace period counts from `ends_at` (the scoring upper bound per §5.3), not
    from whenever an admin manually advances status to "ended" — the two can
    diverge, and only `ends_at` is the cutoff the spec defines.

    终审前先刷新一遍本场比赛的快照（`_snapshot_one_comp`，与比赛快循环
    `snapshot_competitions` 共用同一份实现）：最近一次落盘的快照总有一段陈旧窗口
    （快循环最长约一分钟）——「取消资格 → 立刻终审」这个自然的管理流程会踩到这个陈旧窗口：
    被取消资格的人还占着上一次快照里的名次（compute_comp_rows 已经把 disqualified
    参赛者排除在计分之外，但那是下一次快照才生效），若终审直接读旧快照，永久
    名次表会把他钉在榜上、幸存者拿不到该有的名次（比如没有 rank 1）、
    comp_winner 也会因此静默漏发。这里的刷新和后面「名次 + status + 审计」的
    落盘算在同一段事务里，一起 commit。

    两段式、中间夹一次 commit，且顺序不可换：第一段把（刷新后的）名次和
    status="settled" 连同审计行一起落盘并 commit——这一段完成后，比赛就已经
    终局，`comp.status != "ended"` 的前置校验会挡住任何重复调用。第二段才发
    奖：award_badge 内部自行 commit（沿用既有 house pattern），单枚失败只会
    漏发一枚勋章（可人工补发，幂等），绝不会传导回去把已经写死的名次或 status
    撤回——所以失败被捕获进返回值的 badgeErrors，而不是抛出让调用方以为终审
    本身失败了。

    完整性闸门（2026-10-08 §1.14）：刷新后的前 SETTLE_FLAG_TOP_N 名里任一条目带完整性标记
    （对冲嫌疑 / 出入金 / 账户已撤销 / 非直连，见 competition_integrity）→ 回滚刷新、400，
    除非 acknowledge_flags=True——那样照常终审，并把被放行的 login 写进审计
    （competition:<id>:acknowledgeFlags）。
    Integrity gate: any flagged entry in the refreshed top N → roll back and 400,
    unless acknowledge_flags=True, which settles and audits the waived logins.
    """
    # 内测期这里有过 force=True 跳过全部前置条件的分支（2026-09-04 为测试放开），
    # 上线前移除（2026-09-05）：早于实际结束时间终审会漏掉尚未平仓和迟到的单，
    # 而名次一旦定格就是永久的。要在测试库里快速终审，改 ends_at 或改时钟，不要
    # 给生产代码留后门。
    # A force=True bypass lived here during the closed beta (2026-09-04) and was
    # removed before launch (2026-09-05): settling early drops still-open and
    # late closes, and ranks are permanent once locked. To settle quickly in a test
    # database, move ends_at or the clock — don't leave a backdoor in production code.
    now = _aware(now) or datetime.now(timezone.utc)
    if comp.status != "ended":
        raise HTTPException(
            status_code=400,
            detail="仅可终审已结束的比赛 / Only ended competitions can be settled")
    if now < _aware(comp.ends_at) + timedelta(hours=24):
        raise HTTPException(
            status_code=400,
            detail="比赛结束后需等待 24 小时方可终审，以收齐迟到的平仓 / "
                    "Settlement opens 24 hours after the competition ends, "
                    "so late closes are counted")

    rows = _snapshot_one_comp(db, comp, force=True)   # 先落定最新名次，再读——见上方 docstring
    # 完整性闸门：读的是刚刷新的名次（rows 已带 rank）。挡下时回滚，连刷新一起撤掉——
    # 名次只能在真正终审时落盘。
    # Integrity gate on the freshly ranked rows; on refusal roll back the refresh too.
    flagged = top_entry_flags(db, comp, rows)
    if flagged and not acknowledge_flags:
        db.rollback()
        logins = "、".join(f["login"] for f in flagged)
        raise HTTPException(
            status_code=400,
            detail=(f"前 {SETTLE_FLAG_TOP_N} 名中有 {len(flagged)} 个条目带完整性标记（{logins}），"
                    f"请先查看完整性报告；核实后确认知悉再终审 / "
                    f"{len(flagged)} top-{SETTLE_FLAG_TOP_N} entries carry integrity flags "
                    f"({logins}); review the integrity report, then settle with acknowledgeFlags"))
    by_login = {p.mt5_login: p for p in
                db.query(CompetitionParticipant).filter(
                    CompetitionParticipant.competition_id == comp.id)}

    ranked = 0
    finisher_users: set[str] = set()
    podium_users: set[str] = set()
    winner_user = None
    for r in rows:
        participant = by_login.get(r["login"])
        # 双保险：disqualified 的参赛者理论上根本不会出现在刚刷新的 rows 里
        # （compute_comp_rows 已经把他们排除在计分之外），但终审是终局动作，
        # 宁可多判一次也不让意外情况把取消资格的人写进名次或发出奖。
        if participant is None or participant.disqualified:
            continue
        participant.final_score = r["score"]
        participant.final_rank = r["rank"]
        ranked += 1
        finisher_users.add(participant.user_id)
        if r["rank"] <= 3:
            podium_users.add(participant.user_id)
        if r["rank"] == 1:
            winner_user = participant.user_id

    comp.status = "settled"

    # 审计走 services/audit.log_change（admin 路由的 _log_change 就是它的别名）——
    # 服务层不 import 路由模块。old/new 特意给出两个不同的值——两者相等时直接静默跳过写入。
    # Audit via services/audit.log_change (the admin router's _log_change is an
    # alias of it); the service layer never imports a router.
    from app.services.audit import log_change as _log_change
    _log_change(db, admin_id, admin_id, f"competition:settle:{comp.id}", "ended", "settled")
    if flagged:
        # 管理员确认知悉后放行：被放行的条目留痕 / waived flagged entries are audited
        _log_change(db, admin_id, admin_id, f"competition:{comp.id}:acknowledgeFlags",
                    "", ",".join(sorted(f["login"] for f in flagged)))

    db.commit()   # 名次 + status + 审计：终局状态到此为止，下面发奖失败不会回退到这里

    badges: list[dict] = []
    badge_errors: list[dict] = []

    def _award(user_id: str, badge_id: str, tier: int = 0) -> None:
        try:
            if award_badge(db, user_id, badge_id, tier):
                badges.append({"userId": user_id, "badgeId": badge_id, "tier": tier})
        except Exception as exc:
            # award_badge 自己只兜住 IntegrityError；任何其它异常（推送逻辑之外，
            # 比如 commit 中途的连接错误）会把 session 撂在一个"脏"事务里——
            # Postgres 下这类 session 后续任何语句都会被级联拒绝（当前语句失败后
            # 事务已 abort），必须先 rollback 清空，才能继续发下一枚勋章或做别的
            # 查询。失败本身不重新抛出，收进 badge_errors 供人工补发。
            db.rollback()
            badge_errors.append({"userId": user_id, "badgeId": badge_id, "error": str(exc)})

    # 赛场勋章一枚三档：完赛铜 / 前三银 / 冠军金。每人只发其最高档一次——
    # award_badge 只升不降，之前的比赛拿过银的这次夺冠会升成金。
    # One arena badge, three tiers: finisher bronze / podium silver / champion gold.
    # Each user gets their highest tier once; award_badge only moves up, so a
    # silver from an earlier competition becomes gold on winning this one.
    arena_tier: dict[str, int] = {}
    for uid in finisher_users:
        arena_tier[uid] = max(arena_tier.get(uid, 0), 1)
    for uid in podium_users:
        arena_tier[uid] = max(arena_tier.get(uid, 0), 2)
    if winner_user is not None:
        arena_tier[winner_user] = 3
    for uid, tier in arena_tier.items():
        _award(uid, "arena", tier)

    # 老将：完赛场次到档就发，和赛场勋章同一场到手。本场的 final_rank 与 status
    # 已在上面那次 commit 落盘，所以这里数到的场次已含本场。每小时循环也会判
    # 这枚（badge_judges._j_campaigner），这里只是让"第三场完赛"当场就有反馈。
    # Campaigner: awarded here so the third finish shows up at settlement, not an
    # hour later. This competition is already committed, so the count includes it.
    for uid in finisher_users:
        tier = campaigner_tier(finished_competition_count(db, uid))
        if tier:
            _award(uid, "campaigner", tier)

    # 卫冕王：按 starts_at 升序取全部已 settled 的比赛（含本场——本场的 status
    # 与 final_rank 已经在上面那次 commit 里落盘），相邻两届冠军是同一人才发奖。
    settled_comps = (db.query(Competition)
                        .filter(Competition.status == "settled")
                        .order_by(Competition.starts_at.asc()).all())
    # 冠军一次查完：以前是对每场比赛单独发一次 .first()，比赛场次只增不减，
    # 结算耗时随历史线性变长。final_rank == 1 每场至多一人（final_rank 唯一），
    # 所以按 competition_id 建字典不会互相覆盖；没有冠军的场次在字典里缺席，
    # 下面 .get() 读出 None，与原先的语义一致。
    # Fetch every champion in one query: this used to issue one .first() per
    # settled competition, and the count only grows, so settlement got slower
    # with every season. final_rank == 1 holds at most one row per competition,
    # so keying by competition_id cannot collide; competitions without a
    # champion are simply absent and .get() below yields None as before.
    winner_by_comp: dict[str, str | None] = {}
    if settled_comps:
        rows = (db.query(CompetitionParticipant.competition_id, CompetitionParticipant.user_id)
                  .filter(CompetitionParticipant.competition_id.in_([c.id for c in settled_comps]),
                          CompetitionParticipant.final_rank == 1).all())
        winner_by_comp = {comp_id: uid for comp_id, uid in rows}
    for prev, cur in zip(settled_comps, settled_comps[1:]):
        w_prev, w_cur = winner_by_comp.get(prev.id), winner_by_comp.get(cur.id)
        if w_prev is not None and w_prev == w_cur:
            _award(w_cur, "comp_back_to_back")

    return {"ranked": ranked, "badges": badges, "badgeErrors": badge_errors}


def _end_capture_todo() -> list[tuple[str, str, str, str | None, bool]]:
    """已结束（未终审）比赛里还没拍结束持仓快照的参赛条目：
    [(participant_id, user_id, login, 账户来源, 账户可读)]。"""
    from app.core.database import SessionLocal
    db = SessionLocal()
    try:
        rows = (db.query(CompetitionParticipant, MT5Account.source, MT5Account.revoked_at)
                  .join(Competition, Competition.id == CompetitionParticipant.competition_id)
                  .outerjoin(MT5Account, (MT5Account.user_id == CompetitionParticipant.user_id)
                             & (MT5Account.login == CompetitionParticipant.mt5_login))
                  .filter(Competition.status == "ended",
                          CompetitionParticipant.disqualified.is_(False),
                          CompetitionParticipant.end_positions.is_(None)).all())
        return [(p.id, p.user_id, p.mt5_login, source,
                 source is not None and revoked_at is None)
                for p, source, revoked_at in rows]
    finally:
        db.close()


def _save_end_captures(snaps: dict[str, str]) -> None:
    from app.core.database import SessionLocal
    db = SessionLocal()
    try:
        for pid, raw in snaps.items():
            p = db.get(CompetitionParticipant, pid)
            if p is not None and p.end_positions is None:
                p.end_positions = raw
        db.commit()
    finally:
        db.close()


async def capture_end_positions(now: datetime | None = None) -> int:
    """比赛一进入 ended，就给每个参赛账户拍一张结束持仓快照（仓位号 -> 浮动盈亏），
    供 _end_valuation 把结束时还开着的平台单计入成绩。比赛循环每轮调用，只处理还没
    拍到的条目，所以读失败的下一轮（60 秒后）自动重试。

    gateway 账户直接向网关读（离线用户也读得到）；桥接账户只能用桥接最近推上来的
    持仓缓存。账户已解绑 / 不在、或桥接没有缓存的，记一张空快照（不再重试）：读不到
    就无从估值，按「结束时没有持仓」处理。
    As soon as a competition is ended, snapshot each entry's open positions
    (position id -> floating P/L) for _end_valuation. Runs every competition-loop
    tick and only touches entries not yet captured, so a failed read retries on the
    next tick. Gateway accounts are read from the gateway (works for offline users);
    bridge accounts can only use the bridge's latest pushed snapshot. Unbound
    accounts, or bridge accounts with no snapshot, get an empty one (no retry).
    """
    from starlette.concurrency import run_in_threadpool
    todo = await run_in_threadpool(_end_capture_todo)
    if not todo:
        return 0
    from app.services import gateway_client as gw
    from app.services.connection_manager import manager
    at = (now or datetime.now(timezone.utc)).isoformat()
    snaps: dict[str, str] = {}
    for pid, uid, login, source, readable in todo:
        pnl = None
        if not readable:
            pnl = {}
        elif source == "gateway":
            try:
                rows, err = await gw.get_positions(int(login))
            except Exception:
                rows, err = [], "exception"
            if not err:
                pnl = {str(r.ticket): float(r.profit or 0.0) for r in rows}
        else:
            rows = await manager.get_positions_shared_async(uid)
            pnl = {str(r.get("ticket")): float(r.get("profit") or 0.0)
                   for r in (rows or []) if str(r.get("login")) == str(login)}
        if pnl is not None:
            snaps[pid] = json.dumps({"at": at, "pnl": pnl})
    if snaps:
        await run_in_threadpool(_save_end_captures, snaps)
    return len(snaps)
