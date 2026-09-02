"""勋章注册表与判定（设计 §3）。17 枚，稀有度金字塔；比赛类 Phase 3 终审授予。"""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.models import DisciplineSnapshot, MT5Account, Order, UserBadge
from .stats import compute_account_lifetime_stats, compute_comprehensive_stats

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


def award_badge(db, user_id, badge_id) -> bool:
    db.add(UserBadge(user_id=user_id, badge_id=badge_id))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def _has_real_fill(db, user_id) -> bool:
    return (db.query(Order.id)
              .filter(Order.user_id == user_id, Order.status == "FILLED",
                      Order.trade_mode == REAL)
              .first() is not None)


def _j_profile_complete(db, user, ctx):
    bound = db.query(MT5Account.id).filter(MT5Account.user_id == user.id).first()
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


def _discipline_streak(db, user_id, n) -> bool:
    """login="" 聚合行；total<90 或 NULL 或缺日均断连（设计 §3.2：宁严勿松）。"""
    rows = (db.query(DisciplineSnapshot.date, DisciplineSnapshot.total)
              .filter(DisciplineSnapshot.user_id == user_id,
                      DisciplineSnapshot.login == "").all())
    ok_days = sorted(date.fromisoformat(d) for d, t in rows if t is not None and t >= 90)
    run = 1
    for a, b in zip(ok_days, ok_days[1:]):
        run = run + 1 if b - a == timedelta(days=1) else 1
        if run >= n:
            return True
    return n <= 1 and bool(ok_days)


BADGES: dict[str, dict] = {
    "profile_complete": {"rarity": "common", "category": "growth", "judge": _j_profile_complete},
    "first_close":      {"rarity": "common", "category": "growth", "judge": _j_first_close},
    "first_real_trade": {"rarity": "common", "category": "growth", "judge": _j_first_real_trade},
    "comp_finisher":    {"rarity": "common", "category": "competition", "judge": None},
    "evergreen_3m":     {"rarity": "rare", "category": "performance", "judge": None},   # Task 9 填
    "discipline_90_7":  {"rarity": "rare", "category": "discipline",
                         "judge": lambda db, u, c: _discipline_streak(db, u.id, 7)},
    "hundred_wins":     {"rarity": "rare", "category": "performance", "judge": _j_hundred_wins},
    "midas_touch":      {"rarity": "epic", "category": "performance", "judge": _j_midas_touch},
    "profit_factor_2":  {"rarity": "epic", "category": "performance", "judge": None},   # Task 9 填
    "evergreen_6m":     {"rarity": "epic", "category": "performance", "judge": None},   # Task 9 填
    "discipline_90_30": {"rarity": "epic", "category": "discipline",
                         "judge": lambda db, u, c: _discipline_streak(db, u.id, 30)},
    "no_bad_sl_50":     {"rarity": "epic", "category": "discipline", "judge": None},    # Task 9 填
    "comp_podium":      {"rarity": "epic", "category": "competition", "judge": None},
    "evergreen_12m":    {"rarity": "legendary", "category": "performance", "judge": None},  # Task 9 填
    "comp_winner":      {"rarity": "legendary", "category": "competition", "judge": None},
    "comp_back_to_back": {"rarity": "legendary", "category": "competition", "judge": None},
    "founder_2026":     {"rarity": "limited", "category": "limited", "judge": _j_founder_2026},
}


def judge_and_award_badges(db, user_id) -> list[str]:
    from app.models import User
    user = db.get(User, user_id)
    if user is None:
        return []
    owned = {b.badge_id for b in db.query(UserBadge).filter(UserBadge.user_id == user_id)}
    ctx = {"stats": compute_comprehensive_stats(db, user_id),
           "lifetime": compute_account_lifetime_stats(db, user_id)}
    newly = []
    for bid, meta in BADGES.items():
        if bid in owned or meta["judge"] is None:
            continue
        if meta["judge"](db, user, ctx) and award_badge(db, user_id, bid):
            newly.append(bid)
    return newly
