"""quotes_store 的单测：变化判定要把 closed 状态翻转也算进去，不能只看
bid/ask 有没有变——这正是"休市兜底"这个功能唯一依赖的行为。

Unit tests for quotes_store: change detection must also treat a `closed`
flip as a change, not just bid/ask — this is the one behavior the
closed-market fallback feature depends on.
"""
from app.services import quotes_store as qs


def setup_function():
    # 每个用例前清空模块级缓存,避免测试间互相污染
    # Clear the module-level cache before each test to avoid cross-test pollution
    qs._quotes.clear()
    qs._updated_at.clear()


def test_new_symbol_counts_as_changed():
    changed = qs.update([{"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2, "closed": False}])
    assert len(changed) == 1
    assert changed[0]["symbol"] == "XAUUSD"


def test_identical_quote_is_not_reported_as_changed():
    qs.update([{"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2, "closed": False}])
    changed = qs.update([{"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2, "closed": False}])
    assert changed == []


def test_closed_flip_counts_as_changed_even_with_identical_price():
    """休市兜底推的是同一个价格,但 closed 从 False 翻到 True——这必须算变化,
    否则前端要等到下一次真正的价格波动才会看到"休市"标签更新。
    The closed-market fallback re-sends the same price, but `closed` flips
    False->True — this must count as a change, otherwise the frontend
    wouldn't see the "closed" label until the next genuine price move."""
    qs.update([{"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2, "closed": False}])
    changed = qs.update([{"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2, "closed": True}])
    assert len(changed) == 1
    assert changed[0]["closed"] is True


def test_get_active_symbols_still_includes_closed_symbols():
    """休市品种只要还在被推送(即便是兜底价格),就仍然算"活跃"——不从活跃
    列表里消失是这个功能唯一的目的。
    A closed-market symbol still counts as "active" as long as it's still
    being pushed (even a fallback price) — staying in the active list is
    the entire point of this feature."""
    qs.update([{"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2, "closed": True}])
    assert "XAUUSD" in qs.get_active_symbols()
