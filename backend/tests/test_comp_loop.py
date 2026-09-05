"""循环第 5 阶段（Phase 3 Task 7）：run_gamification_pass 把 snapshot_competitions
接入每小时循环，返回 dict 增 compCount/compRows/compsError，现有键不改名。

run_gamification_pass 自己开 SessionLocal，不吃 conftest 的 db_session fixture
（Phase 2 Task 5 在榜单那一站就撞过这个限制）。数据路径（running 比赛真的算出
快照行、settled/draft/upcoming 不碰）已经在 test_comp_scoring.py 里覆盖到
snapshot_competitions 本身；这里只测循环这一层的集成契约：
  (a) snapshot_competitions 返回值 -> compCount/compRows/compsError 的映射对不对
  (b) snapshot_competitions 抛异常 -> compsError=True，且前四阶段（含榜单）的
      结果不被这次异常牵连

做法：monkeypatch loop.SessionLocal 接到一套内存 SQLite（同 conftest.py::
db_session 的手法），再把前四阶段的函数钉成 no-op——backfill_* 和
judge_and_record_conditions/judge_and_award_badges 是 loop 模块的顶层名字，
直接 monkeypatch.setattr(loop, ...) 就行；boards.snapshot_boards 和
competitions.snapshot_competitions 是 run_gamification_pass 内部按调用现场
`from .xxx import yyy` 现拿的（不是 loop 模块顶层名字），得 monkeypatch 到
它们各自的源模块上，下一次现场 import 才会捡到打过补丁的版本。
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
    monkeypatch.setattr(boards_module, "snapshot_boards",
                         lambda db, now: {"periods": 2, "rows": 5})


def test_comp_stage_maps_return_values(monkeypatch, loop_db):
    _stub_stages_1_4(monkeypatch)
    monkeypatch.setattr(competitions_module, "snapshot_competitions",
                         lambda db, now: {"comps": 3, "rows": 7})

    result = loop_module.run_gamification_pass()

    assert result["compCount"] == 3
    assert result["compRows"] == 7
    assert result["compsError"] is False
    # 前四阶段（含榜单）的键完好、不受 stage 5 打扰
    assert result["boardPeriods"] == 2
    assert result["boardRows"] == 5
    assert result["boardsError"] is False
    assert result["accounts"] == 0 and result["stamped"] == 0 and result["sentinel"] == 0
    assert result["users"] == 0 and result["newConditions"] == 0 and result["newBadges"] == 0
    assert result["failedUsers"] == 0


def test_comp_stage_failure_isolated(monkeypatch, loop_db):
    _stub_stages_1_4(monkeypatch)

    def _boom(db, now):
        raise RuntimeError("competition snapshot exploded")

    monkeypatch.setattr(competitions_module, "snapshot_competitions", _boom)

    result = loop_module.run_gamification_pass()

    assert result["compsError"] is True
    assert result["compCount"] == 0
    assert result["compRows"] == 0
    # stage 5 炸了，前四阶段（含榜单）已经拿到的结果原样返回，不被这次异常牵连
    assert result["boardPeriods"] == 2
    assert result["boardRows"] == 5
    assert result["boardsError"] is False
    assert result["accounts"] == 0 and result["stamped"] == 0 and result["sentinel"] == 0
    assert result["users"] == 0 and result["newConditions"] == 0 and result["newBadges"] == 0
    assert result["failedUsers"] == 0
