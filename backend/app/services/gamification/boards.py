"""榜单计算（设计 §1.5/§1.6/§4）：按账户拍基线、对账入金、整仓计分、快照排名。"""
import logging
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError

from app.models import ClosedTrade, LeaderboardSnapshot, MT5Account, PeriodBaseline, User
from .periods import active_period_keys, period_bounds

log = logging.getLogger("gamification")
RECONCILE_TOLERANCE = 0.01
REAL = 2


def _aware(dt):
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def ensure_baselines(db, period_key: str, now: datetime) -> int:
    """对每个实盘、balance 非 NULL、属主未退榜的账户，若该 (user, login, period) 无
    基线则插入（baseline=balance, taken_at=now）。只对当前进行中的周期调用。
    """
    opted_out = {r[0] for r in db.query(User.id).filter(User.leaderboard_opt_out.is_(True))}
    existing = {(r.user_id, r.mt5_login) for r in
                db.query(PeriodBaseline).filter(PeriodBaseline.period_key == period_key)}
    created = 0
    accounts = (db.query(MT5Account)
                  .filter(MT5Account.trade_mode == REAL,
                          MT5Account.balance.isnot(None)).all())
    for a in accounts:
        if a.user_id in opted_out or (a.user_id, a.login) in existing:
            continue
        db.add(PeriodBaseline(user_id=a.user_id, mt5_login=a.login,
                              period_key=period_key, baseline=a.balance, taken_at=now))
        try:
            db.commit()
            created += 1
        except IntegrityError:
            # 并发拍照撞了唯一约束（同一 (user_id, mt5_login, period_key) 已被另一
            # 趟循环插入）——静默忽略，不是错误。
            db.rollback()
    return created


def _realized_since(db, user_id, login, since, until) -> float:
    """sum(ClosedTrade.profit)，不过滤 verified：对账针对的是余额变动，任何已
    报告的平仓（无论能否被服务端核对）都会真实地改变 MT5 账户余额。
    """
    q = (db.query(ClosedTrade)
           .filter(ClosedTrade.user_id == user_id, ClosedTrade.mt5_login == login,
                   ClosedTrade.closed_at >= since))
    if until is not None:
        q = q.filter(ClosedTrade.closed_at < until)
    return sum(leg.profit or 0.0 for leg in q.all())


def reconcile_deposits(db, period_key: str, now: datetime = None,
                        bounds: tuple[datetime, datetime] | None = None) -> int:
    """对每条基线，若账号行仍在且 balance 非 NULL：
    delta = balance − (baseline + adjust) − realized_since(taken_at, login)；
    delta > RECONCILE_TOLERANCE → adjust += delta（入金并入分母）；
    负 delta（出金）忽略；账号行已不在（解绑）→ 冻结不动，不报错。

    只对当前进行中的周期调用（结束周期不对账）：周期结束后账户仍在正常交易，
    期后的盈亏会被 _realized_since 当成「realized」减掉，从而把期后的正常
    交易误判成入金、永久污染一个已封存周期的分母——即使在 48h 重算窗内也不
    对账，重算窗只重算榜单快照，不重开基线/对账。

    `now` 可注入（默认取系统当前 UTC 时间），供调用方传入统一的时钟基准——
    Task 5 的 `snapshot_boards(db, now)` 会把它接的 now 原样透传到这里，保证
    一趟批处理里「现在」只有一个含义；测试也借此固定成确定性时间，不受真实
    时钟推移影响。

    `bounds` 可选：显式传 (start, end) 时跳过 `period_bounds(period_key)` 解析——
    比赛 key（`comp:<id>`）不是 `period_bounds` 能解析的自然周/月格式，调用方
    （Task 2 的比赛快照）传比赛的 (starts_at, ends_at) 走这条路；默认 None 时
    行为与 Phase 2 完全一致（周期榜调用路径零变化）。
    """
    _start, end = bounds if bounds is not None else period_bounds(period_key)
    now = now if now is not None else datetime.now(timezone.utc)
    if now >= end:
        return 0    # 已结束周期：期后交易会污染对账，冻结不动（重算窗内也不对账）
    acct_map = {(a.user_id, a.login): a.balance
                for a in db.query(MT5Account).filter(MT5Account.balance.isnot(None))}
    adjusted = 0
    for row in db.query(PeriodBaseline).filter(PeriodBaseline.period_key == period_key):
        balance = acct_map.get((row.user_id, row.mt5_login))
        if balance is None:
            continue                                    # 解绑/无余额：冻结不动
        realized = _realized_since(db, row.user_id, row.mt5_login,
                                   _aware(row.taken_at), end)
        delta = balance - (row.baseline + row.adjust) - realized
        if delta > RECONCILE_TOLERANCE:
            row.adjust += delta                          # 入金并入分母
            adjusted += 1
    if adjusted:
        db.commit()
    return adjusted


