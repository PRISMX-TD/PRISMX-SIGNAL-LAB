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
from sqlalchemy.orm import aliased

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


# 判定"重放副本"时,拿新 bar 与最近这么多根已存 bar 比对。休市期间喂价端会在
# 少数几个模板之间来回重放(实测是收盘前最后两根轮流出现),取 8 根足以覆盖,同时
# 不会大到让正常行情里的偶然重合有机会被误判。
# When detecting replayed duplicates, compare each new bar against this many
# recent stored bars. During a close the feed cycles through a handful of
# templates (observed: the last two real bars alternating), so 8 is ample cover
# while staying small enough that coincidental matches in live data stay
# implausible.
REPLAY_LOOKBACK_BARS = 8

# 清理存量副本时,只把时间相距在这个天数以内的两根 bar 当作"同一次重放"。休市最长
# 也就是周末加节假日连休,3 天足够覆盖;超出这个跨度还五字段全同的两根 bar 更可能
# 是罕见巧合,而删除不可逆,宁可漏删。
# When cleaning up stored replays, only treat two bars within this many days of
# each other as part of the same replay. The longest close is a weekend plus
# adjoining holidays, which 3 days covers; two bars matching on all five fields
# further apart than that are more likely a rare coincidence, and since deletion
# is irreversible, under-deleting is the safer error.
REPLAY_MATCH_WINDOW_DAYS = 3

# OHLC 比较用的容差。价格是 Float 列,经过 JSON 与 float 往返后同一个报价可能有
# 末位误差,精确相等会漏判;黄金报两位小数,1e-6 远小于最小价位变动,不会把两个
# 真正不同的价格看成同一个。
# Tolerance for OHLC comparison. Prices are Float columns and a JSON/float round
# trip can leave last-bit error, so exact equality would miss matches; gold
# quotes to two decimals, and 1e-6 is far below the minimum tick, so two
# genuinely different prices can never compare equal.
_PRICE_EPSILON = 1e-6


