"""自动仓位管理在 gateway 通道上的归属判定与指令执行。

这两件事此前都是断的，任何一件单独存在都能让 gateway 账号的自动仓管彻底不生效
（设置页开关开着，指令一条都不产生 / 产生了也没人执行）：

  1. 归属判定只查 orders.mt5_ticket。Bridge 那侧它恰好等于仓位号（MT5 里仓位号
     就是开仓订单的 ticket），但 gateway 存进去的是订单号**或成交号**，成交号与
     仓位号不是同一套编号，比对永远不中 —— platform_tickets 恒为空，规则一次都
     跑不到。真实仓位号在 mt5_position 上。
  2. 指令只落库为 PENDING 等桥接来取。gateway 没有桥接，/bridge/poll 还会主动
     跳过它们，于是指令挂满 5 分钟后被作废。

用例里的 login / 仓位号 / 成交号取自 test_gateway_closed_trades.py 同一批真实数据。
"""

import pytest

from app.models import AutoManageSettings, MT5Account, Order, User
from app.services import auto_manage
from app.services.auto_manage import evaluate_positions, invalidate_eligibility

# 真实数据：仓位号与成交号是两个不同的编号，正是问题 1 的根源
GATEWAY_POSITION = 17431512
GATEWAY_DEAL = 15525579
GATEWAY_LOGIN = "500039"
BRIDGE_LOGIN = "600144"

# 保本用例的价格：R = |4000 - 3990| = 10，现价 4010 即浮盈 1.0R，刚好触发保本
ENTRY = 4000.0
INITIAL_SL = 3990.0
PRICE_AT_1R = 4010.0


def _position(ticket: int, login: str, take_profit: float = 0.0) -> dict:
    """一条持仓上报，浮盈正好 1R。字段与两条通道推送的格式一致。"""
    return {
        "ticket": ticket,
        "symbol": "XAUUSD.s",
        "side": "BUY",
        "volume": 1.0,
        "profit": 100.0,
        "entryPrice": ENTRY,
        "currentPrice": PRICE_AT_1R,
        "stopLoss": INITIAL_SL,
        "takeProfit": take_profit,
        "login": login,
    }


def _setup(db, *, login: str, source: str, mt5_ticket: int, mt5_position: int | None,
           **settings_kw):
    """建一个开着保本的 PRO 用户 + 一笔本平台开出的已成交订单。

    settings_kw 覆盖自动仓管设置的默认值（默认只开保本）。
    """
    user = User(id=f"u-{login}-{source}", email=f"{login}.{source}@t.local",
                api_token=f"tok-{login}-{source}", plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=user.id, login=login, server="", source=source))
    cfg = dict(enabled=True, be_enabled=True, be_trigger_r=1.0,
               trail_enabled=False, ptp_enabled=False)
    cfg.update(settings_kw)
    db.add(AutoManageSettings(user_id=user.id, **cfg))
    db.add(Order(
        user_id=user.id, client_order_id=f"open-{login}",
        action="ORDER", status="FILLED",
        symbol="XAUUSD.s", side="BUY", volume=1.0,
        mt5_login=login, mt5_ticket=mt5_ticket, mt5_position=mt5_position,
    ))
    db.commit()
    # 评估资格有 30 秒否定缓存，用例之间必须清掉
    invalidate_eligibility(user.id)
    return user.id


@pytest.fixture()
def executed(monkeypatch):
    """拦下 gateway 执行调用，记录被执行的订单。"""
    calls: list[Order] = []

    def _fake_execute(db, order):
        calls.append(order)
        order.status = "FILLED"
        db.commit()
        return {"type": "ORDER_UPDATE", "data": {"clientOrderId": order.client_order_id}}

    import app.routers.orders as orders_router
    monkeypatch.setattr(orders_router, "_try_gateway_execute", _fake_execute)
    # 推送不该在单测里真的发出去
    monkeypatch.setattr(auto_manage, "dispatch_event_push", lambda *a, **k: None)
    return calls


