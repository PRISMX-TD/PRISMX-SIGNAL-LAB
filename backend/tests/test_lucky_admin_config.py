"""管理端按期（rev 46）：期的列表 / 新建 / 详情 / 修改 / 显示开关 / 奖品保存（两种模式）/ 结束 / 删除，
统计、审计与操作日志。
Admin, per round (rev 46): list / create / detail / update / visible / prize save (both modes) / end /
delete, plus stats, audit rows and the activity feed."""
import json
from datetime import timedelta

import pytest
from fastapi import FastAPI, HTTPException

from app.models import (AdminAuditLog, LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, LuckyTicketBatch, Ticket,
                        User, UserNotification)
from app.routers import lucky_wheel as router
from app.schemas import LuckyPrizeIn, LuckyPrizesIn, LuckyRoundIn, LuckyRoundPatch, LuckyVisibleIn
from app.services.deps import require_admin
from app.services.lucky import common


def _user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def admin(db_session):
    return _user(db_session, "admin@t.co", role="admin")


def P(**kw):
    base = dict(name="谢谢参与", kind="none", probPct=50.0)
    base.update(kw)
    return LuckyPrizeIn(**base)


def _create(db, admin, name="第一期", mode="prob", starts=-1, ends=72):
    now = common.utcnow()
    return router.admin_create_round(LuckyRoundIn(name=name, mode=mode, startsAt=now + timedelta(hours=starts),
                                                  endsAt=now + timedelta(hours=ends)), db, admin)


def _save(db, admin, rid, mode, prizes):
    return router.admin_save_prizes(rid, LuckyPrizesIn(mode=mode, prizes=prizes), db, admin)


def _audits(db, action):
    return [json.loads(a.new_value) for a in
            db.query(AdminAuditLog).filter(AdminAuditLog.field == f"lucky:{action}").order_by(AdminAuditLog.created_at)]


def test_admin_router_guards_itself():
    app = FastAPI()
    app.include_router(router.admin_router)
    routes = [r for r in app.routes if getattr(r, "dependant", None) is not None]
    assert routes
    for r in routes:
        assert require_admin in {d.call for d in r.dependant.dependencies}, r.path


def test_v1_endpoints_are_gone():
    paths = {(m, r.path) for r in router.admin_router.routes for m in r.methods}
    for gone in [("GET", "/admin/lucky-wheel/config"), ("PUT", "/admin/lucky-wheel/prizes"),
                 ("PATCH", "/admin/lucky-wheel/rounds/current"), ("POST", "/admin/lucky-wheel/rounds/current/end"),
                 ("PUT", "/admin/lucky-wheel/visible")]:
        assert gone not in paths


def test_create_round_shape_defaults_and_several_at_once(db_session, admin):
    a = _create(db_session, admin, name="  国庆场  ", mode="qty")
    assert set(a) == {"id", "name", "mode", "visible", "startsAt", "endsAt", "phase", "endedAt", "stats"}
    assert a["name"] == "国庆场" and a["mode"] == "qty" and a["visible"] is False and a["phase"] == "active"
    assert a["stats"] == {"issued": 0, "used": 0, "unused": 0, "pendingClaims": 0, "draws": 0}
    b = _create(db_session, admin, name="周末场")               # 多期可以并存 / rounds may overlap
    assert b["mode"] == "prob" and db_session.query(LuckyRound).count() == 2
    audit = _audits(db_session, "round_create")[0]
    assert audit["name"] == "国庆场" and audit["mode"] == "qty" and {"id", "startsAt", "endsAt"} <= set(audit)


def test_create_round_rejects_bad_input(db_session, admin):
    now = common.utcnow()
    with pytest.raises(HTTPException):
        _create(db_session, admin, ends=-2)
    with pytest.raises(HTTPException):        # 全是空格 / blank name
        router.admin_create_round(LuckyRoundIn(name="   ", mode="prob", startsAt=now,
                                               endsAt=now + timedelta(days=1)), db_session, admin)
    with pytest.raises(ValueError):
        LuckyRoundIn(name="x" * 41, mode="prob", startsAt=now, endsAt=now)
    with pytest.raises(ValueError):
        LuckyRoundIn(name="x", mode="both", startsAt=now, endsAt=now)


