"""勋章注册表与判定（设计 §3）。17 枚，稀有度金字塔；比赛类 Phase 3 终审授予。"""
import logging
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.models import DisciplineSnapshot, MT5Account, Order, Signal, User, UserBadge
from .stats import compute_account_lifetime_stats, compute_comprehensive_stats, load_trade_data

FOUNDER_DEADLINE = datetime(2027, 1, 1, tzinfo=timezone.utc)
REAL = 2
# 手数阈值判定用浮点容差：lots 是反复 += volume 累加出来的（如 100 笔 0.2 手），
# 双精度浮点误差会让恰好等于阈值的累计和落到 19.99999999999996 这类值上，
# 与 stats.py 里 _resolve 的 _VOL_EPS 同一道理。
# Epsilon for lot-threshold judges: `lots` is summed via repeated += volume
# (e.g. 100 fills of 0.2 lots), and double-precision drift can land an exact
# threshold sum just under it (e.g. 19.99999999999996). Same rationale as
# stats.py's _resolve using _VOL_EPS.
_LOT_EPS = 1e-6

# 可同时佩戴的勋章枚数。第一枚是「默认」——榜单行与比赛条目位置有限，只画
# 这一枚（设计 §3.4 的展示规则不变），其余两枚只在成就页露面。
# How many badges can be worn at once. The first is the default: leaderboard
# rows and competition entries have room for exactly one (the §3.4 display
# rule is unchanged), so the other two show only on the achievements page.
EQUIP_SLOTS = 3


def equipped_list(user) -> list[str]:
    """读佩戴列表（有序，首枚为默认）。新列为空时退回旧的单枚列——迁移回填
    之前、或某条历史路径只写了旧列时都能拿到正确结果。
    Read the equipped list (ordered, first = default). Falls back to the legacy
    single-badge column when the new one is empty, so rows read correctly before
    the backfill runs or if some legacy path wrote only the old column."""
    raw = (getattr(user, "equipped_badges", None) or "").strip()
    if raw:
        return [x for x in raw.split(",") if x]
    single = getattr(user, "equipped_badge", None)
    return [single] if single else []


def set_equipped_list(user, badge_ids) -> list[str]:
    """写佩戴列表：保序去重、截到 EQUIP_SLOTS 枚，并把首枚同步进旧的单枚列。
    **不做持有校验**——调用方（account._apply_profile_patch）先校验再调这里，
    因为它要在校验失败时抛 400 而不是静默丢弃。
    Write the equipped list: dedupe in place, cap at EQUIP_SLOTS, and mirror the
    first entry into the legacy single column. **Does not check ownership** — the
    caller (account._apply_profile_patch) validates first, since it must raise 400
    rather than silently drop an unowned id."""
    seen: list[str] = []
    for b in badge_ids:
        if b and b not in seen:
            seen.append(b)
    seen = seen[:EQUIP_SLOTS]
    user.equipped_badges = ",".join(seen)
    user.equipped_badge = seen[0] if seen else None
    return seen


