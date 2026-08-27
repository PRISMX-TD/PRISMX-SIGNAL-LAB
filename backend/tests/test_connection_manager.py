"""ConnectionManager 的推送去重与死连接清理测试。

这两条逻辑都影响长期运行时的表现，而且出错的方式都比较隐蔽：去重做错会让前端
收不到持仓更新（看起来像"卡住"），死连接不清会让推送对着已断开的 socket 白发。

被测方法都是 async 的，这里用 asyncio.run 直接驱动，不引入 pytest-asyncio ——
项目的 requirements.txt 里连 pytest 都没有，为几个用例加插件依赖不值得。
"""

import asyncio

from app.services.connection_manager import ConnectionManager


class FakeWS:
    """记录收到的消息的 WebSocket 替身。fail=True 时模拟对端已断开。"""

    def __init__(self, fail: bool = False):
        self.sent: list[dict] = []
        self.fail = fail

    async def send_json(self, message: dict) -> None:
        if self.fail:
            raise RuntimeError("connection closed")
        self.sent.append(message)


POS = [{"login": "1", "ticket": 1, "profit": 5.0}]


def test_identical_snapshot_pushed_once():
    """内容不变的第二拍不重复发送。

    休市或行情不动时每拍内容完全一样，照发白费带宽和前端解析。
    """
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", POS)
        await m.push_positions("u1", POS)
        return ws

    assert len(asyncio.run(scenario()).sent) == 1


def test_changed_snapshot_pushed_again():
    """内容变化必须照发 —— 去重不能把真实更新吃掉。"""
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", POS)
        await m.push_positions("u1", [{"login": "1", "ticket": 1, "profit": 7.0}])
        return ws

    ws = asyncio.run(scenario())
    assert len(ws.sent) == 2
    assert ws.sent[1]["funds"] == [{"login": "1", "profit": 7.0}]


def test_profit_only_change_still_pushed():
    """只有浮盈变化（仓位数量不变）也要推。

    这是最常见的一拍：持仓没变但盈亏在跳。若去重只比对仓位列表就会漏掉它，
    账户卡片会僵在旧数字上。
    """
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", [{"login": "1", "ticket": 1, "profit": 1.0}])
        await m.push_positions("u1", [{"login": "1", "ticket": 1, "profit": 1.01}])
        return ws

    assert len(asyncio.run(scenario()).sent) == 2


def test_new_connection_resets_dedup():
    """新连接（含新标签页）要能立刻收到当前快照。

    去重状态是按 user 存的。如果新连上来时不重置，而持仓恰好没有变化，
    新页面就会一直空着，直到持仓真的发生变动。
    """
    async def scenario():
        m = ConnectionManager()
        first = FakeWS()
        await m.register_client("u1", first)
        await m.push_positions("u1", POS)

        second = FakeWS()
        await m.register_client("u1", second)
        await m.push_positions("u1", POS)   # 内容与上一拍相同
        return second

    assert len(asyncio.run(scenario()).sent) == 1


def test_positions_cached_even_when_push_skipped():
    """被跳过的那拍也要更新缓存，供重连补推使用。"""
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", POS)
        await m.push_positions("u1", POS)
        return m.get_positions("u1")

    assert asyncio.run(scenario()) == POS


def test_sources_do_not_overwrite_each_other():
    """bridge 与 gateway 各推自己那批账号时，两边持仓都要在快照里。

    混用两种账号的用户曾经出现持仓行来回闪烁：两条上报路径共用一份快照，
    后到的一方把先到的覆盖掉，前端整表替换后就少了几行。
    """
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", POS, source="bridge")
        await m.push_positions(
            "u1", [{"login": "2", "ticket": 9, "profit": 3.0}], source="gateway"
        )
        return ws, m.get_positions("u1")

    ws, cached = asyncio.run(scenario())
    assert [p["login"] for p in ws.sent[-1]["data"]] == ["1", "2"]
    assert ws.sent[-1]["funds"] == [
        {"login": "1", "profit": 5.0},
        {"login": "2", "profit": 3.0},
    ]
    assert [p["login"] for p in cached] == ["1", "2"]


def test_source_flat_snapshot_removes_only_its_own_rows():
    """某来源清空持仓时，只清掉它自己的行，另一来源保留。"""
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", POS, source="bridge")
        await m.push_positions(
            "u1", [{"login": "2", "ticket": 9, "profit": 3.0}], source="gateway"
        )
        await m.push_positions("u1", [], source="gateway")
        return ws.sent[-1]["data"]

    assert asyncio.run(scenario()) == POS


def test_dead_connection_removed():
    """发送失败的连接要被剔除，不能每拍都对它白发一次。"""
    async def scenario():
        m = ConnectionManager()
        await m.register_client("u1", FakeWS(fail=True))
        await m.push_to_client("u1", {"type": "PING"})
        return m.connected_user_ids()

    assert asyncio.run(scenario()) == []


def test_live_connection_survives_dead_peer():
    """同一用户下，一个连接坏掉不影响另一个。

    多标签页场景：关掉一个标签不该让另一个也收不到推送。
    """
    async def scenario():
        m = ConnectionManager()
        live = FakeWS()
        await m.register_client("u1", FakeWS(fail=True))
        await m.register_client("u1", live)

        await m.push_to_client("u1", {"type": "PING"})
        first_round = (m.connected_user_ids(), len(live.sent))

        # 坏连接已被移除，第二次推送不该再尝试它
        await m.push_to_client("u1", {"type": "PING"})
        return first_round, len(live.sent)

    (users, after_first), after_second = asyncio.run(scenario())
    assert users == ["u1"]
    assert after_first == 1
    assert after_second == 2


def test_dedup_state_cleared_on_last_disconnect():
    """最后一个连接断开时清掉去重状态，避免随用户数累积。"""
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await m.push_positions("u1", POS)
        await m.unregister_client("u1", ws)
        return m._last_positions_push

    assert asyncio.run(scenario()) == {}


def test_concurrent_pushes_do_not_duplicate():
    """并发推送同一份快照时不会重复发送。

    gateway 现在并发处理多个用户，虽然同一 user 仍由单一任务处理，
    这条用例把"去重不依赖调用顺序"这个性质固定下来。
    """
    async def scenario():
        m = ConnectionManager()
        ws = FakeWS()
        await m.register_client("u1", ws)
        await asyncio.gather(*(m.push_positions("u1", POS) for _ in range(5)))
        return ws

    assert len(asyncio.run(scenario()).sent) == 1