def test_list_orders_unended_then_ended_with_stats(db_session, admin):
    old = _create(db_session, admin, name="早", starts=-5)
    new = _create(db_session, admin, name="晚", starts=-1)
    gone = _create(db_session, admin, name="结束了", starts=-10)
    router.admin_end_round(gone["id"], db_session, admin)
    u = _user(db_session, "u@t.co")
    db_session.add_all([LuckyTicket(user_id=u.id, round_id=new["id"], source="manual"),
                        LuckyTicket(user_id=u.id, round_id=new["id"], source="manual", status="used"),
                        LuckyTicket(user_id=u.id, round_id=new["id"], source="manual", status="revoked")])
    db_session.commit()
    out = router.admin_list_rounds(db_session, admin)["rounds"]
    assert [r["name"] for r in out] == ["晚", "早", "结束了"]
    assert out[0]["stats"] == {"issued": 3, "used": 1, "unused": 1, "pendingClaims": 0, "draws": 0}
    assert out[2]["phase"] == "ended" and out[2]["endedAt"] is not None and old["id"]


def test_get_round_detail_and_404(db_session, admin):
    r = _create(db_session, admin)
    _save(db_session, admin, r["id"], "prob", [P(name="A"), P(name="B")])
    out = router.admin_get_round(r["id"], db_session, admin)
    assert out["round"]["id"] == r["id"] and [p["name"] for p in out["prizes"]] == ["A", "B"]
    assert set(out["prizes"][0]) == {"id", "name", "description", "imageUrl", "color", "kind", "proDays", "probBp",
                                     "stock", "stockUsed", "claimMode", "claimHint"}
    with pytest.raises(HTTPException) as e:
        router.admin_get_round("missing", db_session, admin)
    assert e.value.status_code == 404


def test_patch_name_and_moving_end_into_past_ends_and_voids(db_session, admin):
    now = common.utcnow()
    r = _create(db_session, admin, starts=-24)
    u = _user(db_session, "u@t.co")
    db_session.add_all([LuckyTicket(user_id=u.id, round_id=r["id"], source="manual"),
                        LuckyTicket(user_id=u.id, round_id=r["id"], source="manual", status="used")])
    db_session.commit()
    out = router.admin_update_round(r["id"], LuckyRoundPatch(name="改名了"), db_session, admin)
    assert out["name"] == "改名了" and out["voided"] == 0
    out = router.admin_update_round(r["id"], LuckyRoundPatch(endsAt=now - timedelta(minutes=1)), db_session, admin)
    assert out["phase"] == "ended" and out["voided"] == 1
    assert sorted(t.status for t in db_session.query(LuckyTicket)) == ["used", "voided"]
    assert _audits(db_session, "round_update")[-1]["name"] == "改名了"
    with pytest.raises(HTTPException) as e:                    # 已结束不能再改 / ended → 409
        router.admin_update_round(r["id"], LuckyRoundPatch(name="再改"), db_session, admin)
    assert e.value.status_code == 409


def test_extending_end_keeps_round_open(db_session, admin):
    now = common.utcnow()
    r = _create(db_session, admin)
    out = router.admin_update_round(r["id"], LuckyRoundPatch(endsAt=now + timedelta(days=9)), db_session, admin)
    assert out["phase"] == "active"


def test_start_changes_only_while_upcoming(db_session, admin):
    now = common.utcnow()
    r = _create(db_session, admin)
    with pytest.raises(HTTPException):
        router.admin_update_round(r["id"], LuckyRoundPatch(startsAt=now + timedelta(hours=2)), db_session, admin)
    up = _create(db_session, admin, name="下期", starts=5)
    out = router.admin_update_round(up["id"], LuckyRoundPatch(startsAt=now + timedelta(hours=10)), db_session, admin)
    assert out["phase"] == "upcoming"


def test_end_now_and_twice_is_409(db_session, admin):
    r = _create(db_session, admin)
    out = router.admin_end_round(r["id"], db_session, admin)
    assert out["phase"] == "ended" and out["voided"] == 0
    assert _audits(db_session, "round_end")[-1] == {"id": r["id"], "name": "第一期", "voided": 0}
    with pytest.raises(HTTPException) as e:
        router.admin_end_round(r["id"], db_session, admin)
    assert e.value.status_code == 409


def test_visible_toggle_audits_and_ended_round_is_409(db_session, admin):
    r = _create(db_session, admin)
    out = router.admin_set_visible(r["id"], LuckyVisibleIn(visible=True), db_session, admin, background_tasks=None)
    assert out["visible"] is True and db_session.get(LuckyRound, r["id"]).visible is True
    assert _audits(db_session, "visible")[-1] == {"id": r["id"], "name": "第一期", "visible": True}
    router.admin_end_round(r["id"], db_session, admin)
    with pytest.raises(HTTPException) as e:
        router.admin_set_visible(r["id"], LuckyVisibleIn(visible=False), db_session, admin, background_tasks=None)
    assert e.value.status_code == 409


