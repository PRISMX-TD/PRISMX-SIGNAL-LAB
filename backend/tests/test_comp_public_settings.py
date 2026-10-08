"""公开比赛的两个全局设置（设计 §1.3/§1.7）：总开关与主推比赛，走现有游戏化设置接口。"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models import Competition, PlatformSetting
from app.routers.gamification import admin_get_settings, admin_patch_settings
from app.schemas import GamificationSettingsPatchIn
from app.services.settings_store import (
    GAMIFICATION_DEFAULTS, _load_gamification_from_db, get_gamification_settings,
    invalidate_gamification_cache)

T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)


def _comp(db):
    c = Competition(name="Demo Cup", metric="return_pct", enrollment="signup", track="demo",
                    status="upcoming", starts_at=T0, ends_at=T0 + timedelta(days=7))
    db.add(c); db.commit(); return c


def test_defaults_are_off_and_unpinned():
    assert GAMIFICATION_DEFAULTS["competitions_public_enabled"] is False
    assert GAMIFICATION_DEFAULTS["featured_competition_id"] is None
    assert settings.RATE_LIMIT_COMPETITION_PUBLIC == "300/minute"


def test_patch_roundtrip_and_clear(db_session):
    comp = _comp(db_session)
    out = admin_patch_settings(
        GamificationSettingsPatchIn(competitionsPublicEnabled=True, featuredCompetitionId=comp.id),
        db=db_session)
    assert out["competitionsPublicEnabled"] is True and out["featuredCompetitionId"] == comp.id
    invalidate_gamification_cache()
    got = get_gamification_settings(db_session)
    assert got["competitions_public_enabled"] is True and got["featured_competition_id"] == comp.id
    assert got["min_trades_return"] == 5                          # 未传字段不动
    out = admin_patch_settings(GamificationSettingsPatchIn(featuredCompetitionId=None), db=db_session)
    assert out["featuredCompetitionId"] is None
    assert admin_get_settings(db=db_session)["competitionsPublicEnabled"] is True


def test_featured_must_exist(db_session):
    with pytest.raises(HTTPException) as e:
        admin_patch_settings(
            GamificationSettingsPatchIn(featuredCompetitionId="00000000-0000-4000-8000-000000000000"),
            db=db_session)
    assert e.value.status_code == 400 and "主推比赛不存在" in e.value.detail


def test_loader_rejects_non_string_featured(db_session):
    """坏值（数字、对象）宁缺勿错，回落 None；与其它键同一口径。"""
    db_session.add(PlatformSetting(key="gamification",
                                   value=json.dumps({"featured_competition_id": 123,
                                                     "competitions_public_enabled": "true"})))
    db_session.commit()
    data = _load_gamification_from_db(db_session)
    assert data["featured_competition_id"] is None
    assert data["competitions_public_enabled"] is False
