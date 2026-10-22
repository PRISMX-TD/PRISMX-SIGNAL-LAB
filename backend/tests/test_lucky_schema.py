# backend/tests/test_lucky_schema.py
"""幸运轮盘（rev 45）建表与显示开关。"""
from app.core import database
from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, LuckyTicketBatch, User
from app.services.lucky import common


def test_schema_rev_is_45():
    assert database.CURRENT_SCHEMA_REV == 45


def test_tables_exist(db_session):
    from sqlalchemy import inspect
    names = set(inspect(db_session.get_bind()).get_table_names())
    assert {"lucky_wheel_rounds", "lucky_wheel_prizes", "lucky_ticket_batches",
            "lucky_tickets", "lucky_draws"} <= names


def test_visible_defaults_off_and_round_trips(db_session):
    assert common.is_visible(db_session) is False
    common.set_visible(db_session, True)
    db_session.commit()
    assert common.is_visible(db_session) is True
    common.set_visible(db_session, False)
    db_session.commit()
    assert common.is_visible(db_session) is False


def test_draw_ticket_unique(db_session):
    import pytest
    from sqlalchemy.exc import IntegrityError
    u = User(email="a@t.co", password_hash="x", api_token="t-a")
    db_session.add(u)
    db_session.flush()
    r = LuckyRound(starts_at=common.utcnow(), ends_at=common.utcnow(), created_by=u.id)
    p = LuckyPrize(sort_order=0, name="谢谢参与", kind="none", prob_bp=10000)
    db_session.add_all([r, p])
    db_session.flush()
    t = LuckyTicket(user_id=u.id, round_id=r.id, source="manual", status="used")
    db_session.add(t)
    db_session.flush()
    db_session.add(LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t.id, prize_id=p.id,
                             prize_snapshot="{}", request_id="r1", fulfillment_status="auto_done"))
    db_session.flush()
    db_session.add(LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t.id, prize_id=p.id,
                             prize_snapshot="{}", request_id="r2", fulfillment_status="auto_done"))
    with pytest.raises(IntegrityError):
        db_session.flush()