@pytest.fixture()
def pushed(monkeypatch):
    """记录推给前端的 WS 帧。"""
    frames: list[dict] = []

    from app.services.connection_manager import manager

    async def _fake_push(user_id, payload):
        frames.append(payload)

    monkeypatch.setattr(manager, "push_to_client", _fake_push)
    return frames


def test_gateway_position_matched_via_mt5_position(db_session, executed):
    """Gateway：仓位号在 mt5_position 上，必须能认出这笔仓位并下发保本指令。

    只查 mt5_ticket 时这里会一条指令都产生不了 —— 这正是原先的失效表现。
    """
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    created = evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, GATEWAY_LOGIN)])

    assert created == 1
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.ticket == GATEWAY_POSITION
    assert cmd.sl == pytest.approx(ENTRY)  # 保本：止损移到入场价
    assert cmd.mt5_login == GATEWAY_LOGIN


def test_gateway_command_is_executed_not_left_pending(db_session, executed):
    """Gateway：指令必须当场执行掉，不能挂在 PENDING 等一个不存在的桥接。"""
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, GATEWAY_LOGIN)])

    assert len(executed) == 1
    assert executed[0].action == "MODIFY"
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.status != "PENDING"


def test_gateway_execution_pushes_order_update(db_session, executed, pushed):
    """Gateway：执行完要推一帧 ORDER_UPDATE，订单页不必等下一次轮询。

    与 bridge 回执（routers/bridge.py::bridge_result）的口径保持一致。
    """
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, GATEWAY_LOGIN)])

    assert [f["type"] for f in pushed] == ["ORDER_UPDATE"]
    assert pushed[0]["data"]["clientOrderId"].startswith(auto_manage.AUTO_PREFIX)


def test_bridge_position_still_matched_via_mt5_ticket(db_session, executed):
    """Bridge 回归：仓位号存在 mt5_ticket、mt5_position 为空，行为必须不变。"""
    uid = _setup(db_session, login=BRIDGE_LOGIN, source="bridge",
                 mt5_ticket=GATEWAY_POSITION, mt5_position=None)

    created = evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, BRIDGE_LOGIN)])

    assert created == 1
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.sl == pytest.approx(ENTRY)


def test_bridge_command_stays_pending_for_the_bridge_to_fetch(db_session, executed):
    """Bridge 回归：指令必须留在 PENDING 等桥接轮询，绝不能被 gateway 路径执行。"""
    uid = _setup(db_session, login=BRIDGE_LOGIN, source="bridge",
                 mt5_ticket=GATEWAY_POSITION, mt5_position=None)

    evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, BRIDGE_LOGIN)])

    assert executed == []
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.status == "PENDING"


def test_position_not_opened_by_platform_is_ignored(db_session, executed):
    """安全边界：用户自己在 MT5 开的仓（orders 表里没有对应记录）一律不碰。"""
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    # 上报一个完全无关的仓位号
    created = evaluate_positions(db_session, uid, [_position(99999999, GATEWAY_LOGIN)])

    assert created == 0
    assert executed == []
    assert db_session.query(Order).filter(Order.action == "MODIFY").count() == 0


# --------------------------------------------------------------------------
# 只 stub HTTP 边界的集成用例
#
# 上面那批用 `executed` fixture 把 _try_gateway_execute 整段替换掉了，验证的是
# "有没有调到执行"。但指令类型分流（MODIFY→/trade/modify）、ticket 传的是不是
# 仓位号、SL/TP 怎么组装、retcode 怎么映射成 FILLED/REJECTED —— 这些真代码一行
# 都没跑到，而它们恰恰是发到真实券商的那份报文。
#
# 下面这批只拦最外层的 gateway_client._post，中间全部走真实实现，断言的是
# "发给网关的报文逐字段正确"。
# --------------------------------------------------------------------------


