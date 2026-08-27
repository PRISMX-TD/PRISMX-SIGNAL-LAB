"""ACCOUNTS_STATUS 推送的去重与余额同步测试。

这个函数被两个调用方共用（bridge_poll 每 1.5 秒、offline_monitor_loop 每 2 秒），
去重条件写错的后果分两种：条件太松会每拍误推，太紧会把余额变化整个漏掉。
两种都不会报错，只能靠测试固定住。
"""

import asyncio

import pytest

from app.routers import bridge


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """隔离掉推送与事件通知，只观察被推送的消息。"""
    sent: list[tuple[str, dict]] = []

    async def fake_push(user_id: str, message: dict) -> None:
        sent.append((user_id, message))

    async def fake_event(*args, **kwargs) -> None:
        pass

    monkeypatch.setattr(bridge.manager, "push_to_client", fake_push)
    monkeypatch.setattr(bridge, "dispatch_event_push_async", fake_event)
    # 模块级去重状态是全局的，每个用例都要从干净状态开始
    monkeypatch.setattr(bridge, "_last_pushed_online", {})
    monkeypatch.setattr(bridge, "_last_pushed_balances", {})
    return sent


def _push(*args):
    return asyncio.run(bridge._push_accounts_status_if_changed(*args))


def test_first_push_always_sent(_isolate):
    """首次观测必须推送，前端要拿到初始状态。"""
    _push("u1", {"100"}, {"100": 500.0})
    assert len(_isolate) == 1
    assert _isolate[0][1]["data"]["balances"] == {"100": 500.0}


def test_unchanged_state_not_repushed(_isolate):
    """在线集合和余额都没变时不重复推送。

    bridge 每 1.5 秒轮询一次，照推就是纯浪费。
    """
    _push("u1", {"100"}, {"100": 500.0})
    _push("u1", {"100"}, {"100": 500.0})
    assert len(_isolate) == 1


def test_balance_change_triggers_push(_isolate):
    """余额变化必须推送 —— 这是本次改动的核心。

    出入金和平仓结算只改余额，不改在线集合。旧逻辑只比对在线集合，
    这类变化会被完全漏掉，前端只能等 5 秒轮询。
    """
    _push("u1", {"100"}, {"100": 500.0})
    _push("u1", {"100"}, {"100": 620.0})

    assert len(_isolate) == 2
    assert _isolate[1][1]["data"]["balances"] == {"100": 620.0}


def test_online_change_still_triggers_push(_isolate):
    """在线集合变化仍然要推 —— 加入余额比对不能削弱原有行为。"""
    _push("u1", {"100"}, {"100": 500.0})
    _push("u1", {"100", "200"}, {"100": 500.0, "200": 10.0})
    assert len(_isolate) == 2


def test_offline_loop_without_balances_does_not_repush(_isolate):
    """离线监控循环不传余额时不该产生误推。

    offline_monitor_loop 每 2 秒跑一次且不读资金，所以调用时不带余额。函数内部
    与上次推送的余额合并，因此既不会误判成变化、也不会抹掉已知余额。
    """
    _push("u1", {"100"}, {"100": 500.0})

    for _ in range(3):
        _push("u1", {"100"})       # 模拟离线循环：只报在线状态

    assert len(_isolate) == 1


def test_going_offline_keeps_last_balances(_isolate):
    """掉线时推送的余额仍是最后已知值，不是空字典。

    账号离线不代表余额归零。若这里推空字典，前端账户卡片会瞬间归零。
    """
    _push("u1", {"100"}, {"100": 500.0})
    _push("u1", set())             # 全部离线，且不带余额

    assert len(_isolate) == 2
    assert _isolate[1][1]["data"]["onlineLogins"] == []
    assert _isolate[1][1]["data"]["balances"] == {"100": 500.0}


def test_users_tracked_independently(_isolate):
    """去重状态按用户隔离，一个用户的推送不影响另一个。"""
    _push("u1", {"100"}, {"100": 500.0})
    _push("u2", {"200"}, {"200": 900.0})
    _push("u1", {"100"}, {"100": 500.0})   # u1 无变化

    assert len(_isolate) == 2
    assert [uid for uid, _ in _isolate] == ["u1", "u2"]


# --- gateway 侧的余额推送 / balance pushes from the gateway path ---

def _push_bal(user_id, balances):
    return asyncio.run(bridge.push_balances_if_changed(user_id, balances))


def test_gateway_balance_pushed_then_deduped(_isolate):
    """gateway 余额首次推送，重复值不再推。"""
    _push_bal("u1", {"900": 300.0})
    _push_bal("u1", {"900": 300.0})

    assert len(_isolate) == 1
    assert _isolate[0][1]["data"]["balances"] == {"900": 300.0}


