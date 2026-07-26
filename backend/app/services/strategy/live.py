"""实时评估：一根 K 线收盘时，对盯着这个 (品种, 周期) 的所有启用策略求值。

相对旧 evaluate_new_candle 的四处结构变化：

1. 候选来自 strategy_watch 联 enabled 的一次索引查询，不再是"全表 enabled 再
   应用层过滤"——候选集不随平台策略总数增长。
2. 同一次评估内共享指标计算（memo），N 条策略用同一组指标参数只算一次。
3. 判定与开仓彻底分离：判定对全部 PENDING 无条件执行（见 resolution.py），
   一次一单只决定"能不能开新仓"。
4. 一次评估只提交一次，推送在提交之后：旧实现每条策略 commit 两次，且推送
   夹在 commit 之间，推送失败会让已落库的信号与已发出的通知不一致。

Live evaluation: when a bar closes, evaluate every enabled strategy watching
that (symbol, interval). Four structural changes from the old
evaluate_new_candle: candidates come from one indexed strategy_watch join
instead of "load all enabled and filter in Python" (so the candidate set no
longer grows with the platform's strategy count); indicator results are shared
within an evaluation via a memo; resolution is fully decoupled from entry (it
runs unconditionally for every PENDING row, and one-trade-at-a-time only governs
whether a new position may open); and one evaluation commits once, with pushes
after the commit — the old code committed twice per strategy with the push
sandwiched between, so a failed push left the stored signal and the sent
notification out of step.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from app.core.database import SessionLocal
from app.models import Candle, StrategySignal, StrategyWatch, UserStrategy
from app.services.connection_manager import manager
from app.services.push_dispatch import EVENT_STRATEGY_SIGNAL, dispatch_event_push_async
from app.services.strategy import costs as ct
from app.services.strategy.backtest import ExitSpec, exit_prices
from app.services.strategy.presets import collect_rules_intervals, evaluate_strategy
from app.services.strategy.resolution import resolve_strategy_signals

logger = logging.getLogger("prismx.strategy_live")

# 历史窗口深度：要盖住最大指标周期（慢线 300）的预热期。
# Lookback depth: must cover the largest indicator warm-up (slow MA up to 300).
LIVE_LOOKBACK_BARS = 400

# 时段过滤的时区：与前端展示、用户心里的"几点"一致（UTC+8）。
# Session-filter timezone, matching the frontend and the user's sense of "what
# hour it is" (UTC+8).
SESSION_TZ = timezone(timedelta(hours=8))


def session_allows(session_filter: str | None, bar_t: int) -> bool:
    """这根 K 线的开盘时间是否落在允许的交易时段内。

    区间是左闭右开的整小时集合：9-17 表示 9..16，22-4（startHour > endHour）
    表示跨零点的 22,23,0,1,2,3。判定用的是 K 线开盘时间。

    脏数据一律放行而不是屏蔽：静默屏蔽所有信号是最难排查的"策略不出信号"，
    而放行只是回到"没有时段限制"这个默认状态。

    Whether this bar's open time falls inside the allowed session. The window is
    a half-open set of whole hours: 9-17 means 9..16, and 22-4
    (startHour > endHour) crosses midnight as 22,23,0,1,2,3. Malformed data
    allows everything rather than blocking: silently muting every signal is
    the hardest kind of "my strategy never fires" to diagnose, while allowing
    just falls back to the no-restriction default.
    """
    if not session_filter:
        return True
    try:
        cfg = json.loads(session_filter)
        start = int(cfg["startHour"])
        end = int(cfg["endHour"])
    except (ValueError, TypeError, KeyError):
        return True
    if not (0 <= start <= 23 and 0 <= end <= 23) or start == end:
        return True
    hour = datetime.fromtimestamp(bar_t, tz=SESSION_TZ).hour
    if start < end:
        return start <= hour < end
    # 跨零点：22-04 表示 22,23,0,1,2,3 / crosses midnight
    return hour >= start or hour < end


def cooldown_blocks(db, strat, now: datetime) -> bool:
    """距上一条信号不足冷却分钟数则拦下。
    Block when less than the cooldown's minutes have passed since the last signal."""
    minutes = strat.cooldown_minutes
    if not minutes:
        return False
    last = (
        db.query(StrategySignal.created_at)
        .filter(StrategySignal.strategy_id == strat.id)
        .order_by(StrategySignal.created_at.desc())
        .first()
    )
    if last is None or last[0] is None:
        return False
    created = last[0]
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (now - created) < timedelta(minutes=minutes)


