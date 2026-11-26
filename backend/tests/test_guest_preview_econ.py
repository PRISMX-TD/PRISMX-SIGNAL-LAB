"""游客预览的「今日财经」卡（2026-11-26）：GET /public/preview/econ。

和登录用户同一份日历，但预案正文不出服务器，只留「有预案」的标记；预览开关关着是 404，
日历「对用户开放」关着返回 public=False。
The guest preview's calendar card: the same calendar as signed-in users, but preview text never
leaves the server (only the "has a preview" marker); 404 with the preview switch off, public=False
with "open to users" off.
"""
from datetime import timedelta

from app.models import EconRelease
from app.routers import econ
from app.services.econ import loop, store
from tests.test_econ_calendar import NOW, RETAIL, _release, _stub_llm, enabled  # noqa: F401
from tests.test_guest_preview import _client, _switch


def test_guest_calendar_card(enabled, monkeypatch):  # noqa: F811
    db = enabled
    _stub_llm(monkeypatch)
    monkeypatch.setattr(store, "utcnow", lambda: NOW)
    econ.clear_cache()
    store.upsert_releases(db, [
        _release("r1", values=RETAIL),
        _release("low", at=NOW + timedelta(hours=5), name="Some minor survey", family="survey"),
    ], NOW)
    db.commit()
    loop.run_previews(db, store.get_settings(db), NOW)
    db.commit()
    client = _client(db)

    # 预览开关关着：404 / preview switch off: 404
    assert client.get("/api/public/preview/econ").status_code == 404

    _switch(db, True)
    r = client.get("/api/public/preview/econ")
    assert r.status_code == 200
    body = r.json()
    assert body["public"] is True and body["days"] == 10
    by_key = {g["key"]: g for g in body["items"]}
    retail = by_key["USA|2026-11-20T15:00|retail-sales"]
    # 预案只有标记，正文不出服务器 / marker only, no preview text
    assert retail["preview"] == {"status": "ok"}
    assert "title_zh" not in r.text
    # 只要橙红两级 / orange and red only
    assert all(g["importance"] >= 2 for g in body["items"])
    assert db.query(EconRelease).count() == 2

    store.save_settings(db, {"public": False})
    db.commit()
    econ.clear_cache()
    db.connection()   # 提交后重新绑定连接，测试客户端在别的线程里用同一个内存库 / rebind after commit
    closed = client.get("/api/public/preview/econ").json()
    assert closed["public"] is False and closed["items"] == []
