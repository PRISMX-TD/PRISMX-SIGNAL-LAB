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

from sqlalchemy import func

from app.core.database import SessionLocal
from app.models import Candle
from app.services.page_stats import prune_visitor_days, purge_admin_visitors
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


def _has_no_market_activity(bar: dict) -> bool:
    """判断一根 bar 是不是"市场根本没在动"的空转 bar(休市/节假日冻结报价)。

    EA 在周末与节假日仍然连着 MT5、仍然按周期推 bar,此时报价冻结在上一个交易
    日的收盘价,推出来的就是 o == h == l == c 且成交量为 0 的一批 bar。它们在
    时间上确实"已经走完",所以能通过收盘判定,但它们不是行情,落库之后会造成:
      ① 回测图上休市段被一长串完全平坦的蜡烛填满,真实的周末跳空被抹平——
         看起来像是图表在"拉时间",实际是数据库里真有这些行;
      ② 更严重的是指标被污染:BOLL 这类基于标准差的指标在这段里标准差趋近 0,
         上下轨收缩贴到中轨上,一到开盘必然触发穿越,凭空造出入场信号,胜率和
         信号数因此失真。
    所以这类 bar 不该进库。

    判定不去维护"交易时段表"(各品种时段不同、夏令时、节假日年年变、broker
    之间还有差异,长期维护成本高且容易出错),而是直接描述"市场没在动"这个
    事实本身,天然覆盖周末、节假日和临时休市。

    两个条件必须同时成立才丢弃:只看 v == 0 会误伤某些不报 tick volume 的
    broker 的正常 bar;只看 o == h == l == c 会误伤流动性极低时段里真实但确实
    没有波动的 1 分钟 bar。

    Detects a bar with no market activity at all (a frozen quote during a
    market close/holiday).

    Over weekends and holidays the EA stays connected to MT5 and keeps pushing
    bars on schedule, but the quote is frozen at the previous session's close,
    so what arrives is a run of bars with o == h == l == c and zero volume.
    They genuinely have "finished" in time terms, so they pass the closed
    check, but they aren't market data, and persisting them causes:
      ① the backtest chart fills the closed session with a long run of
         perfectly flat candles, flattening away the real weekend gap — it
         looks like the chart is "stretching time" when in fact those rows
         really are in the database;
      ② worse, indicators get corrupted: standard-deviation-based ones like
         Bollinger see stddev approach 0 here, the bands collapse onto the
         mid line, and the next open is then guaranteed to cross them,
         fabricating entry signals and skewing win rate and signal counts.
    So these bars must not be stored.

    The check deliberately avoids maintaining a trading-session calendar
    (per-symbol sessions, DST, yearly-changing holidays and broker-to-broker
    differences make that expensive to maintain and easy to get wrong) and
    instead describes the "market isn't moving" fact directly, which covers
    weekends, holidays and unscheduled halts alike.

    Both conditions must hold to discard: `v == 0` alone would wrongly drop
    normal bars from brokers that don't report tick volume, and
    `o == h == l == c` alone would wrongly drop genuine but truly flat
    1-minute bars in very thin liquidity.
    """
    return (
        bar["o"] == bar["h"] == bar["l"] == bar["c"]
        and not bar.get("v", 0)
    )


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

    # 已收盘但"市场没在动"的空转 bar(休市/节假日的冻结报价)在这里丢掉,理由见
    # _has_no_market_activity()。
    #
    # 放在上面那条 WARNING 之后而不是之前:两个判断诊断的是两件不同的事。"一根都
    # 没收盘"指向喂价端时钟异常,而"收盘了但都是空转"是周末的正常现象;若先过滤
    # 再判空,每个周末批次都会打出那条 clock-skew WARNING,把一条本该罕见的告警变
    # 成噪音,真出时钟问题时反而看不见了。
    #
    # 丢弃要留痕:正常交易时段本不该出现这类 bar,一旦成批出现说明喂价端有问题
    # (比如断线后重放缓存报价),静默丢弃会让这种故障无声无息——上面那条 WARNING
    # 就是为同一类"安静地出错"而存在的(那次真实事故静默持续了三天)。常态量记在
    # debug,整批都是空转时才升到 info,避免周末稳态运行刷屏。
    #
    # Drop closed-but-inactive bars (frozen quotes during a market close); see
    # _has_no_market_activity() for why.
    #
    # Placed after the WARNING above rather than before it: the two checks
    # diagnose different things. "nothing closed" points at a feed clock
    # problem, whereas "closed but all inactive" is simply what a weekend looks
    # like. Filtering first would fire that clock-skew WARNING on every weekend
    # batch, turning a should-be-rare alert into noise that hides the real
    # thing when it happens.
    #
    # Dropping is logged on purpose: these shouldn't occur during a live
    # session, so a sudden run of them means something is wrong upstream (e.g.
    # the feed replaying a stale quote after a disconnect), and silent dropping
    # would hide that — the WARNING above exists for the same class of "fails
    # quietly" bug (that real incident went unnoticed for three days).
    # Steady-state counts go to debug, escalating to info only when the whole
    # batch is inactive, so weekends don't flood the logs.
    active = [b for b in closed if not _has_no_market_activity(b)]
    inactive_count = len(closed) - len(active)
    if inactive_count:
        logger.log(
            logging.INFO if not active else logging.DEBUG,
            "persist_closed_bars: %s/%s skipped %d closed bar(s) with no market "
            "activity (o==h==l==c and zero volume — expected during a weekend/"
            "holiday close; if this appears during a live session, check the feed)",
            symbol, interval, inactive_count,
        )
    closed = active
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


