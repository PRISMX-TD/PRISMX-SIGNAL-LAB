"""每小时游戏化循环（设计 §3.3/§4.2 成本约束：threadpool、串行、打点）。
生产为单进程（config 多 worker 无共享存储拒启动），无需分布式锁。"""
import asyncio
import logging
import time
from datetime import date, datetime, timedelta, timezone

from app.core.database import SessionLocal
from app.models import ClosedTrade, MT5Account, Order, User
from sqlalchemy import or_

from app.services.account_type import classify_account
from app.services.settings_store import get_account_type_settings
from .conditions import judge_and_record_conditions
from .badges import judge_and_award_badges
from .stats import compute_comprehensive_stats, load_trade_data

log = logging.getLogger("gamification")
LOOP_INTERVAL_SECONDS = 3600
SLOW_PASS_WARN_SECONDS = 120
# 增量判定的候选窗口回退量：上一趟 pass 的起点再往前让 10 分钟，抵消"成交落库
# 时刻晚于 closed_at"和两趟 pass 之间的时钟抖动，宁可多判几个人也不漏。
# Slack subtracted from the previous pass's start when picking candidates: covers
# rows persisted slightly after their timestamps and clock jitter between passes.
CANDIDATE_SLACK = timedelta(minutes=10)
# 进程内：上一趟 pass 的起点、最近一次全量 pass 的 UTC 日期。重启后两者为空 →
# 第一趟必然全量，不需要持久化。
# In-process: when the previous pass started and the UTC day of the last full pass.
# Both empty after a restart, so the first pass is always full — nothing to persist.
_last_pass_started_at: datetime | None = None
_last_full_pass_day: date | None = None
# 比赛榜单单独一条快循环：整点那趟 pass 一小时才跑一次，对正在进行的比赛来说太慢——
# 用户平仓后要等最多一小时名次才动。比赛快照只碰 running/ended 的比赛与它们的参赛
# 账户，比整趟 pass（全体用户的条件 + 勋章 + 两张周期榜）轻得多，可以跑得密。
# 没有进行中的比赛时这条循环只花一次 count 查询就睡下，等于不产生负载。
# Competition boards get their own fast loop: the hourly pass is far too slow for a
# live competition (a trader would wait up to an hour to see their rank move). A
# competition snapshot only touches running/ended competitions and their entrants —
# much lighter than a full pass (every user's conditions + badges + both period
# boards) — so it can run often. With no live competition it costs one count query
# per tick and goes back to sleep, i.e. no load at all.
COMP_LOOP_INTERVAL_SECONDS = 60
SLOW_COMP_PASS_WARN_SECONDS = 20


def backfill_account_trade_modes(db) -> int:
    """把还没判定过的账号补上 trade_mode：组名优先（gateway 通道权威），
    没有组名或组名判不出来时依次按登录号段、服务器名兜底（桥接通道，见
    classify_account）。桥接账号实际主要靠 `server_login_rules` 的登录号段
    规则命中——比如 Make Capital 一台服务器混跑模拟与实盘，靠登录号前几位
    区分；`real_server_names` 整服务器白名单默认为空，只在券商真把模拟/
    实盘分到不同服务器时才配置。

    **为什么要放宽到"组名 OR 服务器名非空"**：老版本桥接客户端不上报组名，
    只上报 server——只筛 `mt5_group.isnot(None)` 会把这些账号永远排除在这轮
    回填之外。宽到两者任一非空，剩下靠 classify_account 自己判不出来时返回
    None，行不受影响。

    Backfill accounts still missing trade_mode: group name first (gateway
    channel, authoritative), then login-prefix, then server name as fallback
    when there's no group or the group doesn't classify (bridge channel — see
    classify_account). In practice bridge accounts are driven by the
    server_login_rules login-prefix rules — e.g. Make Capital mixes demo and
    live on one server, told apart by login prefix; the whole-server
    `real_server_names` whitelist defaults to empty and only applies to
    brokers that genuinely segregate demo/live onto separate servers. Widened
    to "group OR server non-null" because older bridge clients report no group
    at all; classify_account still returns None for anything it can't place.
    """
    rows = (db.query(MT5Account)
              .filter(MT5Account.trade_mode.is_(None),
                      or_(MT5Account.mt5_group.isnot(None),
                          MT5Account.server.isnot(None))).all())
    cfg = get_account_type_settings(db)
    n = 0
    for row in rows:
        tm = classify_account(row.mt5_group, row.server, row.login, cfg)
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


