"""每小时游戏化循环（设计 §3.3/§4.2 成本约束：threadpool、串行、打点）。
生产为单进程（config 多 worker 无共享存储拒启动），无需分布式锁。"""
import asyncio
import logging
import time
from datetime import datetime, timezone

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
                # 单个用户的判定失败不该拖垮整轮——记日志，继续下一个，否则一条
                # 脏数据就能让全体用户当轮判定全部跳过。这里的 rollback 不是在
                # 撤销已生效的写入：_record/award_badge 各自按条 commit（成功一
                # 条落一条，IntegrityError 各自 rollback 后返回 False），加上
                # UserTask/UserBadge 的唯一约束，已提交的部分是幂等的，下一轮
                # 重新判定也不会重复写入。这里的 rollback 只是清掉抛异常那一刻
                # session 里任何未提交的残留，让下一个用户拿到一个干净的事务。
                # One user's judging failure must not sink the whole pass: log
                # and move on, otherwise a single bad row would skip judging for
                # everyone in this pass. The rollback here does not undo work
                # that already took effect: _record/award_badge each commit per
                # record (a success persists immediately; an IntegrityError rolls
                # back and returns False), and the UserTask/UserBadge unique
                # constraints make the committed subset idempotent, so a retry
                # next pass won't double-write. This rollback only clears
                # whatever uncommitted state is left on the session at the point
                # of the exception, so the next user starts from a clean transaction.
                log.exception("gamification pass: user %s judging failed", uid)
                db.rollback()
                failed += 1
        board_stats = {}
        try:
            from .boards import snapshot_boards
            board_stats = snapshot_boards(db, datetime.now(timezone.utc))
        except Exception:
            # 榜单快照失败不该拖累前三阶段已经判出的结果——记日志、回滚榜单相关的
            # 未提交残留，本轮的条件/勋章判定照常返回，下一轮再补拍快照。
            log.exception("gamification pass: board snapshot failed")
            db.rollback()
            board_stats = {"error": True}
        return {"accounts": acc, "stamped": stamped, "sentinel": sentinel,
                "users": len(uids), "newConditions": conds, "newBadges": badges,
                "failedUsers": failed,
                "boardPeriods": board_stats.get("periods", 0),
                "boardRows": board_stats.get("rows", 0),
                "boardsError": board_stats.get("error", False)}
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
