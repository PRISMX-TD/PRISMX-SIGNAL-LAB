"""勋章注册表与判定（设计 §3，2026-09-07 改制）。

六枚勋章：四枚**进阶勋章**各有铜 / 银 / 金三档（起步 / 常青 / 胜手 / 赛场），两枚
**独立勋章**没有档位（卫冕王、绝版的创始元老）。原来 17 枚各自独立、按稀有度分
五档的做法作废——相似的合并成一枚分三档，材质只回答"到了第几档"。纪律类勋章
连同整个纪律分体系一并撤销（2026-09-07 用户定案）。

档位规则：判定取**满足的最高档**，不要求低档也满足——首笔实盘的人没设昵称也该
拿到起步·金，档位是荣誉的高低，不是关卡。`award_badge` 只升不降：已持有更高或
相同档位则不动，更低则升档并推送。「发出不收回」的不变量不变。

Six badges: four **tiered** ones with bronze / silver / gold (starter / evergreen /
winning hand / arena) and two **standalone** ones (back-to-back champion, the
limited founder). The old 17 independent badges across five rarities are gone:
similar ones merged into one badge with three tiers, and the material now only
says "which tier". Discipline badges were removed with the discipline system.

Tier rule: the highest satisfied tier is awarded, lower tiers need not hold — a
first live trade earns starter gold even without a nickname; tiers rank honour,
they are not gates. `award_badge` only ever moves up.
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.models import MT5Account, Order, User, UserBadge
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

# 档位：1 铜 / 2 银 / 3 金；独立勋章恒为 0。
# Tiers: 1 bronze / 2 silver / 3 gold; standalone badges are always 0.
MAX_TIER = 3
TIER_NAMES = {1: "铜", 2: "银", 3: "金"}

# 旧 id → (新 id, 档位)。给 rev 16 迁移、测试与任何还拿着旧 id 的调用方用；
# 纪律类三枚没有去处，整行删除。
# Legacy id -> (new id, tier), for the rev 16 migration and anything still holding
# an old id; the three discipline badges have no destination and are deleted.
LEGACY_BADGE_MAP: dict[str, tuple[str, int]] = {
    "profile_complete": ("starter", 1), "first_close": ("starter", 2), "first_real_trade": ("starter", 3),
    "evergreen_3m": ("evergreen", 1), "evergreen_6m": ("evergreen", 2), "evergreen_12m": ("evergreen", 3),
    "hundred_wins": ("winning_hand", 1), "midas_touch": ("winning_hand", 2), "profit_factor_2": ("winning_hand", 3),
    "comp_finisher": ("arena", 1), "comp_podium": ("arena", 2), "comp_winner": ("arena", 3),
}
LEGACY_DROPPED: frozenset[str] = frozenset({"discipline_90_7", "discipline_90_30", "no_bad_sl_50"})


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


def badge_display_name(badge_id: str, tier: int = 0) -> str:
    """推送正文用的展示名：进阶勋章带档位（「起步 · 金」），独立勋章只有名字。
    展示名的维护入口仍是前端 i18n `gamification.badges.<id>.name`，这里是镜像；
    缺失时回落原始 id，绝不能让推送炸掉。
    Display name for push copy: tiered badges carry the tier ("起步 · 金"),
    standalone ones just the name. The frontend i18n stays the source of truth;
    this mirrors it and falls back to the raw id so a push never blows up."""
    meta = BADGES.get(badge_id)
    if meta is None:
        return badge_id
    name = meta.get("name") or badge_id
    if meta["max_tier"] and tier in TIER_NAMES:
        return f"{name} · {TIER_NAMES[tier]}"
    return name


def award_badge(db, user_id, badge_id, tier: int = 0) -> bool:
    """授予或升档。没有记录 → 插入；已持有更低档 → 升档；已持有相同或更高档
    → 不动、返回 False。只升不降是这里唯一的方向。
    Award or upgrade: insert when absent, raise the tier when the held one is
    lower, do nothing (False) when it is equal or higher. Up is the only direction."""
    row = db.query(UserBadge).filter(UserBadge.user_id == user_id,
                                     UserBadge.badge_id == badge_id).first()
    if row is None:
        db.add(UserBadge(user_id=user_id, badge_id=badge_id, tier=tier))
        try:
            db.commit()
        except IntegrityError:            # 并发插入撞唯一约束：对方先到，本次不算新发
            db.rollback()
            return False
    elif (row.tier or 0) >= tier:
        return False
    else:
        row.tier = tier
        row.awarded_at = datetime.now(timezone.utc)   # 「获得日期」= 到达当前档的日期
        db.commit()
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
        name = badge_display_name(badge_id, tier)
        dispatch_event_push(
            user_id, EVENT_BADGE_AWARDED,
            "获得新勋章",
            f"你解锁了勋章「{name}」，去看看吧。",
        )
    except Exception:
        logging.getLogger("gamification").exception(
            "badge push failed (user=%s badge=%s tier=%s)", user_id, badge_id, tier
        )
    return True


def equipped_badge_tiers(db, users) -> dict[str, int]:
    """各用户「默认佩戴」那枚的档位 → {user_id: tier}。榜单行 / 比赛行 / 荣誉墙只
    带 badge id 画不出金银铜，要把档位一并下发；一次 IN 查询取齐，不逐行查。
    没戴、或戴的是独立勋章 → 0。
    Tier of each user's default equipped badge → {user_id: tier}. Board rows,
    competition rows and the hall of champions carry only the badge id, which
    can't tell bronze from gold, so the tier travels with it; one IN query for all.
    Nothing equipped, or a standalone badge → 0."""
    wanted = {u.id: u.equipped_badge for u in users if u is not None and u.equipped_badge}
    if not wanted:
        return {}
    rows = (db.query(UserBadge.user_id, UserBadge.badge_id, UserBadge.tier)
              .filter(UserBadge.user_id.in_(list(wanted))).all())
    return {uid: (tier or 0) for uid, bid, tier in rows if wanted.get(uid) == bid}


def _has_real_fill(db, user_id) -> bool:
    """"首笔实盘成交"要求一笔真正的开仓（action=="ORDER"）。Gateway 的
    gateway_execute.apply_trade_result 对 CLOSE/MODIFY 动作同样会置 FILLED 并照样打
    trade_mode 快照，若不按 action 过滤，只改过止损或平掉一笔非本平台开的
    实盘仓位、从未真正开过仓的用户也会被判定"已实盘"——与 stats.py 的
    _filled_orders 同一道理，同样只认 ORDER。
    "first real trade" requires an actual open (action=="ORDER"). Gateway's
    gateway_execute.apply_trade_result marks CLOSE/MODIFY FILLED too and still stamps
    trade_mode, so without this filter a user who only ever modified a stop
    or closed a position this platform never opened — on a real account —
    would be judged as having a real trade. Mirrors stats.py's
    _filled_orders, which only counts ORDER for the same reason.
    """
    return (db.query(Order.id)
              .filter(Order.user_id == user_id, Order.status == "FILLED",
                      Order.action == "ORDER", Order.trade_mode == REAL)
              .first() is not None)


# ---- 起步 / starter ----

def _j_profile_complete(db, user, ctx):
    from app.services.gateway_binding import not_removed
    bound = db.query(MT5Account.id).filter(MT5Account.user_id == user.id, not_removed()).first()
    return bool(user.nickname) and bound is not None


def _j_first_close(db, user, ctx):
    return ctx["stats"]["trades_any"] >= 1


def _j_first_real_trade(db, user, ctx):
    return _has_real_fill(db, user.id)


# ---- 胜手 / winning hand（单账户考、按人戴）----

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
    `data` 是 stats.load_trade_data 的结果；传了就不再查库（每小时循环里遍历
    整仓的判定共用一份），不传就自己查。"""
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


