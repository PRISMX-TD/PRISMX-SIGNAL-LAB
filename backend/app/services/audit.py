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
import uuid

from sqlalchemy.orm import Session

from app.models import AdminAuditLog

# 同一会话里「这一次操作」的编号存在 db.info 的这个键下 / session.info key of the op id
_OP_KEY = "audit_op"


def log_change(db: Session, admin_id: str, target_id: str, field: str, old_value, new_value) -> None:
    """值没变就不写（old == new 按字符串比较，None 视为空串）。
    调用方负责 commit。Skips when nothing changed; the caller commits.

    op_id（rev 38）：同一个会话里写的所有行共用一个编号——一个管理请求就是一个会话，
    于是「一次改了会员 + 到期 + 备注」「批量改 30 个人」在操作日志里能合成一行。编号放在
    db.info 里，第一次写时生成；会话关了它也跟着没了，不需要任何事件监听器来清。
    op_id (rev 38): every row written within one session shares one id. An admin
    request is one session, so "plan + expiry + note" or a 30-user bulk edit folds
    into one line in the activity log. It lives in db.info, created on the first
    write and gone with the session — no event listener needed to reset it.
    """
    old_s = "" if old_value is None else str(old_value)
    new_s = "" if new_value is None else str(new_value)
    if old_s == new_s:
        return
    op_id = db.info.setdefault(_OP_KEY, uuid.uuid4().hex[:12])
    db.add(
        AdminAuditLog(
            admin_user_id=admin_id,
            target_user_id=target_id,
            field=field,
            old_value=old_s,
            new_value=new_s,
            op_id=op_id,
        )
    )
