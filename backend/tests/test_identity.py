from app.services.gamification.identity import (
    mask_name, mask_account, display_name, nickname_reserved)


def test_mask_rules():
    assert mask_name("Trader") == "T***r"
    assert mask_name("张三丰") == "张***丰"
    assert mask_name("ab") == "**"
    assert mask_name("x") == "**"


def test_display_name_matrix():
    assert display_name("Trader", "a@b.co", True) == "Trader"
    assert display_name("Trader", "a@b.co", False) == "T***r"
    assert display_name(None, "hello@b.co", True) == "h***o"   # 邮箱永远打码，开关无效
    assert display_name(None, "hello@b.co", False) == "h***o"


def test_reserved_words():
    for bad in ("PRISMX官方", "prismx", "Ａｄｍｉｎ", "客 服", "administrator", "官方通知"):
        assert nickname_reserved(bad), bad
    for ok in ("Trader", "张三丰", "金牌操盘手"):
        assert not nickname_reserved(ok), ok


def test_mask_account_covers_exactly_two_middle_chars():
    """榜单展示口径：中间两位换成 **，长度与首尾保持原样（用户能一眼认出自己
    的号）。短号也必须盖住两位，绝不能出现「打了码还是全须全尾」。
    Board display rule: exactly two middle characters become **, the length and
    the ends stay. Short numbers must still lose two characters."""
    assert mask_account("12345678") == "123**678"
    assert mask_account("600402") == "60**02"
    assert mask_account("7001234") == "70**234"
    assert mask_account("1234") == "1**4"
    assert mask_account("123") == "1**"
    assert mask_account("12") == "**"
    assert mask_account("") == "**"
    assert mask_account(None) == "**"
    assert mask_account(500123) == "50**23"        # 非字符串也得能打码