# ---- 常青 / evergreen ----

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


# 注册表。"name" 是给推送正文用的展示名镜像，与 frontend/src/i18n/zh.json 的
# gamification.badges.<id>.name 保持一致；改了名字记得两边同步，失步只会让推送
# 文案悄悄跟页面对不上，不会报错。推送只走中文（沿用 gateway.py / auto_manage.py
# 的先例）。
#   max_tier = 3：进阶勋章，judges 是 [铜, 银, 金] 三个判定函数，或 None（终审授予）；
#   max_tier = 0：独立勋章，judges 是单个判定函数或 None。
# Registry. "name" mirrors the display name used in push copy (source of truth:
# the frontend i18n). max_tier=3 marks a tiered badge whose judges are the
# [bronze, silver, gold] callables (or None when settlement awards it);
# max_tier=0 is a standalone badge with a single judge (or None).
BADGES: dict[str, dict] = {
    "starter": {
        "category": "growth", "name": "起步", "max_tier": 3,
        "judges": [_j_profile_complete, _j_first_close, _j_first_real_trade],
    },
    "evergreen": {
        "category": "performance", "name": "常青", "max_tier": 3,
        "judges": [_j_evergreen(3), _j_evergreen(6), _j_evergreen(12)],
    },
    "winning_hand": {
        "category": "performance", "name": "胜手", "max_tier": 3,
        "judges": [_j_hundred_wins, _j_midas_touch, _j_profit_factor],
    },
    # 赛场：完赛铜 / 前三银 / 冠军金，终审事务内授予（competitions.settle_competition）。
    # Arena: finisher bronze / podium silver / champion gold, awarded at settlement.
    "arena": {"category": "competition", "name": "赛场", "max_tier": 3, "judges": None},
    # 卫冕王：连续两届冠军，终审时判；冠军之上再无档位，独立一枚。
    # Back-to-back champion: judged at settlement; above gold, so a standalone badge.
    "comp_back_to_back": {"category": "competition", "name": "卫冕王", "max_tier": 0, "judges": None},
    "founder_2026": {"category": "limited", "name": "创始元老", "max_tier": 0, "judges": _j_founder_2026},
}


