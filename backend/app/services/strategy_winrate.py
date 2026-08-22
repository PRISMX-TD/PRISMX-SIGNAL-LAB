"""按「策略 × 交易时段」统计平台信号的客观胜率。

口径与 `GET /signals/winrate` **完全一致**：只看行情是否先碰到止盈或止损
（Signal.result），与任何用户的实际下单/平仓行为无关；分母只含 HIT_TP + HIT_SL，
PENDING（还没走出结果）与 STALE（行情追踪中断，见 signal_resolution.py）都不进
分母，但如实回给前端展示。两处口径必须保持一致，否则同一批信号在"总胜率"和
"分时段胜率"里会给出互相矛盾的数字。

只统计 source == "tradingview" 的信号。mock 引擎那批的 indicator 是
"MA5/MA20 金叉, RSI=34.7 / Dead cross" 这种把参数值拼进去的描述文本，按它分组
会炸出上百个只有一条样本的"策略"；TradingView 警报的 strategy 字段才是稳定的
策略名（见 routers/webhook.py 的 _persist_signal_sync）。

Objective win rate for platform signals, broken down by strategy x trading
session.

Same definition as `GET /signals/winrate`: purely whether price reached
take-profit or stop-loss first (Signal.result), independent of any user's real
orders; the denominator is HIT_TP + HIT_SL only, with PENDING (no outcome yet)
and STALE (price tracking broke, see signal_resolution.py) excluded but still
reported for display. The two must stay in step or the same signals would yield
contradictory "overall" and "per-session" numbers.

Only source == "tradingview" signals are counted. The mock engine's `indicator`
is descriptive text with parameter values baked in ("MA5/MA20 golden cross,
RSI=34.7"), which would explode into hundreds of one-sample "strategies";
TradingView's `strategy` field is the stable name (see _persist_signal_sync in
routers/webhook.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Signal


@dataclass(frozen=True)
class TradingSession:
    """一个交易时段：在该金融中心的**本地**时间上取 [start_hour, end_hour) 小时区间。

    刻意用 IANA 时区 + 本地小时，而不是固定的 UTC 区间——伦敦与纽约每年各切换两次
    夏令时，且切换日期不同（欧美错开约两周）。写死 UTC 区间的话，每年会有约四段
    共十几周的时间，整个时段整体错位一小时：信号被算进隔壁时段，胜率跟着串。

    One trading session: the half-open hour range [start_hour, end_hour) in that
    financial centre's **local** time.

    Deliberately an IANA zone plus local hours rather than a fixed UTC range:
    London and New York each shift twice a year, on different dates (the EU and
    US changeovers are ~2 weeks apart). A hard-coded UTC range would be an hour
    off for several weeks every year, filing signals under the neighbouring
    session and skewing both sessions' win rates.
    """

    key: str
    tz: str
    start_hour: int
    end_hour: int


# 三大时段，用各自金融中心的本地时间定义。东京不实行夏令时（1951 年后废止），
# 但仍走同一套 ZoneInfo 逻辑，不为它开特例。
# The three sessions, defined in their own centre's local time. Tokyo has no DST
# (abolished after 1951) but still goes through the same ZoneInfo path — no
# special case for it.
SESSIONS: tuple[TradingSession, ...] = (
    TradingSession("asia", "Asia/Tokyo", 9, 18),
    TradingSession("europe", "Europe/London", 8, 17),
    TradingSession("newyork", "America/New_York", 8, 17),
)

# 不落在任何时段内的信号（主要是亚洲收盘到伦敦开盘之间、以及纽约收盘后的几小时）。
# 单列一桶而不是丢弃：丢掉的话三个时段的样本数加起来对不上总数，看的人会以为
# 数据缺失。
# Signals in none of the sessions (mostly the gap between the Tokyo close and
# the London open, plus the hours after the New York close). Bucketed rather
# than dropped: dropping them would make the three sessions fail to add up to
# the total and read as missing data.
OUTSIDE_KEY = "outside"

# 时段之间**故意允许重叠**：伦敦 08:00–17:00 与纽约 08:00–17:00 在夏令时下有
# 四小时重叠（伦敦 13:00–17:00），那正是外汇日内波动最大的一段。落在重叠区的
# 信号同时计入两个时段，因此各时段样本数之和 > 总样本数——这是正确的（问的是
# "欧洲盘时段内的胜率如何"，而不是"把信号切成互斥的几堆"），前端需要说明这一点。
# Sessions deliberately overlap: London 08:00-17:00 and New York 08:00-17:00
# share four hours under DST (13:00-17:00 London), which is exactly the most
# active stretch of the FX day. A signal in the overlap counts toward both
# sessions, so the per-session counts sum to MORE than the total — which is
# correct (the question is "how do signals fired during the European session
# do", not "partition the signals"), and the UI has to say so.

_ZONES: dict[str, ZoneInfo] = {}


def _zone(name: str) -> ZoneInfo:
    """ZoneInfo 实例缓存。构造会读磁盘上的 tz 数据库，而这里每条信号 × 三个时段
    都要用一次，不缓存就是每次统计成千上万次文件读。

    Cached ZoneInfo instances: constructing one reads the tz database from disk,
    and this is needed once per signal per session — thousands of file reads per
    request without the cache."""
    zone = _ZONES.get(name)
    if zone is None:
        zone = ZoneInfo(name)
        _ZONES[name] = zone
    return zone


def session_keys_for(ts: datetime) -> list[str]:
    """某个时刻落在哪些时段内；不落在任何时段则返回 [OUTSIDE_KEY]。

    naive 输入按 UTC 解读——signals.created_at 列存的就是 naive UTC（见
    models/__init__.py 的 _now）。

    Which sessions an instant falls in; [OUTSIDE_KEY] when it's in none. A naive
    input is read as UTC — signals.created_at stores naive UTC (see _now in
    models/__init__.py)."""
    aware = ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)
    keys = [
        s.key
        for s in SESSIONS
        if s.start_hour <= aware.astimezone(_zone(s.tz)).hour < s.end_hour
    ]
    return keys or [OUTSIDE_KEY]


def _empty_bucket(days: int) -> dict:
    return {
        "hitTp": 0, "hitSl": 0, "pending": 0, "stale": 0,
        # 内部累加器，_finalize 时弹出 / internal accumulators, popped by _finalize
        "_resolveSum": 0.0, "_resolveN": 0, "_daily": [0] * days,
    }


# result 列到桶键的映射。未知值（历史遗留的 WIN/LOSS 等）一律并入 pending：
# 不认识的状态绝不能当成"赢"，也不该悄悄消失在总数之外。
# result column -> bucket key. Unknown values (legacy WIN/LOSS rows) all fall
# into pending: an unrecognized state must never be counted as a win, and must
# not silently vanish from the totals either.
_RESULT_KEYS = {"HIT_TP": "hitTp", "HIT_SL": "hitSl", "STALE": "stale"}


def wilson_lower_bound(hit: int, n: int, z: float = 1.96) -> float | None:
    """胜率的 Wilson 95% 置信区间下限，推荐榜的排序键。

    用下限而不是原始胜率排序：样本少的高胜率（80% × 5 笔）区间宽、下限被压低，
    样本多的稳定胜率（55% × 40 笔）区间窄、下限反而更高——薄样本自动沉底，
    不需要另设门槛或合成分。n = 已判定笔数（hitTp + hitSl）。

    The Wilson 95% lower bound, used as the recommendation ranking key. Ranking
    by the bound rather than the raw rate makes thin samples sink on their own:
    80% of 5 has a wide interval and a low bound, 55% of 40 a narrow one and a
    higher bound. n is the resolved count.
    """
    if n <= 0:
        return None
    p = hit / n
    denom = 1.0 + z * z / n
    centre = p + z * z / (2.0 * n)
    margin = z * math.sqrt(p * (1.0 - p) / n + z * z / (4.0 * n * n))
    return max(0.0, (centre - margin) / denom)


def _finalize(bucket: dict, days: int, include_daily: bool) -> dict:
    resolved = bucket["hitTp"] + bucket["hitSl"]
    samples = resolved + bucket["pending"] + bucket["stale"]
    resolve_n = bucket["_resolveN"]
    return {
        "hitTp": bucket["hitTp"], "hitSl": bucket["hitSl"],
        "pending": bucket["pending"], "stale": bucket["stale"],
        "resolved": resolved,
        "samples": samples,
        # 分母为 0 时给 None 而不是 0：前端要能区分"这个时段 0% 胜率"和"这个
        # 时段还没有已判定的样本"。
        # None rather than 0 on an empty denominator so the UI can tell "0% win
        # rate here" apart from "no resolved samples here yet".
        "winRate": (bucket["hitTp"] / resolved) if resolved > 0 else None,
        "wilsonLow": wilson_lower_bound(bucket["hitTp"], resolved),
        "avgResolveSeconds": (bucket["_resolveSum"] / resolve_n) if resolve_n else None,
        "weeklySignals": round(samples / days * 7, 1),
        # 品种层不下发每日分布：样本太薄，柱图全是零 / omitted at symbol level
        "dailySamples": list(bucket["_daily"]) if include_daily else None,
    }


def compute_strategy_session_winrate(db: Session, days: int = 7) -> dict:
    """近 `days` 天（滚动窗口，按信号创建时间）每个策略在各时段的胜率。

    按 created_at 而不是 resolved_at 归档与分桶：问的是"这个策略在欧洲盘发出的
    信号后来赢了没有"，时段属性属于信号发出的那一刻；用 resolved_at 会把一条亚洲
    盘发出、纽约盘才走出结果的信号记成纽约盘。窗口过滤也必须用同一根时间轴，
    否则会漏掉/多算跨窗口的信号。

    Per-strategy, per-session win rate over the last `days` days (a rolling
    window on the signal's creation time).

    Bucketed and windowed by created_at, not resolved_at: the question is "how
    do this strategy's European-session signals turn out", and the session is a
    property of the moment it fired — resolved_at would file an Asia-session
    signal that only reached TP during New York hours under New York. The window
    filter must use the same axis or signals straddling the edge get dropped or
    double-counted.
    """
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)

    # 只取需要的列。信号表最宽的几列（entry/sl/tp/baseline_*）这里一个都用不上，
    # 全行 SELECT 在 Supabase 上是纯浪费的 Egress——同 signal_resolution.py 的做法。
    # symbol 这里还没用上，是给品种子分层（Task 3）预留的。
    # Only the needed columns: none of the wide columns (entry/sl/tp/baseline_*)
    # are used here, and a full-row SELECT is pure wasted Egress on Supabase —
    # same reasoning as signal_resolution.py. symbol is unused here, reserved
    # for the per-symbol breakdown (Task 3).
    cutoff_naive = cutoff.replace(tzinfo=None)
    rows = (
        db.query(Signal.indicator, Signal.symbol, Signal.created_at,
                 Signal.result, Signal.resolved_at)
        .filter(
            Signal.source == "tradingview",
            Signal.created_at >= cutoff_naive,
        )
        .all()
    )

    # 判定链路的健康读数：全表最近一次成功判定的时间，**刻意不受窗口限制**。
    # 判定只在 POST /webhook/trend 带着 high/low 进来时发生（见 routers/webhook.py），
    # 一旦那条链路断了——趋势推送停了、payload 少了 high/low、或 symbol 串对不上——
    # 表格会满屏"0 笔"，而窗口内的任何数字都无法区分"最近没走出结果"和"判定
    # 功能已经坏了几周"。这个时间戳能：null = 从来没判定成功过，几周前 = 断了。
    # Health reading for the resolution pipeline: when a signal was last
    # successfully resolved, deliberately NOT limited to the window. Resolution
    # only happens when POST /webhook/trend arrives carrying high/low (see
    # routers/webhook.py); if that path breaks — pushes stop, the payload drops
    # high/low, or the symbol strings stop matching — the table fills with
    # zeros, and nothing inside the window distinguishes "nothing has resolved
    # lately" from "resolution has been dead for weeks". This timestamp does:
    # null means it never worked, a date weeks back means it stopped.
    last_resolved = (
        db.query(func.max(Signal.resolved_at))
        .filter(
            Signal.source == "tradingview",
            Signal.result.in_(("HIT_TP", "HIT_SL")),
        )
        .scalar()
    )

    all_keys = [s.key for s in SESSIONS] + [OUTSIDE_KEY]
    # {策略名: {时段键或 "total": 桶}} / {strategy: {session key or "total": bucket}}
    per_strategy: dict[str, dict[str, dict]] = {}
    overall: dict[str, dict] = {k: _empty_bucket(days) for k in [*all_keys, "total"]}

    for indicator, symbol, created_at, result, resolved_at in rows:
        if created_at is None:
            continue
        # 策略名缺失的信号归到一个显式的空串键，前端展示成「未命名策略」。
        # 丢弃它们会让分组之和对不上 /signals/winrate 的总数。
        # Signals with no strategy name go under an explicit empty-string key,
        # shown as "Unnamed" by the UI. Dropping them would make the groups fail
        # to add up to /signals/winrate's totals.
        name = (indicator or "").strip()
        key = _RESULT_KEYS.get(result or "", "pending")
        session_keys = session_keys_for(created_at)
        # 24h 桶下标：自窗口起点起算，floor。spec 原文是"按 UTC 日"，但滚动窗口
        # 起点不在午夜，按日历日会得到 days+1 个桶且首尾残缺；改为 24h 桶后长度
        # 恒等于 days，最后一桶即"最近 24 小时"。clamp 只防御浮点边缘。
        # 24h-bucket index counted from the window start, floored. The spec text
        # says "by UTC calendar day", but the rolling window doesn't start at
        # midnight, so calendar-day slicing yields days+1 buckets with ragged
        # ends; switching to 24h buckets keeps the length always == days, with
        # the last bucket meaning "the last 24 hours". The clamp only guards
        # floating-point edge cases.
        day_idx = min(days - 1, max(0, int(
            (created_at - cutoff_naive).total_seconds() // 86400)))
        resolve_seconds = None
        if result in ("HIT_TP", "HIT_SL") and resolved_at is not None:
            resolve_seconds = (resolved_at - created_at).total_seconds()

        buckets = per_strategy.setdefault(
            name, {k: _empty_bucket(days) for k in [*all_keys, "total"]})
        for target in (buckets, overall):
            for bkey in ("total", *session_keys):
                b = target[bkey]
                b[key] += 1
                b["_daily"][day_idx] += 1
                if resolve_seconds is not None:
                    b["_resolveSum"] += resolve_seconds
                    b["_resolveN"] += 1

    def _shape(buckets: dict[str, dict]) -> dict:
        return {
            "total": _finalize(buckets["total"], days, True),
            "sessions": {k: _finalize(buckets[k], days, True) for k in all_keys},
        }

    strategies = [
        {"strategy": name, **_shape(buckets)} for name, buckets in per_strategy.items()
    ]
    # 已判定样本多的排前面，再按总样本数，最后按名字——保证顺序稳定，否则每次
    # 刷新表格行都在跳。
    # Most resolved samples first, then total samples, then name — a stable order,
    # otherwise the table rows shuffle on every refresh.
    strategies.sort(
        key=lambda s: (-s["total"]["resolved"], -s["total"]["samples"], s["strategy"])
    )

    return {
        "days": days,
        "windowStart": cutoff,
        "windowEnd": now,
        "lastResolvedAt": last_resolved,
        "sessions": [
            {"key": s.key, "tz": s.tz, "startHour": s.start_hour, "endHour": s.end_hour}
            for s in SESSIONS
        ],
        # overall 与每个策略行同形状（strategy 为空串），前端可以用同一个渲染
        # 函数画汇总行和明细行。
        # Same shape as a strategy row (with an empty strategy), so the UI renders
        # the summary row and the detail rows through one function.
        "overall": {"strategy": "", **_shape(overall)},
        "strategies": strategies,
    }
