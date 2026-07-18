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
    closed = [b for b in bars if b["t"] + seconds <= now]
    if not closed:
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
