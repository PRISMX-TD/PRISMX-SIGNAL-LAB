"""财经日历红色数据提醒（rev 54）：公布前 30 分钟推一次、同一时刻合成一条、开关、通知偏好白名单、迁移。
不发任何外部请求：推送打桩。
Red economic-release alerts (rev 54): one push 30 minutes ahead, one message per moment, the switches,
the notification whitelist and the migration. No outbound request: the push is stubbed."""
import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod
from app.models import EconPreview, EconRelease, NotificationPref, User
from app.services import push_dispatch
from app.services.econ import loop, rules, store

NOW = datetime(2026, 11, 23, 13, 0)


def _row(rid, at, importance=rules.HIGH, country="USA", name="Nonfarm payrolls", status="scheduled", key=None):
    return EconRelease(id=rid, country=country, currency=rules.CURRENCY.get(country), name=name, status=status,
                       at=at, importance=importance, values_json="[]",
                       group_key=key or f"{country}|{at:%Y-%m-%dT%H:%M}|{rid}")


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake(event_type, title, body, url, tag):
        calls.append({"event": event_type, "title": title, "body": body, "url": url, "tag": tag})
        return 1

    monkeypatch.setattr(push_dispatch, "dispatch_broadcast_push", fake)
    store._status.clear()
    return calls


def _cfg(db, **patch):
    store.save_settings(db, {"enabled": True, **patch})
    db.commit()
    return store.get_settings(db)


def test_red_release_within_30_minutes_is_pushed_once_and_merged_by_moment(db_session, sent):
    at = NOW + timedelta(minutes=25)
    db_session.add_all([
        _row("nfp", at), _row("ur", at, name="Unemployment rate"),
        _row("cad", at, country="CAN", name="Labour force survey"),
        _row("orange", at, importance=rules.MEDIUM, name="Average hourly earnings"),
    ])
    db_session.add(EconPreview(group_key=f"USA|{at:%Y-%m-%dT%H:%M}|nfp", country="USA", at=at, status="ok",
                               content_json=json.dumps({"title_zh": "美国11月非农就业"})))
    db_session.commit()
    cfg = _cfg(db_session)

    out = loop.run_alerts(db_session, cfg, NOW)
    assert out == {"moments": 1, "sent": 1}
    assert len(sent) == 1
    msg = sent[0]
    assert msg["event"] == push_dispatch.EVENT_ECON_ALERT
    assert msg["title"] == "高影响数据 25 分钟后公布"
    # 有预案用中文标题，没有就用英文名；橙色不进 / preview title when present, English otherwise; orange left out
    assert sorted(msg["body"].split("、")) == sorted(
        ["USD 美国11月非农就业", "USD Unemployment rate", "CAD Labour force survey"])
    assert msg["url"].startswith("/calendar?day=2026-11-23&focus=")
    assert all(r.alert_sent_at == NOW for r in db_session.query(EconRelease).filter(EconRelease.importance == 3))
    assert db_session.get(EconRelease, "orange").alert_sent_at is None

    # 下一轮不再推 / the next pass sends nothing
    assert loop.run_alerts(db_session, cfg, NOW + timedelta(seconds=30)) == {"sent": 0}
    assert len(sent) == 1


def test_window_and_status_limits(db_session, sent):
    db_session.add_all([
        _row("far", NOW + timedelta(minutes=45)),                     # 太早 / too early
        _row("now", NOW + timedelta(minutes=1)),                      # 不到 2 分钟，不推了 / under 2 min
        _row("done", NOW + timedelta(minutes=10), status="published"),
        _row("other", NOW + timedelta(minutes=10), country="BRA"),   # 不在关注国家 / not watched
    ])
    db_session.commit()
    assert loop.run_alerts(db_session, _cfg(db_session), NOW) == {"sent": 0}
    assert sent == []


