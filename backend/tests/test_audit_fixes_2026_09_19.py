"""2026-09-19 审计修复里剩下的那些行为变化。

一条一条钉住的原因都一样：这些判据坏掉时不会报错，只会安静地少做/多做一点事
（工单不冒头、旧令牌永远留表、搜索多返回几个人、平台设置的旧值查不到）——没有
测试就只能靠有人恰好注意到。

对应审计编号：F-04 / F-05 / F-06 / F-07 / F-08 / F-15 / F-17 / F-21 / F-23。
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models import (
    AdminAuditLog,
    PasswordResetToken,
    PushSubscription,
    Ticket,
    TicketReply,
    User,
    UserNotification,
)


def _mk_user(db, email="u@x.io", **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


# ---------- F-04 用户追问要冒头、要通知管理员 ----------


def _mk_ticket(db, owner, title="连不上 MT5"):
    from app.routers.tickets import create_ticket
    from app.schemas import TicketCreate

    return create_ticket(
        TicketCreate(title=title, category="account", priority="normal", body="帮我看看"),
        db=db,
        user=owner,
    )


def test_user_reply_bumps_updated_at_and_notifies_admins(db_session):
    """追加一条 reply 不会触发 Ticket 行的 onupdate，所以必须显式改 updated_at——
    管理端列表按它倒序，不改的话用户回了话那条工单连往上冒都不会。"""
    from app.routers.tickets import reply_to_ticket
    from app.schemas import TicketReplyCreate

    admin = _mk_user(db_session, "a@x.io", role="admin")
    owner = _mk_user(db_session, "o@x.io")
    out = _mk_ticket(db_session, owner)
    ticket = db_session.query(Ticket).filter(Ticket.id == out.id).one()
    # 把 updated_at 推到过去，模拟"这张工单上次被动过是很久以前"
    stale = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=3)
    ticket.updated_at = stale
    db_session.commit()

    db_session.query(UserNotification).delete()   # 只看这次回复产生的通知
    db_session.commit()

    reply_to_ticket(ticket.id, TicketReplyCreate(body="还是不行"), db=db_session, user=owner)
    db_session.refresh(ticket)
    assert ticket.updated_at > stale

    notes = db_session.query(UserNotification).all()
    assert [n.user_id for n in notes] == [admin.id]
    assert notes[0].ref_id == ticket.id
    assert notes[0].link.startswith("/admin")


def test_user_reply_does_not_notify_an_admin_replying_to_their_own_ticket(db_session):
    from app.routers.tickets import reply_to_ticket
    from app.schemas import TicketReplyCreate

    admin = _mk_user(db_session, "a@x.io", role="admin")
    out = _mk_ticket(db_session, admin)
    db_session.query(UserNotification).delete()
    db_session.commit()

    reply_to_ticket(out.id, TicketReplyCreate(body="自问自答"), db=db_session, user=admin)
    assert db_session.query(UserNotification).count() == 0


# ---------- F-17 越权统一回 404 ----------


def test_someone_elses_ticket_is_404_not_403(db_session):
    """403 等于确认这个 id 真的存在；/agent 那边早就是统一 404 的做法。"""
    from app.routers.tickets import get_ticket, reply_to_ticket
    from app.schemas import TicketReplyCreate

    owner = _mk_user(db_session, "o@x.io")
    stranger = _mk_user(db_session, "s@x.io")
    out = _mk_ticket(db_session, owner)

    for call in (
        lambda: get_ticket(out.id, db=db_session, user=stranger),
        lambda: reply_to_ticket(
            out.id, TicketReplyCreate(body="插一嘴"), db=db_session, user=stranger
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404

    # 不存在的 id 回的是同一个 404，两者不可区分
    with pytest.raises(HTTPException) as exc:
        get_ticket("no-such-id", db=db_session, user=stranger)
    assert exc.value.status_code == 404


# ---------- F-05 偏好：命名空间数量与整份大小 ----------


def _put_prefs(db, user, namespace, data):
    """路由是 async 且要过线程池推 WS；直接驱动同一份同步保存逻辑（见 save_prefs）。"""
    from app.routers.account import save_prefs

    return save_prefs(db, user.id, namespace, data)


def test_namespace_count_is_capped(db_session):
    from app.routers.account import PREFS_MAX_NAMESPACES

    user = _mk_user(db_session)
    for i in range(PREFS_MAX_NAMESPACES):
        _put_prefs(db_session, user, f"ns{i}", {"a": 1})
    with pytest.raises(HTTPException) as exc:
        _put_prefs(db_session, user, "one-too-many", {"a": 1})
    assert exc.value.status_code == 400


def test_overwriting_an_existing_namespace_is_always_allowed(db_session):
    """上限是"命名空间个数"，覆盖已有的不增加个数——否则用满之后连改都改不了。"""
    from app.routers.account import PREFS_MAX_NAMESPACES

    user = _mk_user(db_session)
    for i in range(PREFS_MAX_NAMESPACES):
        _put_prefs(db_session, user, f"ns{i}", {"a": 1})
    merged = _put_prefs(db_session, user, "ns0", {"a": 2})
    assert merged["ns0"] == {"a": 2}
    assert len(merged) == PREFS_MAX_NAMESPACES


def test_merge_keeps_other_namespaces(db_session):
    """加锁改造不能顺手改掉"只覆盖这一段"的语义。"""
    user = _mk_user(db_session)
    _put_prefs(db_session, user, "signals", {"filter": "all"})
    merged = _put_prefs(db_session, user, "charts", {"draw": []})
    assert merged == {"signals": {"filter": "all"}, "charts": {"draw": []}}


# ---------- F-06 找回密码：按邮箱频次 + 清理过期令牌 ----------


def test_reset_requests_are_capped_per_email(db_session):
    from app.services import shared_state
    from app.services.password_reset import RESET_MAX_PER_HOUR, too_many_recent_requests

    shared_state.reset_for_tests()
    try:
        for _ in range(RESET_MAX_PER_HOUR):
            assert too_many_recent_requests("victim@x.io") is False
        assert too_many_recent_requests("victim@x.io") is True
        # 另一个邮箱不受影响 / a different address is unaffected
        assert too_many_recent_requests("someone@x.io") is False
    finally:
        shared_state.reset_for_tests()


def test_over_limit_forgot_password_is_indistinguishable(db_session):
    """超限也回同一句话：状态码/响应体一变就成了存在性探针。"""
    from app.routers.auth import forgot_password as decorated
    from app.schemas import ForgotPasswordRequest
    from app.services import shared_state
    from app.services.password_reset import RESET_MAX_PER_HOUR

    forgot = decorated.__wrapped__

    class _Req:
        class _Client:
            host = "203.0.113.9"
        client = _Client()

    class _Bg:
        def __init__(self):
            self.tasks = []

        def add_task(self, fn, *a, **kw):
            self.tasks.append((fn, a, kw))

    shared_state.reset_for_tests()
    try:
        user = _mk_user(db_session, "real@x.io")
        replies, sends = [], 0
        for _ in range(RESET_MAX_PER_HOUR + 2):
            bg = _Bg()
            replies.append(forgot(request=_Req(), req=ForgotPasswordRequest(email=user.email),
                                  background=bg, db=db_session).message)
            sends += len(bg.tasks)
        assert len(set(replies)) == 1                 # 每次都是同一句话
        assert sends == RESET_MAX_PER_HOUR           # 但只真的发了 3 封
    finally:
        shared_state.reset_for_tests()


def test_issue_token_cleans_up_expired_rows(db_session):
    """绝大多数令牌的结局是"发了、没点、过期"；只删用过的等于这张表只增不减。"""
    from app.services.password_reset import hash_token, issue_token

    user = _mk_user(db_session)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db_session.add(PasswordResetToken(
        user_id=user.id, token_hash=hash_token("old-unused"),
        expires_at=now - timedelta(hours=2),
    ))
    db_session.add(PasswordResetToken(
        user_id=user.id, token_hash=hash_token("used"),
        expires_at=now + timedelta(hours=2), used_at=now,
    ))
    db_session.commit()

    issue_token(db_session, user)
    db_session.commit()
    rows = db_session.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user.id).all()
    assert len(rows) == 1                     # 只剩刚签发的这一条
    assert rows[0].used_at is None and rows[0].expires_at > now


def test_a_still_valid_token_is_not_swept_away(db_session):
    """连点两次「忘记密码」的人，第一封信不能因为第二次申请就失效。"""
    from app.services.password_reset import issue_token

    user = _mk_user(db_session)
    first = issue_token(db_session, user)
    db_session.commit()
    issue_token(db_session, user)
    db_session.commit()
    assert db_session.query(PasswordResetToken).count() == 2
    from app.services.password_reset import consume_token
    assert consume_token(db_session, first) is not None


# ---------- F-23 用户已删时令牌真的被作废 ----------


def test_token_of_a_deleted_user_is_actually_committed(db_session):
    """调用方拿到 None 就直接抛异常、从不 commit——作废要么在这里落盘，要么根本没发生。"""
    from app.services.password_reset import consume_token, issue_token

    user = _mk_user(db_session)
    raw = issue_token(db_session, user)
    db_session.commit()
    db_session.delete(user)
    db_session.commit()

    assert consume_token(db_session, raw) is None
    db_session.rollback()                     # 模拟请求以异常收场、事务被丢弃
    row = db_session.query(PasswordResetToken).one()
    assert row.used_at is not None


# ---------- F-07 后台搜索 ----------


def test_all_zero_query_does_not_match_every_phone(db_session):
    """q="000" 去掉前导 0 后什么都不剩，那个后缀条件会退化成 LIKE '%'。"""
    from app.routers.admin import list_users

    admin = _mk_user(db_session, "a@x.io", role="admin")
    _mk_user(db_session, "p1@x.io", phone="+60123456789")
    _mk_user(db_session, "p2@x.io", phone="+60987654321")

    out = list_users(q="000", plan=None, role=None, limit=50, offset=0, db=db_session, _admin=admin)
    assert out["total"] == 0


def test_like_wildcards_in_the_query_are_literal(db_session):
    from app.routers.admin import list_users

    admin = _mk_user(db_session, "a@x.io", role="admin")
    _mk_user(db_session, "ab@x.io")
    _mk_user(db_session, "a_b@x.io")

    # "a_b" 只能命中真的带下划线的那个，不能靠 _ 通配到 "ab"
    out = list_users(q="a_b", plan=None, role=None, limit=50, offset=0, db=db_session, _admin=admin)
    assert {u["email"] for u in out["users"]} == {"a_b@x.io"}
    # "%" 同理，不是"匹配所有"
    assert list_users(q="%", plan=None, role=None, limit=50, offset=0, db=db_session, _admin=admin)["total"] == 0


def test_phone_suffix_search_still_works(db_session):
    """转义不能把本来要的后缀匹配一起弄坏。"""
    from app.routers.admin import list_users

    admin = _mk_user(db_session, "a@x.io", role="admin")
    _mk_user(db_session, "p@x.io", phone="+60123456789")
    out = list_users(q="0123456789", plan=None, role=None, limit=50, offset=0, db=db_session, _admin=admin)
    assert {u["email"] for u in out["users"]} == {"p@x.io"}


# ---------- F-08 平台设置审计记旧值 ----------


def test_settings_audit_records_the_previous_value(db_session, monkeypatch):
    from app.routers.admin import put_trial
    from app.schemas import AdminTrialSettings

    admin = _mk_user(db_session, "a@x.io", role="admin")
    put_trial(AdminTrialSettings(trialEnabled=True, trialDays=7), db=db_session, admin=admin)
    put_trial(AdminTrialSettings(trialEnabled=True, trialDays=14), db=db_session, admin=admin)

    rows = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == "setting:trial:trial_days"
    ).order_by(AdminAuditLog.created_at).all()
    assert rows[-1].old_value == "7" and rows[-1].new_value == "14"
    # 没变的键不写行 / unchanged keys write nothing
    assert db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == "setting:trial:trial_enabled"
    ).count() == 1


def test_pricing_rejects_zero_and_a_full_discount(db_session):
    """0 元套餐与 100% 折扣都会造出一笔 0 元订单，被 NOWPayments 拒收后
    用户只看到一句"创建失败"，没人会想到是后台把价格设成了 0。"""
    from app.routers.admin import put_pricing
    from app.schemas import AdminPricingSettings

    admin = _mk_user(db_session, "a@x.io", role="admin")
    for body in (
        AdminPricingSettings(proMonthlyPrice=0, proYearlyPrice=99),
        AdminPricingSettings(proMonthlyPrice=19, proYearlyPrice=0),
        AdminPricingSettings(proMonthlyPrice=19, proYearlyPrice=99,
                             saleEnabled=True, salePercent=100),
    ):
        with pytest.raises(HTTPException) as exc:
            put_pricing(body, db=db_session, admin=admin)
        assert exc.value.status_code == 400


# ---------- F-15 通知偏好与订阅数量 ----------


def test_pref_whitelists_are_bounded(db_session):
    from app.routers.notifications import NotificationPrefsIn

    with pytest.raises(ValidationError):
        NotificationPrefsIn(selected_categories=[f"c{i}" for i in range(65)])
    with pytest.raises(ValidationError):
        NotificationPrefsIn(selected_symbols=["x" * 65])
    # 正常用量照旧
    NotificationPrefsIn(selected_categories=["trend", "momentum"], selected_symbols=["XAUUSD"])


def test_push_subscriptions_evict_the_oldest(db_session):
    from app.routers.notifications import MAX_PUSH_SUBSCRIPTIONS_PER_USER, push_subscribe
    from app.routers.notifications import PushSubscribeIn

    user = _mk_user(db_session, plan="PRO")
    keys = {"p256dh": "a" * 87, "auth": "b" * 22}

    def _sub(n):
        push_subscribe(
            PushSubscribeIn(endpoint=f"https://fcm.googleapis.com/fcm/send/dev{n}", keys=keys),
            db=db_session,
            current_user=user,
        )
        # created_at 在同一秒内可能相同，手动拉开顺序让"最旧"是确定的
        row = db_session.query(PushSubscription).filter(
            PushSubscription.endpoint.endswith(f"dev{n}")).first()
        if row is not None:
            row.created_at = datetime(2026, 1, 1) + timedelta(minutes=n)
            db_session.commit()

    for n in range(MAX_PUSH_SUBSCRIPTIONS_PER_USER + 3):
        _sub(n)

    rows = db_session.query(PushSubscription).filter(
        PushSubscription.user_id == user.id).all()
    assert len(rows) == MAX_PUSH_SUBSCRIPTIONS_PER_USER
    endpoints = {r.endpoint for r in rows}
    assert not any(e.endswith("dev0") or e.endswith("dev1") for e in endpoints)
    assert any(e.endswith(f"dev{MAX_PUSH_SUBSCRIPTIONS_PER_USER + 2}") for e in endpoints)


def test_resubscribing_the_same_device_does_not_evict_anything(db_session):
    from app.routers.notifications import push_subscribe, PushSubscribeIn

    user = _mk_user(db_session, plan="PRO")
    keys = {"p256dh": "a" * 87, "auth": "b" * 22}
    body = PushSubscribeIn(endpoint="https://fcm.googleapis.com/fcm/send/same", keys=keys)
    push_subscribe(body, db=db_session, current_user=user)
    push_subscribe(body, db=db_session, current_user=user)
    assert db_session.query(PushSubscription).filter(
        PushSubscription.user_id == user.id).count() == 1


# ---------- F-21 TradingView 载荷 ----------


def test_signal_entry_rejects_nan_inf_and_negatives():
    """NaN 会让 json.dumps 写出裸 NaN，经 WS 广播直接把前端的 JSON.parse 打挂。"""
    from app.routers.webhook import TradingViewSignal

    base = {"secret": "s", "symbol": "XAUUSD", "side": "BUY"}
    for bad in (float("nan"), float("inf"), float("-inf"), -1.0):
        with pytest.raises(ValidationError):
            TradingViewSignal(**base, entry=bad)
    assert TradingViewSignal(**base, entry=2415.5).entry == 2415.5
    assert TradingViewSignal(**base).entry is None


def test_ticket_reply_ordering_comment_matches_the_model():
    """_latest_reply 依赖 relationship 自带的 created_at 排序；那个 order_by 被
    改掉的话"最新一条回复"会静默变成别的行，而注释以前写的是按 id 排。"""
    from sqlalchemy import inspect

    rel = inspect(Ticket).relationships["replies"]
    assert "created_at" in str(rel.order_by)
    assert TicketReply is not None
