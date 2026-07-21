"""K 线历史落库：只保存已经走完（收盘）的 K 线，供策略回测/长期回看使用。

与 `chart_store.py`（内存，图表画图用，重启即空）完全独立、互不依赖——
这里落库的是"走完的"K 线，`chart_store` 里既有走完的也有正在形成中的那根。

Persists only closed (finished) candles for backtesting/longer lookback.
Fully independent of `chart_store.py` (in-memory, powers the live chart,
cleared on restart) — this module stores finished bars only; `chart_store`
also holds the still-forming bar.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from app.core.database import SessionLocal
from app.models import Candle
from app.services.settings_store import get_candle_settings

logger = logging.getLogger("prismx.candle_store")

# 各周期的秒数,用于判断一根 K 线是否已经走完(t + 秒数 <= 当前时间)。
# Seconds per interval, used to decide whether a bar has closed (t + seconds <= now).
INTERVAL_SECONDS: dict[str, int] = {
    "1": 60,
    "5": 5 * 60,
    "15": 15 * 60,
    "60": 60 * 60,
    "240": 4 * 60 * 60,
    "D": 24 * 60 * 60,
}

# 每天扫一次即可,K 线不是分秒必争的时效数据 / once a day is plenty; candles aren't latency-sensitive
RETENTION_SWEEP_INTERVAL_SECONDS = 24 * 60 * 60


def persist_closed_bars(db, symbol: str, interval: str, bars: list[dict]) -> int:
    """把 `bars` 里已经走完的部分写入数据库,已存在的(symbol, interval, t)跳过。

    Persist the closed subset of `bars`; rows already present for
    (symbol, interval, t) are skipped.

    返回本次新写入的行数(纯观测用,调用方可忽略)。
    Returns the number of newly-inserted rows (for observability; callers may ignore it).
    """
    seconds = INTERVAL_SECONDS.get(interval)
    if seconds is None or not bars:
        return 0
    now = datetime.now(timezone.utc).timestamp()
    # 一根 bar 满足下面任一条件就算"已收盘"：
    # ① 绝对时钟判定——bar 的收盘时刻早于等于服务器当前时间(常规情况下这条
    #    就够了)；
    # ② 相对判定——同一批里存在时间戳比它更晚的 bar,说明喂价端已经开始形成
    #    更新的一根,这一根必然已经走完,不管喂价端的时钟跟服务器时钟是否对
    #    得上都成立(tick 模式固定推最新 2 根、backfill 模式最后一根才是仍在
    #    形成中的,前面的都有"更晚的邻居"作证)。
    # 加②是为了在喂价端(EA/其运行机器)时钟跑偏、且两边时钟都不方便/不允许
    # 改动时依然能正确判定——真实事故:EA 时钟超前约 11 小时,MT5 服务器时间
    # 改不了、本地系统时间本身是对的也不该为了这个去改,①在这种情况下永远
    # 为假,1 分钟线永远插不进数据库。②不依赖任何一边的绝对时钟,天然免疫
    # 这类偏差。
    # A bar counts as "closed" if EITHER: ① the absolute-clock check — its
    # close time is at or before the server's current time (sufficient under
    # normal conditions); OR ② the relative check — this batch also contains
    # a bar with a strictly later timestamp, proving the feed has already
    # started forming a newer bar, so this one must be finished regardless of
    # whether the feed's clock agrees with the server's (tick mode always
    # sends the latest 2 bars; in backfill mode only the very last bar is
    # still forming — every earlier one has a "later neighbor" vouching for it).
    # ② exists so a skewed feed clock (EA / its host machine) doesn't
    # permanently block persistence in situations where neither clock can
    # reasonably be changed — a real incident had the EA clock running ~11h
    # fast, with the broker's server time not being user-adjustable and the
    # local system clock already correct and not something to touch just for
    # this. ① would stay permanently false in that case; ② doesn't depend on
    # either side's absolute clock, so it's immune to this class of skew.
    latest_t = max(b["t"] for b in bars)
    closed = [b for b in bars if b["t"] + seconds <= now or b["t"] < latest_t]
    if not closed:
        # 有了②(相对判定)之后,这条分支只在批次里连"更晚的邻居"都找不到时才
        # 会走到——也就是这批实际上只有一根独一无二的时间戳,且它本身还没到
        # 绝对时钟的收盘门槛(单根 tick 的极端情况;正常 tick/backfill 批次都有
        # 至少 2 根,不会触发这里)。比引入②之前更少见,但一旦出现仍然值得关注,
        # 打一行 WARNING 方便第一时间在日志里发现——之前一次真实事故里,喂价端
        # 时钟跑偏导致的类似状态安安静静持续了三天才被发现。
        # With ② (the relative check) in place, this branch is only reached
        # when the batch doesn't even have a "later neighbor" to fall back on
        # — i.e. it's effectively a single unique timestamp that also misses
        # the absolute-clock threshold (an edge case; normal tick/backfill
        # batches always have at least 2 bars and won't hit this). Rarer than
        # before ② existed, but still worth flagging — a real incident once
        # had a feed-clock-skew situation like this persist silently for three
        # days before anyone noticed; this WARNING surfaces it immediately.
        latest_gap_hours = (max(b["t"] for b in bars) - now) / 3600
        logger.warning(
            "persist_closed_bars: %s/%s got %d bar(s) but none are closed yet "
            "(latest bar is %.1fh ahead of server time; positive means the feed's "
            "clock is running fast — check the EA/feeder's time source if this recurs)",
            symbol, interval, len(bars), latest_gap_hours,
        )
        return 0

    existing = {
        row[0]
        for row in db.query(Candle.t)
        .filter(
            Candle.symbol == symbol,
            Candle.interval == interval,
            Candle.t.in_([b["t"] for b in closed]),
        )
        .all()
    }
    new_count = 0
    for b in closed:
        if b["t"] in existing:
            continue
        db.add(
            Candle(
                symbol=symbol, interval=interval, t=b["t"],
                o=b["o"], h=b["h"], l=b["l"], c=b["c"], v=b.get("v", 0),
            )
        )
        new_count += 1
    if new_count:
        db.commit()
    return new_count


def cleanup_old_m1(db, retention_days: int) -> int:
    """删掉超过保留天数的 1 分钟线,其余周期不动。返回删除行数。
    Delete 1-minute candles past the retention window; other intervals are
    untouched. Returns the number of rows deleted."""
    cutoff = datetime.now(timezone.utc).timestamp() - retention_days * 86400
    deleted = (
        db.query(Candle)
        .filter(Candle.interval == "1", Candle.t < cutoff)
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
    return deleted


async def candle_retention_sweep_loop() -> None:
    """每天清理一次过期的 1 分钟线(启动即先跑一次)。
    Daily sweep that trims expired 1-minute candles (runs once on startup, then loops)."""
    while True:
        try:
            db = SessionLocal()
            try:
                cfg = get_candle_settings(db)
                deleted = cleanup_old_m1(db, int(cfg["m1_retention_days"]))
                if deleted:
                    logger.info("candle_retention_sweep_loop: deleted %d expired 1m candle(s)", deleted)
            finally:
                db.close()
        except Exception:
            logger.exception("candle_retention_sweep_loop error")
        await asyncio.sleep(RETENTION_SWEEP_INTERVAL_SECONDS)
