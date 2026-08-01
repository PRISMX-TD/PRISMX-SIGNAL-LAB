"""测试夹具：独立 SQLite 库 + TestClient + 造数工具。
Test fixtures: isolated SQLite DB + TestClient + data helpers.

必须在导入任何 app 模块之前设置环境变量（engine 在导入时按 DATABASE_URL 创建）。
Env vars must be set before importing any app module (the engine is created at
import time from DATABASE_URL).
"""
import os
import sys

os.environ["DATABASE_URL"] = "sqlite:///./test_prismx.db"
os.environ["ENABLE_MOCK_SIGNAL_ENGINE"] = "false"
os.environ["ENV"] = "development"
# 推送测试需要非空的 VAPID 配置：密钥缺失时 dispatch_push 会在调用 webpush 之前
# 就静默 return，mock 永远不会被触达。值本身不需要是真钥匙——webpush 全程被 mock。
# Push tests need non-empty VAPID config: with keys missing, dispatch_push
# returns before ever calling webpush, so the mock is never reached. The values
# needn't be real keys — webpush is mocked throughout.
os.environ["VAPID_PRIVATE_KEY_DER"] = "test-private-key-not-real"
os.environ["VAPID_PUBLIC_KEY"] = "test-public-key-not-real"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine, init_db
from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.main import app
from app.models import MT5Account, Order, Signal, User


def trading_session_now() -> datetime:
    """返回一个落在外汇交易时段内的"现在",供需要造 K 线的测试用作时间基准。

    candle_store.persist_closed_bars() 会拒收落在周末休市窗口(周五 21:00 UTC 至
    周日 21:00 UTC)内的非加密品种 bar。任何用 datetime.now() 造 XAUUSD/EURUSD 等
    K 线的测试,在周末跑就会因为数据根本没入库而失败,平时跑却是绿的——测试结果取决
    于跑测试的那一天。更糟的是断言"不产生信号"那类测试会在周末因为错误的原因而通过
    (数据被闸门拦掉,而不是被测逻辑判断为不该出信号),掩盖真实回归。

    这里在周末把基准平移到最近的周五 12:00 UTC(伦敦/纽约重叠时段正中,离两侧边界
    都有余量);工作日直接返回真实当前时间,保持与真实时钟一致。

    A "now" that lands inside an FX trading session, for tests that build candles.

    candle_store.persist_closed_bars() rejects non-crypto bars stamped inside the
    weekend close (Friday 21:00 UTC to Sunday 21:00 UTC). Any test building
    XAUUSD/EURUSD candles from datetime.now() fails on a weekend run — because the
    data never persists — yet passes on weekdays, making the outcome depend on the
    day it runs. Worse, tests asserting "no signal is produced" would pass on
    weekends for the wrong reason (the gate dropped the data, rather than the logic
    under test deciding against a signal), masking real regressions.

    On weekends this shifts the anchor to the most recent Friday 12:00 UTC (mid
    London/New York overlap, clear of both boundaries); on weekdays it returns the
    real current time so it stays aligned with the actual clock.
    """
    now = datetime.now(timezone.utc)
    weekday = now.weekday()
    if weekday == 5:  # 周六 / Saturday
        days_back = 1
    elif weekday == 6:  # 周日 / Sunday
        days_back = 2
    elif weekday == 4 and now.hour >= 21:  # 周五收盘后 / Friday after the close
        days_back = 0
    else:
        return now
    return (now - timedelta(days=days_back)).replace(
        hour=12, minute=0, second=0, microsecond=0
    )


def trading_session_epoch() -> int:
    """trading_session_now() 的 epoch 秒版本 / epoch-seconds form of the above."""
    return int(trading_session_now().timestamp())


@pytest.fixture()
def db():
    """每个测试用干净的表 / fresh tables per test."""
    Base.metadata.drop_all(bind=engine)
    init_db()
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture()
def client(db):
    # 不用 with：避免触发 lifespan 里的后台任务 / no `with`: skip lifespan background tasks
    return TestClient(app)


@pytest.fixture()
def user_token():
    """Bridge 用的明文 API Token（数据库只存其哈希）。
    Plaintext API token for the bridge (only its hash lands in the DB)."""
    return generate_api_token()


@pytest.fixture()
def user(db, user_token):
    u = User(email="tester@example.com", password_hash="x", api_token=hash_api_token(user_token))
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture()
def auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.fixture()
def bridge_headers(user, user_token):
    return {"X-Api-Token": user_token}


def make_signal(db, minutes_left: float = 10.0, **kw) -> Signal:
    now = datetime.now(timezone.utc)
    sig = Signal(
        symbol=kw.get("symbol", "XAUUSD"),
        side=kw.get("side", "BUY"),
        entry=kw.get("entry", 2350.0),
        stop_loss=kw.get("stop_loss", 2340.0),
        take_profit=kw.get("take_profit", 2370.0),
        indicator="test",
        status="EXPIRED" if minutes_left <= 0 else "ACTIVE",
        created_at=now,
        expire_at=now + timedelta(minutes=minutes_left),
    )
    db.add(sig)
    db.commit()
    db.refresh(sig)
    return sig


# 合作券商锁默认启用（settings_store.BROKER_DEFAULTS，关键字 "MakeCapital"）。
# 桥接上报的账号服务器名必须命中该关键字，才能通过券商锁、上线并接收指令；
# 因此测试造的账号与轮询上报都用这个服务器名（poll 辅助函数从这里导入复用）。
# The partner-broker lock is enabled by default (settings_store.BROKER_DEFAULTS,
# keyword "MakeCapital"). A reported account's server name must contain it to
# pass the lock, come online and receive commands — so both the accounts made
# in tests and the poll payloads use this server name (the poll helper imports
# it from here to stay in sync).
BROKER_SERVER = "MakeCapital-Demo"


def make_account(db, user, login="10001", equity=None, server=BROKER_SERVER) -> MT5Account:
    acc = MT5Account(user_id=user.id, login=login, server=server, equity=equity)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return acc


def get_order(db, order_id: str) -> Order:
    db.expire_all()
    return db.query(Order).filter(Order.id == order_id).first()