def _is_replayed_duplicate(bar: dict, recent: list[dict]) -> bool:
    """判断一根 bar 是不是喂价端重放的旧 bar 副本(休市期间的伪造 K 线)。

    休市之后 EA 仍然连着 MT5、仍然按周期推 bar,但推的不是冻结报价,而是把收盘前
    最后几根真实 bar 的 **o/h/l/c/v 五个字段整根复制**,只换上新的时间戳,在两三
    个模板之间来回交替。实测(XAUUSD/15,2026-07-24 周五收盘后):

        20:30 o=4053.36 h=4055.70 l=4051.30 c=4055.12 v=1002   ← 真实
        20:45 o=4055.12 h=4055.77 l=4051.82 c=4052.66 v=795    ← 真实
        21:00 o=4055.12 h=4055.77 l=4051.82 c=4052.66 v=795    ← 20:45 的副本
        22:45 o=4053.36 h=4055.70 l=4051.30 c=4055.12 v=1002   ← 20:30 的副本
        (一直交替到周一开盘)

    这些 bar 时间上确实"已收盘",能通过收盘判定,但它们不是行情。落库后:
      ① 回测图上休市段被一长串来回重复的蜡烛填满(两个模板一涨一跌,于是呈现为
         红绿相间的平带),真实的周末跳空被抹平;
      ② 更要紧的是回测被污染:同一段价格被反复喂给指标,BOLL 这类基于标准差的
         指标在这里收缩、均线被拉平,一到周一开盘必然触发穿越,凭空造出入场
         信号,胜率与信号数因此失真。

    判定用"整根 OHLCV 与近期某根完全相同",不去猜交易时段:时段表要处理各品种
    时段、夏令时、逐年变化的节假日和 broker 差异,维护成本高且猜错窗口会删掉真
    实 bar(不可逆)。而五个字段(两位小数的价格 + 上千的成交量)同时逐一相同,在
    真实行情里实际上不会发生,是个可直接验证的特征。

    注意不能只比价格:真实行情里相邻 bar 的 OHLC 偶然接近是可能的,但连 volume
    都一模一样才是"整根复制"的铁证,所以 volume 必须参与比较。

    Detects a bar that is a replayed copy of an older one (a fabricated bar
    pushed while the market is closed).

    After the close the EA stays connected to MT5 and keeps pushing bars on
    schedule — but not frozen quotes. It copies **all five o/h/l/c/v fields**
    of the last few real bars verbatim, stamps them with new timestamps, and
    cycles between two or three templates. Observed on XAUUSD/15 after the
    2026-07-24 Friday close (see the table above).

    These bars have genuinely "closed" in time terms and pass the closed check,
    but they aren't market data. Once stored:
      ① the backtest chart fills the closed session with a long run of
         repeating candles (the two templates being one up and one down, which
         renders as the red/green flat band), erasing the real weekend gap;
      ② more importantly the backtest is corrupted: the same stretch of price
         is fed to the indicators over and over, so stddev-based ones like
         Bollinger contract and moving averages flatten, making a cross at the
         Monday open inevitable — fabricated entry signals that skew win rate
         and signal counts.

    The predicate is "the whole OHLCV matches a recent bar" rather than a
    guess at trading sessions: a session calendar has to handle per-symbol
    hours, DST, yearly-changing holidays and broker differences, and guessing
    the window wrong deletes real bars (irreversible). Five fields matching
    exactly (two-decimal prices plus four-digit volume) effectively cannot
    happen in live data, which makes it a directly verifiable signal.

    Volume must take part in the comparison: neighbouring real bars can happen
    to have similar OHLC, but an identical volume as well is what proves the
    bar is a verbatim copy.

    完全平坦的 bar(h == l,即整根没有任何高低差)不参与判定,直接放行。这种 bar 没
    有"可被复制的内部结构",连续出现只说明该周期内价格确实没动过(极低流动性、或
    合成/测试数据),不是重放的证据;把它们也当副本删掉会误伤真实的平盘行情。生产
    上观察到的重放副本都带着真实的高低差(rng 3~8 美元),不受这条豁免影响。

    Perfectly flat bars (h == l, i.e. no intrabar range at all) are exempt and
    always pass. Such a bar has no internal structure that could be copied, so a
    run of them only means the price genuinely didn't move in that period (very
    thin liquidity, or synthetic/test data) — that isn't evidence of replay, and
    dropping them would discard real flat markets. The replays observed in
    production all carry a real high/low range (3–8 dollars), so this exemption
    doesn't weaken the fix.
    """
    if bar["h"] == bar["l"]:
        return False
    for prev in recent:
        if (
            abs(bar["o"] - prev["o"]) < _PRICE_EPSILON
            and abs(bar["h"] - prev["h"]) < _PRICE_EPSILON
            and abs(bar["l"] - prev["l"]) < _PRICE_EPSILON
            and abs(bar["c"] - prev["c"]) < _PRICE_EPSILON
            and bar.get("v", 0) == prev.get("v", 0)
        ):
            return True
    return False


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

    # 休市期间喂价端重放的旧 bar 副本在这里丢掉,理由见 _is_replayed_duplicate()。
    #
    # 放在上面那条 WARNING 之后而不是之前:两个判断诊断的是两件不同的事。"一根都
    # 没收盘"指向喂价端时钟异常,而"收盘了但全是重放副本"是周末的正常现象;若先
    # 过滤再判空,每个周末批次都会打出那条 clock-skew WARNING,把一条本该罕见的
    # 告警变成噪音,真出时钟问题时反而看不见了。
    #
    # 比对基准取库里已存的最近若干根:休市第一根副本要跟收盘前的真实 bar 比才能
    # 认出来,而那根真实 bar 只在库里。基准里再把本批已接受的 bar 追加进去,让同
    # 一批内部也能连锁判定——backfill 一次可能送来整个周末,若只跟库里比,批内互
    # 为副本的那些会全部漏掉。
    #
    # 丢弃要留痕:正常交易时段本不该出现这类 bar,一旦成批出现说明喂价端有问题
    # (比如断线后重放缓存),静默丢弃会让这种故障无声无息——上面那条 WARNING 就是
    # 为同一类"安静地出错"而存在的(那次真实事故静默持续了三天)。常态量记在
    # debug,整批都是副本时才升到 info,避免周末稳态运行刷屏。
    #
    # Drop bars the feed replayed while the market was closed; see
    # _is_replayed_duplicate() for why.
    #
    # Placed after the WARNING above rather than before it: the two checks
    # diagnose different things. "nothing closed" points at a feed clock
    # problem, whereas "closed but all replays" is simply what a weekend looks
    # like. Filtering first would fire that clock-skew WARNING on every weekend
    # batch, turning a should-be-rare alert into noise that hides the real thing
    # when it happens.
    #
    # The comparison baseline is the most recent stored bars: recognising the
    # first replay of a close requires comparing it against the last real bar,
    # which only exists in the database. Accepted bars from this batch are
    # appended to that baseline so matches can chain within the batch too — a
    # backfill can deliver a whole weekend at once, and comparing only against
    # stored rows would miss every bar that is a copy of another bar in the same
    # batch.
    #
    # Dropping is logged on purpose: these shouldn't occur during a live
    # session, so a sudden run of them means something is wrong upstream (e.g.
    # the feed replaying its cache after a disconnect), and silent dropping
    # would hide that — the WARNING above exists for the same class of "fails
    # quietly" bug (that real incident went unnoticed for three days).
    # Steady-state counts go to debug, escalating to info only when the whole
    # batch is a replay, so weekends don't flood the logs.
    baseline = [
        {"o": r[0], "h": r[1], "l": r[2], "c": r[3], "v": r[4]}
        for r in db.query(Candle.o, Candle.h, Candle.l, Candle.c, Candle.v)
        .filter(Candle.symbol == symbol, Candle.interval == interval)
        .order_by(Candle.t.desc())
        .limit(REPLAY_LOOKBACK_BARS)
        .all()
    ]
    accepted: list[dict] = []
    replay_count = 0
    for b in closed:
        if _is_replayed_duplicate(b, baseline):
            replay_count += 1
            continue
        accepted.append(b)
        baseline = [b, *baseline][:REPLAY_LOOKBACK_BARS]
    if replay_count:
        logger.log(
            logging.INFO if not accepted else logging.DEBUG,
            "persist_closed_bars: %s/%s skipped %d replayed bar(s) (OHLCV identical "
            "to a recent bar — expected while the market is closed; if this appears "
            "during a live session, check the feed)",
            symbol, interval, replay_count,
        )
    closed = accepted
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


