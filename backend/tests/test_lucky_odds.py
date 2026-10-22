"""概率（rev 46）：按份量的抽奖箱权重、按概率不剔除已抽完、永久 PRO 排除、10 万次分布、按模式校验。
Odds (rev 46): raffle-box weights in qty mode, prob mode keeps sold-out slots, permanent-PRO exclusion,
a 100k-draw distribution check, and validation per mode."""
import math
import random

from app.services.lucky import odds


def S(id, bp=0, stock=None, used=0, excluded=False):
    return odds.Slot(id=id, prob_bp=bp, stock=stock, stock_used=used, excluded=excluded)


def test_qty_weights_are_remaining_stock_and_empty_slots_drop_out():
    w = odds.weights("qty", [S("a", stock=5, used=2), S("b", stock=3, used=3), S("c", stock=1)])
    assert w == [("a", 3), ("c", 1)]           # b 份数用完：权重 0 抽不中 / b is empty: weight 0


def test_qty_all_empty_picks_nothing():
    w = odds.weights("qty", [S("a", stock=1, used=1), S("b", stock=0)])
    assert w == [] and odds.pick(w) is None


def test_prob_keeps_sold_out_slots():
    """按概率：已抽完的格照样按原概率参与，概率不分给别的格。/ prob mode never drops a sold-out slot."""
    w = odds.weights("prob", [S("a", 1000, stock=1, used=1), S("b", 9000)])
    assert w == [("a", 1000), ("b", 9000)]
    assert odds.sold_out(1, 1) and not odds.sold_out(None, 99) and not odds.sold_out(2, 1)


def test_excluded_slot_has_no_weight_in_both_modes():
    assert odds.weights("prob", [S("pd", 9000, excluded=True), S("n", 1000)]) == [("n", 1000)]
    assert odds.weights("qty", [S("pd", stock=5, excluded=True), S("n", stock=0)]) == []


def test_pick_uses_cumulative_ranges():
    w = [("a", 1), ("b", 2), ("c", 7)]
    assert [odds.pick(w, rand_below=lambda n, r=r: r) for r in range(10)] == \
        ["a", "b", "b", "c", "c", "c", "c", "c", "c", "c"]


def test_distribution_matches_within_3_sigma():
    rng = random.Random(20261022)
    w = [("a", 100), ("b", 900), ("c", 3000), ("n", 6000)]
    n = 100_000
    hits = {k: 0 for k, _ in w}
    for _ in range(n):
        hits[odds.pick(w, rand_below=rng.randrange)] += 1
    for k, bp in w:
        p = bp / 10000
        sigma = math.sqrt(n * p * (1 - p))
        assert abs(hits[k] - n * p) <= 3 * sigma, (k, hits[k])


def D(**kw):
    base = dict(name="x", kind="none", prob_bp=0, pro_days=None, stock=None, claim_mode=None)
    base.update(kw)
    return odds.PrizeDraft(**base)


def test_validate_prob_ok_and_stock_optional():
    assert odds.validate("prob", [D(kind="pro_days", pro_days=7, prob_bp=1000, stock=5),
                                  D(kind="none", prob_bp=9000, stock=3)]) == []   # none 格也能设份数
    assert odds.validate("prob", [D(prob_bp=5000), D(kind="retry", prob_bp=5000)]) == []


def test_validate_prob_total_must_be_100():
    assert odds.validate("prob", [D(prob_bp=5000), D(prob_bp=4000)])
    assert odds.validate("prob", [D(prob_bp=-1), D(prob_bp=10001)])


def test_validate_qty_needs_stock_and_a_positive_total():
    assert odds.validate("qty", [D(stock=3), D(kind="retry", stock=0)]) == []
    assert odds.validate("qty", [D(stock=3), D(kind="retry")])                # 少填份数 / missing quantity
    assert odds.validate("qty", [D(stock=0), D(stock=0)])                     # 合计 0 / total 0
    assert odds.validate("qty", [D(stock=-1), D(stock=5)])
    assert odds.validate("qty", [D(stock=3, prob_bp=123), D(stock=1)]) == []  # 概率忽略 / odds ignored


def test_validate_common_rules():
    assert odds.validate("prob", [D(prob_bp=10000)])                                   # 只有 1 格
    assert odds.validate("qty", [D(stock=1)] * 13)                                    # 13 格
    assert odds.validate("prob", [D(kind="pro_days", prob_bp=5000), D(prob_bp=5000)])  # 没填天数
    assert odds.validate("prob", [D(kind="custom", prob_bp=5000), D(prob_bp=5000)])    # 没选领取方式
    assert odds.validate("prob", [D(name="  ", prob_bp=5000), D(prob_bp=5000)])
    assert odds.validate("bogus", [D(prob_bp=5000), D(prob_bp=5000)])
    # v1 的「必须有谢谢参与格」已去掉 / v1's "needs a no-prize slot" rule is gone
    assert odds.validate("prob", [D(kind="retry", prob_bp=5000, stock=1),
                                  D(kind="custom", claim_mode="form", prob_bp=5000, stock=1)]) == []
