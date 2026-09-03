from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import (
    AdminAuditLog, User, MT5Account, Competition, CompetitionParticipant,
    LeaderboardSnapshot, UserBadge,
)
from app.services.gamification.competitions import comp_period_key, settle_competition

UTC = timezone.utc
# 远早于任何测试运行时的真实 now——settle_competition 现在（§5.3）要求
# now >= ends_at + 24h 才放行终审，大多数用例走默认 now（真实时钟），必须
# 让 ends_at 稳稳落在过去，不依赖测试运行的具体日期。
# Far in the past relative to any real wall-clock test run — settle_competition
# now (§5.3) requires now >= ends_at + 24h, and most cases use the default now
# (the real clock), so ends_at must sit safely in the past regardless of when
# the suite actually runs.
T0 = datetime(2020, 1, 1, 0, 0, tzinfo=UTC)
ENDS = T0 + timedelta(days=7)


def _user(db, email):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _admin(db, email="admin@t.co"):
    a = User(email=email, api_token="tok_" + email, role="admin")
    db.add(a); db.commit(); return a


def _comp(db, status="ended", metric="return_pct", starts_at=T0, ends_at=ENDS, name="Comp A"):
    c = Competition(name=name, metric=metric, status=status,
                     starts_at=starts_at, ends_at=ends_at)
    db.add(c); db.commit(); return c


def _participant(db, comp, u, login, disqualified=False):
    p = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login,
                               disqualified=disqualified)
    db.add(p); db.commit(); return p


def _stub_compute_rows(monkeypatch, comp, rows):
    """settle_competition 现在终审前会先重算一遍这场比赛的快照（`_snapshot_one_comp`
    内部调用 `compute_comp_rows`）——见 competitions.py 里 settle_competition 的
    docstring。这里的测试只关心 settle 自身的排名/发奖/审计逻辑，不必为每个用例
    搭一整套真实成交 + 基线数据（那是 test_comp_scoring.py 的职责），所以直接把
    `compute_comp_rows(db, comp)` 对这场比赛的返回值钉死成 `rows`（未排名的
    `{userId, login, score, sample}` 行，形状与 compute_comp_rows 真实返回值一致）；
    其它比赛仍走真实实现，不受影响。
    """
    import app.services.gamification.competitions as comp_mod
    real_compute = comp_mod.compute_comp_rows

    def _fake(db, c):
        if c.id == comp.id:
            return list(rows)
        return real_compute(db, c)

    monkeypatch.setattr(comp_mod, "compute_comp_rows", _fake)


def _badges(db, user_id):
    return {b.badge_id for b in db.query(UserBadge).filter_by(user_id=user_id)}


# ---- status guard ----------------------------------------------------------

def test_settle_rejects_non_ended_status(db_session):
    admin = _admin(db_session)
    for status in ("draft", "upcoming", "running", "settled"):
        comp = _comp(db_session, status=status, name=f"C-{status}")
        with pytest.raises(HTTPException) as exc:
            settle_competition(db_session, comp, admin.id)
        assert exc.value.status_code == 400
        assert "已结束" in exc.value.detail
        assert comp.status == status                      # 未被改动


# ---- §5.3 24h grace period after ends_at ------------------------------------

def test_settle_rejects_within_24h_grace_window(db_session):
    """比赛结束（ends_at）后仅 23 小时：宽限期未满，终审应被拒绝——即便 status
    已经是 ended（管理员可能手动推进得比 ends_at 更晚，但宽限期只认 ends_at）。
    """
    admin = _admin(db_session)
    comp = _comp(db_session, ends_at=ENDS)
    now = ENDS + timedelta(hours=23)
    with pytest.raises(HTTPException) as exc:
        settle_competition(db_session, comp, admin.id, now=now)
    assert exc.value.status_code == 400
    assert "24 小时" in exc.value.detail
    assert comp.status == "ended"                      # 未被改动


def test_settle_succeeds_after_24h_grace_window(db_session, monkeypatch):
    """结束后 25 小时：宽限期已满，终审照常放行。"""
    admin = _admin(db_session)
    comp = _comp(db_session, ends_at=ENDS)
    u = _user(db_session, "grace@t.co")
    _participant(db_session, comp, u, "A")
    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])

    now = ENDS + timedelta(hours=25)
    result = settle_competition(db_session, comp, admin.id, now=now)

    assert comp.status == "settled"
    assert result["ranked"] == 1


# ---- ranks written, unranked stay NULL -------------------------------------

