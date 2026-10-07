"""信号结果判定：baseline 核心（apply_baseline）供平台 webhook 信号（Signal 表）使用；
策略信号（StrategySignal）在 K 线收盘时产生，按其后每根完整 K 线判定。

平台 webhook 信号会落在一根仍在形成的 K 线中途：取整根高低点判定会把该 K 线
此前数小时的波动计入命中，系统性高估胜率，所以首次观测只记基线。策略信号则
不同——它在收盘时产生，之后的每根 K 线完全发生在信号之后，必须与回测
（backtest.resolve_trade，从入场下一根开始）同一口径逐根判定，否则同一组 K 线
上实盘与回测给出不同结果。

Signal-result resolution. The baseline core (apply_baseline) serves platform
webhook signals (the Signal table), which land mid-way through a still-forming
bar: judging that bar's full high/low would count the preceding hours as a hit,
so the first observation only records a baseline. Strategy signals
(StrategySignal) differ — they fire at a bar's close, so every later bar lies
entirely after the signal and must be judged bar by bar exactly like the
backtest (backtest.resolve_trade, from the bar after entry); otherwise live and
backtest disagree on identical bars.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import StrategySignal, UserStrategy
from app.services.symbol_aliases import symbol_match_set

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
            # 与平台信号判定同一条别名规则：个人策略信号的品种名同样来自用户
            # 配置，与行情侧的写法未必一致。两处必须同口径，否则同一个品种在
            # "平台胜率"里判得出、在"策略胜率"里判不出。
            # The same alias rule as platform-signal resolution: a personal
            # strategy's symbol also comes from user configuration and need not
            # match the price side's spelling. Both paths must agree, or one
            # symbol would resolve for the platform win rate but not the
            # strategy win rate.
            StrategySignal.symbol.in_(symbol_match_set(symbol)),
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
    bar_t = bar.get("t")
    for sig in pending:
        # 策略信号只在 K 线**收盘**时由 live.evaluate_new_candle 产生（bar_t = 触发
        # 那根的开盘时间），而且本函数在同一次评估里先于开仓运行——所以信号之后的
        # 每一根 K 线都完整地发生在信号之后，按整根高低点直接判定即可，与回测
        # backtest.resolve_trade 从 entry_i+1 开始逐根判定同一口径。
        # 以前这里也套用了 apply_baseline 的「首次观测只记基线」：那是为平台
        # webhook 信号（Signal 表）设计的——它们会落在一根仍在形成的 K 线中途。
        # 套到策略信号上，等于把入场后的第一根整根作废：那根里真实发生的止盈/止损
        # 被吞掉、超时也晚一根，实盘与回测在同一组 K 线上给出不同结果。
        # 平台信号仍走 apply_baseline（signal_resolution.py），不受影响。
        #
        # Strategy signals are only produced at a bar's **close** by
        # live.evaluate_new_candle (bar_t = the triggering bar's open time), and
        # this function runs before entries within the same evaluation — so every
        # later bar happens entirely after the signal and is judged on its full
        # high/low, the same basis as backtest.resolve_trade scanning from
        # entry_i+1. This used to borrow apply_baseline's "first observation only
        # records a baseline", which exists for platform webhook signals (the
        # Signal table) that land mid-way through a still-forming bar. Applied
        # here it voided the whole first bar after entry: a real TP/SL there was
        # swallowed and timeouts ran one bar late, so live and backtest disagreed
        # on identical bars. Platform signals still use apply_baseline
        # (signal_resolution.py), unchanged.
        if bar_t is not None and sig.bar_t is not None and bar_t <= sig.bar_t:
            # 触发那根本身或更早的 bar（补空洞的批次会带来）：不属于持仓期，跳过。
            # The trigger bar itself or an older one (a gap-filling batch brings
            # these): not part of the holding period, skip.
            continue
        sig.bars_held = (sig.bars_held or 0) + 1
        outcome = _judge_bar(sig, low, high)
        if outcome is not None:
            sig.result = outcome
            sig.resolved_at = now
            resolved.append(sig)
            continue
        limit = timeouts.get(sig.strategy_id)
        if limit is not None and sig.bars_held >= limit:
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


def _judge_bar(sig, low: float, high: float) -> str | None:
    """用一根完整发生在信号之后的 K 线判定，规则与 backtest.resolve_trade 逐字一致：
    同根双触按止损。
    Judge one bar lying entirely after the signal, with exactly
    backtest.resolve_trade's rule: a double touch counts as a stop."""
    if sig.stop_loss is None or sig.take_profit is None:
        return None
    if sig.side == "BUY":
        hit_sl = low <= sig.stop_loss
        hit_tp = high >= sig.take_profit
    else:
        hit_sl = high >= sig.stop_loss
        hit_tp = low <= sig.take_profit
    if hit_sl:
        return "HIT_SL"
    if hit_tp:
        return "HIT_TP"
    return None


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

    # 系统状态页的心跳：每轮开头记一次（内部限频）/ status-page heartbeat
    from app.services import loop_health

    while True:
        loop_health.beat("stale_strategy_signals")
        await asyncio.sleep(STALE_SWEEP_INTERVAL_SECONDS)
        try:
            count = await run_in_threadpool(_sweep)
            if count:
                logger.info("stale_strategy_signal_sweep_loop: marked %d signal(s) STALE", count)
        except Exception:
            logger.exception("stale_strategy_signal_sweep_loop error")
