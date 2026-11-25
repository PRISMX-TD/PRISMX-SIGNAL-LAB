"""公布时间还没到就带公布值的发布（2026-11-25）：按未公布入库，数字全丢，旧预案删掉，
真正公布后照常拿到公布值、补查和提醒都不受影响。
Releases carrying figures before their release time are stored as not yet published: figures
dropped, stale previews removed, and the real release still comes through normally."""
import json
from datetime import datetime, timedelta

from app.models import EconPreview, EconRelease
from app.services.econ import loop, previews, store

NOW = datetime(2026, 11, 22, 0, 40)
AT = datetime(2026, 11, 25, 13, 30)

# Narwhal 11-22 给的样子：美国 Q3 GDP 第二次估值，标成已公布，公布值是首次估值
# What Narwhal sent on 11-22: the US Q3 GDP second estimate, marked published with the advance figure
STALE = [
    {"measure": "gdp_qoq", "concept": "gdp", "unit": "percent", "transformation": "quarter_over_quarter",
     "actual": "3.4", "consensus": "3.4", "previous": "2.2", "provisional": True},
    {"measure": "gdp_deflator_qoq", "unit": "percent", "transformation": "quarter_over_quarter",
     "actual": "2.2", "consensus": "2.2", "previous": "6.1", "provisional": True},
]


def _gdp(status="published", values=None, at=AT, rid="gdp-q3"):
    return {"release_id": rid, "revision": 1, "country": "USA", "series_id": "usa-gdp", "name": "GDP",
            "family": "gdp", "status": status, "at": at.strftime("%Y-%m-%dT%H:%M:%SZ"), "period": "2026-Q3",
            "values": STALE if values is None else values}


def _row(db, rid="gdp-q3") -> EconRelease:
    return db.query(EconRelease).filter(EconRelease.id == rid).one()


def test_future_published_row_is_stored_as_scheduled_without_numbers(db_session):
    stats = store.upsert_releases(db_session, [_gdp()], NOW)
    db_session.commit()
    row = _row(db_session)
    assert stats["premature"] == 1 and stats["newActuals"] == 0 and stats["actualGroups"] == []
    assert row.status == "scheduled" and row.has_actual is False and row.actual_seen_at is None
    vals = store.values_of(row)
    assert [v["measure"] for v in vals] == ["gdp_qoq", "gdp_deflator_qoq"]
    for v in vals:
        assert not {"actual", "consensus", "previous", "provisional"} & set(v)
    # 指标还在，所以仍是红色、仍会被公布后补查 / measures stay: still red, still re-checked
    assert row.importance == 3 and row.values_json != "[]"


def test_actual_without_published_status_is_also_caught(db_session):
    store.upsert_releases(db_session, [_gdp(status="scheduled")], NOW)
    db_session.commit()
    assert _row(db_session).has_actual is False


def test_already_stored_bad_row_is_repaired_on_next_sync(db_session):
    # 修复前的入库结果：已公布、带数字 / how the row looked before the fix
    db_session.add(EconRelease(id="gdp-q3", country="USA", name="GDP", family="gdp", status="published",
                               at=AT, values_json=json.dumps(STALE), importance=3, has_actual=True,
                               actual_seen_at=NOW, group_key=store.group_key("USA", AT, "gdp", "GDP")))
    db_session.commit()
    store.upsert_releases(db_session, [_gdp()], NOW + timedelta(days=3))
    db_session.commit()
    row = _row(db_session)
    assert row.status == "scheduled" and row.has_actual is False and row.actual_seen_at is None


def test_grace_window_and_real_release_are_untouched(db_session):
    # 公布前 5 分钟以内（时钟差）或已过公布时间：照常收 / within 5 min of release or after it: accepted
    store.upsert_releases(db_session, [_gdp(rid="a")], AT - timedelta(minutes=4))
    store.upsert_releases(db_session, [_gdp(rid="b")], AT + timedelta(minutes=2))
    db_session.commit()
    for rid in ("a", "b"):
        row = _row(db_session, rid)
        assert row.status == "published" and row.has_actual is True


def test_real_release_after_premature_one_counts_as_new_actual(db_session):
    store.upsert_releases(db_session, [_gdp()], NOW)
    db_session.commit()
    real = [dict(STALE[0], actual="3.6", consensus="3.5", previous="3.4")]
    stats = store.upsert_releases(db_session, [_gdp(values=real)], AT + timedelta(minutes=2))
    db_session.commit()
    row = _row(db_session)
    assert stats["newActuals"] == 1 and stats["actualGroups"] == [row.group_key]
    assert row.status == "published" and row.actual_seen_at == AT + timedelta(minutes=2)


def test_premature_row_is_picked_up_by_post_release_checks(db_session):
    store.upsert_releases(db_session, [_gdp()], NOW)
    db_session.commit()
    cfg = store.get_settings(db_session)
    due = loop.due_checks(db_session, cfg, AT + timedelta(minutes=3))
    assert [r.id for r in due] == ["gdp-q3"]


def test_stale_preview_is_dropped_but_matching_one_kept(db_session):
    key = store.group_key("USA", AT, "gdp", "GDP")
    # 按旧预期 3.4 写的预案 / preview written against the stale 3.4 consensus
    db_session.add(EconPreview(group_key=key, country="USA", at=AT, status="ok", content_json="{}",
                               consensus_sig="v3|consensus|gdp_qoq=3.4"))
    db_session.commit()
    stats = store.upsert_releases(db_session, [_gdp()], NOW)
    db_session.commit()
    assert stats["stalePreviewsDropped"] == 1
    assert db_session.query(EconPreview).filter(EconPreview.group_key == key).count() == 0

    # 签名和现状一致的不删（否则每轮同步都会删了重写）/ a matching one stays
    rows = db_session.query(EconRelease).filter(EconRelease.group_key == key).all()
    basis, _ = previews.group_basis("USA", rows)
    db_session.add(EconPreview(group_key=key, country="USA", at=AT, status="ok", content_json="{}",
                               consensus_sig=previews._signature(basis, rows)))
    db_session.commit()
    stats = store.upsert_releases(db_session, [_gdp()], NOW + timedelta(hours=1))
    db_session.commit()
    assert stats.get("stalePreviewsDropped") == 0
    assert db_session.query(EconPreview).filter(EconPreview.group_key == key).count() == 1


def test_cancelled_future_row_keeps_its_status(db_session):
    store.upsert_releases(db_session, [_gdp(status="cancelled", values=[])], NOW)
    db_session.commit()
    assert _row(db_session).status == "cancelled"