def test_settle_writes_final_rank_and_score_matching_snapshot(db_session, monkeypatch):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u1 = _user(db_session, "s1@t.co"); _acct = MT5Account(user_id=u1.id, login="A", server="s",
                                                            balance=1000.0, trade_mode=2)
    db_session.add(_acct); db_session.commit()
    p1 = _participant(db_session, comp, u1, "A")

    u2 = _user(db_session, "s2@t.co")
    p2 = _participant(db_session, comp, u2, "B")           # 没入榜：compute 不出这行

    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u1.id, "login": "A", "score": 0.5, "sample": 20}])

    result = settle_competition(db_session, comp, admin.id)

    db_session.refresh(p1); db_session.refresh(p2)
    assert p1.final_rank == 1 and p1.final_score == 0.5
    assert p2.final_rank is None and p2.final_score is None
    assert comp.status == "settled"
    assert result["ranked"] == 1


# ---- badge matrix -----------------------------------------------------------

def test_settle_badge_matrix_winner_podium_finisher_unranked_disqualified(db_session, monkeypatch):
    admin = _admin(db_session)
    comp = _comp(db_session)

    u_winner = _user(db_session, "win@t.co")
    _participant(db_session, comp, u_winner, "A")

    u_second = _user(db_session, "sec@t.co")
    _participant(db_session, comp, u_second, "B")

    u_third = _user(db_session, "third@t.co")
    _participant(db_session, comp, u_third, "C")

    u_fourth = _user(db_session, "fourth@t.co")
    _participant(db_session, comp, u_fourth, "D")

    u_unranked = _user(db_session, "unranked@t.co")
    _participant(db_session, comp, u_unranked, "E")        # compute 不出这行

    u_dq = _user(db_session, "dq@t.co")
    _participant(db_session, comp, u_dq, "F", disqualified=True)  # 取消资格：不参与计分

    # 同分同笔数：排名靠 (-score, -sample, login) 里的 login 打破平局——
    # A<B<C<D 正好对应 rank 1..4，与原先手写的名次一致。
    _stub_compute_rows(monkeypatch, comp, [
        {"userId": u_winner.id, "login": "A", "score": 0.5, "sample": 10},
        {"userId": u_second.id, "login": "B", "score": 0.5, "sample": 10},
        {"userId": u_third.id, "login": "C", "score": 0.5, "sample": 10},
        {"userId": u_fourth.id, "login": "D", "score": 0.5, "sample": 10},
    ])

    settle_competition(db_session, comp, admin.id)

    assert _badges(db_session, u_winner.id) == {"comp_winner", "comp_podium", "comp_finisher"}
    assert _badges(db_session, u_second.id) == {"comp_podium", "comp_finisher"}
    assert _badges(db_session, u_third.id) == {"comp_podium", "comp_finisher"}
    assert _badges(db_session, u_fourth.id) == {"comp_finisher"}
    assert _badges(db_session, u_unranked.id) == set()
    assert _badges(db_session, u_dq.id) == set()


def test_settle_disqualified_participant_stays_excluded_even_if_compute_returns_a_row(
        db_session, monkeypatch):
    """双保险：`compute_comp_rows` 按设计根本不会给 disqualified 参赛者出行，但
    终审是终局动作，这里故意让替身 compute_comp_rows 违反这条约定（模拟潜在
    bug 或数据竞态），验证 settle 自己那道 `participant.disqualified` 检查仍然
    挡得住——不写 final_*，不计入 ranked，不发任何勋章。"""
    admin = _admin(db_session)
    comp = _comp(db_session)
    u_dq = _user(db_session, "staledq@t.co")
    p_dq = _participant(db_session, comp, u_dq, "A", disqualified=True)

    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u_dq.id, "login": "A", "score": 0.9, "sample": 30}])

    result = settle_competition(db_session, comp, admin.id)

    db_session.refresh(p_dq)
    assert p_dq.final_rank is None and p_dq.final_score is None
    assert _badges(db_session, u_dq.id) == set()
    assert result["ranked"] == 0


