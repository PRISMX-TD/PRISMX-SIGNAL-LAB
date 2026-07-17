"""纪律分 Discipline Score 的单测：三维度评分逻辑、账号过滤语义、权重归一化、
等级裁剪、快照 upsert、权限边界。

Unit tests for the Discipline Score: the three-dimension scoring rules,
account-filter semantics, weight normalization, plan-based response gating,
snapshot upsert, and the authorization boundary.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import ClosedTrade, MT5Account, Order, User
from app.services.discipline import compute_discipline, discipline_snapshot_loop
from app.services.settings_store import invalidate_discipline_cache, save_discipline_settings

from conftest import make_signal


@pytest.fixture(autouse=True)
def _reset_discipline_cache():
    """settings_store 的纪律分参数缓存是进程级全局变量，不随每个测试的 `db`
    fixture（drop_all + 重建）一起清空；显式失效，保证每个测试从头读取当前
    （刚重建的）数据库默认值。同 test_trial.py 的 _reset_trial_cache 手法。"""
    invalidate_discipline_cache()
    yield
    invalidate_discipline_cache()


def _now():
    return datetime.now(timezone.utc)


def _admin_headers(db):
    admin = User(
        email="dscadmin@example.com",
        password_hash="x",
        api_token=hash_api_token(generate_api_token()),
        role="admin",
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return admin, {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def _signal_order(
    db, user, ticket, login, signal_id, sl=99.0, side="BUY", volume=1.0,
    filled_price=100.0, minutes_ago=120, client_order_id=None,
):
    created = _now() - timedelta(minutes=minutes_ago)
    o = Order(
        user_id=user.id,
        signal_id=signal_id,
        client_order_id=client_order_id or f"co-{login}-{ticket}",
        action="ORDER",
        status="FILLED",
        symbol="XAUUSD",
        side=side,
        volume=volume,
        sl=sl,
        mt5_login=login,
        mt5_ticket=ticket,
        filled_price=filled_price,
        created_at=created,
    )
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


def _leg(db, user, ticket, login, profit, volume=1.0, deal=None):
    row = ClosedTrade(
        user_id=user.id,
        mt5_login=login,
        symbol="XAUUSD",
        side="BUY",
        close_volume=volume,
        close_price=99.0,
        profit=profit,
        position_ticket=ticket,
        deal_ticket=deal if deal is not None else int(f"{ticket}{abs(int(profit)) % 100:02d}9"),
        closed_at=_now(),
    )
    db.add(row)
    db.commit()
    return row


def _modify(db, user, ticket, login, sl, minutes_ago=60, prefix=""):
    o = Order(
        user_id=user.id,
        client_order_id=f"{prefix}modify-{login}-{ticket}-{sl}",
        action="MODIFY",
        status="FILLED",
        symbol="XAUUSD",
        side="BUY",
        volume=0.0,
        ticket=ticket,
        sl=sl,
        mt5_login=login,
        created_at=_now() - timedelta(minutes=minutes_ago),
    )
    db.add(o)
    db.commit()
    return o


def _close(db, user, ticket, login, minutes_ago=30, prefix=""):
    o = Order(
        user_id=user.id,
        client_order_id=f"{prefix}close-{login}-{ticket}",
        action="CLOSE",
        status="FILLED",
        symbol="XAUUSD",
        side="BUY",
        volume=1.0,
        ticket=ticket,
        mt5_login=login,
        created_at=_now() - timedelta(minutes=minutes_ago),
    )
    db.add(o)
    db.commit()
    return o


def test_no_signal_orders_returns_all_none(db, user):
    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["total"] is None
    assert result["positions"] == 0
    assert result["dimensions"]["stopLoss"]["score"] is None
    assert result["dimensions"]["volume"]["score"] is None
    assert result["dimensions"]["exit"]["score"] is None


def test_clean_position_d1_d3_perfect(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=100, login="10001", signal_id=sig.id, sl=99.0)
    _leg(db, user, ticket=100, login="10001", profit=-5.0)  # SL 打掉，亏损平仓，无手动 CLOSE

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["positions"] == 1
    assert result["dimensions"]["stopLoss"]["score"] == 100.0
    assert result["dimensions"]["exit"]["score"] == 100.0


def test_d1_violation_adverse_modify(db, user):
    sig = make_signal(db)
    # BUY 仓，入场 100，止损 99（距离 1）。MODIFY 把止损调低到 97.5，
    # 恶化 2.5 > 1×10% 容差，判违规。
    _signal_order(db, user, ticket=200, login="10001", signal_id=sig.id, sl=99.0, filled_price=100.0)
    _modify(db, user, ticket=200, login="10001", sl=97.5)
    _leg(db, user, ticket=200, login="10001", profit=-10.0)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["stopLoss"]["score"] == 0.0
    assert result["dimensions"]["stopLoss"]["violations"] == 1


def test_d1_within_tolerance_not_violation(db, user):
    sig = make_signal(db)
    # 止损距离 1，调低 0.05（5%）在默认 10% 容差内 → 不算违规
    _signal_order(db, user, ticket=201, login="10001", signal_id=sig.id, sl=99.0, filled_price=100.0)
    _modify(db, user, ticket=201, login="10001", sl=98.95)
    _leg(db, user, ticket=201, login="10001", profit=-9.5)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["stopLoss"]["score"] == 100.0


def test_d1_sl_removed_is_violation(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=202, login="10001", signal_id=sig.id, sl=99.0, filled_price=100.0)
    _modify(db, user, ticket=202, login="10001", sl=0)
    _leg(db, user, ticket=202, login="10001", profit=20.0)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["stopLoss"]["score"] == 0.0


def test_d1_excludes_auto_managed_modify(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=203, login="10001", signal_id=sig.id, sl=99.0, filled_price=100.0)
    # 自动仓管把止损移到很不利的位置——但 client_order_id 带 auto_ 前缀，不算用户行为
    _modify(db, user, ticket=203, login="10001", sl=90.0, prefix="auto_sl_")
    _leg(db, user, ticket=203, login="10001", profit=-100.0)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["stopLoss"]["score"] == 100.0


def test_d1_no_stop_loss_at_open_is_violation(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=204, login="10001", signal_id=sig.id, sl=None, filled_price=100.0)
    _leg(db, user, ticket=204, login="10001", profit=-5.0)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["stopLoss"]["score"] == 0.0


def test_d2_volume_spike_is_violation(db, user):
    sig = make_signal(db)
    # 6 笔历史 volume=0.1 的信号单，故意放在默认 90 天统计窗口**之外**——
    # _score_volume 的基准查询不设窗口下限，仍会看到它们；但 _resolved_positions
    # 受窗口限制，它们不会被单独评出自己的 D2 分数掺进平均值（否则等history
    # 自己有了≥5笔更早历史后也会被判"合规"，把断言要看的那一个违规分稀释掉）。
    # Placed outside the default 90-day window on purpose: _score_volume's
    # baseline query has no lower time bound and still sees them, but
    # _resolved_positions is window-bound so they aren't separately scored
    # themselves (which would otherwise dilute the one violation we're asserting).
    for i in range(6):
        _signal_order(
            db, user, ticket=300 + i, login="10001", signal_id=sig.id,
            volume=0.1, minutes_ago=91 * 24 * 60 + i * 10, client_order_id=f"hist-{i}",
        )
        _leg(db, user, ticket=300 + i, login="10001", profit=1.0, volume=0.1)
    _signal_order(db, user, ticket=310, login="10001", signal_id=sig.id, volume=0.5, minutes_ago=60)
    _leg(db, user, ticket=310, login="10001", profit=-5.0, volume=0.5)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["positions"] == 1  # 历史仓位在窗口外，不参与评分，只有 spike 这一笔
    assert result["dimensions"]["volume"]["score"] == 0.0
    assert result["dimensions"]["volume"]["violations"] == 1


def test_d2_insufficient_history_is_none(db, user):
    sig = make_signal(db)
    # 只有 4 笔历史（< 默认 history_min=5）
    for i in range(4):
        _signal_order(
            db, user, ticket=320 + i, login="10001", signal_id=sig.id,
            volume=0.1, minutes_ago=500 - i * 10, client_order_id=f"hist2-{i}",
        )
        _leg(db, user, ticket=320 + i, login="10001", profit=1.0, volume=0.1)
    _signal_order(db, user, ticket=330, login="10001", signal_id=sig.id, volume=0.5, minutes_ago=60)
    _leg(db, user, ticket=330, login="10001", profit=-5.0, volume=0.5)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["volume"]["score"] is None


def test_d3_manual_close_with_loss_is_violation(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=400, login="10001", signal_id=sig.id, sl=99.0)
    _close(db, user, ticket=400, login="10001")
    _leg(db, user, ticket=400, login="10001", profit=-3.0)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["exit"]["score"] == 0.0


def test_d3_manual_close_with_profit_not_violation(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=401, login="10001", signal_id=sig.id, sl=99.0)
    _close(db, user, ticket=401, login="10001")
    _leg(db, user, ticket=401, login="10001", profit=8.0)

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["exit"]["score"] == 100.0


def test_d3_no_manual_close_is_compliant(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=402, login="10001", signal_id=sig.id, sl=99.0)
    _leg(db, user, ticket=402, login="10001", profit=-3.0)  # SL 打掉，无手动 CLOSE

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["exit"]["score"] == 100.0


def test_account_filter_no_cross_contamination(db, user):
    sig = make_signal(db)
    # 账号 A：违规仓位；账号 B：干净仓位——两边不应互相影响
    _signal_order(db, user, ticket=500, login="A", signal_id=sig.id, sl=99.0, filled_price=100.0)
    _modify(db, user, ticket=500, login="A", sl=90.0)  # A 违规
    _leg(db, user, ticket=500, login="A", profit=-50.0)

    _signal_order(db, user, ticket=500, login="B", signal_id=sig.id, sl=99.0, filled_price=100.0)  # 同编号，不同账号
    _leg(db, user, ticket=500, login="B", profit=-5.0)  # B 干净

    result_a = compute_discipline(db, user.id, login="A")
    result_b = compute_discipline(db, user.id, login="B")
    assert result_a["dimensions"]["stopLoss"]["score"] == 0.0
    assert result_b["dimensions"]["stopLoss"]["score"] == 100.0

    # 全部账户聚合：两个仓位都应计入（各account一个仓位，ticket相同但login不同不冲突）
    result_all = compute_discipline(db, user.id, bound_logins=["A", "B"])
    assert result_all["positions"] == 2


def test_weight_normalization_when_dimension_is_none(db, user):
    sig = make_signal(db)
    # 只构造能评出 D1/D3 的仓位，D2（仓位纪律）因历史不足恒为 None
    _signal_order(db, user, ticket=600, login="10001", signal_id=sig.id, sl=99.0, filled_price=100.0)
    _modify(db, user, ticket=600, login="10001", sl=90.0)  # D1 违规 → 0
    _leg(db, user, ticket=600, login="10001", profit=-50.0)  # 无手动 CLOSE → D3 合规 → 100

    result = compute_discipline(db, user.id, bound_logins=["10001"])
    assert result["dimensions"]["volume"]["score"] is None
    # 总分 = D1(0)*40 + D3(100)*30，权重和 70（D2 权重 30 被剔除）
    expected = (0.0 * 40 + 100.0 * 30) / 70
    assert result["total"] == pytest.approx(expected)


def test_api_plan_gating_free_vs_pro(client, db, user, auth_headers):
    sig = make_signal(db)
    _signal_order(db, user, ticket=700, login="10001", signal_id=sig.id, sl=99.0)
    _leg(db, user, ticket=700, login="10001", profit=-5.0)
    admin, headers = _admin_headers(db)

    # 端点当前仅管理员可用；用管理员账号验证 FREE/PRO 裁剪逻辑本身
    admin_signal_order_ticket = 701
    _signal_order(db, admin, ticket=admin_signal_order_ticket, login="10001", signal_id=sig.id, sl=99.0)
    _leg(db, admin, ticket=admin_signal_order_ticket, login="10001", profit=-5.0)

    # 默认管理员 plan=FREE（未设置）
    res_free = client.get("/api/orders/discipline", headers=headers)
    assert res_free.status_code == 200
    assert "dimensions" not in res_free.json()

    admin.plan = "PRO"
    db.add(admin)
    db.commit()
    res_pro = client.get("/api/orders/discipline", headers=headers)
    assert res_pro.status_code == 200
    assert "dimensions" in res_pro.json()


def test_snapshot_upsert_idempotent(db, user):
    sig = make_signal(db)
    _signal_order(db, user, ticket=800, login="10001", signal_id=sig.id, sl=99.0)
    _leg(db, user, ticket=800, login="10001", profit=-5.0)
    # 快照循环按当前绑定账号列表建行——没有 MT5Account 行，login="10001" 那一行
    # 就永远不会生成（只会有 login="" 的全部账户聚合行）。
    # The snapshot loop enumerates currently-bound accounts — without an
    # MT5Account row, the login="10001" snapshot never gets created (only the
    # login="" all-accounts aggregate would).
    db.add(MT5Account(user_id=user.id, login="10001", server="MakeCapital-Demo"))
    db.commit()

    import asyncio

    async def run_once():
        task = asyncio.create_task(discipline_snapshot_loop())
        await asyncio.sleep(0.2)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(run_once())
    asyncio.run(run_once())

    from app.models import DisciplineSnapshot

    rows = (
        db.query(DisciplineSnapshot)
        .filter(DisciplineSnapshot.user_id == user.id, DisciplineSnapshot.login == "10001")
        .all()
    )
    assert len(rows) == 1


def test_requires_auth(client, db, auth_headers):
    """任何登录用户都能拿到自己的纪律分；匿名请求被拒绝。
    Any logged-in user can fetch their own discipline score; anonymous requests are refused."""
    assert client.get("/api/orders/discipline", headers=auth_headers).status_code == 200
    assert client.get("/api/orders/discipline").status_code == 401


def test_admin_settings_get_put(client, db):
    _admin, headers = _admin_headers(db)
    res = client.get("/api/admin/discipline", headers=headers)
    assert res.status_code == 200
    assert res.json() == {
        "windowDays": 90, "weightStop": 40, "weightVolume": 30, "weightExit": 30,
        "slTolerancePct": 0.10, "volumeMultiple": 3.0, "volumeHistoryMin": 5,
    }

    put = client.put(
        "/api/admin/discipline",
        headers=headers,
        json={
            "windowDays": 30, "weightStop": 50, "weightVolume": 25, "weightExit": 25,
            "slTolerancePct": 0.2, "volumeMultiple": 2.0, "volumeHistoryMin": 3,
        },
    )
    assert put.status_code == 200
    assert put.json()["windowDays"] == 30


def test_admin_settings_reject_all_zero_weights(client, db):
    _admin, headers = _admin_headers(db)
    res = client.put(
        "/api/admin/discipline",
        headers=headers,
        json={
            "windowDays": 90, "weightStop": 0, "weightVolume": 0, "weightExit": 0,
            "slTolerancePct": 0.10, "volumeMultiple": 3.0, "volumeHistoryMin": 5,
        },
    )
    assert res.status_code == 400
