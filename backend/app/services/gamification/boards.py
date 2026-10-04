"""榜单计算（设计 §1.5/§1.6/§4）：按账户拍基线、对账出入金、逐仓按当时本金计分、快照排名。"""
import json
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.models import ClosedTrade, LeaderboardSnapshot, MT5Account, PeriodBaseline, User
from app.services import shared_cache, shared_state
from .periods import active_period_keys, period_bounds

log = logging.getLogger("gamification")
RECONCILE_TOLERANCE = 0.01
# 出金门槛：余额少掉的钱要同时超过这两条线才算出金（取两者较大）。手续费、隔夜
# 利息、点差返还都是几美金到几十美金的量级，够不到这条线，照旧忽略；真出金一般
# 是几百起。本金按账户币种原值比较，与 min_baseline_usd 同一口径（不换汇）。
# Withdrawal threshold: a balance drop counts as a withdrawal only when it clears
# both lines (the larger wins). Commission / swap / rebates are single- to
# double-digit noise and stay ignored; a real withdrawal is hundreds and up.
# 这两个数字在用户端是明写出来的（前端 i18n 的 cashflowRules.noteSmall，中英各一条，
# 排行榜与比赛详情页的折叠说明里）——改这里要一并改那两条文案。
# Both numbers are stated verbatim to users in the frontend i18n key
# cashflowRules.noteSmall (zh + en); changing them here means changing that copy.
WITHDRAWAL_MIN_ABS = 100.0
WITHDRAWAL_MIN_FRAC = 0.05
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
    from app.services.gateway_binding import not_removed
    accounts = (db.query(MT5Account)
                  .filter(MT5Account.trade_mode == REAL,
                          MT5Account.balance.isnot(None), not_removed()).all())
    # 循环内**逐账户 commit**：账户上千时这是上千次事务往返，看起来该改成批量。
    # 保持现状是有意的——幂等手段就是下面那个 IntegrityError：并发的另一趟循环
    # 先插了同一行，本行静默跳过，其余账户照拍。改成攒一批再 commit 的话，一整
    # 批里只要有一行撞约束，整批都会回滚，得另外设计「先查后插 + 失败降级逐条
    # 重试」之类的幂等手段——那是一次真正的重构，风险大于这里省下的往返。
    # 真要优化先做的是别的：这一趟 5 分钟一次，但只有新账户才走到 commit（已有基线的
    # 在上面就 continue 了），账户数也远没到瓶颈。
    # Per-account commit inside the loop: at a thousand accounts that's a thousand
    # round trips and looks like an obvious batching target. Keeping it is
    # deliberate — the IntegrityError below *is* the idempotency mechanism (a
    # concurrent pass inserted this row first; skip it and carry on). Batching
    # would roll back every row in a batch whenever any one row collided, so it
    # would need a different idempotency design (probe-then-insert with per-row
    # retry on failure) — a real refactor, worth more risk than the round trips
    # cost. The pass runs every 5 minutes, but only new accounts reach the commit
    # (existing baselines continue above), and the count is nowhere near the limit.
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


