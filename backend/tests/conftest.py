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

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.database import Base, SessionLocal, engine, init_db
from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.main import app
from app.models import MT5Account, Order, Signal, User


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
