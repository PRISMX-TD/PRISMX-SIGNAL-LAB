"""管理员操作留痕 / admin audit trail.

一条 AdminAuditLog = 「谁、把哪个用户的哪个字段、从什么改成了什么」。平台设置、
邀请链接、比赛终审这类没有目标用户的操作沿用同一张表：`target_user_id` 用操作者
自己占位，`field` 加 `setting:` / `invite:` / `plan:` 之类前缀区分（见 admin.py）。

以前这个函数是 routers/admin.py 里的 `_log_change`，routers/competitions.py 从
router 反向 import 它——services 层（比赛终审）依赖 routers 层，将来拆模块时会
绕不开。搬到 services 之后两边都从这里拿；admin.py 保留同名别名，调用点不动。
Moved out of routers/admin.py so services no longer import from a router;
admin.py keeps a same-named alias so its call sites are untouched.
"""
from sqlalchemy.orm import Session

from app.models import AdminAuditLog


def log_change(db: Session, admin_id: str, target_id: str, field: str, old_value, new_value) -> None:
    """值没变就不写（old == new 按字符串比较，None 视为空串）。
    调用方负责 commit。Skips when nothing changed; the caller commits."""
    old_s = "" if old_value is None else str(old_value)
    new_s = "" if new_value is None else str(new_value)
    if old_s == new_s:
        return
    db.add(
        AdminAuditLog(
            admin_user_id=admin_id,
            target_user_id=target_id,
            field=field,
            old_value=old_s,
            new_value=new_s,
        )
    )
