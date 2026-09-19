"""列表分页与看板时间范围的共用件 / shared list-paging and dashboard-range helpers.

这些东西原先长在 routers/admin.py 里，于是 routers/invite.py 为了拿分页常量和
范围解析就得 `from app.routers.admin import ...`——一个 router 反向依赖另一个
router。services/audit.py 顶部那段迁移说明已经为「services 不该 import router」
做过同样的事；router 之间互相 import 是同一个问题的另一半：

- 循环导入只差一步。admin.py 只要哪天需要 invite 那边的一个函数，import 就成环，
  而报错点会出现在毫不相干的第三个文件里。
- 它让「后台分页上限」这种全站口径看起来像是管理后台的私有实现细节，于是下一个
  需要分页的路由多半会自己再定义一份 50/200，两处从此各走各的。

放在 services 层之后，admin / invite / 将来任何列表端点都从这一处取同一份定义。

These lived in routers/admin.py, which forced routers/invite.py to import from
another router. The note atop services/audit.py made the same move for "services
must not import routers"; router-to-router imports are the other half of it: one
future need in the opposite direction closes an import cycle, and site-wide page
bounds read as a back-office implementation detail that the next list endpoint
will simply redefine. One definition here, shared by every list endpoint.
"""
from datetime import date

from fastapi import HTTPException

from app.services.stats_time import RangeError, RangeSpec, resolve_range
from app.services.stats_time import today as stats_today

# 列表端点的默认页大小与硬上限。上限是 200 而不是「随便传」：名单接口会把整页
# 数据序列化进响应，再叠加每页一轮批量查询，放开等于给自己开一个放大器。
# Default page size and hard ceiling for list endpoints. The ceiling exists
# because a page is serialized in full and carries a batch query per page.
PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 200


def resolve_range_or_422(range_: str | None, from_: date | None, to: date | None) -> RangeSpec:
    """看板的时间范围参数。预设由后端解析（见 stats_time），非法一律 422。
    Dashboard range parameters; presets are resolved server-side, bad input 422s."""
    try:
        return resolve_range(range_, from_, to, stats_today())
    except RangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