def award_badge(db, user_id, badge_id) -> bool:
    db.add(UserBadge(user_id=user_id, badge_id=badge_id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False
    # 授予落库后才推送（先例见 auto_manage.py L390-399、gateway.py
    # _notify_revoked）：推送失败不该撤销已经生效的授予，也不该拖垮
    # 判定循环，所以单独 try/except 兜住、只记日志。事件白名单 NULL 默认不含
    # badge_awarded（见 push_dispatch.EVENT_BADGE_AWARDED），用户得自己去
    # 通知设置里勾选才会真的收到。
    # Only push after the award is actually committed (precedent:
    # auto_manage.py L390-399, gateway.py _notify_revoked): a push
    # failure must not undo an award that already took effect, nor sink the
    # judging loop — caught and logged on its own. NULL event whitelists
    # exclude badge_awarded by default (see push_dispatch.EVENT_BADGE_AWARDED),
    # so users only get this once they opt in via notification settings.
    try:
        from app.services.push_dispatch import EVENT_BADGE_AWARDED, dispatch_event_push
        # 推送正文要人话，不能是原始 badge_id（如 "first_close"）。展示名只在
        # BADGES[badge_id]["name"] 里镜像一份——真正的展示名源头是前端 i18n
        # gamification.badges.<id>.name，那边才是维护入口；这里缺失时兜底回落
        # 原始 id，绝不能让推送直接炸掉。
        # Push copy needs a human name, not the raw badge_id (e.g. "first_close").
        # The display name is mirrored onto BADGES[badge_id]["name"] — the real
        # source of truth stays the frontend i18n at
        # gamification.badges.<id>.name; falls back to the raw id if missing so
        # a push never blows up over it.
        name = BADGES.get(badge_id, {}).get("name") or badge_id
        dispatch_event_push(
            user_id, EVENT_BADGE_AWARDED,
            "获得新勋章",
            f"你解锁了勋章「{name}」，去看看吧。",
        )
    except Exception:
        logging.getLogger("gamification").exception(
            "badge push failed (user=%s badge=%s)", user_id, badge_id
        )
    return True


def _has_real_fill(db, user_id) -> bool:
    """"首笔实盘成交"要求一笔真正的开仓（action=="ORDER"）。Gateway 的
    _apply_trade_result 对 CLOSE/MODIFY 动作同样会置 FILLED 并照样打
    trade_mode 快照，若不按 action 过滤，只改过止损或平掉一笔非本平台开的
    实盘仓位、从未真正开过仓的用户也会被判定"已实盘"——与 stats.py 的
    _filled_orders 同一道理，同样只认 ORDER。
    "first real trade" requires an actual open (action=="ORDER"). Gateway's
    _apply_trade_result marks CLOSE/MODIFY FILLED too and still stamps
    trade_mode, so without this filter a user who only ever modified a stop
    or closed a position this platform never opened — on a real account —
    would be judged as having a real trade. Mirrors stats.py's
    _filled_orders, which only counts ORDER for the same reason.
    """
    return (db.query(Order.id)
              .filter(Order.user_id == user_id, Order.status == "FILLED",
                      Order.action == "ORDER", Order.trade_mode == REAL)
              .first() is not None)


def _j_profile_complete(db, user, ctx):
    from app.services.gateway_binding import not_removed
    bound = db.query(MT5Account.id).filter(MT5Account.user_id == user.id, not_removed()).first()
    return bool(user.nickname) and bound is not None


def _j_first_close(db, user, ctx):
    return ctx["stats"]["trades_any"] >= 1


def _j_first_real_trade(db, user, ctx):
    return _has_real_fill(db, user.id)


def _j_hundred_wins(db, user, ctx):
    return any(a["wins"] >= 100 and a["lots"] >= 20 - _LOT_EPS and a["profit"] > 0
               for a in ctx["lifetime"].values())


def _j_midas_touch(db, user, ctx):
    return any(a["trades"] >= 500 and a["lots"] >= 100 - _LOT_EPS and a["profit"] > 0
               and (a["win_rate"] or 0) > 0.60
               for a in ctx["lifetime"].values())


def _j_founder_2026(db, user, ctx):
    created = user.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created is not None and created < FOUNDER_DEADLINE and _has_real_fill(db, user.id)


def _resolved_real_positions(db, user_id, cutoff=None, data: dict | None = None):
    """[(order, profit, last_close_at)]，实盘 + verified + 整仓。
    `data` 是 stats.load_trade_data 的结果；传了就不再查库（每小时循环里五枚
    勋章共用一份），不传就自己查。"""
    from .stats import _orders_since, _resolve
    from app.services.trade_performance import position_id_of
    if data is None:
        data = load_trade_data(db, user_id)
    orders = [o for o in _orders_since(data["orders"], cutoff) if o.trade_mode == REAL]
    legs_map = data["legs"]
    out = []
    for o, p in _resolve(orders, legs_map):
        legs = legs_map[(o.mt5_login, position_id_of(o))]
        out.append((o, p, max(l.closed_at for l in legs)))
    return out


def _evergreen_months(db, user_id, data: dict | None = None) -> int:
    now = datetime.now(timezone.utc)
    cur_month = (now.year, now.month)
    monthly: dict[tuple[int, int], float] = {}
    for _o, p, closed in _resolved_real_positions(db, user_id, data=data):
        ts = closed if closed.tzinfo else closed.replace(tzinfo=timezone.utc)
        key = (ts.year, ts.month)
        if key != cur_month:                       # 未结束的当前月不计
            monthly[key] = monthly.get(key, 0.0) + p
    def _next(k):
        y, m = k
        return (y + 1, 1) if m == 12 else (y, m + 1)
    best = run = 0
    prev = None
    for key in sorted(monthly):
        ok = monthly[key] > 0
        run = (run + 1 if ok and prev is not None and _next(prev) == key
               else (1 if ok else 0))
        best = max(best, run)
        prev = key
    return best


def _j_evergreen(n):
    return lambda db, u, c: _evergreen_months(db, u.id, c.get("data")) >= n


def _j_profit_factor(db, user, ctx):
    from .stats import GAMIFICATION_WINDOW_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=GAMIFICATION_WINDOW_DAYS)
    res = _resolved_real_positions(db, user.id, cutoff, data=ctx.get("data"))
    if len(res) < 100:
        return False
    profits = [p for _o, p, _t in res]
    if sum(profits) <= 0:
        return False
    wins = [p for p in profits if p > 0]
    losses = [-p for p in profits if p < 0]   # 恰好 0 的仓位不进胜负任何一边——仍占样本量和总盈亏两道闸门，
                                               # 但不该拉低亏损仓的平均亏损（也不该算赢）。
                                               # exact-zero positions enter neither side: they still count
                                               # toward the sample-size and total-profit gates, but shouldn't
                                               # dilute avg-loss (nor count as a win).
    if not losses:
        return True
    if not wins:
        return False
    return (sum(wins) / len(wins)) / (sum(losses) / len(losses)) >= 2.0


def _consecutive_clean_signal_positions(db, user_id, data: dict | None = None) -> int:
    """按平仓时间倒序数「无恶意移损」的信号整仓连续串（对照 discipline.py D1 口径）。"""
    from app.services.settings_store import get_discipline_settings
    from app.services.trade_performance import position_id_of
    tol = float(get_discipline_settings(db).get("sl_tolerance_pct", 0.10))
    sig_pos = [(o, t) for o, _p, t in _resolved_real_positions(db, user_id, data=data)
               if o.signal_id is not None]
    sig_pos.sort(key=lambda x: x[1], reverse=True)
    # 批量取信号原始止损——判定"订单没止损"是弃权还是违规，要看信号本身有没有
    # 给止损（discipline.py D1：信号无止损→弃权；信号有止损但订单上没有→违规，
    # 是下单时被主动抹掉）。一次查完，不在循环里逐仓查。
    # Batch-load each signal's original stop loss: whether an order with no SL
    # is an abstain or a violation depends on whether the signal itself carried
    # one (discipline.py D1: no signal stop -> abstain; signal had a stop but
    # the order doesn't -> violation, cleared at entry). Fetched once, not
    # per-position inside the walk.
    sig_ids = {o.signal_id for o, _t in sig_pos}
    sig_map: dict[str, tuple] = {
        sid: (sl, entry)
        for sid, sl, entry in (
            db.query(Signal.id, Signal.stop_loss, Signal.entry)
              .filter(Signal.id.in_(sig_ids)).all()
            if sig_ids else []
        )
    }
    mods = (db.query(Order)
              .filter(Order.user_id == user_id, Order.action == "MODIFY",
                      Order.status == "FILLED").all())
    mods = [m for m in mods if not (m.client_order_id or "").startswith("auto_")]
    # 分组键是 (账号, ticket) 而不是只用 ticket：ticket 只在单账号内唯一，同一用户
    # 绑多个账号时会撞车，只按 ticket 分组会把 A 账号的改单错记到 B 账号同编号的
    # 仓位上（凭空多判违规，或者反过来把真违规盖住）。对照 discipline.py 的
    # _user_modify_close_map（~L198-218），同一条约束搬过来。
    # Grouping key is (login, ticket), not ticket alone: tickets are only unique
    # within an account, so a user with several accounts can collide — grouping by
    # ticket alone would credit account A's edits to account B's same-numbered
    # position (inventing a violation, or masking a real one the other way).
    # Mirrors discipline.py's _user_modify_close_map (~L198-218), same constraint.
    by_key: dict[tuple, list] = {}
    for m in mods:
        if m.ticket is not None:
            by_key.setdefault((m.mt5_login, m.ticket), []).append(m)
    run = 0
    for o, _t in sig_pos:
        orig_sl = o.sl
        sig = sig_map.get(o.signal_id)
        sig_sl = sig[0] if sig else None
        if orig_sl in (None, 0):
            if sig_sl in (None, 0):
                continue                               # 信号本就没给止损：弃权，不计入序列
            break                                       # 信号给了、订单上却没有：下单时被抹掉，违规断串
        # 入场价：优先真实成交价，回落到信号给的入场价（对照 discipline.py 的
        # _entry_of，L258-264）；两边都没有就没法算距离/容差，宁缺勿错，弃权整仓
        # （不计入也不断串），不瞎猜一个 0 把容差带撑大。
        # Entry price: real fill first, falling back to the signal's entry
        # (mirrors discipline.py's _entry_of, L258-264); with neither there's no
        # distance to scale the tolerance by — abstain the whole position (skip,
        # not counted, not breaking) rather than guessing 0 and inflating the band.
        entry = o.filled_price
        if entry is None:
            entry = sig[1] if sig else None
        if entry is None:
            continue                                   # 入场价未知：弃权，不计入序列
        dist = abs(entry - orig_sl)
        violated = False
        for m in by_key.get((o.mt5_login, position_id_of(o)), []):
            new_sl = m.sl
            if new_sl in (None, 0):
                violated = True; break                 # 清掉止损
            if dist <= 0:
                continue                                # 距离为 0（entry==sl）无法判容差，宁缺勿错，对照 discipline.py 的 dist>0 判定
            if o.side == "BUY" and new_sl < orig_sl - dist * tol:
                violated = True; break
            if o.side == "SELL" and new_sl > orig_sl + dist * tol:
                violated = True; break
        if violated:
            break
        run += 1
    return run


# 「纪律标兵 / 纪律大师」的分数线。设计文档按 08-27 重定口径**之前**的分数分布定的
# 90 分，重定之后分数整体上移，技术文档 §15 要求用真实数据重新校准——跑
# `python -m scripts.calibrate_discipline_badges` 看分布再定。集中成一个常量，
# 校准脚本按不同分数线试算时也走同一个判定函数，不另写一份。
# Threshold for the two discipline-streak badges. The spec picked 90 against the
# pre-08-27 score distribution; scores moved up after the redefinition and the
# tech doc (§15) asks for recalibration on real data — run
# scripts/calibrate_discipline_badges.py. One constant, and the calibration script
# reuses this very judge with alternative thresholds instead of a second copy.
DISCIPLINE_BADGE_THRESHOLD = 90.0


def _discipline_streak(db, user_id, n, threshold: float = DISCIPLINE_BADGE_THRESHOLD) -> bool:
    """login="" 聚合行；total<threshold 或 NULL 或缺日均断连（设计 §3.2：宁严勿松）。"""
    rows = (db.query(DisciplineSnapshot.date, DisciplineSnapshot.total)
              .filter(DisciplineSnapshot.user_id == user_id,
                      DisciplineSnapshot.login == "").all())
    ok_days = sorted(date.fromisoformat(d) for d, t in rows if t is not None and t >= threshold)
    run = 1
    for a, b in zip(ok_days, ok_days[1:]):
        run = run + 1 if b - a == timedelta(days=1) else 1
        if run >= n:
            return True
    return n <= 1 and bool(ok_days)


# "name" 是给推送正文用的展示名镜像，逐条从 frontend/src/i18n/zh.json 的
# gamification.badges.<id>.name 原样抄来（不是重新措辞）。展示名的维护入口
# 还是那边的前端 i18n；这里改了名字记得同步过来，两边失步只会让推送文案
# 悄悄跟页面对不上，不会报错。推送本身只走中文（沿用 gateway.py/auto_manage.py
# 的先例），所以这里不需要 en 版本。
# "name" mirrors the display name used in push copy, copied verbatim per-entry
# from frontend/src/i18n/zh.json's gamification.badges.<id>.name (not
# reworded). The frontend i18n stays the real source of truth for on-page
# names — keep this in sync whenever a badge is renamed there, since drifting
# apart only shows up as push copy silently disagreeing with the page, never
# as an error. Push copy itself is Chinese-only (following gateway.py /
# auto_manage.py precedent), so no English variant is needed here.
BADGES: dict[str, dict] = {
    "profile_complete": {"rarity": "common", "category": "growth", "judge": _j_profile_complete,
                         "name": "完善资料"},
    "first_close":      {"rarity": "common", "category": "growth", "judge": _j_first_close,
                         "name": "首笔平仓"},
    "first_real_trade": {"rarity": "common", "category": "growth", "judge": _j_first_real_trade,
                         "name": "首笔实盘"},
    "comp_finisher":    {"rarity": "common", "category": "competition", "judge": None,
                         "name": "完赛"},
    "evergreen_3m":     {"rarity": "rare", "category": "performance", "judge": _j_evergreen(3),
                         "name": "季度常青"},
    "discipline_90_7":  {"rarity": "rare", "category": "discipline",
                         "judge": lambda db, u, c: _discipline_streak(db, u.id, 7),
                         "name": "纪律标兵"},
    "hundred_wins":     {"rarity": "rare", "category": "performance", "judge": _j_hundred_wins,
                         "name": "百战百胜"},
    "midas_touch":      {"rarity": "epic", "category": "performance", "judge": _j_midas_touch,
                         "name": "点金胜手"},
    "profit_factor_2":  {"rarity": "epic", "category": "performance", "judge": _j_profit_factor,
                         "name": "盈亏比之王"},
    "evergreen_6m":     {"rarity": "epic", "category": "performance", "judge": _j_evergreen(6),
                         "name": "半年常青"},
    "discipline_90_30": {"rarity": "epic", "category": "discipline",
                         "judge": lambda db, u, c: _discipline_streak(db, u.id, 30),
                         "name": "纪律大师"},
    "no_bad_sl_50":     {"rarity": "epic", "category": "discipline",
                         "judge": lambda db, u, c: _consecutive_clean_signal_positions(db, u.id, c.get("data")) >= 50,
                         "name": "铁律如山"},
    "comp_podium":      {"rarity": "epic", "category": "competition", "judge": None,
                         "name": "比赛前三"},
    "evergreen_12m":    {"rarity": "legendary", "category": "performance", "judge": _j_evergreen(12),
                         "name": "全年常青"},
    "comp_winner":      {"rarity": "legendary", "category": "competition", "judge": None,
                         "name": "比赛冠军"},
    "comp_back_to_back": {"rarity": "legendary", "category": "competition", "judge": None,
                         "name": "卫冕王"},
    "founder_2026":     {"rarity": "limited", "category": "limited", "judge": _j_founder_2026,
                         "name": "创始元老"},
}


def judge_and_award_badges(db, user_id, data: dict | None = None) -> list[str]:
    """`data` 是 stats.load_trade_data 的结果，可由每小时循环预先读好传入；
    这里把它放进 ctx，五枚要遍历整仓的勋章都从这一份数据判，不再各自查库。
    `data` (from stats.load_trade_data) may be preloaded by the hourly pass; it
    rides in ctx so the five position-walking judges share it instead of each
    reloading the user's orders."""
    user = db.get(User, user_id)
    if user is None:
        return []
    owned = {b.badge_id for b in db.query(UserBadge).filter(UserBadge.user_id == user_id)}
    if data is None:
        data = load_trade_data(db, user_id)
    ctx = {"stats": compute_comprehensive_stats(db, user_id, data),
           "lifetime": compute_account_lifetime_stats(db, user_id, data),
           "data": data}
    newly = []
    for bid, meta in BADGES.items():
        if bid in owned or meta["judge"] is None:
            continue
        if meta["judge"](db, user, ctx) and award_badge(db, user_id, bid):
            newly.append(bid)
    return newly
