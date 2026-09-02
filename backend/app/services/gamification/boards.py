"""榜单计算（设计 §1.5/§1.6/§4）：按账户拍基线、对账入金、整仓计分、快照排名。"""
import logging
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError

from app.models import ClosedTrade, MT5Account, PeriodBaseline, User
from .periods import period_bounds

log = logging.getLogger("gamification")
RECONCILE_TOLERANCE = 0.01
REAL = 2


def _now():
    return datetime.now(timezone.utc)


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


def reconcile_deposits(db, period_key: str) -> int:
    """对每条基线，若账号行仍在且 balance 非 NULL：
    delta = balance − (baseline + adjust) − realized_since(taken_at, login)；
    delta > RECONCILE_TOLERANCE → adjust += delta（入金并入分母）；
    负 delta（出金）忽略；账号行已不在（解绑）→ 冻结不动，不报错。

    只对当前进行中的周期调用（结束周期不对账）：周期结束后账户仍在正常交易，
    期后的盈亏会被 _realized_since 当成「realized」减掉，从而把期后的正常
    交易误判成入金、永久污染一个已封存周期的分母——即使在 48h 重算窗内也不
    对账，重算窗只重算榜单快照，不重开基线/对账。
    """
    _start, end = period_bounds(period_key)
    if datetime.now(timezone.utc) >= end:
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
