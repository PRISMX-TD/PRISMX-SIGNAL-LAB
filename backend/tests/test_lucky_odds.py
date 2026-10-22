"""概率：兜底合并、按比例放大、全部抽完、10 万次分布、配置校验。"""
import math
import random

from app.services.lucky import odds
from app.services.lucky.common import SOLD_OUT_FALLBACK as FB, SOLD_OUT_REDISTRIBUTE as RD


def S(id, bp, avail=True, mode=FB, fb=False):
    return odds.Slot(id=id, prob_bp=bp, available=avail, on_sold_out=mode, is_fallback=fb)


def test_all_available_weights_unchanged():
    w = odds.effective_weights([S("a", 1000), S("b", 2000), S("n", 7000, fb=True)])
    assert w == [("a", 1000), ("b", 2000), ("n", 7000)]


def test_sold_out_to_fallback_moves_weight_to_fallback():
    w = odds.effective_weights([S("a", 1000, avail=False), S("b", 2000), S("n", 7000, fb=True)])
    assert w == [("b", 2000), ("n", 8000)]


def test_sold_out_redistribute_just_drops_it():
    w = odds.effective_weights([S("a", 1000, avail=False, mode=RD), S("b", 2000), S("n", 7000, fb=True)])
    assert w == [("b", 2000), ("n", 7000)]   # 合计 9000：其余按比例放大 / the rest scale up


def test_everything_unavailable_picks_nothing():
    w = odds.effective_weights([S("a", 5000, avail=False, mode=RD), S("b", 5000, avail=False, mode=RD)])
    assert w == []
    assert odds.pick(w) is None


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
    base = dict(name="x", kind="none", prob_bp=0, pro_days=None, stock=None,
                per_user_limit=None, on_sold_out=FB, claim_mode=None)
    base.update(kw)
    return odds.PrizeDraft(**base)


def test_validate_ok():
    assert odds.validate([D(kind="pro_days", pro_days=7, prob_bp=1000, stock=5),
                          D(kind="none", prob_bp=9000)]) == []


def test_validate_errors():
    assert odds.validate([D(prob_bp=10000)])                                   # 只有 1 格
    assert odds.validate([D(prob_bp=5000), D(prob_bp=4000)])                   # 合计 ≠ 100%
    assert odds.validate([D(kind="pro_days", prob_bp=5000), D(prob_bp=5000)])  # 没填天数
    assert odds.validate([D(kind="custom", prob_bp=5000), D(prob_bp=5000)])    # 没选领取方式
    assert odds.validate([D(kind="retry", prob_bp=5000, stock=1),              # 设了库存又要并入兜底
                          D(kind="custom", claim_mode="form", prob_bp=5000)])  # 却没有「谢谢参与」
    assert odds.validate([D(prob_bp=5000, stock=3), D(prob_bp=5000)])          # 兜底格不能设库存
    assert odds.validate([D(prob_bp=-1), D(prob_bp=10001)])
    assert odds.validate([D(name="  ", prob_bp=5000), D(prob_bp=5000)])


def test_fallback_is_first_none():
    assert odds.fallback_index([D(kind="retry"), D(kind="none"), D(kind="none")]) == 1
    assert odds.fallback_index([D(kind="retry")]) is None