# ---- 奖品 / prizes ----

def test_prob_save_validates_total_and_audits(db_session, admin):
    r = _create(db_session, admin)
    with pytest.raises(HTTPException) as e:
        _save(db_session, admin, r["id"], "prob", [P(probPct=40), P(probPct=40)])
    assert e.value.status_code == 422
    with pytest.raises(HTTPException):                          # 没填概率 = 0，合计不够 / missing odds
        _save(db_session, admin, r["id"], "prob", [P(probPct=None), P(probPct=50)])
    out = _save(db_session, admin, r["id"], "prob",
                [P(name="7 天 PRO", kind="pro_days", proDays=7, probPct=10.5, stock=3), P(probPct=89.5)])
    assert [p["probBp"] for p in out["prizes"]] == [1050, 8950]
    assert [p["stock"] for p in out["prizes"]] == [3, None]
    assert out["round"]["mode"] == "prob"
    (audit,) = _audits(db_session, "prizes")
    assert audit["roundId"] == r["id"] and audit["roundName"] == "第一期" and audit["mode"] == "prob"


def test_qty_save_requires_stock_and_stores_no_odds(db_session, admin):
    r = _create(db_session, admin, mode="qty")
    with pytest.raises(HTTPException) as e:
        _save(db_session, admin, r["id"], "qty", [P(stock=3), P()])            # 第二格没份数
    assert e.value.status_code == 422
    with pytest.raises(HTTPException):
        _save(db_session, admin, r["id"], "qty", [P(stock=0), P(stock=0)])     # 合计 0
    out = _save(db_session, admin, r["id"], "qty", [P(name="A", stock=3, probPct=77), P(name="B", stock=0)])
    assert [(p["stock"], p["probBp"]) for p in out["prizes"]] == [(3, 0), (0, 0)]


def test_mode_switch_allowed_before_draws_and_409_after(db_session, admin):
    r = _create(db_session, admin)
    _save(db_session, admin, r["id"], "prob", [P(name="A"), P(name="B")])
    out = _save(db_session, admin, r["id"], "qty", [P(name="A", stock=2), P(name="B", stock=1)])
    assert out["round"]["mode"] == "qty"
    u = _user(db_session, "u@t.co")
    p = db_session.query(LuckyPrize).filter(LuckyPrize.archived.is_(False)).first()
    t = LuckyTicket(user_id=u.id, round_id=r["id"], source="manual", status="used")
    db_session.add(t)
    db_session.flush()
    db_session.add(LuckyDraw(user_id=u.id, round_id=r["id"], ticket_id=t.id, prize_id=p.id, prize_snapshot="{}",
                             request_id="d-1", fulfillment_status="auto_done"))
    db_session.commit()
    with pytest.raises(HTTPException) as e:
        _save(db_session, admin, r["id"], "prob", [P(name="A"), P(name="B")])
    assert e.value.status_code == 409
    _save(db_session, admin, r["id"], "qty", [P(name="A", stock=5), P(name="B", stock=1)])   # 同模式照改 / same mode ok


def test_save_archives_missing_within_the_round_only(db_session, admin):
    r1, r2 = _create(db_session, admin), _create(db_session, admin, name="二期")
    a_id = _save(db_session, admin, r1["id"], "prob", [P(name="A"), P(name="B")])["prizes"][0]["id"]
    _save(db_session, admin, r2["id"], "prob", [P(name="X"), P(name="Y")])
    out = _save(db_session, admin, r1["id"], "prob", [P(id=a_id, name="A2", probPct=100), P(name="C", probPct=0)])
    assert out["prizes"][0]["id"] == a_id and out["prizes"][0]["name"] == "A2"
    archived = db_session.query(LuckyPrize).filter(LuckyPrize.archived.is_(True)).all()
    assert [p.name for p in archived] == ["B"] and archived[0].round_id == r1["id"]
    assert [p["name"] for p in router.admin_get_round(r2["id"], db_session, admin)["prizes"]] == ["X", "Y"]
    with pytest.raises(HTTPException) as e:                    # 别的期的格 id 不认 / foreign slot id
        _save(db_session, admin, r2["id"], "prob", [P(id=a_id, name="A"), P(name="Y")])
    assert e.value.status_code == 404


