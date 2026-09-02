from app.services.settings_store import (
    get_gamification_settings, save_gamification_settings, invalidate_gamification_cache)


def test_default_is_hidden(db_session):
    invalidate_gamification_cache()
    assert get_gamification_settings(db_session)["user_visible"] is False


def test_save_and_reload(db_session):
    save_gamification_settings(db_session, {"user_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    assert get_gamification_settings(db_session)["user_visible"] is True
    # 收尾：不留 user_visible=True 在 30s TTL 的进程全局缓存里，避免后面的
    # 测试要靠"防御性 invalidate"才能不受这条测试顺序影响。
    invalidate_gamification_cache()