# ---- 出入金流水与「当时本金」 / cash flows and capital-at-time ---------------------
#
# 2026-09-06 之前分母是「基线 + 期内全部入金」，出金一律不减。对出金的人不公平
# （出掉大半资金后继续赚，收益率被大分母压低），但改成「出金直接减分母」会开一个
# 洞：先赚 1000 再把 9000 提走，分母从 10000 变 1000，同一笔利润的收益率从 10%
# 变 100%。所以分母不再是一个数，而是**每一笔仓位各算各的**：
#   这笔仓位的本金 = max(开仓那一刻账户里的钱, 平仓那一刻账户里的钱)
#   收益率 = Σ 每笔盈亏 ÷ 该笔本金
# 「钱只要在开仓或平仓任一时刻在账户里，就算这笔的本金」——赚完再提走，本金按提走
# 前算，放大不了；提走后再交易，本金按提走后算，不再被压低；交易中途入金，本金按
# 入金后算，与原来「入金摊薄」的保守方向一致。没有出入金时公式与原来完全相同
# （Σp ÷ D）。
# 流水记在基线行的 flows（JSON [[iso 时刻, 金额], ...]），`adjust` 仍是流水总和，
# rev 15 之前只有 adjust 没流水的旧行按「全程生效」处理（capital_at 里的 residue）。
#
# Before 2026-09-06 the denominator was baseline + all deposits, withdrawals
# ignored. Subtracting withdrawals naively opens a hole (earn 1000 on 10000,
# withdraw 9000, the same profit now reads 100%). So each position gets its own
# denominator: max(capital when it opened, capital when it closed) — money counts
# as this position's capital if it was in the account at either moment. Earn-then-
# withdraw can't inflate; withdraw-then-trade is no longer deflated; deposit mid-
# trade keeps the old dilute-conservatively direction. With no flows the formula
# reduces to the old Σp ÷ D exactly. Flows live on the baseline row as JSON;
# `adjust` stays their running sum, and legacy rows with adjust but no flows are
# treated as "in effect for the whole period" (the residue term in capital_at).

def _flows(b) -> list[tuple[datetime, float]]:
    """基线行的出入金流水，按时间升序；坏 JSON 当作没有流水（不抛）。"""
    raw = getattr(b, "flows", None)
    if not raw:
        return []
    try:
        items = json.loads(raw)
        out = [(_aware(datetime.fromisoformat(t)), float(a)) for t, a in items]
    except (ValueError, TypeError):
        return []
    out.sort(key=lambda x: x[0])
    return out


def _append_flow(b, at: datetime, amount: float) -> None:
    items = [[t.isoformat(), a] for t, a in _flows(b)]
    items.append([_aware(at).isoformat(), float(amount)])
    b.flows = json.dumps(items)


def capital_at(b, t: datetime) -> float:
    """t 时刻账户里的本金：基线 + 在 t 之前（含）发生的流水 + 无时间信息的残差。
    残差 = adjust − 流水总和，只有 rev 15 之前记的入金会落在这里，按全程生效。"""
    flows = _flows(b)
    residue = float(b.adjust or 0.0) - sum(a for _, a in flows)
    t = _aware(t)
    return float(b.baseline) + residue + sum(a for at, a in flows if at <= t)


def position_denominator(b, opened_at: datetime, closed_at: datetime) -> float:
    return max(capital_at(b, opened_at), capital_at(b, closed_at))


# 本金门槛比较的容差。比赛可以把上下限设成同一个数（「只收 1000 USD 的账户」），
# 这时本金必须"等于"它——而本金是基线加一串浮点流水算出来的，1000 可能变成
# 999.9999999999 或 1000.0000000001。差这一点就整行掉榜显然不对；0.005 是半美分，
# 余额本身只精确到分，所以不会放进任何真正超限的账户。
# Tolerance for the capital gates. A competition may set floor == ceiling ("1000
# USD accounts only"), and capital is a baseline plus float flows, so 1000 can come
# out as 999.9999999999. Half a cent: balances are only exact to the cent, so this
# never admits a genuinely out-of-range account.
BASELINE_EPS = 0.005


def baseline_in_range(capital: float, min_baseline: float, max_baseline: float | None) -> bool:
    """本金是否落在 [min, max]（max 为 None = 不设上限），两端各带 BASELINE_EPS 容差。
    报名闸与计分闸共用这一个函数，两边的口径不会分叉。
    Whether capital lies in [min, max] (max None = no ceiling), with BASELINE_EPS
    slack at both ends. Shared by the signup gate and scoring so they can't diverge."""
    if capital < min_baseline - BASELINE_EPS:
        return False
    return max_baseline is None or capital <= max_baseline + BASELINE_EPS