def test_stock_cannot_drop_below_used(db_session, admin):
    r = _create(db_session, admin, mode="qty")
    out = _save(db_session, admin, r["id"], "qty", [P(name="A", kind="retry", stock=5), P(stock=1)])
    p = db_session.get(LuckyPrize, out["prizes"][0]["id"])
    p.stock_used = 4
    db_session.commit()
    with pytest.raises(HTTPException) as e:
        _save(db_session, admin, r["id"], "qty", [P(id=p.id, name="A", kind="retry", stock=3), P(stock=1)])
    assert e.value.status_code == 400
    out = _save(db_session, admin, r["id"], "qty", [P(id=p.id, name="A", kind="retry", stock=4), P(stock=1)])
    assert out["prizes"][0]["stockUsed"] == 4


def test_stock_floor_uses_fresh_used_count_not_the_cached_one(db_session, admin):
    """会话里已缓存的奖项（路由先读一遍做审计快照）不能拿来比份数下限：另一个事务（开奖）刚把已发出数
    加上去，保存要按最新值拒绝。
    The prize rows cached in the session (the router reads them first for the audit snapshot) must
    not drive the stock floor: a spin in another transaction just bumped stock_used, and the save must
    see it."""
    from sqlalchemy.orm import Session

    r = _create(db_session, admin, mode="qty")
    out = _save(db_session, admin, r["id"], "qty", [P(name="A", kind="retry", stock=5), P(stock=1)])
    pid = out["prizes"][0]["id"]
    cached = db_session.get(LuckyPrize, pid)   # 持有引用，身份映射里留着旧值 / hold it so the identity map keeps the old value
    assert cached.stock_used == 0
    other = Session(bind=db_session.get_bind())
    other.get(LuckyPrize, pid).stock_used = 4
    other.commit()
    other.close()
    assert cached.stock_used == 0   # 本会话里仍是旧值 / still stale in this session
    with pytest.raises(HTTPException) as e:
        _save(db_session, admin, r["id"], "qty", [P(id=pid, name="A", kind="retry", stock=3), P(stock=1)])
    assert e.value.status_code == 400


def test_prizes_of_an_ended_round_are_frozen(db_session, admin):
    r = _create(db_session, admin)
    router.admin_end_round(r["id"], db_session, admin)
    with pytest.raises(HTTPException) as e:
        _save(db_session, admin, r["id"], "prob", [P(), P()])
    assert e.value.status_code == 409


def test_prize_save_audit_records_money_fields_before_and_after(db_session, admin):
    """最终评审 I3：保存奖项的审计要带上会动钱的字段（天数、份数、概率、领取方式……）和改动前 / 后，
    以及被下架的格子。
    Final review I3: the prize-save audit carries the money-moving fields with before / after, plus archives."""
    r = _create(db_session, admin)
    out = _save(db_session, admin, r["id"], "prob",
                [P(name="A", kind="pro_days", proDays=7, probPct=50, stock=3), P(name="B", probPct=50)])
    a_id, b_id = (p["id"] for p in out["prizes"])
    first = _audits(db_session, "prizes")[-1]
    assert [c["before"] for c in first["changes"]] == [None, None]          # 新建 / created
    assert first["prizes"][0]["proDays"] == 7 and first["prizes"][0]["stock"] == 3

    _save(db_session, admin, r["id"], "prob",
          [P(id=a_id, name="A", kind="pro_days", proDays=30, probPct=50, stock=5), P(id=b_id, name="B", probPct=50)])
    payload = [x for x in _audits(db_session, "prizes") if x["changes"] and x["changes"][0]["before"] is not None][-1]
    assert [c["id"] for c in payload["changes"]] == [a_id]                  # B 没动不记 / unchanged B is skipped
    ch = payload["changes"][0]
    assert ch["before"]["proDays"] == 7 and ch["after"]["proDays"] == 30
    assert ch["before"]["stock"] == 3 and ch["after"]["stock"] == 5
    assert {"imageUrl", "claimMode", "sortOrder", "active", "probBp"} <= set(ch["after"])
    assert not ({"perUserLimit", "onSoldOut", "stockUsed"} & set(ch["after"]))
    assert payload["archived"] == []

    _save(db_session, admin, r["id"], "prob",
          [P(id=a_id, name="A", kind="pro_days", proDays=30, probPct=100, stock=5), P(name="C", probPct=0)])
    last = [x for x in _audits(db_session, "prizes") if x["archived"]][-1]
    assert [x["id"] for x in last["archived"]] == [b_id]


# ---- 删除 / delete ----

