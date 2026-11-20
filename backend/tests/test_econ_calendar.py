"""财经日历（rev 52）：规则、入库与合并、预案生成与校验、公布后判定、补查、后台循环开关、管理接口。
不发任何外部请求：Narwhal 与 DeepSeek 都打桩。
Economic calendar (rev 52): rules, upsert and merge, preview generation and validation, outcomes,
re-checks, the loop switch and the admin endpoints. No outbound request: both clients are stubbed."""
import json
from datetime import date, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models import EconPreview, EconRelease, PlatformSetting, User
from app.routers import admin_econ
from app.services.econ import deepseek, loop, narwhal, previews, rules, store

NOW = datetime(2026, 11, 20, 12, 0)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _release(rid, country="USA", at=NOW + timedelta(hours=3), name="Retail sales", family="activity",
             status="scheduled", values=None, **extra):
    r = {"release_id": rid, "revision": 1, "country": country, "series_id": f"{country.lower()}-x", "name": name,
         "family": family, "status": status, "at": _iso(at), "timezone": "America/New_York", "period": "2026-10",
         "values": values if values is not None else []}
    r.update(extra)
    return r


RETAIL = [
    {"measure": "retail_sales_control_group_mom", "unit": "percent", "consensus": "0.4", "previous": "0.5"},
    {"measure": "retail_sales_mom", "unit": "percent", "consensus": "0.2", "previous": "0.8"},
    {"measure": "retail_sales_yoy", "unit": "percent", "consensus": "6.5", "previous": "6.6"},
]

GOOD_CONTENT = {
    "title_zh": "美国10月零售销售", "title_en": "US October retail sales",
    "why_zh": "衡量消费需求的核心数据。", "why_en": "The core gauge of consumer demand.",
    "focus_zh": "看月率。", "focus_en": "Watch the monthly rate.",
    "names_zh": {"retail_sales_mom": "零售销售月率"},
    "scenarios": {
        "above": {"impacts": [{"asset": "USD", "direction": "bullish", "strength": "medium"},
                              {"asset": "XAU", "direction": "bearish", "strength": "weak"}],
                  "reason_zh": "消费强劲，降息预期降温。", "reason_en": "Strong spending cools rate-cut bets."},
        "inline": {"impacts": [{"asset": "USD", "direction": "neutral", "strength": "weak"}],
                   "reason_zh": "符合预期，影响有限。", "reason_en": "In line, limited impact."},
        "below": {"impacts": [{"asset": "USD", "direction": "bearish", "strength": "medium"}],
                  "reason_zh": "消费走弱，降息预期升温。", "reason_en": "Weak spending lifts rate-cut bets."},
    },
}