def cleanup_replayed_bars(db) -> int:
    """删掉存量的重放副本 bar(休市期间被伪造出来的那些)。返回删除行数。

    写入侧的过滤只能挡住新数据,这条负责清掉过滤上线之前已经落库的那些——否则
    回测图上历史休市段那条来回重复的平带会一直留着,回测也继续被污染。

    只删"同 symbol/interval 下,存在一根时间更早、且 OHLCV 五个字段全部相同的
    bar"的行,也就是每组重复里只保留最早那一根——最早那根正是收盘前的真实 bar,
    后面全是它的副本。判定与 _is_replayed_duplicate() 一致,两边必须同步改。

    额外加了 REPLAY_MATCH_WINDOW_DAYS 的时间邻近限制:相隔很久的两根真实 bar 恰好
    五个字段全同虽然近乎不可能,但删除不可逆,加一道窗口把这种理论可能性也挡掉,
    代价只是极端情况下漏删一点(下次清扫仍会处理)。

    跟着每天的保留期清扫跑,不做成一次性脚本:清扫是幂等的(写入侧修好后不再产生
    新副本,这条从第二天起就查不到东西可删),而一次性脚本得手动上机器执行,容易
    漏做或在下次重建环境时被忘记。

    Delete stored replayed bars (the ones fabricated during a market close).
    Returns the number of rows deleted.

    The write-path filter only stops new data; this clears what was already
    persisted before that filter existed — otherwise the repeating flat band
    over historical closed sessions stays on the backtest chart and keeps
    corrupting backtests.

    Only rows that have an earlier bar with identical o/h/l/c/v in the same
    symbol/interval are removed, i.e. each group of duplicates keeps its
    earliest row — and that earliest row is precisely the real pre-close bar
    every later one was copied from. Must stay in sync with
    _is_replayed_duplicate().

    A REPLAY_MATCH_WINDOW_DAYS proximity limit is applied on top: two genuine
    bars matching on all five fields far apart in time is next to impossible,
    but deletion is irreversible, so the window rules out even that theoretical
    case. The cost is under-deleting in extreme situations, which the next sweep
    picks up anyway.

    Runs as part of the daily retention sweep rather than as a one-off script:
    the sweep is idempotent (with the write path fixed, no new replays appear,
    so from the next day on it finds nothing to delete), whereas a one-off
    script has to be run by hand and is easy to skip or forget when the
    environment is next rebuilt.
    """
    earlier = aliased(Candle)
    duplicate_of_earlier = (
        db.query(earlier.id)
        .filter(
            # 完全平坦的 bar 豁免,与 _is_replayed_duplicate() 保持一致。
            # Flat bars are exempt, matching _is_replayed_duplicate().
            Candle.h != Candle.l,
            earlier.symbol == Candle.symbol,
            earlier.interval == Candle.interval,
            earlier.t < Candle.t,
            earlier.t >= Candle.t - REPLAY_MATCH_WINDOW_DAYS * 86400,
            func.abs(earlier.o - Candle.o) < _PRICE_EPSILON,
            func.abs(earlier.h - Candle.h) < _PRICE_EPSILON,
            func.abs(earlier.l - Candle.l) < _PRICE_EPSILON,
            func.abs(earlier.c - Candle.c) < _PRICE_EPSILON,
            func.coalesce(earlier.v, 0) == func.coalesce(Candle.v, 0),
        )
        .exists()
    )
    deleted = (
        db.query(Candle)
        .filter(duplicate_of_earlier)
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
                # 清掉写入侧过滤上线之前落库的休市重放副本,见 cleanup_replayed_bars()。
                # Clear replayed bars persisted before the write-path filter existed;
                # see cleanup_replayed_bars().
                replays = cleanup_replayed_bars(db)
                if replays:
                    logger.info(
                        "candle_retention_sweep_loop: deleted %d replayed candle(s) "
                        "(pre-existing market-closed duplicates)",
                        replays,
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
