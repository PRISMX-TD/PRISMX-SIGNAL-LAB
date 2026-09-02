from app.services.settings_store import (
    get_gamification_settings, save_gamification_settings, invalidate_gamification_cache)


def test_default_is_hidden(db_session):
    invalidate_gamification_cache()
    assert get_gamification_settings(db_session)["user_visible"] is False


def test_save_and_reload(db_session):
    save_gamification_settings(db_session, {"user_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    assert get_gamification_settings(db_session)["user_visible"] is True
