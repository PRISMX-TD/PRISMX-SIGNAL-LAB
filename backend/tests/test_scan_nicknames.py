"""`scripts/scan_nicknames.py` 的纯函数：新规则下的问题标签与 nickname_key 重建计划。"""
from app.services.gamification.identity import nickname_key
from scripts.scan_nicknames import nickname_issues, plan_key_rebuild

ZW = "\u200b"   # 零宽空格 / zero-width space


def test_issue_tags():
    assert nickname_issues(None, None) == []
    assert nickname_issues("Alice", nickname_key("Alice")) == []
    assert nickname_issues("Alice", "alice ") == ["key_stale"]
    assert nickname_issues("加我 www.foo.com", nickname_key("加我 www.foo.com")) == ["forbidden"]
    assert nickname_issues("QQ12345678", nickname_key("QQ12345678")) == ["forbidden"]
    assert nickname_issues("PRISMX客服", nickname_key("PRISMX客服")) == ["reserved"]
    # 旧 key 算法不剥不可见字符：prism<ZW>x 以前躲过了保留词，key 也是旧的
    sneaky = f"prism{ZW}x"
    assert nickname_issues(sneaky, sneaky) == ["reserved", "invisible", "key_stale"]


def test_rebuild_plan_updates_only_stale_non_conflicting():
    rows = [
        ("u1", "Alice", "alice"),                 # 已是新 key
        ("u2", f"Bo{ZW}b", f"bo{ZW}b"),           # 过时，新 key bob 没人占 → 写
        ("u3", None, None),                       # 没昵称
    ]
    updates, conflicts = plan_key_rebuild(rows)
    assert updates == {"u2": "bob"}
    assert conflicts == []


def test_rebuild_plan_reports_conflicts_instead_of_writing():
    rows = [
        ("u1", "Carol", "carol"),
        ("u2", f"Car{ZW}ol", f"car{ZW}ol"),       # 新 key carol 已被 u1 占
        ("u3", f"D{ZW}an", f"d{ZW}an"),           # 与 u4 的新 key 撞
        ("u4", f"Da{ZW}n", f"da{ZW}n"),
        ("u5", ZW, ZW),                           # 新 key 为空
    ]
    updates, conflicts = plan_key_rebuild(rows)
    assert updates == {}
    reasons = {uid: why for uid, _new, why in conflicts}
    assert reasons["u2"] == "taken by u1"
    assert reasons["u3"].startswith("same new key") and reasons["u4"].startswith("same new key")
    assert reasons["u5"] == "empty"
