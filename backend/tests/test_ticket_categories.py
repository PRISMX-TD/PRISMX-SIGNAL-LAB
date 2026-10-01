"""工单分类：新增「申领」（claim），其余分类照旧，未知分类仍拒收。
Ticket categories: "claim" is accepted alongside the existing ones; unknown values are still rejected.
"""
import pytest
from pydantic import ValidationError

import app.routers.tickets as tk
from app.models import User
from app.routers.tickets import create_ticket, list_all_tickets
from app.schemas import TicketCreate


@pytest.mark.parametrize("category", ["account", "payment", "claim", "technical", "feature"])
def test_known_categories_are_accepted(category):
    assert TicketCreate(title="t", category=category, body="b").category == category


def test_unknown_category_is_rejected():
    with pytest.raises(ValidationError):
        TicketCreate(title="t", category="refund", body="b")


def test_claim_tickets_can_be_filtered_in_admin_list(db_session, monkeypatch):
    monkeypatch.setattr(tk, "notify_ws", lambda *a, **k: None)
    owner = User(email="o@x.com", api_token="tok_o")
    admin = User(email="a@x.com", api_token="tok_a", role="admin")
    db_session.add_all([owner, admin])
    db_session.commit()
    create_ticket(TicketCreate(title="申领试用", category="claim", body="想申领试用"), db_session, owner)
    create_ticket(TicketCreate(title="别的", category="technical", body="x"), db_session, owner)
    rows = list_all_tickets(None, "claim", 50, 0, db_session, admin)
    assert [r.title for r in rows] == ["申领试用"]
    assert rows[0].category == "claim"