def _resolved_in_period(db, user_id, logins, period_key, taken_at_by_login,
                         bounds: tuple[datetime, datetime] | None = None):
    """整仓判定 + 归期：返回 login -> list[profit]。归期 = 最后一腿时间落在
    [max(期初, 该账户 taken_at), 期末)。订单锚定 lifetime（开仓可早于期初）。

    `bounds` 可选：显式传 (start, end) 时跳过 `period_bounds(period_key)` 解析
    （比赛 key 不是自然周/月格式，解析不了）；默认 None 时行为与 Phase 2 完全
    一致。
    """
    from .stats import _filled_orders, _legs_by_position, _resolve
    from app.services.trade_performance import position_id_of
    start, end = bounds if bounds is not None else period_bounds(period_key)
    orders = [o for o in _filled_orders(db, user_id, cutoff=None)
              if o.trade_mode == REAL and o.mt5_login in logins]
    keys = {(o.mt5_login, position_id_of(o)) for o in orders if position_id_of(o)}
    legs_map = _legs_by_position(db, user_id, keys)
    out = defaultdict(list)
    for o, p in _resolve(orders, legs_map):
        legs = legs_map[(o.mt5_login, position_id_of(o))]
        last_close = _aware(max(l.closed_at for l in legs))
        lower = max(start, _aware(taken_at_by_login[o.mt5_login]))
        if lower <= last_close < end:
            out[o.mt5_login].append(p)
    return out


def board_gates(gset: dict) -> dict:
    """把游戏化设置收敛成两块榜（及走同一套规则的比赛榜）共用的入榜门槛。

    与 `settings_store._load_gamification_from_db` 的坏值兜底是两层不同的
    防线：那边保证存进缓存的值本身可信（读时已经做过 int/float 转换和
    负值/坏值回退默认），这里再做一次 `max(1, ...)` 下限收敛，是因为门槛的
    语义下限（笔数至少 1）比"值是不是能转成 int"更严格——两层防线独立，
    任何一层失手另一层仍能兜住，不能只留一层。

    `compute_board_rows`（周期榜）与 `compute_comp_rows`（比赛榜，复用同一
    metric 的门槛）都必须调用这个函数，不能各自重复 max(1, int(...)) 的算法——
    两处逻辑分叉是历史上真实出现过的 bug 来源（一处改了下限、另一处忘改）。
    `build_board_rows_payload` 把它下发给前端展示，同一个函数保证"页面上写的
    门槛"与"计算时用的门槛"永远是同一个数。

    Distills gamification settings into the entry gates shared by both boards
    (and by the competition board, which reuses whichever metric's rules
    apply).

    This is a second line of defense on top of
    `settings_store._load_gamification_from_db`'s own bad-value fallback: that
    one guarantees the cached value is itself trustworthy (int/float coercion
    and negative/bad-value fallback already happened at read time); this one
    additionally floors the value at its semantic minimum (a trade count can
    never mean "fewer than 1"), which is a stricter requirement than merely
    "convertible to int". The two layers are independent so a failure in
    either is still caught by the other.

    Both `compute_board_rows` (the standing boards) and `compute_comp_rows`
    (competitions, which reuse whichever metric's rules apply) must call this
    rather than each re-deriving max(1, int(...)) — divergence between the two
    has been a real bug source (one side's floor gets changed, the other
    forgotten). `build_board_rows_payload` hands the same dict to the frontend,
    so the number shown on the page and the number used to compute the rows
    are guaranteed to be the same value.
    """
    return {
        "min_baseline_usd": float(gset.get("min_baseline_usd", 500.0)),
        "min_trades_return": max(1, int(gset.get("min_trades_return", 5))),
        "min_trades_winrate": max(1, int(gset.get("min_trades_winrate", 20))),
    }