def cleanup_inactive_bars(db) -> int:
    """删掉存量的空转 bar(休市冻结报价:o==h==l==c 且量为 0)。返回删除行数。

    写入侧的过滤只能挡住新数据,这条负责清掉过滤上线之前已经落库的那些——否则
    回测图上历史休市段的平线会一直留着,指标也继续被污染。判定条件与
    _has_no_market_activity() 完全一致,两边必须同步改。

    跟着每天的保留期清扫跑,不做成一次性脚本:清扫本身是幂等的(写入侧修好之后
    不再产生新的空转 bar,这条从第二天起就查不到东西可删),而一次性脚本得手动上
    机器执行,容易漏做或在下次重建环境时被忘记。

    Delete stored inactive bars (frozen quotes over a market close: o==h==l==c
    with zero volume). Returns the number of rows deleted.

    The write-path filter only stops new data; this clears what was already
    persisted before that filter existed — otherwise the flat stretches over
    historical closed sessions stay on the backtest chart and keep corrupting
    indicators. The predicate must stay in sync with _has_no_market_activity().

    Runs as part of the daily retention sweep rather than as a one-off script:
    the sweep is idempotent (with the write path fixed, no new inactive bars
    appear, so from the next day on it finds nothing to delete), whereas a
    one-off script has to be run by hand on the machine and is easy to skip or
    forget when the environment is next rebuilt.
    """
    deleted = (
        db.query(Candle)
        .filter(
            Candle.o == Candle.h,
            Candle.h == Candle.l,
            Candle.l == Candle.c,
            func.coalesce(Candle.v, 0) == 0,
        )
        .delete(synchronize_session=False)
    )
    if deleted:
        db.commit()
    return deleted


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
                # 清掉写入侧过滤上线之前落库的休市空转 bar,见 cleanup_inactive_bars()。
                # Clear inactive bars persisted before the write-path filter existed;
                # see cleanup_inactive_bars().
                inactive = cleanup_inactive_bars(db)
                if inactive:
                    logger.info(
                        "candle_retention_sweep_loop: deleted %d stored bar(s) with no "
                        "market activity (pre-existing weekend/holiday frozen quotes)",
                        inactive,
                    )
                # 顺带清页面统计的去重标记：同样是每天一次的保留期清理，
                # 为一张小表另开一个后台任务不值得（VPS 是 2 核单进程）。
                # Also prune page-stat dedup markers: same daily retention job,
                # not worth a separate background task for one small table.
                pruned = prune_visitor_days(db)
                if pruned:
                    logger.info("candle_retention_sweep_loop: pruned %d expired visitor marker(s)", pruned)
                purged = purge_admin_visitors(db)
                if purged:
                    logger.info("candle_retention_sweep_loop: purged %d admin visitor marker(s)", purged)
            finally:
                db.close()
        except Exception:
            logger.exception("candle_retention_sweep_loop error")
        await asyncio.sleep(RETENTION_SWEEP_INTERVAL_SECONDS)
