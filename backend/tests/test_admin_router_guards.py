"""管理路由的守卫必须长在 router 自己身上。

gamification / competitions 两组管理接口以前只靠 main.py 挂载处的
dependencies=[Depends(require_admin)]，单独 include_router 这个对象就裸奔。
现在 APIRouter 自带 require_admin，与工单 / 邀请链接两组一致。这里对四组管理
router 统一断言：不管在哪挂载，每个路由都带 require_admin。
Admin routers must carry require_admin themselves, not only via main.py.
"""
from fastapi import FastAPI

from app.routers import competitions, gamification, invite, tickets
from app.services.deps import require_admin


def _all_routes_guarded(router) -> bool:
    app = FastAPI()
    app.include_router(router)           # 刻意不传 dependencies：模拟"单独挂载"
    routes = [r for r in app.routes if getattr(r, "dependant", None) is not None]
    assert routes, "router 没有任何路由"
    for r in routes:
        calls = {d.call for d in r.dependant.dependencies}
        if require_admin not in calls:
            return False
    return True


def test_gamification_and_competition_admin_routers_guard_themselves():
    assert _all_routes_guarded(gamification.admin_router)
    assert _all_routes_guarded(competitions.admin_router)


def test_ticket_and_invite_admin_routers_still_guarded():
    assert _all_routes_guarded(tickets.admin_router)
    assert _all_routes_guarded(invite.admin_router)
