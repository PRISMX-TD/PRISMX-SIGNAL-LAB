"""管理员审计缺口（设计 2026-10-09 §4.2 最后两行）：游戏化设置与工单处理以前不留痕。

  · 游戏化 PATCH /visibility、/settings → 每个真变了的键一行 `gamification:<存储键>`，值是
    json.dumps 的旧 / 新值；同一请求的几行共用一个 op_id；没变的不写；拿不到管理员身份
    （直接调路由函数）照常保存、不写审计。
  · 工单状态 / 优先级 / 回复 → `ticket:<id>:status` / `:priority` / `:reply`，目标用户是工单
    提交者；回复只留开头 60 字；只发图片的回复也算一条；没变的不写；工单不存在不写。

Admin audit gaps: gamification settings and ticket handling used to leave no
trace. Pins the field names, json-encoded values, op_id grouping, the 60-char
reply excerpt, image-only replies, and no row for no-ops or failures.
"""
import json

import pytest
from fastapi import HTTPException

import app.routers.tickets as tk
from app.models import AdminAuditLog, Ticket, User
from app.routers.gamification import admin_patch_settings, admin_set_visibility
from app.schemas import AdminTicketReplyCreate, AdminTicketUpdate, GamificationSettingsPatchIn, VisibilityPatchIn
from app.services.settings_store import get_gamification_settings, invalidate_gamification_cache


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    """回复会发推送、签图片 URL：换成空实现，测试只看审计行。"""
    import app.services.push_dispatch as pd

    monkeypatch.setattr(pd, "dispatch_ticket_reply", lambda *a, **k: None)
    monkeypatch.setattr(tk, "notify_ws", lambda *a, **k: None)
    monkeypatch.setattr(tk, "signed_image_urls", lambda keys: {})


def _user(db, email, role="user") -> User:
    u = User(email=email, api_token=f"tok_{email}", role=role)
    db.add(u)
    db.commit()
    return u


def _audits(db, prefix) -> list[AdminAuditLog]:
    return (
        db.query(AdminAuditLog)
        .filter(AdminAuditLog.field.like(prefix + "%"))
        .order_by(AdminAuditLog.field)
        .all()
    )


# ── 游戏化设置 / gamification settings ────────────────────────────────────────────

def test_visibility_patch_is_audited_once_per_real_change(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    before = bool(get_gamification_settings(db_session).get("user_visible"))

    admin_set_visibility(VisibilityPatchIn(userVisible=not before), db=db_session, admin=admin)
    [row] = _audits(db_session, "gamification:")
    assert row.field == "gamification:user_visible"
    assert row.admin_user_id == admin.id and row.target_user_id == admin.id
    assert (row.old_value, row.new_value) == (json.dumps(before), json.dumps(not before))
    assert row.op_id

    invalidate_gamification_cache()
    admin_set_visibility(VisibilityPatchIn(userVisible=not before), db=db_session, admin=admin)  # 原样再存
    assert len(_audits(db_session, "gamification:")) == 1


def test_settings_patch_audits_each_changed_key_under_one_op(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    old = get_gamification_settings(db_session)
    admin_patch_settings(
        GamificationSettingsPatchIn(
            competitionsPublicEnabled=not old["competitions_public_enabled"],
            minTradesReturn=old["min_trades_return"] + 3,
            leaderboardVisible=old["leaderboard_visible"],          # 没变 / unchanged
        ),
        db=db_session, admin=admin,
    )
    rows = _audits(db_session, "gamification:")
    assert [r.field for r in rows] == [
        "gamification:competitions_public_enabled",
        "gamification:min_trades_return",
    ]
    assert rows[0].new_value == json.dumps(not old["competitions_public_enabled"])
    assert (rows[1].old_value, rows[1].new_value) == (
        json.dumps(old["min_trades_return"]), json.dumps(old["min_trades_return"] + 3))
    assert len({r.op_id for r in rows}) == 1 and rows[0].op_id


def test_invalid_settings_patch_writes_no_audit(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minBaselineUsd=0), db=db_session, admin=admin)
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(featuredCompetitionId="nope"), db=db_session, admin=admin)
    assert _audits(db_session, "gamification:") == []


