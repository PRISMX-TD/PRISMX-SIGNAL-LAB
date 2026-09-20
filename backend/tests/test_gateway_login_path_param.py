"""`POST /gateway/account/{login}/refresh` 的路径参数要按 LOGIN_PATTERN 校验。

函数体里 `int(login)` 是无条件的。不校验路径参数时，一个非数字的 login 只要在库里
配得上（历史脏数据、手工插入的行、将来支持非数字账号的券商）就会在那一行抛
ValueError，端点回 500——而正确答案是「这个路径参数本来就不合法」，应当 422。
请求体里的 login 早就按 `LOGIN_PATTERN` 校验了（`schemas.py`、`routers/bridge.py`
多处），路径参数没跟上属于口径漏了一处。

The path parameter must be validated like every other login; without it a
non-numeric value reaches an unconditional int() and surfaces as a 500.
"""
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.core.database import get_db
from app.models import User
from app.routers import gateway as gateway_router
from app.schemas import LOGIN_PATTERN
from app.services.deps import get_current_user


def _client(db_session):
    user = User(email="g@t.co", api_token="tok_g")
    db_session.add(user)
    db_session.commit()
    # TestClient 在工作线程里跑，内存 SQLite 引擎没配 StaticPool：取一次连接把它
    # 钉在这个 Session 上，否则工作线程会另开一个连接、看到的是一个空库。
    # 必须在**最后一次 commit 之后**——commit 会把连接还回池子。
    # Pin the connection after the last commit (a commit returns it to the pool).
    db_session.connection()
    app = FastAPI()
    # 这个端点挂了 @limiter.limit，slowapi 要从 app.state 上找到 limiter。
    # The endpoint is rate-limited; slowapi looks the limiter up on app.state.
    from app.core.rate_limit import limiter
    app.state.limiter = limiter
    app.include_router(gateway_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app, raise_server_exceptions=False)


def test_non_numeric_login_is_422_not_500(db_session):
    """字母 login → 422（参数不合法），不是 500，也不该走到查库那一步。"""
    res = _client(db_session).post("/gateway/account/abc/refresh")
    assert res.status_code == 422, res.text


def test_absurdly_long_login_is_rejected(db_session):
    """LOGIN_PATTERN 上限 20 位；超长值同样在路由层就被挡下。"""
    res = _client(db_session).post("/gateway/account/" + "9" * 30 + "/refresh")
    assert res.status_code == 422, res.text


def test_well_formed_unknown_login_still_reaches_the_404(db_session):
    """合法但不存在的账号仍走原有语义（404），校验没有改变正常路径。
    A well-formed but unknown login keeps its original 404."""
    res = _client(db_session).post("/gateway/account/601144/refresh")
    assert res.status_code == 404, res.text


def test_path_param_uses_the_same_pattern_as_request_bodies():
    """校验用的是同一个 LOGIN_PATTERN，而不是就地另写一个正则。
    The same pattern as every request body, not a second hand-rolled regex."""
    route = next(
        r for r in gateway_router.router.routes
        if isinstance(r, APIRoute) and r.path.endswith("/refresh")
    )
    param = next(p for p in route.dependant.path_params if p.name == "login")
    assert param.field_info.metadata
    patterns = [getattr(m, "pattern", None) for m in param.field_info.metadata]
    assert LOGIN_PATTERN in patterns