def _populate(db, admin, rid):
    """一期里造齐 5 类行，外加一张客服工单、一条站内通知、一次 PRO 天数。
    Fill a round with all 5 row kinds, plus a support ticket, a feed row and PRO days."""
    u = _user(db, "winner@t.co")
    u.plan, u.plan_expires_at = "PRO", common.utcnow() + timedelta(days=7)
    p = LuckyPrize(round_id=rid, sort_order=0, name="手表", kind="custom", claim_mode="ticket", prob_bp=10000)
    b = LuckyTicketBatch(round_id=rid, reason="测试", created_by=admin.id, request_id="del-batch-1")
    st = Ticket(user_id=u.id, title="幸运轮盘奖品领取：手表", category="claim", priority="normal", status="open")
    db.add_all([p, b, st])
    db.flush()
    t1 = LuckyTicket(user_id=u.id, round_id=rid, batch_id=b.id, source="manual", status="used")
    t2 = LuckyTicket(user_id=u.id, round_id=rid, batch_id=b.id, source="manual")
    db.add_all([t1, t2])
    db.flush()
    db.add(LuckyDraw(user_id=u.id, round_id=rid, ticket_id=t1.id, prize_id=p.id, prize_snapshot="{}",
                     request_id="del-d-1", fulfillment_status="submitted", support_ticket_id=st.id))
    db.add(UserNotification(user_id=u.id, kind="lucky_ticket", text="×2 · 测试", link="/lucky", ref_id=b.id))
    db.commit()
    return u, st


def test_delete_round_hard_deletes_its_rows_and_keeps_pro_and_tickets(db_session, admin):
    keep = _create(db_session, admin, name="别动我")
    keep_prize = LuckyPrize(round_id=keep["id"], sort_order=0, name="K", kind="none", prob_bp=10000)
    db_session.add(keep_prize)
    db_session.commit()
    r = _create(db_session, admin, name="要删的")
    u, st = _populate(db_session, admin, r["id"])
    expires = u.plan_expires_at
    out = router.admin_delete_round(r["id"], db_session, admin)
    assert out == {"deleted": {"draws": 1, "tickets": 2, "batches": 1, "prizes": 1}}
    db_session.expire_all()
    assert db_session.get(LuckyRound, r["id"]) is None
    for model in (LuckyDraw, LuckyTicket, LuckyTicketBatch):
        assert db_session.query(model).count() == 0
    assert [p.id for p in db_session.query(LuckyPrize)] == [keep_prize.id]     # 别的期不受影响 / other round kept
    assert db_session.get(LuckyRound, keep["id"]) is not None
    assert db_session.get(Ticket, st.id) is not None                          # 工单还在 / ticket stays
    assert db_session.get(User, u.id).plan_expires_at == expires              # PRO 不撤回 / PRO kept
    assert db_session.query(UserNotification).count() == 1                    # 通知不撤回 / feed row kept
    (audit,) = _audits(db_session, "round_delete")
    assert audit == {"id": r["id"], "name": "要删的", "draws": 1, "tickets": 2, "batches": 1, "prizes": 1}
    with pytest.raises(HTTPException) as e:
        router.admin_delete_round(r["id"], db_session, admin)
    assert e.value.status_code == 404


def test_activity_feed_renders_round_delete_and_names(db_session, admin):
    """操作日志：lucky 族新动作 round_delete 照样是 admin.lucky，期名在 params 里。
    The activity log shows the new round_delete as admin.lucky with the round name in params."""
    from app.services import activity_feed as feed

    r = _create(db_session, admin, name="要删的")
    router.admin_set_visible(r["id"], LuckyVisibleIn(visible=True), db_session, admin, background_tasks=None)
    router.admin_delete_round(r["id"], db_session, admin)
    # 测试里三步共用一个会话 = 同一个 op_id，会并成一条；真实请求各是一个会话。这里拆开、时间拉开
    # The three calls share one session (= one op_id) here and would merge; real requests each get their own
    base = common.utcnow() - timedelta(minutes=5)
    for i, a in enumerate(db_session.query(AdminAuditLog).filter(AdminAuditLog.field.like("lucky:%"))
                          .order_by(AdminAuditLog.created_at, AdminAuditLog.id)):
        a.created_at, a.op_id = base + timedelta(seconds=30 * i), f"op-{i}"
    db_session.commit()
    items = [i for i in feed.list_activity(db_session)["items"] if i["kind"] != "user.register"]
    by_action = {i["params"]["action"]: i for i in items}
    assert {"round_create", "visible", "round_delete"} <= set(by_action)
    d = by_action["round_delete"]
    assert d["kind"] == "admin.lucky" and d["actor"]["type"] == "admin"
    assert d["params"]["name"] == "要删的" and d["params"]["draws"] == 0 and d["params"]["prizes"] == 0
    assert by_action["round_create"]["params"]["mode"] == "prob"
    assert by_action["visible"]["params"]["name"] == "要删的"
