"""对外 HTTP 面的三处收口：读接口不再写库、Token 重置有闸门、CORS 不带凭证。

**读接口不再写库**：`get_db` 只 close 不 commit，所以 `GET /automation/settings` 里
「查不到就建一行」的那条 INSERT 必然被回滚——每次 GET 白写一条注定作废的插入，
下次 GET 再来一遍。前端每打开一次设置页就来一趟，纯属浪费库往返（Egress 敏感）。

**Token 重置有闸门**：每次调用都 `db.commit()` 并失效一条桥接鉴权缓存。只影响调用者
自己的 Token，不是安全边界，但没有任何理由允许脚本连打。

**CORS 不带凭证**：全站鉴权只有 Bearer 头，一个 cookie 都不用，`allow_credentials`
没有任何收益；而白名单里的 `https://localhost`（安卓 App 的 WebView origin）本机
任何 HTTPS 开发服务都能冒充。趁它还没有代价的时候关掉。

Three tightenings on the outward HTTP surface: a read endpoint that no longer
writes, a rate limit on token reset, and CORS without credentials.
"""
import pytest
from fastapi.testclient import TestClient

from app.models import AutoManageSettings, User
from app.routers import automation as automation_router


def _user(db) -> User:
    u = User(email="u@t.co", api_token="tok_u", plan="FREE")
    db.add(u)
    db.commit()
    return u


# ---------- GET /automation/settings 不落库 ----------
#
# 直接调路由函数而不是走 TestClient：TestClient 的同步路由在另一个线程上跑，而
# db_session 是内存 SQLite，路由里的 commit 会把跨线程钉住的连接释放掉。这几条测的
# 是"读路径有没有写库"，与 HTTP 层无关，没必要把线程问题引进来。

def test_reading_settings_does_not_create_a_row(db_session):
    user = _user(db_session)

    automation_router.get_settings(db=db_session, user=user)

    assert db_session.query(AutoManageSettings).count() == 0, "读接口不该产生注定回滚的 INSERT"
    assert not db_session.new, "连待写入的对象都不该有"


def test_reading_settings_returns_the_factory_defaults(db_session):
    """没有行 = 全是默认值。答案必须和真落库之后读出来的一模一样，否则前端会看到
    「进页面是一套值，存一次之后又是另一套」。"""
    user = _user(db_session)

    before = automation_router.get_settings(db=db_session, user=user)

    db_session.add(AutoManageSettings(user_id=user.id))
    db_session.commit()
    after = automation_router.get_settings(db=db_session, user=user)

    assert before == after
    assert before.enabled is False and before.beEnabled is True


def test_the_defaults_match_the_model_columns(db_session):
    """默认值有两个出处（schema 的 AutoManageSettingsIn 与模型列），必须钉住它们
    一致——否则哪天改一边，「没存过」与「存过默认值」的用户会看到不同的设置。"""
    user = _user(db_session)
    row = AutoManageSettings(user_id=user.id)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)

    assert automation_router._defaults_out() == automation_router._serialize(row)


def test_saving_still_creates_the_row(db_session):
    """读不落库，写照常落库——否则设置就存不下来了。"""
    user = _user(db_session)
    body = automation_router.AutoManageSettingsIn(enabled=False, beTriggerR=2.0)

    out = automation_router.put_settings(body=body, db=db_session, user=user)

    assert db_session.query(AutoManageSettings).count() == 1
    assert out.beTriggerR == 2.0


# ---------- /ea/token/reset 的限流 ----------

def test_token_reset_is_rate_limited():
    """端点上必须真的挂着 limiter，不是靠注释约定。

    slowapi 把限流登记在 `limiter._route_limits`，键是 `模块.函数名`。
    """
    from app.core.rate_limit import limiter
    from app.routers import ea  # noqa: F401  —— 装饰器要在 import 时才登记

    limits = limiter._route_limits.get("app.routers.ea.reset_token")
    assert limits, "/ea/token/reset 没有 @limiter.limit 装饰"


def test_token_read_is_not_rate_limited():
    """只读的 GET /ea/token 不必限流——别把闸门加到没有代价的地方。"""
    from app.core.rate_limit import limiter
    from app.routers import ea  # noqa: F401

    assert not limiter._route_limits.get("app.routers.ea.get_token")


# ---------- CORS 不带凭证 ----------

def test_cors_does_not_allow_credentials():
    from starlette.middleware.cors import CORSMiddleware

    from app.main import app

    cors = next(m for m in app.user_middleware if m.cls is CORSMiddleware)
    assert cors.kwargs["allow_credentials"] is False


@pytest.mark.parametrize("origin", ["https://prismxsignallab.com", "https://localhost"])
def test_allowed_origins_still_work(origin):
    """关掉凭证不等于关掉跨域：网站与安卓 App 的 origin 照常放行。"""
    from app.main import app

    client = TestClient(app)
    res = client.options(
        "/api/health",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )

    assert res.headers.get("access-control-allow-origin") == origin
    assert "access-control-allow-credentials" not in res.headers
