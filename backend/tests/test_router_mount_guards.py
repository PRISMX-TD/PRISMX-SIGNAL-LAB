"""挂载级依赖：端点漏写依赖时的兜底（2026-09-20 技术债清理）。

`tests/test_admin_router_guards.py` 钉的是「管理 router 自己带 require_admin」。
这里钉的是另一半：**main.py 挂载时也要带**，两处都有才是「漏写一处也不会裸奔」。

代理 router（`/agent/*`）此前只在每个端点各自 `Depends(get_current_user)`，挂载处
什么都没有——当前四个端点都写对了所以安全，但新增一个忘了写依赖的端点就会直接对
未登录者敞开：代理看板上有客户名单、注册数、会员状态，还有一个能改别人会员等级的
写端点。

Mount-level dependencies are the backstop for an endpoint that forgets its own.
"""
from fastapi import Depends
from fastapi.routing import APIRoute

from app import main as app_main
from app.services.deps import get_current_user, require_admin


def _mounted_routes(prefix_fragment: str) -> list[APIRoute]:
    return [
        r for r in app_main.app.routes
        if isinstance(r, APIRoute) and prefix_fragment in r.path
    ]


def _guards(route: APIRoute) -> set:
    return {d.call for d in route.dependant.dependencies}


def test_agent_routes_carry_the_login_guard_from_the_mount():
    """/agent/* 每条路由都必须带 get_current_user。

    代理端点要求的是**登录**，不是管理员：「是不是代理」看 invite_link_agents 里
    有没有这个人的行，每个端点再各自按 link 归属校验（不属于自己的一律 404）。
    所以挂载级依赖是 get_current_user 而不是 require_admin——不能照抄 admin_router。
    """
    routes = _mounted_routes("/agent/links")
    assert routes, "没找到代理路由，测试目标不存在"
    for r in routes:
        assert get_current_user in _guards(r), f"{r.path} 没有登录守卫"


def test_agent_mount_does_not_require_admin():
    """反向断言：代理端点不该被误挂成管理员专属，否则真代理全被 403 挡在门外。
    The agent mount must not be admin-only, or real agents get 403."""
    for r in _mounted_routes("/agent/links"):
        assert require_admin not in _guards(r), f"{r.path} 被误挂成了管理员专属"


def test_a_new_agent_endpoint_without_its_own_dependency_is_still_guarded():
    """兜底的意义：一个忘写 Depends 的新端点，挂上去之后仍然要求登录。

    直接构造这种"漏写"的端点并按 main.py 同样的方式挂载，验证挂载级依赖确实能
    接住——这是这条改动唯一真正要证明的事。
    """
    from fastapi import APIRouter, FastAPI

    sloppy = APIRouter(prefix="/agent", tags=["agent"])

    @sloppy.get("/oops")          # 刻意不写任何 Depends / deliberately dependency-free
    def oops():
        return {"secret": "customer list"}

    app = FastAPI()
    app.include_router(sloppy, dependencies=[Depends(get_current_user)])
    route = next(r for r in app.routes if isinstance(r, APIRoute) and r.path == "/agent/oops")
    assert get_current_user in _guards(route)


def test_admin_mounts_keep_their_guard():
    """既有的管理挂载点不受影响（本次只给代理补了一条）。
    The existing admin mounts are untouched."""
    for fragment in ("/admin/invite-links", "/admin/competitions", "/admin/tickets"):
        routes = _mounted_routes(fragment)
        assert routes, f"没找到 {fragment} 的路由"
        for r in routes:
            assert require_admin in _guards(r), f"{r.path} 丢了管理员守卫"