def judge_and_award_badges(db, user_id, data: dict | None = None) -> list[str]:
    """判定并授予。返回本次新发 / 升档的条目：进阶勋章写成 "起步id:档位"
    （如 "starter:3"），独立勋章就是 id。
    `data` 是 stats.load_trade_data 的结果，可由每小时循环预先读好传入；放进 ctx
    后所有遍历整仓的判定都从这一份数据判，不再各自查库。
    Judge and award. Returns what was newly awarded or upgraded this pass:
    "badge:tier" for tiered badges (e.g. "starter:3"), the bare id for standalone
    ones. `data` (from stats.load_trade_data) may be preloaded by the hourly pass."""
    user = db.get(User, user_id)
    if user is None:
        return []
    owned = {b.badge_id: (b.tier or 0)
             for b in db.query(UserBadge).filter(UserBadge.user_id == user_id)}
    if data is None:
        data = load_trade_data(db, user_id)
    ctx = {"stats": compute_comprehensive_stats(db, user_id, data),
           "lifetime": compute_account_lifetime_stats(db, user_id, data),
           "data": data}
    newly: list[str] = []
    for bid, meta in BADGES.items():
        judges = meta["judges"]
        if judges is None:
            continue
        if meta["max_tier"] == 0:
            if bid in owned:
                continue
            if judges(db, user, ctx) and award_badge(db, user_id, bid, 0):
                newly.append(bid)
            continue
        # 从最高档往下找第一个满足的；只判比已持有档位高的那几档。
        # Walk down from the top tier to the first satisfied one, only above what is held.
        have = owned.get(bid, 0)
        for tier in range(meta["max_tier"], have, -1):
            if judges[tier - 1](db, user, ctx):
                if award_badge(db, user_id, bid, tier):
                    newly.append(f"{bid}:{tier}")
                break
    return newly