def compute_board_rows(db, period_key: str) -> dict:
    """两榜行计算（设计 §4.1）：按有基线的账户分组、整仓归期过滤、双闸门槛。
    返回 {"return_pct": [...], "win_rate": [...]}，行已过滤门槛、未排名。

    退榜（User.leaderboard_opt_out）在这里再判一次：即使基线已在退榜前拍好，
    只要用户当下仍标记退榜，其名下全部账户在本次快照计算时直接跳过（设计
    §4.1）——做到「下轮快照即消失」。注意这是计算期（compute）层面的过滤，
    不能挪到 build_leaderboard_payload（读取期）：那样会把已封存的历史榜也
    按当前状态重新过滤，等于回溯改写已封存快照，违反封存不可变的约定。
    """
    from app.services.settings_store import get_gamification_settings
    gset = get_gamification_settings(db)
    gates = board_gates(gset)
    min_baseline = gates["min_baseline_usd"]
    min_trades_return = gates["min_trades_return"]
    min_trades_winrate = gates["min_trades_winrate"]
    opted_out = {r[0] for r in db.query(User.id).filter(User.leaderboard_opt_out.is_(True))}
    baselines = db.query(PeriodBaseline).filter(
        PeriodBaseline.period_key == period_key).all()
    by_user = defaultdict(dict)
    for b in baselines:
        if b.user_id in opted_out:
            continue
        by_user[b.user_id][b.mt5_login] = b
    ret_rows, wr_rows = [], []
    for uid, blmap in by_user.items():
        taken = {lg: b.taken_at for lg, b in blmap.items()}
        profits_by_login = _resolved_in_period(db, uid, set(blmap), period_key, taken)
        for lg, b in blmap.items():
            profits = profits_by_login.get(lg, [])
            sample = len(profits)
            total = sum(profits)
            denom = b.baseline + b.adjust
            if sample >= min_trades_return and denom >= min_baseline and denom > 0:
                ret_rows.append({"userId": uid, "login": lg,
                                 "score": total / denom, "sample": sample})
            # `total > 0`（本期盈利为正）刻意不做成设置项：这是原则，不是门槛。
            # 高胜率不等于盈利——没有这道闸，榜首可能是一个在亏钱的账户
            # （比如高胜率、小赢大亏）。笔数门槛可以为了内测松一松，这道闸不行。
            # `total > 0` (period profit must be positive) is deliberately left
            # hardcoded, not a setting: it's a principle, not a threshold. A high
            # win rate doesn't mean profitable — without this gate the board's
            # top entry could be a net-losing account (many small wins, one big
            # loss). The count gate can loosen for the beta; this one never does.
            if sample >= min_trades_winrate and total > 0:
                wins = sum(1 for p in profits if p > 0)
                wr_rows.append({"userId": uid, "login": lg,
                                "score": wins / sample, "sample": sample})
    return {"return_pct": ret_rows, "win_rate": wr_rows}


def snapshot_boards(db, now: datetime) -> dict:
    """快照排名（设计 §1.6/§4）：对每个 active period key，若仍在进行中先拍基线
    + 对账，再算行、排序、定名次，先删后插该 (board, period_key) 的全部快照行，
    一次 commit。出窗（>48h）的周期不在 active keys 里——天然封存，行永不再动。

    `now` 是这一趟批处理唯一的时钟基准：既用来判断哪些周期仍需拍基线/对账
    （`end > now`），也原样透传给 `reconcile_deposits`（它内部还有一层
    `now >= end` 的防御性兜底），确保「现在」在一次调用里只有一个含义。
    """
    total_rows = 0
    keys = active_period_keys(now)
    for key in keys:
        _start, end = period_bounds(key)
        if end > now:                                # 进行中：拍基线 + 对账
            ensure_baselines(db, key, now)
            reconcile_deposits(db, key, now=now)
        rows_by_board = compute_board_rows(db, key)
        for board, rows in rows_by_board.items():
            rows.sort(key=lambda r: (-r["score"], -r["sample"], r["login"]))
            db.query(LeaderboardSnapshot).filter(
                LeaderboardSnapshot.board == board,
                LeaderboardSnapshot.period_key == key).delete()
            for i, r in enumerate(rows, start=1):
                db.add(LeaderboardSnapshot(board=board, period_key=key,
                                           user_id=r["userId"], mt5_login=r["login"],
                                           rank=i, score=r["score"], sample=r["sample"]))
            total_rows += len(rows)
        db.commit()
    return {"periods": len(keys), "rows": total_rows}
