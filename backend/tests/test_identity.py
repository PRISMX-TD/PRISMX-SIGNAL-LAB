from app.services.gamification.identity import (
    mask_name, mask_account, display_name, nickname_reserved)


def test_mask_rules():
    assert mask_name("Trader") == "T***r"
    assert mask_name("张三丰") == "张***丰"
    assert mask_name("ab") == "**"
    assert mask_name("x") == "**"


def test_display_name_matrix():
    """昵称原样展示（2026-09-19 起不再按开关打码——藏的换成了账户号）；没设
    昵称的老账号退回邮箱前缀，那条路径永远打码。"""
    assert display_name("Trader", "a@b.co") == "Trader"
    assert display_name("张三丰", "a@b.co") == "张三丰"
    assert display_name(None, "hello@b.co") == "h***o"         # 邮箱永远打码
    assert display_name("", "hello@b.co") == "h***o"


def test_reserved_words():
    for bad in ("PRISMX官方", "prismx", "Ａｄｍｉｎ", "客 服", "administrator", "官方通知"):
        assert nickname_reserved(bad), bad
    for ok in ("Trader", "张三丰", "金牌操盘手"):
        assert not nickname_reserved(ok), ok


def test_mask_account_shows_only_last_three():
    """站内他人账户号只露后 3 位（设计 §1.9，2026-10-08 收紧）：前面全换成 *，长度不变
    （长度不是要藏的信息）。短号至少盖住 2 位，绝不能出现「打了码还是全须全尾」。
    Another entrant's account shows only its last three characters; short numbers
    still hide at least two."""
    assert mask_account("12345678") == "*****678"
    assert mask_account("600402") == "***402"
    assert mask_account("7001234") == "****234"
    assert mask_account("1234") == "**34"
    assert mask_account("123") == "**3"
    assert mask_account("12") == "**"
    assert mask_account("") == "**"
    assert mask_account(None) == "**"
    assert mask_account(500123) == "***123"        # 非字符串也得能打码
