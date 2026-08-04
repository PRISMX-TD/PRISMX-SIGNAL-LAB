"""趋势模块测试 / trend tests.

运行 / run:  python -m unittest manager_feed.test_trend -v
"""
from __future__ import annotations

import unittest

from manager_feed.trend import DOWN, FLAT, UP, compute_trends, direction, ema


class TestEma(unittest.TestCase):
    def test_insufficient_data_returns_empty(self):
        self.assertEqual(ema([1.0, 2.0], 5), [])

    def test_seed_is_sma(self):
        vals = [1.0, 2.0, 3.0, 4.0]
        out = ema(vals, 4)
        self.assertEqual(len(out), 4)
        self.assertAlmostEqual(out[-1], 2.5)  # 前 4 根的简单平均 / SMA of the 4

    def test_length_matches_input(self):
        vals = [float(i) for i in range(50)]
        self.assertEqual(len(ema(vals, 10)), 50)

    def test_follows_rising_series(self):
        vals = [float(i) for i in range(60)]
        out = ema(vals, 10)
        # 上升序列里 EMA 应递增且滞后于价格 / rising, and lagging price
        self.assertLess(out[20], out[40])
        self.assertLess(out[-1], vals[-1])

    def test_zero_length_guard(self):
        self.assertEqual(ema([1.0, 2.0, 3.0], 0), [])


class TestDirection(unittest.TestCase):
    def test_insufficient_data_is_flat(self):
        self.assertEqual(direction([1.0] * 10), FLAT)

    def test_steady_uptrend(self):
        closes = [100.0 + i for i in range(60)]
        self.assertEqual(direction(closes), UP)

    def test_steady_downtrend(self):
        closes = [200.0 - i for i in range(60)]
        self.assertEqual(direction(closes), DOWN)

    def test_flat_series(self):
        """完全不动的价格不应判出方向。
        A perfectly static price yields no direction."""
        self.assertEqual(direction([100.0] * 60), FLAT)

    def test_alternating_series_documents_ema_phase_effect(self):
        """逐根交替的锯齿序列会判出方向，这是 EMA 的固有行为，不是缺陷。

        EMA(10) 与 EMA(30) 在严格交替的序列上采样到该振荡的不同相位，末值相差
        约振幅的 3.6%（实测 fast-slow=0.071，slope=0.068，振幅 2.0），足以同时
        满足"快线在上"和"慢线上行"两个条件。

        这里断言现状而不是断言 FLAT：EA 用完全相同的 EMA10/EMA30 + 斜率判据，同样
        输入会给出同样结果。网关的目标是让前端趋势读数在切换前后一致，若在此"修正"
        算法，两端就会分叉，用户会在切换那一刻看到趋势数据无故变化——那比锯齿误判
        更糟。真实行情不会逐根精确翻转，见 test_noisy_range_is_flat。

        A strictly alternating sawtooth does yield a direction; that's inherent to
        EMA, not a defect.

        EMA(10) and EMA(30) sample different phases of the oscillation, leaving the
        final values ~3.6% of the amplitude apart (measured: fast-slow=0.071,
        slope=0.068 against an amplitude of 2.0) — enough to satisfy both "fast
        above" and "slow rising".

        This asserts current behaviour rather than FLAT: the EA uses the very same
        EMA10/EMA30-plus-slope predicate and returns the same thing. The gateway's
        goal is for the frontend's trend readings to match across the switch;
        "fixing" the algorithm here would fork the two and users would see trends
        change for no reason at cutover — worse than the sawtooth misread. Real
        series don't flip exactly every bar; see test_noisy_range_is_flat.
        """
        closes = [100.0 + (1.0 if i % 2 else -1.0) for i in range(60)]
        self.assertEqual(direction(closes), UP)

    def test_reversal_confirmation_window_is_flat(self):
        """转折确认期判 FLAT：慢线已上行但快线还在其下方，两条件不同时成立。

        实测得到的形态（fast_above=False, slow_rising=True），对应"跌势刚结束、反弹
        尚未被快线确认"的一段。斜率条件的作用就是让这段不给方向。

        FLAT during a reversal's confirmation window: the slow line has turned up while
        the fast line is still below it, so the conditions don't hold together.

        This is the measured shape (fast_above=False, slow_rising=True) — a decline
        that has just ended with the rebound not yet confirmed by the fast line. The
        slope condition exists so this stretch yields no direction.
        """
        closes = [200.0 - i * 2 for i in range(45)] + [110.0 + i * 3 for i in range(12)]
        fast, slow = ema(closes, 10), ema(closes, 30)
        self.assertLess(fast[-1], slow[-1])      # 快线仍在下方 / fast still below
        self.assertGreater(slow[-1], slow[-4])   # 慢线已上行 / slow already rising
        self.assertEqual(direction(closes), FLAT)

    def test_real_market_shape_pullback_in_uptrend(self):
        """真实形态：上升趋势中的回调，末段下行应判 DOWN。

        对应实测数据里 XAUUSD.s 的 M1/M5 读数（方向=DOWN，fast-slow=-2.87）：短周期
        在回调，长周期仍向上。趋势指标本就该跟随当下的段，而不是试图识别更大的结构。

        Real shape: a pullback inside an uptrend reads DOWN on the short leg.

        Matches the measured XAUUSD.s M1/M5 readings (DOWN, fast-slow=-2.87): the
        short intervals pull back while longer ones still rise. A trend indicator
        should follow the current leg rather than infer the larger structure.
        """
        closes = [100.0 + i * 0.8 for i in range(40)] + [131.2 - i * 1.5 for i in range(20)]
        self.assertEqual(direction(closes), DOWN)

    def test_reversal_from_up_to_down(self):
        """先涨后跌，末段足够长时应判 DOWN。
        Rising then falling: DOWN once the tail is long enough."""
        closes = [100.0 + i for i in range(40)] + [140.0 - i * 2 for i in range(40)]
        self.assertEqual(direction(closes), DOWN)

    def test_exact_boundary_length(self):
        """刚好 slow_len + slope_len 根时应能判定，不再返回 FLAT。
        Exactly slow_len + slope_len bars must be evaluable."""
        closes = [100.0 + i for i in range(33)]  # 30 + 3
        self.assertEqual(direction(closes), UP)
        closes_short = [100.0 + i for i in range(32)]
        self.assertEqual(direction(closes_short), FLAT)


class TestComputeTrends(unittest.TestCase):
    def test_omits_intervals_without_enough_data(self):
        """数据不足的周期应缺席，而不是填 FLAT。
        Short intervals are omitted, not set to FLAT."""
        data = {
            "M1": [100.0 + i for i in range(60)],
            "H4": [100.0, 101.0],  # 太短 / too short
        }
        out = compute_trends(data)
        self.assertIn("M1", out)
        self.assertNotIn("H4", out)

    def test_returns_backend_accepted_values(self):
        """只能返回后端 TrendDir 接受的三个值。
        Only the three values the backend's TrendDir accepts."""
        data = {
            "M1": [100.0 + i for i in range(60)],
            "M5": [200.0 - i for i in range(60)],
            "M15": [100.0] * 60,
        }
        out = compute_trends(data)
        self.assertEqual(set(out.values()) - {UP, DOWN, FLAT}, set())
        self.assertEqual(out["M1"], UP)
        self.assertEqual(out["M5"], DOWN)
        self.assertEqual(out["M15"], FLAT)

    def test_empty_input(self):
        self.assertEqual(compute_trends({}), {})


if __name__ == "__main__":
    unittest.main()
