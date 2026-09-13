"""连不上 FCM 的设备：通知经 WebSocket 再送一份（PUSH_FALLBACK）。

大陆网络连不上 Google 的服务器，那些设备永远拿不到 FCM token，也就永远不会有
PushSubscription 行——每个推送函数里的「没有订阅就返回」对它们恒成立。后端因此在
做出「这个用户该收到这条通知」的**同一处**，把标题正文经 WebSocket 再发一份。

这一组钉的是三件事，任何一件坏掉，症状都是"大陆用户照旧一条收不到"，
而这和他们本来就收不到的样子一模一样，不会有任何报错指向这里：
  1. 只发给此刻真的在线的人（离线的发了也是白发，还多一次 Redis publish）
  2. 消息形状就是前端读的那几个字段
  3. 兜底失败绝不能把正常的推送路径带崩

Devices that can never reach FCM: the same notification mirrored over the
WebSocket. See the module docstring of push_dispatch._ws_fallback.
"""
import app.services.push_dispatch as pd


class _FakeManager:
    def __init__(self, online):
        self._online = list(online)
        self.sent = []

    def connected_user_ids(self):
        return list(self._online)

    def push_to_client(self, user_id, message):
        # 真实现是协程；这里返回的对象由假的 run_on_main_loop 直接消费，
        # 不进事件循环，所以返回什么都行——记下来就够了。
        self.sent.append((user_id, message))
        return ("coro", user_id, message)


def _patch(monkeypatch, manager, run=None):
    """把 _ws_fallback 里那两个延迟 import 的目标换掉。

    它是在函数体内 `from app.services.connection_manager import manager` 的（避免
    模块级循环导入），所以要打在**被导入的那个模块**上，不是 push_dispatch 上。
    """
    import app.services.connection_manager as cm
    import app.services.gateway_client as gc
    monkeypatch.setattr(cm, "manager", manager)
    monkeypatch.setattr(gc, "run_on_main_loop", run or (lambda coro, timeout: None))


def test_只发给在线的人(monkeypatch):
    m = _FakeManager(["u1", "u3"])
    _patch(monkeypatch, m)
    pd._ws_fallback(["u1", "u2", "u3"], "标题", "正文")
    assert [uid for uid, _ in m.sent] == ["u1", "u3"]


def test_没人在线时一次都不发(monkeypatch):
    m = _FakeManager([])
    _patch(monkeypatch, m)
    pd._ws_fallback(["u1", "u2"], "标题", "正文")
    assert m.sent == []


def test_重复的用户只发一次(monkeypatch):
    m = _FakeManager(["u1"])
    _patch(monkeypatch, m)
    pd._ws_fallback(["u1", "u1", "u1"], "标题", "正文")
    assert len(m.sent) == 1


def test_消息形状就是前端读的那几个字段(monkeypatch):
    m = _FakeManager(["u1"])
    _patch(monkeypatch, m)
    pd._ws_fallback(["u1"], "新信号 XAUUSD", "BUY · AIFT", url="/app", tag="t-1")
    _uid, msg = m.sent[0]
    assert msg["type"] == pd.WS_PUSH_FALLBACK == "PUSH_FALLBACK"
    assert msg["data"] == {"title": "新信号 XAUUSD", "body": "BUY · AIFT", "url": "/app", "tag": "t-1"}


def test_没给url和tag时不写进去(monkeypatch):
    m = _FakeManager(["u1"])
    _patch(monkeypatch, m)
    pd._ws_fallback(["u1"], "标题", "正文")
    _uid, msg = m.sent[0]
    assert msg["data"] == {"title": "标题", "body": "正文"}


def test_下发失败不抛出去(monkeypatch):
    # 兜底路径炸了只能吞掉：它的调用点就在真正的推送发送之前，抛出去等于
    # 让一条本来能正常推送的通知因为兜底失败而整条丢掉。
    def boom(coro, timeout):
        raise RuntimeError("主循环没了")

    m = _FakeManager(["u1"])
    _patch(monkeypatch, m, run=boom)
    pd._ws_fallback(["u1"], "标题", "正文")  # 不抛即通过


def test_在线名单读不出来时不抛也不发(monkeypatch):
    class _Broken(_FakeManager):
        def connected_user_ids(self):
            raise RuntimeError("Redis 挂了")

    m = _Broken(["u1"])
    _patch(monkeypatch, m)
    pd._ws_fallback(["u1"], "标题", "正文")
    assert m.sent == []
