from app.services.gamification.identity import mask_name, display_name, nickname_reserved


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
