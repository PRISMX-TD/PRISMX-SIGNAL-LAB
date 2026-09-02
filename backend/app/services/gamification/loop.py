"""每小时游戏化循环（设计 §3.3/§4.2 成本约束：threadpool、串行、打点）。
生产为单进程（config 多 worker 无共享存储拒启动），无需分布式锁。"""
import asyncio
import logging
import time

from app.core.database import SessionLocal
from app.models import MT5Account, Order, User
from app.services.account_type import classify_group
from app.services.settings_store import get_account_type_settings
from .conditions import judge_and_record_conditions
from .badges import judge_and_award_badges

log = logging.getLogger("gamification")
LOOP_INTERVAL_SECONDS = 3600
SLOW_PASS_WARN_SECONDS = 120


def backfill_account_trade_modes(db) -> int:
    rows = (db.query(MT5Account)
              .filter(MT5Account.trade_mode.is_(None),
                      MT5Account.mt5_group.isnot(None)).all())
    cfg = get_account_type_settings(db)
    n = 0
    for row in rows:
        tm = classify_group(row.mt5_group, cfg)
        if tm is not None:
            row.trade_mode = tm
            n += 1
    if n:
        db.commit()
    return n


def backfill_order_trade_modes(db) -> tuple[int, int]:
    orders = (db.query(Order)
                .filter(Order.status == "FILLED", Order.trade_mode.is_(None),
                        Order.mt5_login.isnot(None)).all())
    acct = {(a.user_id, a.login): a.trade_mode for a in db.query(MT5Account).all()}
    stamped = sentinel = 0
    for o in orders:
        key = (o.user_id, o.mt5_login)
        if key not in acct:
            o.trade_mode = -1           # 账号行已删：永远无来源，哨兵收敛
            sentinel += 1
        elif acct[key] is not None:
            o.trade_mode = acct[key]
            stamped += 1
        # 账号行在但 trade_mode 仍 NULL：等账号被判定后的下一轮
    if stamped or sentinel:
        db.commit()
    return stamped, sentinel


def run_gamification_pass() -> dict:
    db = SessionLocal()
    try:
        acc = backfill_account_trade_modes(db)
        stamped, sentinel = backfill_order_trade_modes(db)
        uids = [r[0] for r in db.query(User.id).all()]
        conds = badges = 0
        failed = 0
        for uid in uids:
            try:
                conds += len(judge_and_record_conditions(db, uid))
                badges += len(judge_and_award_badges(db, uid))
            except Exception:
                # 单个用户的判定失败不该拖垮整轮——回滚这个用户的半截改动，
                # 记日志，继续下一个。否则一条脏数据就能让全体用户当轮判定全部跳过。
                # One user's judging failure must not sink the whole pass: roll
                # back that user's partial writes, log, and move on to the next
                # user. Otherwise a single bad row would skip judging for everyone
                # in this pass.
                log.exception("gamification pass: user %s judging failed", uid)
                db.rollback()
                failed += 1
        return {"accounts": acc, "stamped": stamped, "sentinel": sentinel,
                "users": len(uids), "newConditions": conds, "newBadges": badges,
                "failedUsers": failed}
    finally:
        db.close()


async def gamification_loop(startup_delay: float = 25.0):
    await asyncio.sleep(startup_delay)      # 首个 await 前零阻塞（main.py:61-70 约束）
    from starlette.concurrency import run_in_threadpool
    while True:
        try:
            t0 = time.monotonic()
            result = await run_in_threadpool(run_gamification_pass)
            dur = time.monotonic() - t0
            log.info("gamification pass %.1fs %s", dur, result)
            if dur > SLOW_PASS_WARN_SECONDS:
                log.warning("gamification pass slow: %.1fs", dur)
        except Exception:
            log.exception("gamification pass failed")
        await asyncio.sleep(LOOP_INTERVAL_SECONDS)
