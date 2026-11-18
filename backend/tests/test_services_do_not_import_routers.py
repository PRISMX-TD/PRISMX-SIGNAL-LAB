"""工程铁律：服务层（app/services）不 import 路由层（app/routers），延迟导入也不行。

2026-11-18 审计时违例已经从 4 处涨到 8 处：被复用的函数一直留在路由文件里，服务要用就
反过来 import。现在都搬进了 services（public_feeds、ticket_notify、invite_trial、
support_desk.apply_comp_days、gamification.periods.resolve_period_key、
gateway_snapshot.position_rows），这条测试防它再长回来。

Iron rule: app/services never imports app/routers, not even lazily. By the 2026-11-18 audit
the violations had grown from 4 to 8; the shared functions now live in services and this
test keeps it that way.
"""
import ast
from pathlib import Path

SERVICES = Path(__file__).resolve().parent.parent / "app" / "services"


def _router_imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if mod == "app.routers" or mod.startswith("app.routers."):
                hits.append(f"{path.name}:{node.lineno} from {mod}")
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "app.routers" or a.name.startswith("app.routers."):
                    hits.append(f"{path.name}:{node.lineno} import {a.name}")
    return hits


def test_services_never_import_routers():
    hits = [h for p in sorted(SERVICES.rglob("*.py")) for h in _router_imports(p)]
    assert not hits, hits
