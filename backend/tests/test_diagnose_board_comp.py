"""`scripts/diagnose_board.py --comp`：判定与后台参赛名单 / 真实计分同源。

2026-10-06 之前脚本自己按「基线 + 入金调整」算分母、不看本金上限与结束快照，比赛改成
「平台单盈亏 ÷ 报名本金」（方案 3）之后会说出与真榜相反的结论。现在判定直接取
`participant_details`；这里钉住：有资金进出的照样算上榜（只标「需复核」）、笔数不足的
说清差在哪、取消资格的写明原因。
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

UTC = timezone.utc


@pytest.fixture()
def session_factory(monkeypatch):
    from app.core.database import Base
    import app.models  # noqa: F401
    import scripts.diagnose_board as diag

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(diag, "SessionLocal", Session)
    yield Session
    engine.dispose()


def test_comp_diagnosis_matches_scoring(session_factory, capsys):
    from app.models import (ClosedTrade, Competition, CompetitionParticipant, LeaderboardSnapshot,
                            MT5Account, Order, PeriodBaseline, User)
    from app.services.gamification.competitions import comp_period_key, refresh_comp_board
    from scripts.diagnose_board import _diagnose_comp

    now = datetime.now(UTC)
    db = session_factory()
    comp = Competition(name="诊断赛", metric="return_pct", status="running", track="demo",
                       starts_at=now - timedelta(days=2), ends_at=now + timedelta(days=5),
                       min_baseline_usd=10000.0, max_baseline_usd=10000.0, min_trades=2)
    db.add(comp); db.commit()

    def entrant(login, n_closed, adjust=0.0, disqualified=False, reason=None):
        u = User(email=f"{login}@t.co", api_token=f"tok{login}")
        db.add(u); db.commit()
        db.add(MT5Account(user_id=u.id, login=login, server="s", balance=10000.0 + adjust,
                          trade_mode=0, source="gateway"))
        db.add(CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                                      disqualified=disqualified, disqualify_reason=reason))
        db.add(PeriodBaseline(user_id=u.id, mt5_login=login, period_key=comp_period_key(comp.id),
                              baseline=10000.0, taken_at=now - timedelta(days=3), adjust=adjust))
        for i in range(n_closed):
            t = int(login) * 100 + i
            db.add(Order(user_id=u.id, client_order_id=f"c{t}", symbol="X", side="BUY", volume=0.1,
                         status="FILLED", mt5_login=login, mt5_ticket=t, trade_mode=0,
                         created_at=now - timedelta(hours=10)))
            db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=50.0, position_ticket=t,
                               deal_ticket=t * 10, closed_at=now - timedelta(hours=5), verified=True))
        db.commit()

    entrant("7001", 3)                      # 正常上榜
    entrant("7002", 3, adjust=-2000.0)      # 平台外亏了 2000：照样上榜，标需复核
    entrant("7003", 1)                      # 只平 1 笔，门槛 2
    entrant("7004", 3, disqualified=True, reason="平台外交易")
    refresh_comp_board(db, comp, force=True)
    db.commit()
    ranked = {r.mt5_login for r in db.query(LeaderboardSnapshot)}
    assert ranked == {"7001", "7002"}
    comp_id = comp.id
    db.close()

    assert _diagnose_comp(comp_id, verbose=False) == 0
    out = capsys.readouterr().out
    assert "报名本金须正好 10000 USD" in out
    assert "7003  平仓笔数不足 · 计分 1 笔（需 2）" in out
    assert "7004  已取消资格" in out and "取消原因：平台外交易" in out
    # 资金进出需复核的上榜行即使不加 --verbose 也列出来；正常上榜的不列
    assert "7002  +1.50% · 3 笔" in out and "资金进出 -2000.00（需复核）" in out
    assert "7001  +1.50%" not in out
