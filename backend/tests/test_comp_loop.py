"""游戏化各循环的分工（2026-09-28 起）：每小时 pass 只判条件/勋章，周期榜只由
board_loop（5 分钟）算，比赛榜只由 competition_loop（60 秒）算。每张榜只能有一处
对账——两处并发跑 reconcile_deposits，同一笔入金可能被记两次。

run_gamification_pass / run_board_pass 自己开 SessionLocal，不吃 conftest 的
db_session fixture，所以这里 monkeypatch loop.SessionLocal 接到一套内存 SQLite。
boards.snapshot_boards 和 competitions.snapshot_competitions 是调用现场
`from .xxx import yyy` 现拿的，得 monkeypatch 到各自的源模块上。
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import pytest

from app.core.database import Base
import app.models  # noqa: F401 —— 触发建表所需的模型注册
import app.services.gamification.boards as boards_module
import app.services.gamification.competitions as competitions_module
from app.services.gamification import loop as loop_module


@pytest.fixture()
def loop_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(loop_module, "SessionLocal", Session)
    yield Session
    engine.dispose()


def _stub_stages_1_4(monkeypatch):
    monkeypatch.setattr(loop_module, "backfill_account_trade_modes", lambda db: 0)
    monkeypatch.setattr(loop_module, "backfill_order_trade_modes", lambda db: (0, 0))
    monkeypatch.setattr(loop_module, "judge_and_record_conditions", lambda db, uid, *a: [])
    monkeypatch.setattr(loop_module, "judge_and_award_badges", lambda db, uid, *a: [])
    def _no_boards(db, now):
        raise AssertionError("周期榜已拆到 board_loop，整趟 pass 不该再算它")
    monkeypatch.setattr(boards_module, "snapshot_boards", _no_boards)


def test_hourly_pass_computes_neither_board(monkeypatch, loop_db):
    """整趟 pass 不碰周期榜也不碰比赛榜（两者任一被调用，桩就会抛）。"""
    _stub_stages_1_4(monkeypatch)
    def _no_comps(db, now):
        raise AssertionError("比赛榜只由 competition_loop 算，整趟 pass 不该再算它")
    monkeypatch.setattr(competitions_module, "snapshot_competitions", _no_comps)

    result = loop_module.run_gamification_pass()

    assert not any(k.startswith(("board", "comp")) for k in result)
    assert result["accounts"] == 0 and result["stamped"] == 0 and result["sentinel"] == 0
    assert result["users"] == 0 and result["newConditions"] == 0 and result["newBadges"] == 0
    assert result["failedUsers"] == 0


def test_board_pass_maps_snapshot_result(monkeypatch, loop_db):
    """周期榜 5 分钟循环：run_board_pass 原样返回 snapshot_boards 的结果。"""
    monkeypatch.setattr(boards_module, "snapshot_boards", lambda db, now: {"periods": 2, "rows": 5})
    assert loop_module.run_board_pass() == {"periods": 2, "rows": 5}


def test_board_pass_failure_is_contained(monkeypatch, loop_db):
    """snapshot_boards 抛异常：记日志、回滚，返回 error 标记，不把循环带崩。"""
    def _boom(db, now):
        raise RuntimeError("board snapshot exploded")
    monkeypatch.setattr(boards_module, "snapshot_boards", _boom)
    assert loop_module.run_board_pass() == {"periods": 0, "rows": 0, "error": True}