def test_more_than_three_items_are_summarised(db_session, sent):
    at = NOW + timedelta(minutes=20)
    db_session.add_all([_row(f"r{i}", at, name=f"Item {i}") for i in range(5)])
    db_session.commit()
    loop.run_alerts(db_session, _cfg(db_session), NOW)
    assert sent[0]["body"].endswith("等 5 项")


def test_separate_moments_get_separate_pushes(db_session, sent):
    db_session.add_all([_row("a", NOW + timedelta(minutes=10)), _row("b", NOW + timedelta(minutes=30))])
    db_session.commit()
    out = loop.run_alerts(db_session, _cfg(db_session), NOW)
    assert out["moments"] == 2 and len(sent) == 2
    assert sent[0]["tag"] != sent[1]["tag"]


@pytest.mark.parametrize("patch", [{"alerts": False}, {"public": False}])
def test_switches_turn_alerts_off(db_session, sent, patch):
    db_session.add(_row("a", NOW + timedelta(minutes=10)))
    db_session.commit()
    assert loop.run_alerts(db_session, _cfg(db_session, **patch), NOW) == {"sent": 0}
    assert sent == [] and db_session.get(EconRelease, "a").alert_sent_at is None


def test_alerts_setting_defaults_on_and_round_trips(db_session):
    assert store.get_settings(db_session)["alerts"] is True
    assert store.save_settings(db_session, {"alerts": False})["alerts"] is False


def test_econ_alert_follows_the_event_whitelist(db_session, monkeypatch):
    monkeypatch.setattr(push_dispatch, "can_use_push", lambda *a: True)
    for uid, events in (("never", None), ("kept", json.dumps(["strategy_signal", "econ_alert"])),
                        ("off", json.dumps(["strategy_signal"]))):
        db_session.add(User(id=uid, email=f"{uid}@t.co", api_token=f"tok-{uid}", plan="PRO"))
        db_session.add(NotificationPref(user_id=uid, enabled=True, event_types=events))
    db_session.commit()
    allowed = push_dispatch._bulk_prefs_allow(db_session, ["never", "kept", "off"], push_dispatch.EVENT_ECON_ALERT)
    assert allowed == ["never", "kept"]
    assert push_dispatch.EVENT_ECON_ALERT not in push_dispatch.ALWAYS_ON_EVENTS


@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    from app.core.database import Base
    import app.models  # noqa: F401
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE econ_releases DROP COLUMN alert_sent_at"))
    session = sessionmaker(bind=eng)()
    for uid, events in (("never", None), ("set", '["strategy_signal"]'), ("none", "[]"), ("bad", "nope")):
        session.add(User(id=uid, email=f"{uid}@t.co", api_token=f"tok-{uid}"))
        session.add(NotificationPref(id=f"p-{uid}", user_id=uid, enabled=True, event_types=events))
    session.commit()
    session.close()
    monkeypatch.setattr(db_mod, "engine", eng)
    return eng


def _events(eng):
    with eng.connect() as conn:
        return dict(conn.execute(text("SELECT user_id, event_types FROM notification_prefs")).fetchall())


def test_rev54_migration_adds_the_column_and_opts_stored_whitelists_in_once(legacy_engine):
    db_mod._migrate_econ_alerts_rev54(53, "DATETIME")
    assert "alert_sent_at" in {c["name"] for c in inspect(legacy_engine).get_columns("econ_releases")}
    ev = _events(legacy_engine)
    assert ev["never"] is None
    assert json.loads(ev["set"]) == ["strategy_signal", "econ_alert"]
    assert json.loads(ev["none"]) == ["econ_alert"]
    assert ev["bad"] == "nope"

    # 用户之后自己关掉，再次启动（版本已是 54）不会被打开 / a later opt-out survives the next boot
    with legacy_engine.begin() as conn:
        conn.execute(text("UPDATE notification_prefs SET event_types = '[]' WHERE user_id = 'set'"))
    db_mod._migrate_econ_alerts_rev54(54, "DATETIME")
    assert _events(legacy_engine)["set"] == "[]"