def test_settle_refreshes_stale_snapshot_before_reading(db_session, monkeypatch):
    """核心场景：上一次每小时快照留了 2 行（rank 1/2），rank 1 的参赛者在那之后
    被取消资格——终审必须先按当前 disqualified 状态重算，而不是照单全收陈旧
    快照。刷新后：永久榜只剩幸存者一行且排到 rank 1，comp_winner 发给幸存者，
    取消资格那一行从 leaderboard_snapshots 里消失（不是继续躺在榜上）。"""
    admin = _admin(db_session)
    comp = _comp(db_session)
    key = comp_period_key(comp.id)

    u_dq = _user(db_session, "wasfirst@t.co")
    p_dq = _participant(db_session, comp, u_dq, "A", disqualified=False)
    u_ok = _user(db_session, "survivor@t.co")
    p_ok = _participant(db_session, comp, u_ok, "B")

    # 模拟上一次每小时快照：rank 1 = A（此时还没被取消资格），rank 2 = B。
    db_session.add(LeaderboardSnapshot(board=comp.metric, period_key=key,
                                       user_id=u_dq.id, mt5_login="A", rank=1,
                                       score=0.9, sample=30))
    db_session.add(LeaderboardSnapshot(board=comp.metric, period_key=key,
                                       user_id=u_ok.id, mt5_login="B", rank=2,
                                       score=0.3, sample=15))
    db_session.commit()

    # 快照之后才发生：管理员取消 A 的资格。
    p_dq.disqualified = True
    db_session.commit()

    # compute_comp_rows 的真实实现本就会把 disqualified 参赛者排除在外
    # （见 test_comp_scoring.test_disqualified_participant_excluded）——这里
    # 直接钉死它对本场比赛的返回值，等价于「A 已不出行，B 照旧」，不必为 B
    # 搭一整套真实成交数据。
    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u_ok.id, "login": "B", "score": 0.3, "sample": 15}])

    result = settle_competition(db_session, comp, admin.id)

    db_session.refresh(p_dq); db_session.refresh(p_ok)
    assert p_dq.final_rank is None and p_dq.final_score is None
    assert p_ok.final_rank == 1 and p_ok.final_score == 0.3
    assert result["ranked"] == 1
    assert "comp_winner" in _badges(db_session, u_ok.id)
    assert _badges(db_session, u_dq.id) == set()

    snaps = db_session.query(LeaderboardSnapshot).filter_by(
        board=comp.metric, period_key=key).all()
    assert len(snaps) == 1
    assert snaps[0].mt5_login == "B" and snaps[0].rank == 1


def test_settle_multi_account_same_user_dedups_badges(db_session, monkeypatch):
    """同一人两个账户占 1/2 名：winner/podium/finisher 各只发一枚，不因两行快照重复。"""
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "dual@t.co")
    _participant(db_session, comp, u, "A")
    _participant(db_session, comp, u, "B")

    _stub_compute_rows(monkeypatch, comp, [
        {"userId": u.id, "login": "A", "score": 0.5, "sample": 10},
        {"userId": u.id, "login": "B", "score": 0.5, "sample": 10},
    ])

    result = settle_competition(db_session, comp, admin.id)

    assert _badges(db_session, u.id) == {"comp_winner", "comp_podium", "comp_finisher"}
    winner_badges = [b for b in result["badges"] if b["userId"] == u.id]
    ids = [b["badgeId"] for b in winner_badges]
    assert sorted(ids) == ["comp_finisher", "comp_podium", "comp_winner"]  # 各一次


# ---- badge award failures don't undo finality -------------------------------

def test_settle_badge_award_failure_lands_in_badgeErrors_finality_intact(db_session, monkeypatch):
    """某一枚勋章授予中途抛出非 IntegrityError 异常：settle 正常返回，比赛仍
    settled，名次仍写死，失败进 badgeErrors——不传导成整场结算的异常。"""
    import app.services.gamification.competitions as comp_mod

    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "boom@t.co")
    _participant(db_session, comp, u, "A")
    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])

    real_award_badge = comp_mod.award_badge

    def _boom(db, user_id, badge_id):
        if badge_id == "comp_winner":
            raise RuntimeError("simulated award failure")
        return real_award_badge(db, user_id, badge_id)

    monkeypatch.setattr(comp_mod, "award_badge", _boom)

    result = settle_competition(db_session, comp, admin.id)

    assert comp.status == "settled"
    p = db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id, mt5_login="A").first()
    assert p.final_rank == 1                            # 名次不受发奖失败影响

    errors = [e for e in result["badgeErrors"] if e["badgeId"] == "comp_winner"]
    assert len(errors) == 1 and errors[0]["userId"] == u.id
    # comp_winner 失败不该拖垮同一用户的其它勋章授予（同一次 _award 调用互不影响）
    assert "comp_finisher" in _badges(db_session, u.id)
    assert "comp_podium" in _badges(db_session, u.id)
    assert "comp_winner" not in _badges(db_session, u.id)

    # session 在异常后仍可用（未被脏事务卡死）——能正常再查询/写入
    assert db_session.query(CompetitionParticipant).filter_by(
        competition_id=comp.id).count() == 1


