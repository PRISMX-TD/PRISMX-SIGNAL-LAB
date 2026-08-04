"""聚合模块测试 / aggregation tests.

运行 / run:  python -m unittest manager_feed.test_aggregate -v
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone

from manager_feed.aggregate import (
    INTERVAL_SECONDS,
    aggregate,
    bucket_start,
    drop_forming_bar,
)


def ts(text: str) -> int:
    """把 "2026-08-04 08:00" 解析成 UTC 秒 / parse to UTC seconds."""
    return int(datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())


def m1(t: int, o: float, h: float, l: float, c: float, v: float = 1.0) -> dict:
    return {"t": t, "o": o, "h": h, "l": l, "c": c, "v": v}


def series(start: int, count: int, base: float = 100.0) -> list[dict]:
    """生成 count 根连续 M1，价格逐根递增便于验证 OHLC。
    Build `count` consecutive M1 bars with rising prices so OHLC is checkable."""
    out = []
    for i in range(count):
        p = base + i
        out.append(m1(start + i * 60, o=p, h=p + 0.5, l=p - 0.5, c=p + 0.2))
    return out


class TestBucketStart(unittest.TestCase):
    def test_aligns_to_utc_grid(self):
        t = ts("2026-08-04 08:37")
        self.assertEqual(bucket_start(t, "M5"), ts("2026-08-04 08:35"))
        self.assertEqual(bucket_start(t, "M15"), ts("2026-08-04 08:30"))
        self.assertEqual(bucket_start(t, "H1"), ts("2026-08-04 08:00"))
        self.assertEqual(bucket_start(t, "H4"), ts("2026-08-04 08:00"))
        self.assertEqual(bucket_start(t, "D1"), ts("2026-08-04 00:00"))

    def test_h4_boundaries(self):
        # H4 应落在 UTC 0/4/8/12/16/20 时 / H4 sits on UTC 0/4/8/12/16/20
        for hour, expect in ((3, 0), (7, 4), (11, 8), (23, 20)):
            t = ts(f"2026-08-04 {hour:02d}:30")
            self.assertEqual(
                bucket_start(t, "H4"), ts(f"2026-08-04 {expect:02d}:00"),
                f"hour={hour}",
            )

    def test_satisfies_backend_grid(self):
        """后端 _grid_seconds() 对 H1/H4/D1 要求 1800 秒网格。
        The backend requires H1/H4/D1 to sit on a 1800s grid."""
        t = ts("2026-08-04 13:42")
        for interval in ("H1", "H4", "D1"):
            self.assertEqual(bucket_start(t, interval) % 1800, 0, interval)
        for interval, grid in (("M1", 60), ("M5", 300), ("M15", 900)):
            self.assertEqual(bucket_start(t, interval) % grid, 0, interval)


class TestAggregate(unittest.TestCase):
    def test_m1_passthrough(self):
        bars = series(ts("2026-08-04 08:00"), 3)
        self.assertEqual(aggregate(bars, "M1"), bars)

    def test_m5_ohlc(self):
        start = ts("2026-08-04 08:00")
        bars = series(start, 5, base=100.0)
        out = aggregate(bars, "M5")
        self.assertEqual(len(out), 1)
        bar = out[0]
        self.assertEqual(bar["t"], start)
        self.assertEqual(bar["o"], 100.0)          # 首根开 / first open
        self.assertEqual(bar["c"], 104.2)          # 末根收 / last close
        self.assertEqual(bar["h"], 104.5)          # 最高 / max high
        self.assertEqual(bar["l"], 99.5)           # 最低 / min low
        self.assertEqual(bar["v"], 5.0)            # 量累加 / summed volume

    def test_incomplete_bucket_skipped(self):
        """缺 M1 的时段不生成 bar——这是防垃圾 K 线的核心规则。
        A short bucket yields no bar: the core junk-candle rule."""
        start = ts("2026-08-04 08:00")
        bars = series(start, 3)  # 只有 3 根，M5 需要 5 根 / 3 bars, M5 needs 5
        self.assertEqual(aggregate(bars, "M5"), [])

    def test_gap_in_middle_skipped(self):
        """中间缺一根也不生成，而不是用现有的凑。
        A hole in the middle also skips, rather than making do."""
        start = ts("2026-08-04 08:00")
        bars = series(start, 5)
        del bars[2]  # 挖掉 08:02 / remove 08:02
        self.assertEqual(aggregate(bars, "M5"), [])

    def test_only_complete_buckets_emitted(self):
        start = ts("2026-08-04 08:00")
        bars = series(start, 8)  # 08:00-08:04 完整，08:05-08:07 只有 3 根
        out = aggregate(bars, "M5")
        self.assertEqual([b["t"] for b in out], [start])

    def test_h1_needs_60_m1(self):
        start = ts("2026-08-04 08:00")
        self.assertEqual(aggregate(series(start, 59), "H1"), [])
        out = aggregate(series(start, 60), "H1")
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["t"], start)

    def test_weekend_gap_produces_no_bar(self):
        """周末没有 M1，就不会产生周末的 bar。
        No M1 over the weekend means no weekend bar."""
        friday = series(ts("2026-08-07 20:00"), 60)      # 周五 / Friday
        monday = series(ts("2026-08-10 00:00"), 60)      # 周一 / Monday
        out = aggregate(friday + monday, "H1")
        emitted = {b["t"] for b in out}
        self.assertIn(ts("2026-08-07 20:00"), emitted)
        self.assertIn(ts("2026-08-10 00:00"), emitted)
        # 周末区间内不应有任何 bar / nothing in between
        self.assertEqual(len(out), 2)

    def test_unknown_interval_raises(self):
        with self.assertRaises(ValueError):
            aggregate(series(ts("2026-08-04 08:00"), 5), "M7")

    def test_empty_input(self):
        for interval in INTERVAL_SECONDS:
            self.assertEqual(aggregate([], interval), [])


class TestDropFormingBar(unittest.TestCase):
    def test_drops_current_bucket(self):
        start = ts("2026-08-04 08:00")
        bars = [{"t": start, "c": 1.0}, {"t": ts("2026-08-04 08:05"), "c": 2.0}]
        now = ts("2026-08-04 08:07")  # 08:05 那根还在形成 / 08:05 still forming
        out = drop_forming_bar(bars, "M5", now)
        self.assertEqual([b["t"] for b in out], [start])

    def test_keeps_all_closed(self):
        start = ts("2026-08-04 08:00")
        bars = [{"t": start, "c": 1.0}, {"t": ts("2026-08-04 08:05"), "c": 2.0}]
        now = ts("2026-08-04 08:10")  # 两根都已收盘 / both closed
        out = drop_forming_bar(bars, "M5", now)
        self.assertEqual(len(out), 2)


if __name__ == "__main__":
    unittest.main()