def daily_cap_reached(db, strat, now: datetime) -> bool:
    """当天（UTC+8 自然日）已触发数达到上限则拦下。用与时段过滤同一个时区，
    否则"每天 3 条"会在用户眼里的下午忽然重置。
    Block once the day's signal count hits the cap. Uses the same timezone as the
    session filter; otherwise "3 per day" would reset midway through the user's
    afternoon."""
    cap = strat.daily_signal_cap
    if not cap:
        return False
    local_now = now.astimezone(SESSION_TZ)
    day_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    count = (
        db.query(StrategySignal)
        .filter(
            StrategySignal.strategy_id == strat.id,
            StrategySignal.created_at >= day_start.astimezone(timezone.utc).replace(tzinfo=None),
        )
        .count()
    )
    return count >= cap


def _load_bars(db, symbol: str, interval: str, limit: int = LIVE_LOOKBACK_BARS) -> list[dict]:
    rows = (
        db.query(Candle)
        .filter(Candle.symbol == symbol, Candle.interval == interval)
        .order_by(Candle.t.desc())
        .limit(limit)
        .all()
    )
    return [{"t": r.t, "o": r.o, "h": r.h, "l": r.l, "c": r.c, "v": r.v} for r in reversed(rows)]


def _has_pending(db, strategy_id: str) -> bool:
    return (
        db.query(StrategySignal)
        .filter(StrategySignal.strategy_id == strategy_id, StrategySignal.result == "PENDING")
        .first()
        is not None
    )


