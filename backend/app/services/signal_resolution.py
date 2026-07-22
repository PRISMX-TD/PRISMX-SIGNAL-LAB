"""信号胜负判定：用行情（K 线高低点）追踪信号是先碰到止盈还是止损。

与信号的 status（ACTIVE/EXPIRED，只管"能不能拿它下单"）完全独立。信号一生成
即视为已进场，不受 10 分钟过期影响，一直追踪到真正命中 TP/SL，或者太久没有
任何行情更新（判定为 STALE，视为数据源中断，不计入胜率）。

Signal win/loss resolution: use market data (a bar's high/low) to determine
whether a signal reached its take-profit or stop-loss first.

Fully independent of the signal's `status` (ACTIVE/EXPIRED, which only governs
whether it can still be traded). A signal is treated as entered the moment
it's created and keeps being tracked until it actually hits TP/SL, or until it
goes too long without any price update (marked STALE — presumed feed outage —
and excluded from win-rate stats).
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Signal

logger = logging.getLogger("prismx.signal_resolution")

# 保险丝清扫间隔（秒）：判定窗口以天为单位，不需要频繁轮询。
# Stale-sweep interval (seconds): the threshold is measured in days, so this
# doesn't need to poll tightly.
STALE_SWEEP_INTERVAL_SECONDS = 3600


def resolve_signals_with_price(db: Session, symbol: str, low: float, high: float) -> list[Signal]:
    """用一根 K 线的最高/最低价，检查该品种下所有未判定信号是否命中 TP/SL。

    同一根 K 线内止盈止损都落在 [low, high] 区间的极端情况（跳空/剧烈波动），
    无法从单根 K 线的高低点判断谁先发生，保守按止损处理——不猜一个对统计更
    好看的结果。这是当前基于「K 线高低点」而非逐笔行情的判定方式的已知局限。

    Use one bar's high/low to check every unresolved signal on this symbol for
    a TP/SL hit. In the rare case both levels fall inside [low, high] within
    the same bar (a gap or sharp move), a single bar's high/low can't tell
    which happened first — we conservatively count it as a stop-loss rather
    than guess in whichever direction flatters the stats. This is a known
    limitation of bar-level (vs. tick-level) resolution.

    价格基线（baseline_high/baseline_low）：首次观测到某个信号时，本次上报
    的这根 K 线可能早于信号创建就已经在形成（比如 H1 线一开盘就在追踪，信号
    却是开盘后才生成的），其高低点会混入信号创建前、与这个信号毫无关系的
    价格波动，直接拿来判定会把"巧合"记成"命中"。首次观测只记录基线、不
    判定胜负；此后只有真正超出基线的新极值——即信号存在期间才发生的价格
    行为——才计入判定。基线随每次上报单调扩张（同一根形成中的 K 线的高低点
    本就单调扩张；换下一根新 K 线则其本身完全形成于信号创建之后），因此
    这个处理不会漏判任何真实发生在信号创建之后的命中。

    Price baseline (baseline_high/baseline_low): the first time a signal is
    observed here, the bar being reported may have started forming before the
    signal even existed (e.g. an H1 bar already mid-formation when a signal
    fires partway through it), so its high/low can include price action with
    nothing to do with this signal — resolving against it directly would
    record a coincidence as a hit. The first observation only records the
    baseline and never resolves; from then on, only a genuinely new extreme
    beyond the baseline — price action that happened while the signal
    actually existed — counts. The baseline only ever grows (a still-forming
    bar's own high/low are monotonic; a newly-started bar formed entirely
    after the signal was created), so this never misses a real post-signal hit.

    调用方需已开启事务（沿用调用方的 db session），本函数不提交/不关闭。
    Caller is expected to be inside a transaction on the same session; this
    function does not commit or close it.
    """
    if low > high:
        logger.warning("resolve_signals_with_price: low > high for %s, skipping", symbol)
        return []

    pending = (
        db.query(Signal)
        .filter(Signal.symbol == symbol, Signal.result == "PENDING")
        .all()
    )
    resolved: list[Signal] = []
    now = datetime.now(timezone.utc)
    for sig in pending:
        if sig.stop_loss is None or sig.take_profit is None:
            continue  # 缺 SL/TP 无法判定，留给 STALE 兜底 / can't resolve, stale sweep handles it eventually

        if sig.baseline_high is None or sig.baseline_low is None:
            # 首次观测：只建立基线，不判定（见函数说明）。
            # First observation: establish the baseline only, never resolve.
            sig.baseline_high = high
            sig.baseline_low = low
            continue

        new_high = high > sig.baseline_high
        new_low = low < sig.baseline_low
        sig.baseline_high = max(sig.baseline_high, high)
        sig.baseline_low = min(sig.baseline_low, low)

        if sig.side == "BUY":
            hit_tp = new_high and high >= sig.take_profit
            hit_sl = new_low and low <= sig.stop_loss
        else:  # SELL
            hit_tp = new_low and low <= sig.take_profit
            hit_sl = new_high and high >= sig.stop_loss

        if not (hit_sl or hit_tp):
            continue

        # 同一次上报里双触发，保守按止损 / same-report double-touch, conservative SL
        sig.result = "HIT_SL" if hit_sl else "HIT_TP"
        sig.resolved_at = now
        resolved.append(sig)

    return resolved


def sweep_stale_signals(db: Session) -> list[Signal]:
    """把追踪太久、从未等到任何行情更新的 PENDING 信号标记为 STALE。

    纯粹是数据源中断的保险丝，不是业务规则；正常运行下不应触发。
    调用方需已开启事务，本函数不提交/不关闭。

    Mark PENDING signals that have gone unresolved for too long as STALE. Purely
    a feed-outage safety net, not a business rule — shouldn't trigger under
    normal operation. Caller manages the transaction.
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=settings.SIGNAL_STALE_DAYS)
    # 时区比较在 Python 侧做（SQLite 存的是不带时区的时间，跟其他后台任务一致）。
    # Compare timezones in Python (SQLite stores naive datetimes; matches the
    # convention used by the other background sweeps in this codebase).
    candidates = db.query(Signal).filter(Signal.result == "PENDING").all()
    stale = []
    for sig in candidates:
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


async def stale_signal_sweep_loop() -> None:
    """周期性把长期无行情更新的 PENDING 信号标记为 STALE。
    Periodically mark long-unresolved PENDING signals as STALE."""
    from starlette.concurrency import run_in_threadpool

    from app.core.database import SessionLocal

    def _sweep() -> int:
        db = SessionLocal()
        try:
            stale = sweep_stale_signals(db)
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
                logger.info("stale_signal_sweep_loop: marked %d signal(s) STALE", count)
        except Exception:
            logger.exception("stale_signal_sweep_loop error")