def return_score(b, resolved, min_baseline: float, max_baseline: float | None = None):
    """收益榜一行的分数：resolved = [(opened_at, closed_at, profit), ...]。
    返回 (score, sample)；任一笔仓位的本金低于门槛或 ≤ 0 → None（整行不入榜，
    与原来「分母 ≥ min_baseline」的闸同一语义：本金不够时的交易不排名）。
    比赛设了本金上限时同理：任一笔仓位的本金高于上限（报名后入金超过上限）→ None。
    Score for one return_pct row. None when any position's capital is below the
    floor or non-positive — the whole row stays off the board, same semantics as
    the old denominator gate. Likewise above a competition's ceiling (deposited
    past it after signing up).
    """
    # 先按本金分组再各除一次，而不是逐笔相除再相加：没有出入金时结果与原来的
    # total / denom 逐位相同（逐笔相除会多出浮点尾差，让本该打平的两行分不出胜负）。
    # Sum per distinct denominator, then divide once each: with no flows this is
    # bit-for-bit the old total / denom (per-position division would introduce
    # float noise and break exact ties).
    by_denom: dict[float, float] = defaultdict(float)
    for opened_at, closed_at, profit in resolved:
        denom = position_denominator(b, opened_at, closed_at)
        if denom <= 0 or not baseline_in_range(denom, min_baseline, max_baseline):
            return None
        by_denom[denom] += profit
    return sum(total / d for d, total in by_denom.items()), len(resolved)


def _realized_since_bulk(db, baselines, until) -> dict:
    """对一批基线一次查出各自的已实现盈亏：{(user_id, mt5_login): sum(profit)}。
    每条基线各查一次（N+1）改成一条 `user_id IN (...) AND closed_at >= min(taken_at)`
    只取 4 列，再在 Python 里按各基线自己的 taken_at 求和（平仓时间 >= taken_at）。
    没用 tuple IN：SQLite 测试库兼容，且 idx_closed_trades_position 的 (user_id,
    mt5_login) 前缀已能服务这个过滤。口径同原来逐条查询：不过滤 verified——对账针对的
    是余额变动，任何已报告的平仓（无论能否被服务端核对）都会真实地改变 MT5 账户余额。
    Realized profit for a whole batch of baselines in one query instead of one per
    baseline: one `user_id IN (...) AND closed_at >= min(taken_at)` read of four
    columns, summed in Python against each baseline's own taken_at. No tuple IN
    (SQLite test DB); the (user_id, mt5_login) prefix of an existing index serves it.
    Same semantics as before: verified is not filtered — any reported close moves
    the MT5 balance.
    """
    if not baselines:
        return {}
    taken = {(b.user_id, b.mt5_login): _aware(b.taken_at) for b in baselines}
    q = (db.query(ClosedTrade.user_id, ClosedTrade.mt5_login, ClosedTrade.closed_at, ClosedTrade.profit)
           .filter(ClosedTrade.user_id.in_({u for u, _l in taken}),
                   ClosedTrade.closed_at >= min(taken.values())))
    if until is not None:
        q = q.filter(ClosedTrade.closed_at < until)
    out = {k: 0.0 for k in taken}
    for uid, login, closed_at, profit in q.all():
        k = (uid, login)
        since = taken.get(k)
        if since is not None and _aware(closed_at) >= since:
            out[k] += profit or 0.0
    return out