def test_gateway_push_does_not_touch_online_state(_isolate):
    """gateway 推送不得写入在线状态。

    gateway 账号没有心跳，其在线与否取决于 gateway 服务本身。若它写
    _last_pushed_online，就会和按心跳维护该状态的 offline_monitor_loop 互相
    覆盖，导致 bridge 账号的在线状态每两秒抖动一次。
    """
    _push("u1", {"100"}, {"100": 500.0})       # bridge 账号在线
    _push_bal("u1", {"900": 300.0})            # gateway 余额变化

    # 在线集合仍只有 bridge 账号，且推送里如实带回
    assert bridge._last_pushed_online["u1"] == {"100"}
    assert _isolate[-1][1]["data"]["onlineLogins"] == ["100"]


def test_both_paths_balances_coexist(_isolate):
    """两条链路的余额互不覆盖。

    一个用户可能同时绑 bridge 和 gateway 账号，各自只知道自己那部分余额。
    任一侧直接替换整份状态，都会把对方账号的余额抹掉。
    """
    _push("u1", {"100"}, {"100": 500.0})       # bridge
    _push_bal("u1", {"900": 300.0})            # gateway

    assert _isolate[-1][1]["data"]["balances"] == {"100": 500.0, "900": 300.0}

    # 反向再来一次：bridge 侧更新不该丢掉 gateway 的余额
    _push("u1", {"100"}, {"100": 555.0})
    assert _isolate[-1][1]["data"]["balances"] == {"100": 555.0, "900": 300.0}


def test_gateway_balance_change_pushed(_isolate):
    """gateway 账号余额变化要推送 —— 出入金/平仓结算后卡片才不会滞后。"""
    _push_bal("u1", {"900": 300.0})
    _push_bal("u1", {"900": 412.5})

    assert len(_isolate) == 2
    assert _isolate[1][1]["data"]["balances"] == {"900": 412.5}


# --- 去重状态的内存回收 / de-duplication state cleanup ---

def _forget(monkeypatch, online_users, connected):
    """跑一次清理。connected 指当前有 WS 连接的用户。"""
    monkeypatch.setattr(
        bridge.manager, "connected_user_ids", lambda: list(connected)
    )
    bridge._forget_idle_users(set(online_users))


def test_idle_user_state_dropped(_isolate, monkeypatch):
    """既无在线账号又无 WS 连接的用户，状态要回收。

    这两个字典是模块级的，没有回收就只增不减。
    """
    _push("u1", {"100"}, {"100": 500.0})
    _forget(monkeypatch, online_users=set(), connected=set())

    assert "u1" not in bridge._last_pushed_online
    assert "u1" not in bridge._last_pushed_balances


def test_state_kept_while_page_open(_isolate, monkeypatch):
    """账号离线但页面还开着时，状态必须保留。

    否则桥接一恢复就会因为"没有上次记录"而当成首次观测重推一遍。
    """
    _push("u1", {"100"}, {"100": 500.0})
    _forget(monkeypatch, online_users=set(), connected={"u1"})

    assert bridge._last_pushed_balances["u1"] == {"100": 500.0}


def test_state_kept_while_accounts_online(_isolate, monkeypatch):
    """页面关了但桥接还在跑时，状态同样要保留。"""
    _push("u1", {"100"}, {"100": 500.0})
    _forget(monkeypatch, online_users={"u1"}, connected=set())

    assert bridge._last_pushed_balances["u1"] == {"100": 500.0}


def test_reappearing_user_gets_full_push(_isolate, monkeypatch):
    """被回收的用户再出现时，照常收到一次完整推送。

    这是回收安全的前提：状态没了就等于首次观测，不会静默漏推。
    """
    _push("u1", {"100"}, {"100": 500.0})
    _forget(monkeypatch, online_users=set(), connected=set())

    _push("u1", {"100"}, {"100": 500.0})   # 与回收前完全相同的内容

    assert len(_isolate) == 2
    assert _isolate[1][1]["data"]["balances"] == {"100": 500.0}


def test_cleanup_only_touches_idle_users(_isolate, monkeypatch):
    """回收不影响其他仍然活跃的用户。"""
    _push("u1", {"100"}, {"100": 500.0})
    _push("u2", {"200"}, {"200": 900.0})
    _forget(monkeypatch, online_users={"u2"}, connected=set())

    assert "u1" not in bridge._last_pushed_balances
    assert bridge._last_pushed_balances["u2"] == {"200": 900.0}
