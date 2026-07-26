"""信号结果判定：baseline 核心对 Signal 与 StrategySignal 两表通用。

共用而非各写一份，是为了让"策略胜率"与"平台胜率"口径一致、可直接对比——这
正是策略卡片并排展示两个数字的前提。旧策略侧实现直接取整根 K 线高低点判定，
在一根 4H K 线中途触发时会把该 K 线此前数小时的波动计入命中，系统性高估胜率。

Signal-result resolution; the baseline core is shared by the Signal and
StrategySignal tables. Sharing (rather than two copies) is what makes "strategy
win rate" and "platform win rate" the same measurement and therefore
comparable — the premise of showing both side by side on a strategy card. The
old strategy-side code resolved against a whole bar's high/low, so a signal
firing partway through a 4H bar counted the preceding hours of movement as a
hit, systematically overstating win rates.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import StrategySignal, UserStrategy

logger = logging.getLogger("prismx.strategy_resolution")

# 与 signal_resolution 的清扫间隔一致：判定窗口以天计，不需要密集轮询。
# Same cadence as signal_resolution's sweep: the threshold is in days.
STALE_SWEEP_INTERVAL_SECONDS = 3600


def apply_baseline(sig, low: float, high: float) -> str | None:
    """用一次上报的高低点对单条信号做 baseline 判定，原地更新基线。

    首次观测（基线为空）只记录基线、不判定：本次上报的这根 K 线可能早于信号
    创建就已在形成，其高低点混有与该信号无关的波动。此后只有真正超出基线的
    新极值才计入判定。基线单调扩张，因此不会漏判任何真实发生在信号创建之后
    的命中。同一次上报双触发按止损处理（保守，不猜对统计更好看的结果）。

    返回 "HIT_SL" / "HIT_TP"，未命中返回 None。不写 result / resolved_at——由
    调用方决定（策略侧还要处理超时），也让本函数对两张表都无副作用假设。

    Resolve one signal against a single report's high/low, updating its
    baseline in place. The first observation (baseline empty) only records the
    baseline: the reported bar may have started forming before the signal
    existed, mixing in unrelated movement. From then on only a genuinely new
    extreme beyond the baseline counts. The baseline only ever grows, so no real
    post-signal hit is missed. A double touch within one report counts as a stop
    (conservative — never guess the flattering outcome).

    Returns "HIT_SL"/"HIT_TP", or None. Deliberately does not write
    result/resolved_at: the caller decides (the strategy side also has to handle
    timeouts), which keeps this function free of table-specific assumptions.
    """
    if sig.stop_loss is None or sig.take_profit is None:
        return None

    if sig.baseline_high is None or sig.baseline_low is None:
        sig.baseline_high = high
        sig.baseline_low = low
        return None

    new_high = high > sig.baseline_high
    new_low = low < sig.baseline_low
    sig.baseline_high = max(sig.baseline_high, high)
    sig.baseline_low = min(sig.baseline_low, low)

    if sig.side == "BUY":
        hit_tp = new_high and high >= sig.take_profit
        hit_sl = new_low and low <= sig.stop_loss
    else:
        hit_tp = new_low and low <= sig.take_profit
        hit_sl = new_high and high >= sig.stop_loss

    if hit_sl:
        return "HIT_SL"
    if hit_tp:
        return "HIT_TP"
    return None


def resolve_strategy_signals(db: Session, symbol: str, interval: str, bar: dict) -> list[StrategySignal]:
    """用一根刚收盘的 K 线判定该 (品种, 周期) 下全部 PENDING 策略信号。

    与策略的 one_trade_at_a_time 完全无关：判定是"这笔到底赢了还是输了"的事实
    记录，与"是否允许开新仓"是两件事。旧实现把判定写在一次一单分支内，导致
    关掉一次一单的策略其信号永久 PENDING。

    调用方管理事务：本函数不提交、不关闭。

    Resolve every PENDING strategy signal on this (symbol, interval) using one
    freshly closed bar. Entirely independent of the strategy's
    one_trade_at_a_time: resolution records the fact of win or loss, which is a
    different question from whether a new position may open. The old code nested
    resolution inside the one-trade-at-a-time branch, so signals from strategies
    with it off stayed PENDING forever. The caller owns the transaction.
    """
    pending = (
        db.query(StrategySignal)
        .filter(
            StrategySignal.symbol == symbol,
            StrategySignal.interval == interval,
            StrategySignal.result == "PENDING",
        )
        .all()
    )
    if not pending:
        return []

    low, high, close = bar["l"], bar["h"], bar["c"]
    if low > high:
        logger.warning("resolve_strategy_signals: low > high for %s/%s, skipping", symbol, interval)
        return []

    # 超时根数按策略读一次，避免每条信号一次查询（N+1）。
    # Fetch each strategy's timeout once instead of per signal (N+1).
    strategy_ids = {s.strategy_id for s in pending}
    timeouts = {
        row.id: row.exit_timeout_bars
        for row in db.query(UserStrategy).filter(UserStrategy.id.in_(strategy_ids)).all()
    }

    now = datetime.now(timezone.utc)
    resolved: list[StrategySignal] = []
    for sig in pending:
        first_observation = sig.baseline_high is None or sig.baseline_low is None
        outcome = apply_baseline(sig, low, high)
        # bars_held 从"信号存在期间经过的收盘 K 线"开始计数，首次观测那根也算：
        # 它确实已经收盘，只是其高低点不可信（可能早于信号创建就在形成），
        # 而"过了几根"这件事与价格是否可信无关。
        # bars_held counts closed bars elapsed while the signal existed,
        # including the first observation: that bar really did close; only its
        # high/low are untrustworthy (it may predate the signal), and "how many
        # bars have passed" doesn't depend on that.
        sig.bars_held = (sig.bars_held or 0) + 1
        if outcome is not None:
            sig.result = outcome
            sig.resolved_at = now
            resolved.append(sig)
            continue
        limit = timeouts.get(sig.strategy_id)
        if limit is not None and not first_observation and sig.bars_held >= limit:
            # 超时平仓：按当根收盘价平仓，记 TIMEOUT。计入绩效（是一个真实
            # 出场），与 STALE（数据源中断，不计入）区分。
            # Timeout exit at this bar's close, recorded as TIMEOUT. Counts
            # toward performance (it's a real exit), unlike STALE (feed outage).
            sig.result = "TIMEOUT"
            sig.resolved_at = now
            resolved.append(sig)
            logger.info(
                "resolve_strategy_signals: signal %s timed out after %d bar(s) at close %.6f",
                sig.id, sig.bars_held, close,
            )
    return resolved


def sweep_stale_strategy_signals(db: Session) -> list[StrategySignal]:
    """把追踪太久、从未等到结果的 PENDING 策略信号标记为 STALE。

    数据源中断的保险丝，同时解决"一次一单策略因永久 PENDING 卡死不再触发"。
    STALE 不计入绩效统计。调用方管理事务。

    Mark long-unresolved PENDING strategy signals STALE: a feed-outage safety
    net that also unblocks a one-trade-at-a-time strategy stuck behind a
    permanently pending row. STALE is excluded from performance stats. The
    caller owns the transaction.
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=settings.SIGNAL_STALE_DAYS)
    stale: list[StrategySignal] = []
    for sig in db.query(StrategySignal).filter(StrategySignal.result == "PENDING").all():
        created = sig.created_at
        if created is None:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created < cutoff:
            sig.result = "STALE"
            sig.resolved_at = now
            stale.append(sig)
    return stale


async def stale_strategy_signal_sweep_loop() -> None:
    """周期性清扫策略信号的 STALE，与平台信号的同名循环同一模式。
    Periodic STALE sweep for strategy signals, same shape as the platform one."""
    from starlette.concurrency import run_in_threadpool

    from app.core.database import SessionLocal

    def _sweep() -> int:
        db = SessionLocal()
        try:
            stale = sweep_stale_strategy_signals(db)
            if stale:
                db.commit()
            return len(stale)
        finally:
            db.close()

    while True:
        await asyncio.sleep(STALE_SWEEP_INTERVAL_SECONDS)
        try:
            count = await run_in_threadpool(_sweep)
            if count:
                logger.info("stale_strategy_signal_sweep_loop: marked %d signal(s) STALE", count)
        except Exception:
            logger.exception("stale_strategy_signal_sweep_loop error")