# ---- 入金流水记在「上一次对账」时刻 / deposits are stamped at the previous check ----
#
# 对账是周期性的（周期榜 5 分钟、比赛 60 秒；2026-09-28 之前周期榜每小时一次），入金
# 只能在「上一次对账之后、这一次之前」的某个时刻发生。原来流水记在「这一次」——两次
# 对账之间开仓平仓的单子，按时间取本金时入金还不存在：
# 余额归零后入金再交易的账户，这些单子本金 = 0，整行不入榜（2026-09-28 实例：
# 周一 06:04 起交易，06:57 才记上入金）。改成入金记在区间的**最早**一端：区间里
# 的单子本金按入金后算，只会被摊薄，放大不了，与「持仓当中入金按钱多的那一刻算」
# 同一个保守方向。出金反过来记在最晚一端（仍是「这一次」）：区间里的单子按出金前
# 的大本金算，同样放大不了。桥接晚报平仓那种「先出后入」的一对流水，入金的记账
# 时刻正好等于出金那一轮，两条仍在同一时刻相抵。
# 上一次对账的时刻按 period key 存在 shared_state（有 Redis 跨进程/重启可见）；
# 取不到（首轮、内存后端重启后）退回「这一次往前一个对账周期」，并且不早于基线
# 拍照时刻。
#
# Reconcile runs periodically, so a deposit happened somewhere between the previous
# check and this one. Stamping it at *this* check left positions traded in that
# window with capital from before the deposit — zero for an account refilled from
# empty, which drops the whole row. Deposits now take the window's earliest end
# (window positions can only be diluted, never inflated); withdrawals keep the
# latest end for the same reason. The previous check time lives in shared_state
# per period key; when missing, fall back to one loop interval back, never
# earlier than the baseline snapshot.
RECONCILE_MARK_TTL_SECONDS = 45 * 24 * 3600     # 覆盖一个自然月 + 重算窗 / a month + grace
# 取不到上一次对账时刻时往前退一小时：远宽于 5 分钟的周期，重启/停机的空档也盖得住；
# 往前退只会把区间里的单子摊薄，不会放大。
# Fallback when no mark exists: an hour, far wider than the 5-minute cadence so a
# restart gap is covered; stamping earlier can only dilute, never inflate.
DEPOSIT_FALLBACK_LOOKBACK = timedelta(hours=1)


def _reconcile_mark_key(period_key: str) -> str:
    return f"gami:reconciled_at:{period_key}"


def _last_reconciled_at(period_key: str) -> datetime | None:
    try:
        raw = shared_state.kv_get(_reconcile_mark_key(period_key))
        return _aware(datetime.fromisoformat(raw)) if raw else None
    except Exception:
        # Redis 不可用 / 值损坏：当作没有记录，走回退，不让对账失败
        log.warning("reconcile mark unreadable for %s", period_key, exc_info=True)
        return None


def _mark_reconciled(period_key: str, now: datetime) -> None:
    try:
        shared_state.kv_set(_reconcile_mark_key(period_key), _aware(now).isoformat(),
                            RECONCILE_MARK_TTL_SECONDS)
    except Exception:
        log.warning("reconcile mark not saved for %s", period_key, exc_info=True)


def _deposit_at(row, prev_check: datetime | None, now: datetime) -> datetime:
    """入金流水的记账时刻：上一次对账（取不到则 now − 一个周期），不早于基线拍照、不晚于 now。"""
    at = prev_check if prev_check is not None else now - DEPOSIT_FALLBACK_LOOKBACK
    if row.taken_at is not None:
        at = max(at, _aware(row.taken_at))
    return min(at, now)


