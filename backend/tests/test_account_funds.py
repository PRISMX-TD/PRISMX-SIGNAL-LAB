"""account_funds_from_positions 的汇总与边界测试。

这个函数的输出直接决定账户卡片显示的浮动盈亏和净值，而它的入参来自两条不同的
上报链路（bridge 与 gateway），字段类型并不完全可控。以下用例覆盖的是实际会
遇到的几种输入形态，而不是理论上的异常。
"""

from app.services.connection_manager import ConnectionManager

agg = ConnectionManager.account_funds_from_positions


def _as_dict(funds: list[dict]) -> dict[str, float]:
    return {f["login"]: f["profit"] for f in funds}


def test_sums_multiple_positions_per_login():
    """同一账号多笔持仓要合并成一个数字。

    账户卡片只展示一行，必须是该账号所有持仓浮盈的总和。
    """
    out = _as_dict(agg([
        {"login": "500039", "profit": -2.10},
        {"login": "500039", "profit": 5.30},
        {"login": "100042", "profit": 472.50},
    ]))
    assert out == {"500039": 3.20, "100042": 472.50}


def test_rounds_to_cents():
    """浮点累加的尾数不能带到界面上。

    0.1 + 0.2 在二进制浮点下是 0.30000000000000004，前端直接展示会露出尾数。
    """
    out = _as_dict(agg([
        {"login": "1", "profit": 0.1},
        {"login": "1", "profit": 0.2},
    ]))
    assert out == {"1": 0.30}


def test_login_normalized_to_string():
    """login 统一成字符串，否则前端按 account.login 查表会落空。

    MT5Account.login 在前端是 string；如果这里保留 int，Record 的键就成了
    "500039" 之外的形态，查表失败会让浮盈静默显示为 0。
    """
    out = agg([{"login": 500039, "profit": 1.0}])
    assert out == [{"login": "500039", "profit": 1.0}]


def test_int_and_float_profit_both_accepted():
    """profit 可能是整数（无小数的盈亏），不能被当成非法值丢掉。"""
    out = _as_dict(agg([
        {"login": "1", "profit": 3},
        {"login": "1", "profit": 0.5},
    ]))
    assert out == {"1": 3.50}


def test_accounts_without_positions_are_absent():
    """没有持仓的账号不出现在结果里。

    这个函数只看得见持仓快照，无从得知用户有哪些账号。前端必须把"缺席"当成 0，
    这条用例把该契约固定下来。
    """
    assert agg([]) == []
    assert agg(None) == []


def test_skips_entries_missing_login_or_profit():
    """字段缺失的条目跳过，不影响同批其他账号。

    上报链路有多个版本的客户端，字段并非始终完整。一条坏数据不能让整个账号的
    浮盈变成 None 或抛异常。
    """
    out = _as_dict(agg([
        {"login": "1", "profit": 10.0},
        {"profit": 99.0},            # 无 login
        {"login": "2"},              # 无 profit
        {"login": "3", "profit": None},
        "not-a-dict",
        {"login": "1", "profit": 5.0},
    ]))
    assert out == {"1": 15.0}


def test_bool_profit_rejected():
    """bool 是 int 的子类，True 会被当成 1 混进求和，必须显式排除。"""
    out = _as_dict(agg([
        {"login": "1", "profit": True},
        {"login": "1", "profit": 2.0},
    ]))
    assert out == {"1": 2.0}


def test_negative_totals_preserved():
    """亏损账号的负号要保留 —— 卡片靠正负决定红绿。"""
    out = _as_dict(agg([
        {"login": "1", "profit": -10.5},
        {"login": "1", "profit": -0.53},
    ]))
    assert out == {"1": -11.03}