def test_direct_call_without_admin_still_saves_but_writes_no_audit(db_session):
    """老测试 / 脚本直接调路由函数、不传 admin：保存照常，审计跳过（硬写会撞非空外键）。"""
    out = admin_patch_settings(GamificationSettingsPatchIn(winrateRequireProfit=True), db=db_session)
    assert out["winrateRequireProfit"] is True
    assert db_session.query(AdminAuditLog).count() == 0


# ── 工单 / tickets ──────────────────────────────────────────────────────────────

def _ticket(db, owner, status="open", priority="normal") -> Ticket:
    t = Ticket(user_id=owner.id, title="连不上 MT5", category="account", status=status, priority=priority)
    db.add(t)
    db.commit()
    return t


def test_status_and_priority_changes_are_audited_against_the_submitter(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    owner = _user(db_session, "o@x.io")
    t = _ticket(db_session, owner)

    tk.admin_update_ticket(t.id, AdminTicketUpdate(status="in_progress", priority="urgent"),
                           db=db_session, admin=admin)
    rows = _audits(db_session, f"ticket:{t.id}:")
    assert [(r.field, r.old_value, r.new_value) for r in rows] == [
        (f"ticket:{t.id}:priority", "normal", "urgent"),
        (f"ticket:{t.id}:status", "open", "in_progress"),
    ]
    assert all(r.admin_user_id == admin.id and r.target_user_id == owner.id for r in rows)
    assert len({r.op_id for r in rows}) == 1


def test_no_op_update_and_missing_ticket_write_nothing(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    owner = _user(db_session, "o@x.io")
    t = _ticket(db_session, owner, status="closed")

    tk.admin_update_ticket(t.id, AdminTicketUpdate(status="closed"), db=db_session, admin=admin)
    tk.admin_update_ticket(t.id, AdminTicketUpdate(), db=db_session, admin=admin)
    with pytest.raises(HTTPException) as exc:
        tk.admin_update_ticket("missing", AdminTicketUpdate(status="open"), db=db_session, admin=admin)
    assert exc.value.status_code == 404
    assert _audits(db_session, "ticket:") == []


def test_reply_is_audited_with_a_60_char_excerpt_alongside_the_status_change(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    owner = _user(db_session, "o@x.io")
    t = _ticket(db_session, owner)
    body = "您好，" + "这是一段很长的回复内容。" * 10

    tk.admin_reply_to_ticket(t.id, AdminTicketReplyCreate(body=body, status="closed"),
                             db=db_session, admin=admin)
    rows = {r.field: r for r in _audits(db_session, f"ticket:{t.id}:")}
    assert set(rows) == {f"ticket:{t.id}:status", f"ticket:{t.id}:reply"}   # 优先级没变 / priority unchanged
    reply = rows[f"ticket:{t.id}:reply"]
    assert reply.old_value == ""
    assert reply.new_value == body[:60] + "…"
    assert reply.target_user_id == owner.id
    assert rows[f"ticket:{t.id}:status"].op_id == reply.op_id


def test_short_reply_is_kept_whole(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    owner = _user(db_session, "o@x.io")
    t = _ticket(db_session, owner)
    tk.admin_reply_to_ticket(t.id, AdminTicketReplyCreate(body="  已处理  "), db=db_session, admin=admin)
    [row] = _audits(db_session, "ticket:")
    assert row.field == f"ticket:{t.id}:reply" and row.new_value == "已处理"


def test_image_only_reply_is_still_audited(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    owner = _user(db_session, "o@x.io")
    t = _ticket(db_session, owner)
    keys = [f"{admin.id}/{format(n, '032x')}.png" for n in range(2)]
    tk.admin_reply_to_ticket(t.id, AdminTicketReplyCreate(images=keys), db=db_session, admin=admin)
    [row] = _audits(db_session, "ticket:")
    assert row.field == f"ticket:{t.id}:reply"
    assert row.new_value == "[图片 ×2 / 2 image(s)]"


def test_rejected_reply_writes_nothing(db_session):
    admin = _user(db_session, "admin@x.io", role="admin")
    owner = _user(db_session, "o@x.io")
    t = _ticket(db_session, owner)
    with pytest.raises(HTTPException):                     # 别人的图片键 / someone else's upload
        tk.admin_reply_to_ticket(
            t.id, AdminTicketReplyCreate(body="看图", images=[f"{owner.id}/{'0' * 32}.png"], status="closed"),
            db=db_session, admin=admin)
    db_session.rollback()
    assert _audits(db_session, "ticket:") == []
