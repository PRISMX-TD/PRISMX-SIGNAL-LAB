"""/api/feed/candles 的单测：喂价端(EA)时钟跑偏时的纠偏逻辑。

真实事故背景：EA 那台机器的时钟比服务器快了约 11 小时,导致 K 线时间戳被
打成"未来",1 分钟线永远摸不到"已收盘"的门槛(见 candle_store.py 的相对
判定修复)。但即便写库成功了,存进去/显示出来的时间本身依然是错的——用户
两边时钟都不方便/不允许调整(经纪商服务器时间改不了,本地系统时间本身
是对的也不该为此去改),所以只能在这个入口把偏差识别出来并纠正回去。

Unit tests for /api/feed/candles: the skew-correction logic for when the
feed's (EA) clock runs fast.

Real-incident background: the EA's host machine ran ~11h ahead of the
server, stamping bar timestamps into the "future" so 1-minute bars never hit
the "closed" threshold (see candle_store.py's relative-check fix). But even
once persistence started succeeding, the stored/displayed timestamps
themselves were still wrong — neither clock could reasonably be adjusted
(the broker's server time isn't user-adjustable; the local system clock was
already correct and shouldn't be touched just for this) — so the skew has to
be detected and corrected right at this ingestion boundary instead.
"""
from datetime import datetime, timezone

from app.core.config import settings
from app.models import Candle
from app.routers.chart import FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS, _correct_future_skew


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


# ---------- _correct_future_skew() 纯函数单测 / pure-function unit tests ----------
def test_no_correction_when_within_threshold():
    now = _now()
    bars = [{"t": int(now) - 60, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    corrected, skew = _correct_future_skew(bars, now)
    assert skew == 0
    assert corrected == bars


def test_corrects_bars_when_clock_runs_far_ahead():
    """复现事故量级：喂价端时钟超前约 11 小时。
    Reproduces the incident's magnitude: the feed's clock runs ~11h ahead."""
    now = _now()
    skew_seconds = 11 * 3600
    bars = [
        {"t": int(now) + skew_seconds, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": int(now) + skew_seconds + 60, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    corrected, skew = _correct_future_skew(bars, now)
    assert skew > FUTURE_SKEW_CORRECTION_THRESHOLD_SECONDS
    # 纠正后最新一根应该落在服务器"现在"附近(容差内),彼此的相对间隔(60秒)
    # 保持不变。/ After correction the newest bar should land near the
    # server's "now" (within tolerance); the 60s relative spacing is preserved.
    assert abs(max(b["t"] for b in corrected) - now) < 5
    assert corrected[1]["t"] - corrected[0]["t"] == 60


def test_does_not_correct_when_feed_is_behind_not_ahead():
    """喂价端时钟偏慢、或者收市期间最新一根天然落在过去,都不该被"纠正"——
    那样等于瞎猜着把旧数据往前挪。
    A feed clock running slow, or a market-closed period where the newest bar
    is genuinely in the past, must never be "corrected" — that would just be
    guessing and shifting old data forward."""
    now = _now()
    bars = [{"t": int(now) - 12 * 3600, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]
    corrected, skew = _correct_future_skew(bars, now)
    assert skew == 0
    assert corrected == bars


def test_empty_bars_is_a_noop():
    corrected, skew = _correct_future_skew([], _now())
    assert corrected == []
    assert skew == 0


# ---------- /api/feed/candles 端到端:纠正后的时间戳才是落库的时间戳 ----------
# ---------- End-to-end: the corrected timestamp is what actually lands in the DB ----------
def test_future_skewed_bars_are_corrected_before_persisting(client, db, monkeypatch):
    monkeypatch.setattr(settings, "EA_TOKEN", "test-ea-token")
    now = _now()
    skew_seconds = 11 * 3600
    bars = [
        {"t": int(now) + skew_seconds, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10},
        {"t": int(now) + skew_seconds + 60, "o": 1.5, "h": 1.6, "l": 1.4, "c": 1.55, "v": 3},
    ]
    res = client.post(
        "/api/feed/candles",
        headers={"X-EA-Token": "test-ea-token"},
        json={"mode": "tick", "series": [{"symbol": "XAUUSD", "interval": "1", "bars": bars}]},
    )
    assert res.status_code == 200

    rows = db.query(Candle).filter(Candle.symbol == "XAUUSD", Candle.interval == "1").all()
    assert len(rows) == 1
    # 落库的那根是"较早"的一根(比另一根早 60 秒;那一根仍在形成中,还没收盘),
    # 它的 t 应该已经被纠正到贴近真实"现在减 60 秒",而不是原始的、超前 11
    # 小时的那个值。
    # The persisted row is the "earlier" bar (60s before the other one, which
    # is still forming); its t should already be corrected to near the real
    # "now minus 60s", not the original ~11h-ahead value.
    assert abs(rows[0].t - (int(now) - 60)) < 5
    assert rows[0].t != bars[0]["t"]