def select_candidate_users(db, since: datetime | None) -> list[str]:
    """本趟要判定的用户。since=None → 全体（全量 pass）。

    增量 pass 只挑 since 以来"有可能变化"的人：
      · 有新的 FILLED 开仓单（created_at）——笔数/手数/交易日/胜率类条件；
      · 有新落库的平仓腿（created_at，不是 closed_at：回补进来的老成交也算）——
        整仓判定、盈亏类条件、五枚看整仓的勋章；
      · 活跃过（last_active_at，任何已登录请求都会 5 分钟节流地打这一列）——
        改昵称、绑账号、开策略、活跃日连续这些不经过交易表的条件。
    纪律分快照、自然月翻页这类"用户什么都没做也会变"的输入，靠每天一趟全量
    pass 兜底（见 run_gamification_pass）；用户自己打开成就页也会即时判定一次。

    Users to judge this pass; None means everyone. An incremental pass takes only
    users who could have changed since `since`: new FILLED orders, newly persisted
    closing legs (created_at, so backfilled old closes count too), or any activity
    (last_active_at covers nickname/bind/strategy/streak). Inputs that move
    without the user doing anything — discipline snapshots, month rollover — are
    caught by the daily full pass, and by the user opening the achievements page.
    """
    if since is None:
        return [r[0] for r in db.query(User.id).all()]
    ids: set[str] = set()
    ids.update(r[0] for r in db.query(User.id).filter(User.last_active_at >= since))
    ids.update(r[0] for r in db.query(Order.user_id)
                               .filter(Order.status == "FILLED", Order.created_at >= since)
                               .distinct())
    ids.update(r[0] for r in db.query(ClosedTrade.user_id)
                               .filter(ClosedTrade.created_at >= since)
                               .distinct())
    return sorted(ids)


def run_gamification_pass(full: bool | None = None) -> dict:
    """整趟 pass。`full`：None=自动（重启后首趟、或今天还没跑过全量 → 全量；否则
    增量，只判 select_candidate_users 挑出的人）；True/False 强制。

    **为什么要分增量/全量**：原来每小时把全体用户逐个判一遍，每人还要把 365 天
    订单读 7 次以上，是 O(用户数 × 订单数) 的活，用户过百这条循环就跑不完
    （SLOW_PASS_WARN_SECONDS 就是为它预留的告警）。绝大多数用户在任意一小时里
    什么都没变，判了也是白判。每天一趟全量是为了兜住"没人动它也会变"的输入。

    Full vs incremental: the pass used to judge every user every hour, reloading
    each user's year of orders 7+ times — O(users × orders), unworkable past a
    hundred users. Almost nobody changes in a given hour. One full pass a day
    still catches inputs that move on their own (snapshots, month rollover).
    """
    global _last_pass_started_at, _last_full_pass_day
    started = datetime.now(timezone.utc)
    if full is None:
        full = _last_pass_started_at is None or _last_full_pass_day != started.date()
    since = None if full else _last_pass_started_at - CANDIDATE_SLACK
    db = SessionLocal()
    try:
        acc = backfill_account_trade_modes(db)
        stamped, sentinel = backfill_order_trade_modes(db)
        uids = select_candidate_users(db, since)
        conds = badges = 0
        failed = 0
        for uid in uids:
            try:
                # 一次读、处处用：订单+平仓腿读一遍，综合统计算一遍，条件与勋章共用。
                # Load once, judge everything from it.
                data = load_trade_data(db, uid)
                stats = compute_comprehensive_stats(db, uid, data)
                conds += len(judge_and_record_conditions(db, uid, stats))
                badges += len(judge_and_award_badges(db, uid, data))
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
        now = datetime.now(timezone.utc)     # 榜单与比赛快照共用同一个时钟，同一轮内口径一致
        board_stats = {}
        try:
            from .boards import snapshot_boards
            board_stats = snapshot_boards(db, now)
        except Exception:
            # 榜单快照失败不该拖累前三阶段已经判出的结果——记日志、回滚榜单相关的
            # 未提交残留，本轮的条件/勋章判定照常返回，下一轮再补拍快照。
            log.exception("gamification pass: board snapshot failed")
            db.rollback()
            board_stats = {"error": True}
        comp_stats = {}
        try:
            from .competitions import snapshot_competitions
            comp_stats = snapshot_competitions(db, now)
        except Exception:
            # 同上：比赛快照失败不该拖累前四阶段（含榜单）已经落定的结果——记日志、
            # 回滚比赛相关的未提交残留，本轮其余结果照常返回，下一轮再补拍快照。
            log.exception("gamification pass: competition snapshot failed")
            db.rollback()
            comp_stats = {"error": True}
        # 只有整趟跑到这里才推进水位：中途异常抛出去的话，下一趟会以更早的
        # since 重判，宁可重复不可漏判。
        # Advance the watermark only on completion; an exception leaves it, so the
        # next pass re-judges from the earlier point — duplicates are harmless, gaps aren't.
        _last_pass_started_at = started
        if full:
            _last_full_pass_day = started.date()
        return {"accounts": acc, "stamped": stamped, "sentinel": sentinel,
                "users": len(uids), "full": full,
                "newConditions": conds, "newBadges": badges,
                "failedUsers": failed,
                "boardPeriods": board_stats.get("periods", 0),
                "boardRows": board_stats.get("rows", 0),
                "boardsError": board_stats.get("error", False),
                "compCount": comp_stats.get("comps", 0),
                "compRows": comp_stats.get("rows", 0),
                "compsError": comp_stats.get("error", False)}
    finally:
        db.close()


