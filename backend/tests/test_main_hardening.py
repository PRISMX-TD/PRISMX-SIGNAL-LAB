"""main.py 的两条挂载级防线：生产环境不开放接口文档；管理 router 挂载处兜一层 require_admin。

Two mount-level guards in main.py: no API docs in production, and the admin router
carries require_admin at the mount as a backstop.
"""
import os
import subprocess
import sys
from pathlib import Path

from fastapi.routing import APIRoute

from app.core.config import settings
from app.main import app
from app.routers import admin
from app.services.deps import require_admin

BACKEND = Path(__file__).resolve().parents[1]


def test_every_admin_router_route_has_the_mount_level_require_admin():
    """将来新加的 /admin 端点忘了写依赖，挂载处这一层也照样挡住普通用户。
    A future /admin endpoint that forgets its dependency is still covered by the mount."""
    admin_paths = {settings.API_PREFIX + r.path for r in admin.router.routes if isinstance(r, APIRoute)}
    mounted = [r for r in app.routes if isinstance(r, APIRoute) and r.path in admin_paths]
    assert mounted, "admin router not mounted"
    for route in mounted:
        assert any(d.dependency is require_admin for d in route.dependencies), route.path


def test_docs_are_served_outside_production():
    assert settings.ENV.lower() != "production"
    assert app.openapi_url == "/openapi.json"


def test_docs_are_disabled_in_production():
    """ENV=production 时 /docs、/redoc、/openapi.json 全部关掉。子进程里按生产配置导入，
    只给过启动校验所需的最小环境变量。
    With ENV=production all three are off. Imported in a subprocess with just enough
    env to pass the production startup checks."""
    env = dict(
        os.environ,
        PYTHONUTF8="1",
        ENV="production",
        JWT_SECRET="k" * 64,
        WEBHOOK_SECRET="test-webhook-secret",
        ENABLE_MOCK_SIGNAL_ENGINE="false",
        NOWPAYMENTS_SANDBOX="false",
        MAIL_DEBUG_LOG_LINKS="false",
    )
    proc = subprocess.run(
        [sys.executable, "-c", "from app.main import app; print(app.openapi_url, app.docs_url, app.redoc_url)"],
        cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout.strip().splitlines()[-1] == "None None None"