# ---- back-to-back -----------------------------------------------------------

def test_settle_back_to_back_awarded_when_same_winner(db_session, monkeypatch):
    admin = _admin(db_session)
    u = _user(db_session, "champ@t.co")

    comp1 = _comp(db_session, starts_at=T0, ends_at=ENDS, name="Comp 1")
    _participant(db_session, comp1, u, "A")
    _stub_compute_rows(monkeypatch, comp1,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])
    settle_competition(db_session, comp1, admin.id)
    assert "comp_back_to_back" not in _badges(db_session, u.id)   # 首场没有「上一届」

    comp2 = _comp(db_session, starts_at=ENDS + timedelta(days=1),
                  ends_at=ENDS + timedelta(days=8), name="Comp 2")
    _participant(db_session, comp2, u, "A")
    _stub_compute_rows(monkeypatch, comp2,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])
    settle_competition(db_session, comp2, admin.id)

    assert "comp_back_to_back" in _badges(db_session, u.id)


def test_settle_back_to_back_not_awarded_when_different_winner(db_session, monkeypatch):
    admin = _admin(db_session)
    u1 = _user(db_session, "champ1@t.co")
    u2 = _user(db_session, "champ2@t.co")

    comp1 = _comp(db_session, starts_at=T0, ends_at=ENDS, name="Comp 1")
    _participant(db_session, comp1, u1, "A")
    _stub_compute_rows(monkeypatch, comp1,
                       [{"userId": u1.id, "login": "A", "score": 0.5, "sample": 10}])
    settle_competition(db_session, comp1, admin.id)

    comp2 = _comp(db_session, starts_at=ENDS + timedelta(days=1),
                  ends_at=ENDS + timedelta(days=8), name="Comp 2")
    _participant(db_session, comp2, u2, "B")
    _stub_compute_rows(monkeypatch, comp2,
                       [{"userId": u2.id, "login": "B", "score": 0.5, "sample": 10}])
    settle_competition(db_session, comp2, admin.id)

    assert "comp_back_to_back" not in _badges(db_session, u1.id)
    assert "comp_back_to_back" not in _badges(db_session, u2.id)


def test_settle_back_to_back_empty_board_adjacent_no_crash_no_spurious_award(db_session, monkeypatch):
    """相邻（按 starts_at）的一场比赛没有任何参赛者（零参赛/零入榜，真实
    compute_comp_rows 对零参赛自然返回空，不必 stub）：那一届没有冠军
    （winner_by_comp 为 None），不该让相邻对的比较抛异常，也不该误发
    comp_back_to_back 给任何人。"""
    admin = _admin(db_session)
    u = _user(db_session, "soloChamp@t.co")

    comp_empty = _comp(db_session, starts_at=T0, ends_at=ENDS, name="Comp Empty")
    settle_competition(db_session, comp_empty, admin.id)   # 零参赛、零快照，照样能终审

    comp_winner = _comp(db_session, starts_at=ENDS + timedelta(days=1),
                        ends_at=ENDS + timedelta(days=8), name="Comp Winner")
    _participant(db_session, comp_winner, u, "A")
    _stub_compute_rows(monkeypatch, comp_winner,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])
    result = settle_competition(db_session, comp_winner, admin.id)

    assert comp_empty.status == "settled" and comp_winner.status == "settled"
    assert "comp_back_to_back" not in _badges(db_session, u.id)
    assert result["badgeErrors"] == []


# ---- audit -------------------------------------------------------------------

def test_settle_writes_audit_log(db_session, monkeypatch):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "audit@t.co")
    _participant(db_session, comp, u, "A")
    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])

    settle_competition(db_session, comp, admin.id)

    rows = db_session.query(AdminAuditLog).filter(
        AdminAuditLog.field == f"competition:settle:{comp.id}").all()
    assert len(rows) == 1
    assert rows[0].admin_user_id == admin.id


# ---- not re-runnable ----------------------------------------------------------

def test_settle_is_not_rerunnable(db_session, monkeypatch):
    admin = _admin(db_session)
    comp = _comp(db_session)
    u = _user(db_session, "once@t.co")
    _participant(db_session, comp, u, "A")
    _stub_compute_rows(monkeypatch, comp,
                       [{"userId": u.id, "login": "A", "score": 0.5, "sample": 10}])

    settle_competition(db_session, comp, admin.id)
    assert comp.status == "settled"

    with pytest.raises(HTTPException) as exc:
        settle_competition(db_session, comp, admin.id)
    assert exc.value.status_code == 400