@pytest.fixture
def enabled(db_session, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.NARWHAL_API_KEY", "nw-test")
    monkeypatch.setattr("app.core.config.settings.DEEPSEEK_API_KEY", "ds-test")
    store.save_settings(db_session, {"enabled": True})
    db_session.commit()
    store._status.clear()
    monkeypatch.setattr(store.shared_cache, "get_json", lambda k: None)
    monkeypatch.setattr(store.shared_cache, "set_json", lambda k, v, ttl: None)
    monkeypatch.setattr(loop, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(store, "utcnow", lambda: NOW)
    return db_session


def _stub_llm(monkeypatch, data=None, calls=None):
    def fake(system, user, **kw):
        if calls is not None:
            calls.append(json.loads(user))
        return deepseek.DeepSeekReply(data if data is not None else GOOD_CONTENT, "deepseek-flash", 900, 400)
    monkeypatch.setattr(deepseek, "chat_json", fake)


# ---- rules ----

@pytest.mark.parametrize("actual,consensus,expected", [
    ("0.3", "0.3", "inline"), ("0.4", "0.3", "above"), ("0.2", "0.3", "below"), ("0.30", "0.3", "inline"),
    ("203", "197", "above"), ("197.4", "197", "inline"), ("-43.5", "25", "below"), ("6.3", "20", "below"),
    (None, "0.3", None), ("0.3", None, None), ("abc", "1", None),
])
def test_compare_uses_the_precision_of_the_consensus(actual, consensus, expected):
    assert rules.compare(actual, consensus) == expected


def test_importance_table():
    assert rules.release_importance("USA", "activity", "Retail sales", RETAIL) == rules.HIGH
    assert rules.release_importance("USA", "labour", "Jobless claims",
                                    [{"measure": "initial_claims"}]) == rules.MEDIUM
    assert rules.release_importance("USA", "housing", "Mortgage rates", [{"measure": "mortgage_rate_30y"}]) == rules.LOW
    # 对齐 Forex Factory：欧银非货币会议低，央行讲话橙，美联储纪要红、其它纪要橙
    # Aligned with Forex Factory: ECB non-monetary meeting low, speeches orange, FOMC minutes red
    assert rules.release_importance("EMU", "policy_rate", "Monetary council meeting", []) == rules.LOW
    assert rules.release_importance("GBR", "policy_rate", "Central bank speech", []) == rules.MEDIUM
    assert rules.release_importance("USA", "policy_rate", "Monetary policy minutes", []) == rules.HIGH
    assert rules.release_importance("GBR", "policy_rate", "Monetary policy minutes", []) == rules.MEDIUM
    assert rules.release_importance("GBR", "policy_rate", "Monetary policy vote", []) == rules.HIGH
    # 同一指标按国家分级：瑞士工业产出黄、加拿大 PPI 黄 / per-country: CHF industrial output and CAD PPI are low
    assert rules.release_importance("CHE", "activity", "Industrial production",
                                    [{"measure": "industrial_production_yoy"}]) == rules.LOW
    assert rules.release_importance("CAN", "prices", "Producer prices", [{"measure": "producer_prices_mom"}]) == rules.LOW
    assert rules.release_importance("CAN", "prices", "Consumer prices", [{"measure": "cpi_common_yoy"}]) == rules.MEDIUM
    assert rules.release_importance("USA", "activity", "Futures positioning", []) == rules.NONE
    # 利率决议带数值也是高 / a rate decision with a figure is high
    assert rules.release_importance("AUS", "policy_rate", "Rate decision", [{"measure": "cash_rate"}]) == rules.HIGH


def test_primary_prefers_importance_then_priority():
    p = rules.primary_measure("USA", "activity", RETAIL)
    assert p["measure"] == "retail_sales_mom"
    assert rules.primary_measure("USA", "activity", [{"measure": "retail_sales_mom"}]) is None   # 没预期值 / no consensus


# ---- 入库与合并 / upsert and merge ----

def test_upsert_tracks_new_actuals_and_groups(db_session):
    db = db_session
    stats = store.upsert_releases(db, [_release("r1", values=RETAIL)], NOW)
    db.commit()
    assert stats["new"] == 1 and stats["newActuals"] == 0
    row = db.get(EconRelease, "r1")
    assert row.importance == rules.HIGH and row.currency == "USD" and row.group_key == "USA|2026-11-20T15:00"
    published = [dict(v, actual="0.6") for v in RETAIL]
    stats = store.upsert_releases(db, [_release("r1", status="published", values=published)], NOW + timedelta(hours=3))
    db.commit()
    assert stats["newActuals"] == 1 and stats["actualGroups"] == ["USA|2026-11-20T15:00"]
    assert db.get(EconRelease, "r1").actual_seen_at == NOW + timedelta(hours=3)
    # 再来一遍不重复计 / a second pass does not count again
    stats = store.upsert_releases(db, [_release("r1", status="published", values=published)], NOW + timedelta(hours=4))
    assert stats["newActuals"] == 0


def test_merged_values_dedupes_overlapping_releases(db_session):
    db = db_session
    store.upsert_releases(db, [
        _release("a", country="AUS", name="Labour force survey", family="labour",
                 values=[{"measure": "unemployment_rate", "unit": "percent", "previous": "4.7"}]),
        _release("b", country="AUS", name="Unemployment", family="labour",
                 values=[{"measure": "unemployment_rate", "unit": "percent", "consensus": "4.7", "previous": "4.7"},
                         {"measure": "participation_rate", "unit": "percent", "consensus": "66.8"}]),
    ], NOW)
    db.commit()
    rows = db.query(EconRelease).all()
    merged = store.merged_values(rows)
    assert [v["measure"] for v in merged] == ["unemployment_rate", "participation_rate"]
    assert merged[0]["consensus"] == "4.7"


def test_settings_fall_back_per_field(db_session):
    db = db_session
    db.add(PlatformSetting(key=store.SETTINGS_KEY, value=json.dumps(
        {"enabled": "yes", "countries": ["usa", "GBR", 3], "dailyLlmCap": -1, "previewMinImportance": 3})))
    db.commit()
    cfg = store.get_settings(db)
    assert cfg["enabled"] is False and cfg["countries"] == ["GBR"]
    assert cfg["dailyLlmCap"] == store.SETTINGS_DEFAULTS["dailyLlmCap"] and cfg["previewMinImportance"] == 3


# ---- 预案 / previews ----

def test_generate_ok_and_validated(enabled, monkeypatch):
    db = enabled
    calls = []
    _stub_llm(monkeypatch, calls=calls)
    store.upsert_releases(db, [_release("r1", values=RETAIL)], NOW)
    db.commit()
    groups = previews.due_groups(db, store.get_settings(db), NOW)
    assert [k for k, _ in groups] == ["USA|2026-11-20T15:00"]
    p = previews.generate(db, *groups[0], NOW)
    db.commit()
    assert p.status == "ok" and p.primary_measure == "retail_sales_mom" and p.tokens_in == 900
    assert json.loads(p.content_json)["scenarios"]["above"]["impacts"][0]["asset"] == "USD"
    sent = calls[0]
    assert sent["primary_figure"] == "retail_sales_mom" and sent["currency"] == "USD" and "XAU" in sent["assets"]
    assert all("actual" not in f for f in sent["figures"])
    assert store.llm_calls_today() == 1
    # 预期值没变就不再写 / unchanged consensus is not rewritten
    assert previews.due_groups(db, store.get_settings(db), NOW) == []
    # 预期值变了要重写 / a changed consensus is
    changed = [dict(v) for v in RETAIL]
    changed[1]["consensus"] = "0.3"
    store.upsert_releases(db, [_release("r1", values=changed)], NOW)
    db.commit()
    assert [k for k, _ in previews.due_groups(db, store.get_settings(db), NOW)] == ["USA|2026-11-20T15:00"]


@pytest.mark.parametrize("mutate", [
    lambda c: c["scenarios"]["above"]["impacts"].__setitem__(0, {"asset": "AAPL", "direction": "bullish",
                                                                    "strength": "medium"}),
    lambda c: c["scenarios"].pop("inline"),
    lambda c: c["scenarios"]["below"].__setitem__("impacts", []),
    lambda c: c["scenarios"]["above"]["impacts"][0].__setitem__("direction", "up"),
])
def test_invalid_model_output_is_stored_as_failed(enabled, monkeypatch, mutate):
    db = enabled
    bad = json.loads(json.dumps(GOOD_CONTENT))
    mutate(bad)
    _stub_llm(monkeypatch, data=bad)
    store.upsert_releases(db, [_release("r1", values=RETAIL)], NOW)
    db.commit()
    key, rows = previews.due_groups(db, store.get_settings(db), NOW)[0]
    p = previews.generate(db, key, rows, NOW)
    db.commit()
    assert p.status == "failed" and p.content_json is None and p.attempts == 1
    # 失败的最多试 3 次 / failures retry up to 3 times
    for _ in range(2):
        previews.generate(db, key, rows, NOW)
    db.commit()
    assert previews.due_groups(db, store.get_settings(db), NOW) == []


def test_low_importance_gets_no_preview_but_no_consensus_still_does(enabled, monkeypatch):
    # 黄色不写；没有预期值的橙 / 红也写：有前值的对前值比，讲话这类按鹰 / 中 / 鸽写
    # Yellow is skipped; orange/red without a consensus are still written (vs previous, or hawkish/dovish)
    db = enabled
    calls = []
    _stub_llm(monkeypatch, calls=calls)
    store.upsert_releases(db, [
        _release("low", name="Mortgage rates", family="housing",
                 values=[{"measure": "mortgage_rate_30y", "consensus": "6.1"}]),
        _release("nocons", country="GBR", name="Retail sales",
                 values=[{"measure": "retail_sales_mom", "previous": "0.1"}]),
        _release("speech", country="EMU", at=NOW + timedelta(hours=4), name="Central bank speech", family="policy_rate"),
    ], NOW)
    db.commit()
    due = previews.due_groups(db, store.get_settings(db), NOW)
    assert [k for k, _ in due] == ["GBR|2026-11-20T15:00", "EMU|2026-11-20T16:00"]
    gbr = previews.generate(db, due[0][0], due[0][1], NOW)
    speech = previews.generate(db, due[1][0], due[1][1], NOW)
    db.commit()
    assert calls[0]["basis"] == "previous" and calls[0]["primary_figure"] == "retail_sales_mom"
    assert calls[1]["basis"] == "none"
    assert json.loads(gbr.content_json)["basis"] == "previous" and json.loads(speech.content_json)["basis"] == "none"
    # 写过就不再写 / cached afterwards
    assert previews.due_groups(db, store.get_settings(db), NOW) == []
    # 公布后对前值判定 / once out, judged against the previous value
    store.upsert_releases(db, [_release("nocons", country="GBR", name="Retail sales", status="published",
                                        values=[{"measure": "retail_sales_mom", "previous": "0.1", "actual": "0.4"}])],
                          NOW + timedelta(hours=4))
    db.commit()
    assert previews.apply_outcomes(db, ["GBR|2026-11-20T15:00", "EMU|2026-11-20T16:00"], NOW) == 1
    assert db.query(EconPreview).filter(EconPreview.group_key == "GBR|2026-11-20T15:00").one().outcome == "above"


def test_peak_hours_only_write_soon_groups(enabled):
    db = enabled
    peak = datetime(2026, 11, 20, 7, 0)    # 周五 UTC 07:00 是高峰 / Friday 07:00 UTC is peak
    store.upsert_releases(db, [_release("soon", at=peak + timedelta(hours=2), values=RETAIL),
                               _release("later", country="CAN", at=peak + timedelta(hours=12), values=RETAIL)], peak)
    db.commit()
    keys = [k for k, _ in previews.due_groups(db, store.get_settings(db), peak)]
    assert keys == ["USA|2026-11-20T09:00"]


def test_outcome_is_stamped_without_a_model_call(enabled, monkeypatch):
    db = enabled
    _stub_llm(monkeypatch)
    store.upsert_releases(db, [_release("r1", at=NOW - timedelta(minutes=10), values=RETAIL)], NOW - timedelta(hours=1))
    db.commit()
    rows = db.query(EconRelease).all()
    previews.generate(db, rows[0].group_key, rows, NOW - timedelta(hours=1))
    db.commit()
    monkeypatch.setattr(deepseek, "chat_json", lambda *a, **k: pytest.fail("no model call at release"))
    published = [dict(v, actual=a) for v, a in zip(RETAIL, ("0.6", "0.2", "6.8"))]
    stats = store.upsert_releases(db, [_release("r1", at=NOW - timedelta(minutes=10), status="published",
                                                values=published)], NOW)
    db.commit()
    assert previews.apply_outcomes(db, stats["actualGroups"], NOW) == 1
    db.commit()
    p = db.query(EconPreview).one()
    assert (p.outcome, p.outcome_actual, p.outcome_consensus) == ("inline", "0.2", "0.2")


# ---- 循环 / loop ----

def test_loop_does_nothing_while_switched_off(db_session, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.NARWHAL_API_KEY", "nw-test")
    monkeypatch.setattr(loop, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(store.shared_cache, "set_json", lambda k, v, ttl: None)
    monkeypatch.setattr(narwhal, "fetch_calendar", lambda *a, **k: pytest.fail("no call while off"))
    assert loop.run_once() == {"skipped": True}


def test_loop_without_key_sends_nothing(enabled, monkeypatch):
    monkeypatch.setattr("app.core.config.settings.NARWHAL_API_KEY", "")
    monkeypatch.setattr(narwhal, "fetch_calendar", lambda *a, **k: pytest.fail("no call without a key"))
    assert loop.run_once() == {"skipped": True}


def _fake_fetch(releases_by_call, seen):
    def fake(countries, start, end, **kw):
        seen.append((tuple(countries), start, end))
        res = narwhal.NarwhalResult()
        res.releases = releases_by_call.pop(0) if releases_by_call else []
        res.calls, res.balance = 1, 9.5
        return res
    return fake


def test_full_sync_then_checks_after_release(enabled, monkeypatch):
    db = enabled
    _stub_llm(monkeypatch)
    at = NOW - timedelta(minutes=3)
    seen = []
    published = [dict(v, actual=a) for v, a in zip(RETAIL, ("0.6", "0.4", "6.8"))]
    monkeypatch.setattr(narwhal, "fetch_calendar", _fake_fetch(
        [[_release("r1", at=at, values=RETAIL)],                           # 整页同步：还没公布 / not out yet
         [_release("r1", at=at, status="published", values=published)]],  # 补查：公布了 / re-check: out
        seen))
    monkeypatch.setattr(loop, "_last_full_sync", 0.0)
    out = loop.run_once()
    assert out["sync"]["seen"] == 1
    assert out["checks"] == {"checked": 1, "calls": 1}
    assert seen[0][1] == NOW.date() - timedelta(days=1) and seen[0][2] == NOW.date() + timedelta(days=7)
    assert seen[1][1] == seen[1][2] == at.date()
    row = db.get(EconRelease, "r1")
    assert row.has_actual and row.check_stage == 0
    assert store.get_status()["balance"] == 9.5


def test_sync_range_fetches_only_the_picked_week(enabled, monkeypatch):
    db = enabled
    seen = []
    monkeypatch.setattr(narwhal, "fetch_calendar", _fake_fetch([[_release("r1", values=RETAIL)]], seen))
    start = date(2026, 11, 8)
    out = loop.sync_range(start, start + timedelta(days=6))
    assert out["sync"]["seen"] == 1 and seen[0][1:] == (start, date(2026, 11, 14))
    assert db.get(EconRelease, "r1") is not None and store.get_status()["balance"] == 9.5


def test_calendar_values_carry_per_row_importance(enabled):
    db = enabled
    store.upsert_releases(db, [_release("r1", values=RETAIL)], NOW)
    db.commit()
    g = admin_econ.econ_calendar(start=NOW.date(), days=1, minImportance=rules.LOW, db=db, admin=_admin(db))["items"][0]
    imp = {v["measure"]: v["importance"] for v in g["values"]}
    assert imp["retail_sales_mom"] == rules.HIGH and imp["retail_sales_yoy"] == rules.LOW


def test_check_stage_advances_while_actual_is_missing(enabled, monkeypatch):
    db = enabled
    at = NOW - timedelta(minutes=3)
    store.upsert_releases(db, [_release("r1", at=at, values=RETAIL)], NOW - timedelta(hours=1))
    db.commit()
    seen = []
    monkeypatch.setattr(narwhal, "fetch_calendar", _fake_fetch([[_release("r1", at=at, values=RETAIL)]], seen))
    cfg = store.get_settings(db)
    loop.run_checks(db, cfg, NOW)
    assert db.get(EconRelease, "r1").check_stage == 1
    # 下一档是 +5 分钟，现在才 +3，不查 / next stage is +5 min, not due at +3
    assert loop.due_checks(db, cfg, NOW) == []
    assert loop.due_checks(db, cfg, NOW + timedelta(minutes=2))[0].id == "r1"


def test_narwhal_error_is_recorded_not_raised(enabled, monkeypatch):
    def boom(*a, **k):
        raise narwhal.NarwhalError("Narwhal 额度已用完 / Narwhal credit exhausted")
    monkeypatch.setattr(narwhal, "fetch_calendar", boom)
    monkeypatch.setattr(loop, "_last_full_sync", 0.0)
    out = loop.run_once()
    assert "exhausted" in out["error"]
    assert "exhausted" in store.get_status()["lastError"]


def test_daily_cap_stops_previews(enabled, monkeypatch):
    db = enabled
    calls = []
    _stub_llm(monkeypatch, calls=calls)
    store.save_settings(db, {"dailyLlmCap": 1})
    store.upsert_releases(db, [_release("r1", values=RETAIL),
                               _release("r2", country="CAN", values=RETAIL)], NOW)
    db.commit()
    assert loop.run_previews(db, store.get_settings(db), NOW) == 1
    assert len(calls) == 1


# ---- 管理接口 / admin endpoints ----

def _admin(db):
    u = User(email="admin@t.co", password_hash="x", api_token="tok-admin", role="admin")
    db.add(u)
    db.commit()
    return u


def test_admin_calendar_groups_and_filters(enabled, monkeypatch):
    db = enabled
    _stub_llm(monkeypatch)
    store.upsert_releases(db, [
        _release("r1", values=RETAIL),
        _release("r2", name="Business inventories", values=[{"measure": "business_inventories_mom", "consensus": "0.1"}]),
        _release("low", country="GBR", at=NOW + timedelta(hours=5), name="House prices", family="housing",
                 values=[{"measure": "house_price_asking_mom"}]),
    ], NOW)
    db.commit()
    loop.run_previews(db, store.get_settings(db), NOW)
    admin = _admin(db)
    out = admin_econ.econ_calendar(start=NOW.date(), days=2, minImportance=rules.MEDIUM, db=db, admin=admin)
    assert [g["key"] for g in out["items"]] == ["USA|2026-11-20T15:00"]
    g = out["items"][0]
    assert g["importance"] == rules.HIGH and len(g["releases"]) == 2 and g["primaryMeasure"] == "retail_sales_mom"
    assert g["preview"]["status"] == "ok" and g["preview"]["content"]["title_zh"] == "美国10月零售销售"
    assert g["outcome"] is None
    everything = admin_econ.econ_calendar(start=NOW.date(), days=2, minImportance=rules.LOW, db=db, admin=admin)
    assert len(everything["items"]) == 2


def test_admin_settings_audit_and_validation(db_session):
    db = db_session
    admin = _admin(db)
    out = admin_econ.econ_save_settings(admin_econ.EconSettingsIn(enabled=True, countries=["usa", " gbr "]), db, admin)
    assert out["enabled"] is True and out["countries"] == ["USA", "GBR"]
    with pytest.raises(HTTPException):
        admin_econ.econ_save_settings(admin_econ.EconSettingsIn(countries=["  "]), db, admin)
    from app.models import AdminAuditLog
    assert db.query(AdminAuditLog).filter(AdminAuditLog.field == "setting:econ_calendar").count() == 1


def test_admin_router_requires_admin():
    from app.services.deps import require_admin
    assert any(d.dependency is require_admin for d in admin_econ.router.dependencies)


# ---- 手动整周生成 + 周五写下一整周 / admin week job + Friday covers next week ----

def test_week_job_writes_every_due_group_in_range_including_released(enabled, monkeypatch):
    db = enabled
    calls = []
    _stub_llm(monkeypatch, calls=calls)
    past = NOW - timedelta(days=1)
    store.upsert_releases(db, [
        _release("old", at=past, status="published", values=[dict(v, actual="0.1") for v in RETAIL]),
        _release("soon", country="CAN", values=RETAIL),
        _release("far", country="GBR", at=NOW + timedelta(days=20), values=RETAIL),   # 范围外 / out of range
    ], NOW)
    db.commit()
    lo = datetime.combine(NOW.date() - timedelta(days=2), datetime.min.time())
    job = loop.run_week_job(lo, lo + timedelta(days=7))
    assert job["total"] == 2 and job["done"] == 2 and job["running"] is False
    assert store.get_status()["weekJob"]["done"] == 2 and not loop.week_job_running()
    # 再跑一次全部命中缓存 / a second run is all cache hits
    assert loop.run_week_job(lo, lo + timedelta(days=7))["total"] == 0 and len(calls) == 2


def test_auto_loop_yields_while_week_job_runs(enabled, monkeypatch):
    db = enabled
    _stub_llm(monkeypatch)
    store.upsert_releases(db, [_release("r1", values=RETAIL)], NOW)
    db.commit()
    store.update_status(weekJob={"running": True, "startedAt": NOW.isoformat() + "Z"})
    assert loop.run_previews(db, store.get_settings(db), NOW) == 0
    # 30 分钟还没结束的当作已死 / a job older than 30 min counts as dead
    assert loop.run_previews(db, store.get_settings(db), NOW + timedelta(minutes=31)) == 1


def test_friday_horizon_covers_the_whole_next_week():
    fri = datetime(2026, 11, 20, 12, 0)            # 周五 / Friday
    assert previews.horizon_end(fri) == datetime(2026, 11, 30)   # 下周日 22 日开始，到 28 日周六结束 + 1 天余量
    wed = datetime(2026, 11, 18, 12, 0)
    assert previews.horizon_end(wed) == wed + timedelta(days=7)


def test_status_update_merges_other_workers_fields(monkeypatch):
    from app.services import shared_cache
    store.update_status(llmCalls=5, llmDay="x")
    store._status.clear()     # 模拟另一个 worker：本地副本是空的 / another worker with an empty local copy
    store.update_status(weekJob={"running": False})
    st = store.get_status()
    assert st["llmCalls"] == 5 and st["weekJob"] == {"running": False}


def test_admin_generate_week_rejects_a_second_job(enabled, monkeypatch):
    import asyncio as _asyncio
    monkeypatch.setattr(deepseek, "configured", lambda: True)
    store.update_status(weekJob={"running": True, "startedAt": store.utcnow().isoformat() + "Z"})
    with pytest.raises(HTTPException) as e:
        _asyncio.run(admin_econ.econ_generate_week(start=NOW.date(), days=7, admin=None))
    assert e.value.status_code == 409


# ---- DeepSeek 客户端：截断 / 空回复 / 限流都要重试 / client retries truncation, empty replies, 429 ----

class _Resp:
    def __init__(self, status=200, content="", finish="stop"):
        self.status_code = status
        self._p = {"model": "deepseek-flash", "usage": {"prompt_tokens": 10, "completion_tokens": 5},
                   "choices": [{"finish_reason": finish, "message": {"content": content}}]}
        self.text = ""

    def json(self):
        return self._p


def _script(monkeypatch, responses):
    sent = []

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append(json)
        return responses.pop(0)
    monkeypatch.setattr(deepseek.httpx, "post", fake_post)
    monkeypatch.setattr(deepseek.time, "sleep", lambda s: None)
    monkeypatch.setattr(deepseek.settings, "DEEPSEEK_API_KEY", "sk-test")
    return sent


def test_deepseek_truncated_reply_retries_with_double_budget(monkeypatch):
    sent = _script(monkeypatch, [_Resp(content="", finish="length"), _Resp(content='{"a": 1}')])
    reply = deepseek.chat_json("sys json", "u")
    assert reply.data == {"a": 1} and reply.tokens_out == 10
    assert sent[0]["max_tokens"] == deepseek.DEFAULT_MAX_TOKENS and sent[1]["max_tokens"] == 2 * deepseek.DEFAULT_MAX_TOKENS


def test_deepseek_empty_rate_limited_and_fenced_replies_recover(monkeypatch):
    _script(monkeypatch, [_Resp(content="   "), _Resp(status=429), _Resp(status=503),
                          _Resp(content='```json\n{"ok": true}\n```')])
    assert deepseek.chat_json("sys json", "u").data == {"ok": True}


def test_deepseek_gives_up_after_all_attempts_and_fails_fast_on_bad_key(monkeypatch):
    _script(monkeypatch, [_Resp(content="") for _ in range(deepseek.ATTEMPTS)])
    with pytest.raises(deepseek.DeepSeekError, match="empty reply"):
        deepseek.chat_json("sys json", "u")
    sent = _script(monkeypatch, [_Resp(status=401)])
    with pytest.raises(deepseek.DeepSeekError, match="key"):
        deepseek.chat_json("sys json", "u")
    assert len(sent) == 1


def test_week_job_retries_groups_that_failed_three_times(enabled, monkeypatch):
    db = enabled
    store.upsert_releases(db, [_release("r1", values=RETAIL)], NOW)
    db.commit()

    def boom(*a, **k):
        raise deepseek.DeepSeekError("empty reply")
    monkeypatch.setattr(deepseek, "chat_json", boom)
    for _ in range(3):
        previews.generate(db, "USA|2026-11-20T15:00", db.query(EconRelease).all(), NOW)
        db.commit()
    assert previews.due_groups(db, store.get_settings(db), NOW) == []   # 自动循环不再试 / auto loop gives up
    _stub_llm(monkeypatch)
    lo = datetime.combine(NOW.date(), datetime.min.time())
    assert loop.run_week_job(lo, lo + timedelta(days=1))["done"] == 1
