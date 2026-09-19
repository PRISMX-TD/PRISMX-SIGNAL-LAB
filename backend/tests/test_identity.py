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


def test_mask_account_covers_exactly_two_middle_chars():
    """榜单账户号列的口径：中间两位换成 **，长度与首尾保持原样（用户能一眼
    认出自己的号）。短号也必须盖住两位，绝不能出现「打了码还是全须全尾」。
    The board's account column: exactly two middle characters become **, the
    length and the ends stay. Short numbers must still lose two characters."""
    assert mask_account("12345678") == "123**678"
    assert mask_account("600402") == "60**02"
    assert mask_account("7001234") == "70**234"
    assert mask_account("1234") == "1**4"
    assert mask_account("123") == "1**"
    assert mask_account("12") == "**"
    assert mask_account("") == "**"
    assert mask_account(None) == "**"
    assert mask_account(500123) == "50**23"        # 非字符串也得能打码