@pytest.fixture()
def threaded_db_session():
    """跨线程可用的内存库会话。

    conftest 的 db_session 用 sqlite:// 默认连接池，换个线程会新建连接——而
    内存库的"新连接"就是一个全新的空库，建的表一张都不在。下面那个死锁用例
    要真的在线程池里跑评估，所以这里改用 StaticPool 让所有线程共用同一条连接。

    只有这一个用例需要，故不动共享 fixture。
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


class _GatewayStub:
    """记录发往网关的 (path, body)，并可指定网关的回复。"""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.response = {
            "ok": True, "retcode": "MT_RET_REQUEST_DONE",
            "deal": 0, "order": 0, "price": 0.0,
        }
        # 按 path 覆盖回复（/positions 之类的读接口用）
        self.by_path: dict[str, dict] = {}


@pytest.fixture()
def gateway_http(monkeypatch, pushed):
    """只 stub HTTP，让真实的 _try_gateway_execute 完整跑一遍。"""
    stub = _GatewayStub()

    from app.services import gateway_client

    async def _fake_post(path, body, timeout=None):
        stub.calls.append((path, body))
        return dict(stub.by_path.get(path, stub.response))

    monkeypatch.setattr(gateway_client, "_post", _fake_post)
    monkeypatch.setattr(auto_manage, "dispatch_event_push", lambda *a, **k: None)
    stub.pushed = pushed
    return stub


def test_modify_payload_sent_to_gateway_is_correct(db_session, gateway_http):
    """保本：发出去的必须是 /trade/modify，ticket 是仓位号，且带上原有止盈。

    止盈这一项是安全要害：MODIFY 里 takeProfit=0 会被理解成"清除止盈"，
    漏传就等于自动仓管顺手把用户的止盈抹掉。
    """
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    evaluate_positions(
        db_session, uid,
        [_position(GATEWAY_POSITION, GATEWAY_LOGIN, take_profit=4200.0)],
    )

    assert len(gateway_http.calls) == 1
    path, body = gateway_http.calls[0]
    assert path == "/trade/modify"
    assert body["login"] == int(GATEWAY_LOGIN)
    assert body["ticket"] == GATEWAY_POSITION      # 仓位号，不是成交号
    assert body["stopLoss"] == pytest.approx(ENTRY)
    assert body["takeProfit"] == pytest.approx(4200.0)  # 原有止盈被保留

    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.status == "FILLED"


def test_partial_take_profit_payload_sent_to_gateway_is_correct(db_session, gateway_http):
    """分批止盈：发出去的必须是 /trade/close，且带上要平掉的手数。"""
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION,
                 be_enabled=False, trail_enabled=False,
                 ptp_enabled=True, ptp_trigger_r=1.0, ptp_fraction=0.5)

    evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, GATEWAY_LOGIN)])

    assert len(gateway_http.calls) == 1
    path, body = gateway_http.calls[0]
    assert path == "/trade/close"
    assert body["login"] == int(GATEWAY_LOGIN)
    assert body["ticket"] == GATEWAY_POSITION
    assert body["volume"] == pytest.approx(0.5)  # 1.0 手的 50%

    cmd = db_session.query(Order).filter(Order.action == "CLOSE").one()
    assert cmd.status == "FILLED"


def test_gateway_rejection_maps_to_rejected_status(db_session, gateway_http):
    """网关拒绝时指令必须落成 REJECTED 并带上原因，不能假装成功。"""
    gateway_http.response = {
        "ok": False, "retcode": "MT_RET_REQUEST_INVALID_STOPS",
        "message": "止损距离过近", "deal": 0, "order": 0, "price": 0.0,
    }
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, GATEWAY_LOGIN)])

    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.status == "REJECTED"
    assert "MT_RET_REQUEST_INVALID_STOPS" in cmd.message


def test_executes_without_deadlock_in_production_concurrency_shape(
    threaded_db_session, gateway_http
):
    """复刻生产的并发形态，确认不会死锁。

    这是上面所有用例都覆盖不到、又最容易在线上炸的一段：

      * 生产里 gateway_positions_loop 在主事件循环上 `await
        run_in_threadpool(evaluate_positions, ...)`，评估跑在工作线程里；
      * 而 gateway 调用要靠 run_on_main_loop 用 run_coroutine_threadsafe
        提交回主事件循环，并阻塞该工作线程等结果。

    单测默认 _main_loop 是 None，走的是 asyncio.run() 兜底分支，那条
    「线程池 → 主循环」的真实路径一次都没跑到。若它死锁，全部用例照样全绿，
    线上却是持仓轮询整条卡死。所以这里把主循环真的建起来跑一遍。
    """
    import asyncio

    from starlette.concurrency import run_in_threadpool

    from app.services import gateway_client

    db_session = threaded_db_session
    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    async def _main():
        # gateway_client 在 lifespan 启动时捕获主循环，这里手工复刻
        gateway_client.set_main_loop(asyncio.get_running_loop())
        # 超时即视为死锁：正常路径是毫秒级
        return await asyncio.wait_for(
            run_in_threadpool(
                evaluate_positions, db_session, uid,
                [_position(GATEWAY_POSITION, GATEWAY_LOGIN)],
            ),
            timeout=10,
        )

    try:
        created = asyncio.run(_main())
    finally:
        # 循环已关闭，留着会污染后续用例
        gateway_client._main_loop = None

    assert created == 1
    assert gateway_http.calls[0][0] == "/trade/modify"
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.status == "FILLED"


def test_full_gateway_data_path_from_wire_format_to_modify(db_session, gateway_http):
    """整条 gateway 数据链路：网关 /positions 的原始报文 → 自动仓管发出改单。

    除 socket 外每一层都是真代码：gateway_client.get_positions 的字段解析、
    routers.gateway._read_positions 的键名映射、auto_manage 的规则评估与执行。

    下面的报文字段名照抄 gateway/HttpServer.cs 里 /positions 的 JsonWriter
    输出。这一层与消费方的约定一旦对不上（side 变小写、priceOpen 改名……），
    auto_manage 会静默跳过全部仓位、不报任何错 —— 与本次修复前的失效形态
    一模一样，所以值得用真报文钉住。
    """
    import asyncio

    from app.routers.gateway import _read_positions

    gateway_http.by_path["/positions"] = {
        "ok": True,
        "positions": [{
            "ticket": GATEWAY_POSITION,
            "symbol": "XAUUSD.s",
            "side": "BUY",
            "volume": 1.0,
            "priceOpen": ENTRY,
            "priceCurrent": PRICE_AT_1R,
            "stopLoss": INITIAL_SL,
            "takeProfit": 4200.0,
            "profit": 100.0,
            "comment": "PRISMX-abc123",
        }],
    }

    uid = _setup(db_session, login=GATEWAY_LOGIN, source="gateway",
                 mt5_ticket=GATEWAY_DEAL, mt5_position=GATEWAY_POSITION)

    # 真实的读取 + 映射
    rows, ok = asyncio.run(_read_positions(GATEWAY_LOGIN))
    assert ok
    assert len(rows) == 1

    # 真实的规则评估 + 执行
    created = evaluate_positions(db_session, uid, rows)
    assert created == 1

    modify = [c for c in gateway_http.calls if c[0] == "/trade/modify"]
    assert len(modify) == 1
    body = modify[0][1]
    assert body["login"] == int(GATEWAY_LOGIN)
    assert body["ticket"] == GATEWAY_POSITION
    assert body["stopLoss"] == pytest.approx(ENTRY)
    assert body["takeProfit"] == pytest.approx(4200.0)


def test_bridge_never_reaches_the_gateway(db_session, gateway_http):
    """Bridge 回归：指令绝不能被发到网关，必须留给桥接轮询。"""
    uid = _setup(db_session, login=BRIDGE_LOGIN, source="bridge",
                 mt5_ticket=GATEWAY_POSITION, mt5_position=None)

    evaluate_positions(db_session, uid, [_position(GATEWAY_POSITION, BRIDGE_LOGIN)])

    assert gateway_http.calls == []
    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.status == "PENDING"