def reconcile_deposits(db, period_key: str, now: datetime = None,
                        bounds: tuple[datetime, datetime] | None = None) -> int:
    """对每条基线，若账号行仍在且 balance 非 NULL：
    delta = balance − (baseline + adjust) − realized_since(taken_at, login)；
    delta > RECONCILE_TOLERANCE → 入金：adjust += delta，记一条流水；
    −delta ≥ max(WITHDRAWAL_MIN_ABS, WITHDRAWAL_MIN_FRAC × 当前本金) → 出金：
    adjust += delta（负数），记一条流水；够不到门槛的小额负差（手续费、隔夜利息）
    忽略；账号行已不在（解绑）→ 冻结不动，不报错。
    流水带时间，计分时按每笔仓位开/平仓时刻各取本金（见 capital_at）。桥接晚报的
    平仓单会先被看成一笔出金、下一轮余额对上后再记一笔等额入金，两条流水相抵，
    在此之前平掉的仓位本金不受影响（取的是它平仓时刻的本金）。

    只对当前进行中的周期调用（结束周期不对账）：周期结束后账户仍在正常交易，
    期后的盈亏会被 _realized_since_bulk 当成「realized」减掉，从而把期后的正常
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
    prev_check = _last_reconciled_at(period_key)
    adjusted = 0
    baseline_rows = [r for r in db.query(PeriodBaseline).filter(PeriodBaseline.period_key == period_key)
                     if acct_map.get((r.user_id, r.mt5_login)) is not None]
    realized_by_acct = _realized_since_bulk(db, baseline_rows, end)   # 一次查询，不再每条基线一次
    for row in baseline_rows:
        balance = acct_map[(row.user_id, row.mt5_login)]      # 解绑/无余额的基线已滤掉：冻结不动
        realized = realized_by_acct[(row.user_id, row.mt5_login)]
        denom = row.baseline + row.adjust
        delta = balance - denom - realized
        if delta > RECONCILE_TOLERANCE:
            row.adjust += delta                          # 入金：记在上一次对账时刻（见上方说明）
            _append_flow(row, _deposit_at(row, prev_check, now), delta)
            adjusted += 1
        elif delta < 0 and -delta >= max(WITHDRAWAL_MIN_ABS, WITHDRAWAL_MIN_FRAC * denom):
            row.adjust += delta                          # 出金：此后仓位的本金减少
            _append_flow(row, now, delta)
            adjusted += 1
    if adjusted:
        db.commit()
    _mark_reconciled(period_key, now)
    return adjusted


def _resolved_in_period(db, user_id, logins, period_key, taken_at_by_login,
                         bounds: tuple[datetime, datetime] | None = None,
                         modes: tuple[int, ...] = (REAL,)):
    """整仓判定 + 归期：返回 login -> list[(opened_at, closed_at, profit)]。归期 =
    最后一腿时间落在 [max(期初, 该账户 taken_at), 期末)。订单锚定 lifetime（开仓可
    早于期初）。开/平仓时刻给 return_score 取「当时本金」用；胜率榜只看 profit。

    `bounds` 可选：显式传 (start, end) 时跳过 `period_bounds(period_key)` 解析
    （比赛 key 不是自然周/月格式，解析不了）；默认 None 时行为与 Phase 2 完全
    一致。

    `modes`：参与计分的 `orders.trade_mode` 集合，默认只认实盘。周期榜永远只
    算实盘（设计 §4），传默认值即可；**模拟盘比赛**必须把赛道对应的模式传进来
    （`competitions.track_modes`），否则模拟账户的成交单会在这里被整个滤掉，
    比赛榜永远算不出行——2026-09-04 加赛道时就漏了这一处。
    `modes`: which `orders.trade_mode` values count, real-only by default. The
    standing boards are always real-only (design §4) and take the default; a
    **demo-track competition** must pass its track's modes
    (`competitions.track_modes`) or every fill from a demo account is filtered out
    right here and the competition board can never produce a row — exactly the case
    missed when tracks were added on 2026-09-04.
    """
    from .stats import _filled_orders, _legs_by_position, _resolve
    from app.services.trade_performance import position_id_of
    start, end = bounds if bounds is not None else period_bounds(period_key)
    # 账户、trade_mode、开仓时刻上界三个筛子全部下推到 SQL。以前是
    # `_filled_orders(db, user_id, cutoff=None)` 把这个用户**全生命周期**的
    # 订单整张读进内存再在 Python 侧筛——而 `compute_board_rows` 对每个有基线的
    # 用户各调一次、`snapshot_boards` 每趟又要跑 2~4 个周期 key，于是整趟 pass
    # 的榜单阶段是 O(用户 × 全部订单)，用户和订单一涨就先顶到
    # SLOW_PASS_WARN_SECONDS。下推之后读的是「这几个账户、这个赛道、开在期末
    # 之前」的那一小片。
    # 口径不变：这三个条件本来就是下面 Python 侧在做的同一件事（开仓时刻上界是
    # 新加的，但仓位不可能先平后开，开在期末之后的单原本也一定过不了窗口那一
    # 关）。**下界不能下推**，理由见 `_filled_orders` 的 docstring。
    # Account, trade_mode and an upper bound on the open instant are pushed into
    # SQL. This used to read every order in the user's lifetime and filter in
    # Python, once per user with a baseline, times the 2-4 period keys per pass —
    # O(users × orders), the first thing to blow past SLOW_PASS_WARN_SECONDS as
    # the tables grow. Semantics are unchanged: those were already the conditions
    # applied below (the upper bound is new but implied — a position cannot close
    # before it opens). The lower bound cannot be pushed down; see _filled_orders.
    orders = _filled_orders(db, user_id, cutoff=None, logins=logins,
                            modes=modes, before=end)
    keys = {(o.mt5_login, position_id_of(o)) for o in orders if position_id_of(o)}
    legs_map = _legs_by_position(db, user_id, keys)
    out = defaultdict(list)
    for o, p in _resolve(orders, legs_map):
        legs = legs_map[(o.mt5_login, position_id_of(o))]
        last_close = _aware(max(l.closed_at for l in legs))
        lower = max(start, _aware(taken_at_by_login[o.mt5_login]))
        if lower <= last_close < end:
            out[o.mt5_login].append((_aware(o.created_at), last_close, p))
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
        "winrate_require_profit": bool(gset.get("winrate_require_profit", False)),
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
    wr_require_profit = gates["winrate_require_profit"]
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
            resolved = profits_by_login.get(lg, [])
            profits = [p for _o, _c, p in resolved]
            sample = len(profits)
            total = sum(profits)
            scored = return_score(b, resolved, min_baseline)
            if sample >= min_trades_return and scored is not None:
                ret_rows.append({"userId": uid, "login": lg,
                                 "score": scored[0], "sample": sample})
            # 「本期盈亏为正」原本写死在这里（高胜率 ≠ 赚钱：小赢大亏的打法能刷出
            # 高胜率却在亏钱，这道闸挡的就是它）。2026-09-04 应产品要求改成可配
            # 开关 `winrate_require_profit`，默认关闭——内测期样本太小，这道闸把
            # 大部分账户挡在榜外。**公开前建议在管理端打开**，理由见设计 §4。
            # "Period P&L must be positive" used to be hardcoded here (a high win rate
            # is not the same as making money: small-wins/big-losses trading scores a
            # high rate while losing, and this gate is what stops it). Made configurable
            # via `winrate_require_profit` on 2026-09-04 at the product owner's request,
            # default off — in beta the samples are tiny and this gate keeps most
            # accounts off the board. **Turn it back on before going public** (design §4).
            if sample >= min_trades_winrate and (total > 0 or not wr_require_profit):
                wins = sum(1 for p in profits if p > 0)
                wr_rows.append({"userId": uid, "login": lg,
                                "score": wins / sample, "sample": sample})
    return {"return_pct": ret_rows, "win_rate": wr_rows}


# 快照没变时最多隔这么久才碰一次 computed_at（前端「上次刷新」读它的 MAX）。
# When nothing changed, computed_at ("last refreshed" on the page) is touched at most this often.
SNAPSHOT_TOUCH_SECONDS = 3600


def replace_snapshot_rows(db, board: str, period_key: str, rows: list[dict], force: bool = False) -> bool:
    """把 (board, period_key) 的快照替换成已排好序的 rows（并原地写入 rank）；返回是否真的写了库。

    先读现有快照与新名次逐行比对（rank/user/login/score/sample）：完全一致就跳过
    delete+insert——清淡时段名次一整天不动，以前每 5 分钟（比赛榜每 60 秒）照样全删
    全插。比对对象是库里的行本身而不是 Redis 里存的指纹，所以管理员删行、迁移、
    另一个 worker 抢先写这类情况下不会出现「指纹说没变、库却不一样」。不动的时候
    computed_at 也停住，超过 SNAPSHOT_TOUCH_SECONDS 才用一条 UPDATE 刷一次，页面上
    的「上次刷新」不至于几小时不动。force=True 一律重写。**调用方的 commit 照旧**：
    同一会话里 ensure_baselines / reconcile_deposits 的改动靠它落库。
    Replace a board's snapshot with the ranked rows (setting rank in place); returns
    whether the DB was written. Compare the stored rows against the new ranking first
    and skip delete+insert when identical. The comparison is against the table itself,
    not a Redis fingerprint, so admin deletes, migrations or another worker's write
    can't leave a fingerprint that disagrees with the table. computed_at is touched by
    one UPDATE at most every SNAPSHOT_TOUCH_SECONDS. force always rewrites. The caller
    still commits — baseline/reconcile changes in the same session ride on it.
    """
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    cond = (LeaderboardSnapshot.board == board, LeaderboardSnapshot.period_key == period_key)
    if not force:
        old = (db.query(LeaderboardSnapshot.rank, LeaderboardSnapshot.user_id, LeaderboardSnapshot.mt5_login,
                        LeaderboardSnapshot.score, LeaderboardSnapshot.sample, LeaderboardSnapshot.computed_at)
                 .filter(*cond).order_by(LeaderboardSnapshot.rank).all())
        new = [(r["rank"], r["userId"], r["login"], r["score"], r["sample"]) for r in rows]
        if [tuple(o[:5]) for o in old] == new:
            newest = max((o[5] for o in old if o[5] is not None), default=None)
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            if newest is not None and (now - newest).total_seconds() > SNAPSHOT_TOUCH_SECONDS:
                db.query(LeaderboardSnapshot).filter(*cond).update(
                    {LeaderboardSnapshot.computed_at: now}, synchronize_session=False)
            return False
    db.query(LeaderboardSnapshot).filter(*cond).delete()
    for r in rows:
        db.add(LeaderboardSnapshot(board=board, period_key=period_key,
                                   user_id=r["userId"], mt5_login=r["login"],
                                   rank=r["rank"], score=r["score"], sample=r["sample"]))
    return True


def leaderboard_cache_key(board: str, period_key: str) -> str:
    """榜单前 50 行在 shared_cache 里的键（读侧见 routers/gamification.build_board_rows_payload）。
    shared_cache key of a board's cached top 50 (read side: routers/gamification)."""
    return f"leaderboard:{board}:{period_key}"


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
        changed_boards: list[str] = []
        for board, rows in rows_by_board.items():
            # 排序键 = (分数降序, 笔数降序, 账户号升序)。
            # **没有并列名次的概念**：同分同笔数时按账户号字典序分先后，两行拿到的
            # 是 1 和 2，不是并列第 1。这是刻意的设计而非疏漏——名次要唯一，
            # `settle_competition` 才能按 `rank == 1` 发唯一一枚冠军金牌，快照表也
            # 才能有稳定可翻页的顺序。tests/test_comp_settle.py 与
            # tests/test_board_snapshots.py 都把这个行为钉住了（后者刻意让笔数多的
            # 账户字母序靠后，确保测的是 -sample 那一档而不是巧合命中 login 序）。
            # 已知代价：奖金场景下同分同笔数时冠军由账户号字典序决定，是否可接受
            # 属产品判断，代码这一侧先如实记下来。
            # Sort key = score desc, sample desc, login asc. There is deliberately
            # no notion of a tie: equal score and sample are broken by login, so
            # the two rows get ranks 1 and 2, never a shared 1. Ranks must be
            # unique for settle_competition to award exactly one champion on
            # `rank == 1` and for the snapshot table to paginate stably. Pinned by
            # test_comp_settle.py and test_board_snapshots.py. Known cost: with
            # prize money on the line, an exact tie is decided by account number —
            # whether that is acceptable is a product call, recorded here as-is.
            rows.sort(key=lambda r: (-r["score"], -r["sample"], r["login"]))
            if replace_snapshot_rows(db, board, key, rows):
                changed_boards.append(board)
            total_rows += len(rows)
        db.commit()
        # 新快照已提交：删掉**真的变了**的榜的前 50 缓存，所有 worker 下一次读取即看到新名次；
        # 没变的榜不击穿缓存。
        # New snapshot committed: drop the cached top 50 of boards that really changed;
        # unchanged boards keep their cache.
        if changed_boards:
            shared_cache.delete(*(leaderboard_cache_key(b, key) for b in changed_boards))
    return {"periods": len(keys), "rows": total_rows}