def run_competition_pass() -> dict:
    """只重算比赛榜快照（不碰条件/勋章/周期榜）。没有进行中或待终审的比赛时
    直接返回，不开销任何计算——快循环绝大多数时候走的就是这条路。

    Recomputes competition board snapshots only (no conditions/badges/period
    boards). Returns immediately when no competition is running or awaiting
    settlement, which is what this fast loop does almost all of the time."""
    from app.models import Competition
    from .competitions import snapshot_competitions
    db = SessionLocal()
    try:
        live = (db.query(Competition.id)
                  .filter(Competition.status.in_(("running", "ended"))).first())
        if live is None:
            return {"comps": 0, "rows": 0, "idle": True}
        try:
            return snapshot_competitions(db, datetime.now(timezone.utc))
        except Exception:
            # 与整趟 pass 里的处理一致：记日志、回滚未提交的残留，下一轮再来。
            # 快循环失败绝不能把循环本身带崩——名次晚一分钟远好过不再更新。
            # Same handling as inside the full pass: log, roll back whatever is
            # uncommitted, retry next tick. A failure here must never kill the loop:
            # a rank that is one minute stale beats a rank that stops updating.
            log.exception("competition pass failed")
            db.rollback()
            return {"comps": 0, "rows": 0, "error": True}
    finally:
        db.close()


async def competition_loop(startup_delay: float = 35.0):
    """比赛榜快循环（默认 60 秒）。整点那趟 pass 仍然照常也会刷比赛快照——
    两者都是「先删后插同一批行」，重复执行幂等，不需要互斥。
    Fast competition-board loop (60s by default). The hourly pass still refreshes
    competition snapshots as well; both are delete-then-insert over the same rows,
    so running them both is idempotent and needs no mutual exclusion."""
    await asyncio.sleep(startup_delay)      # 首个 await 前零阻塞（main.py:61-70 约束）
    from starlette.concurrency import run_in_threadpool
    while True:
        try:
            t0 = time.monotonic()
            result = await run_in_threadpool(run_competition_pass)
            dur = time.monotonic() - t0
            # 空转（没有进行中的比赛）不打日志，否则一分钟一行把日志刷满。
            # Idle ticks (no live competition) aren't logged, or this would fill the
            # log with one line a minute.
            if not result.get("idle"):
                log.info("competition pass %.1fs %s", dur, result)
            if dur > SLOW_COMP_PASS_WARN_SECONDS:
                log.warning("competition pass slow: %.1fs", dur)
        except Exception:
            log.exception("competition loop failed")
        await asyncio.sleep(COMP_LOOP_INTERVAL_SECONDS)


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