def _evaluate_sync(symbol: str, interval: str) -> list[tuple]:
    """同步评估段：判定 + 开仓 + 一次提交，返回待推送列表。

    与推送分开是为了让整段阻塞工作能整体丢进线程池，同时把 async 的推送留在
    事件循环上（见 evaluate_new_candle）。

    The synchronous half: resolution, entries and one commit, returning the
    pushes to send. Kept separate so the whole blocking stretch can go to a
    thread pool while the async pushes stay on the event loop (see
    evaluate_new_candle).
    """
    db = SessionLocal()
    pushes: list[tuple[str, dict, str, str]] = []
    try:
        candidates = (
            db.query(UserStrategy)
            .join(StrategyWatch, StrategyWatch.strategy_id == UserStrategy.id)
            .filter(
                StrategyWatch.symbol == symbol,
                StrategyWatch.interval == interval,
                UserStrategy.enabled.is_(True),
            )
            .all()
        )
        bars = _load_bars(db, symbol, interval)
        if len(bars) < 5:
            return pushes
        last_bar = bars[-1]

        # 判定先做，且与是否有候选策略无关：已触发的信号必须继续被追踪，即便
        # 其策略此后被停用。
        # Resolution runs first and regardless of candidates: already-fired
        # signals must keep being tracked even if their strategy was disabled
        # since.
        resolve_strategy_signals(db, symbol, interval, last_bar)

        if not candidates:
            db.commit()
            return pushes

        now = datetime.now(timezone.utc)
        memo: dict = {}
        extra_cache: dict[str, list[dict]] = {}

        for strat in candidates:
            try:
                if strat.last_signal_bar_t == last_bar["t"]:
                    continue
                if not session_allows(strat.session_filter, last_bar["t"]):
                    continue
                if strat.one_trade_at_a_time and _has_pending(db, strat.id):
                    continue
                if cooldown_blocks(db, strat, now) or daily_cap_reached(db, strat, now):
                    continue

                rules = json.loads(strat.rules or "{}")
                # 多周期引用：按需拉取并在本次评估内复用。
                # Multi-interval references: fetched on demand, reused within
                # this evaluation.
                extra: dict[str, list[dict]] = {}
                for itv in collect_rules_intervals(rules):
                    if itv not in extra_cache:
                        extra_cache[itv] = _load_bars(db, symbol, itv)
                    extra[itv] = extra_cache[itv]

                side = evaluate_strategy(bars, rules, extra or None, memo=memo)[-1]
                if side is None:
                    continue

                costs = ct.symbol_costs(db, symbol)
                entry_price = ct.round_price(ct.entry_fill(side, last_bar["c"], costs))
                spec = ExitSpec(
                    sl_method=strat.stop_loss_method,
                    sl_value=strat.stop_loss_value,
                    tp_method=strat.take_profit_method,
                    tp_value=strat.take_profit_value,
                    timeout_bars=strat.exit_timeout_bars,
                )
                atr_value = None
                if "atr" in (spec.sl_method, spec.tp_method):
                    from app.services.strategy import indicators as ind

                    atr_value = ind.atr(
                        [b["h"] for b in bars], [b["l"] for b in bars], [b["c"] for b in bars], 14
                    )[-1]
                    if atr_value is None:
                        continue
                sl, tp = exit_prices(side, entry_price, symbol, spec, atr_value)

                sig = StrategySignal(
                    strategy_id=strat.id, user_id=strat.user_id, symbol=symbol,
                    interval=interval, side=side, entry=entry_price,
                    stop_loss=sl, take_profit=tp, bar_t=last_bar["t"],
                )
                db.add(sig)
                strat.last_signal_bar_t = last_bar["t"]
                db.flush()
                pushes.append((
                    strat.user_id,
                    {
                        "type": "STRATEGY_SIGNAL",
                        "data": {
                            "id": sig.id, "strategyId": strat.id, "symbol": symbol,
                            "interval": interval, "side": side, "entry": entry_price,
                            "stopLoss": sl, "takeProfit": tp,
                            "createdAt": sig.created_at.isoformat() if sig.created_at else None,
                        },
                    },
                    f"我的策略信号 {symbol}",
                    f"{side} · {strat.name or strat.template}",
                ))
            except Exception:
                # 单条策略的脏数据/坏规则不该拖垮同组合下的其他策略。
                # One strategy's dirty data or broken rules mustn't take down the
                # others on this combo.
                logger.exception("evaluate_new_candle: strategy %s failed", strat.id)

        # 一次评估只提交一次：把 N 条策略的信号与游标更新合成一个事务，减少
        # 写放大，也避免中途异常留下"信号已写、游标未更新"的半状态。
        # One commit per evaluation: the N strategies' signals and cursor updates
        # form a single transaction, cutting write amplification and preventing a
        # mid-loop failure from leaving "signal written, cursor not" behind.
        db.commit()
    finally:
        db.close()
    return pushes


async def evaluate_new_candle(symbol: str, interval: str) -> None:
    """某 (品种, 周期) 刚有一根 K 线收盘时调用。

    同步段走 run_in_threadpool——整段工作是同步 SQLAlchemy 查询 + 纯 Python
    指标循环，留在事件循环里会拖住 WebSocket 推送与桥接轮询（生产是 2 核单
    进程）。推送段必须留在事件循环上，所以线程池边界画在函数内部而不是调用点。

    Called when a bar closes for a (symbol, interval). The synchronous half runs
    through run_in_threadpool: it's all blocking SQLAlchemy plus a pure-Python
    indicator loop, and leaving it on the event loop stalls the WebSocket pushes
    and bridge polling it shares (production is 2 cores, single process). The
    push half has to stay on the event loop, so the thread-pool boundary sits
    inside this function rather than at the call site.
    """
    from starlette.concurrency import run_in_threadpool

    pushes = await run_in_threadpool(_evaluate_sync, symbol, interval)

    # 推送在提交之后：推送失败不该回滚已落库的信号（用户仍能在列表里看到它）。
    # Pushes come after the commit: a failed push must not roll back a stored
    # signal — the user can still see it in their list.
    for user_id, payload, title, body in pushes:
        try:
            await manager.push_to_client(user_id, payload)
        except Exception:
            logger.exception("evaluate_new_candle: websocket push failed for user %s", user_id)
        try:
            await dispatch_event_push_async(user_id, EVENT_STRATEGY_SIGNAL, title, body)
        except Exception:
            logger.exception("evaluate_new_candle: notification push failed for user %s", user_id)
