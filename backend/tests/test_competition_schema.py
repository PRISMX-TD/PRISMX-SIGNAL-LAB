from datetime import datetime, timezone

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import User, Competition, CompetitionParticipant


def _user(db, email="comp@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _competition(db, name="Comp A"):
    c = Competition(name=name, starts_at=datetime.now(timezone.utc),
                     ends_at=datetime.now(timezone.utc))
    db.add(c); db.commit(); return c


def test_competition_defaults(db_session):
    c = _competition(db_session)
    row = db_session.query(Competition).first()
    assert row.metric == "return_pct"
    assert row.enrollment == "signup"
    assert row.status == "draft"
    assert row.track == "real"


def test_participant_unique_per_competition_login(db_session):
    u = _user(db_session)
    c1 = _competition(db_session, "Comp A")
    c2 = _competition(db_session, "Comp B")
    db_session.add(CompetitionParticipant(competition_id=c1.id, user_id=u.id, mt5_login="A"))
    db_session.commit()
    db_session.add(CompetitionParticipant(competition_id=c1.id, user_id=u.id, mt5_login="A"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
    # same login in a different competition is fine
    db_session.add(CompetitionParticipant(competition_id=c2.id, user_id=u.id, mt5_login="A"))
    db_session.commit()
    assert db_session.query(CompetitionParticipant).count() == 2


def test_participant_defaults(db_session):
    u = _user(db_session)
    c = _competition(db_session)
    db_session.add(CompetitionParticipant(competition_id=c.id, user_id=u.id, mt5_login="A"))
    db_session.commit()
    row = db_session.query(CompetitionParticipant).first()
    assert row.disqualified is False
    assert row.final_score is None
    assert row.final_rank is None
    assert row.scoring_from is None
