"""两个「静默返回错值」型缺陷的回归锁：管理端用户载荷漏字段，以及 PATCH 清不掉
可空字段。

两者的共同点是不报错——接口 200、前端不抛异常、日志里什么都没有，只是某个值悄悄
不对了。这类失败只有测试能拦住。

Regression locks for two silently-wrong-value defects: a missing field in the
admin user payload, and nullable fields that PATCH could not clear. Both fail
without raising — 200 responses, no frontend error, nothing in the log, just a
value quietly wrong. Only a test catches this class.
"""
from app.models import User
from app.routers.admin import _user_out
from app.schemas import AdminUserOut, StrategyUpdate


# ---------- 管理端用户载荷：字段不能漏 ----------


def _mk_user(**kw) -> User:
    base = dict(
        id="u1",
        email="a@b.com",
        phone="+60123456789",
        role="user",
        plan="PRO",
        plan_note="备注",
    )
    base.update(kw)
    return User(**base)


def test_includes_phone():
    """PATCH /admin/users/{id} 曾自己构造 AdminUserOut 且漏了 phone。

    漏了不会报错：phone 在 schema 里默认 None，缺席就是安静地返回 null。前端保存
    后拿响应整行替换列表行，于是管理员每改一次用户，那一行的手机号就空掉。
    """
    out = _user_out(_mk_user(), 2)
    assert out.phone == "+60123456789"


def test_no_phone_stays_none():
    """存量用户本来就没有手机号，此时是真的 null，不是漏字段。"""
    assert _user_out(_mk_user(phone=None), 0).phone is None


def test_covers_every_field_of_the_schema():
    """真正要钉住的不是 phone 这一个字段，而是「schema 加了字段而构造函数没跟上」
    这条路径本身——下一个被漏掉的字段现在还不知道叫什么。

    判据是构造出来的载荷里没有任何字段停留在 schema 默认值上：夹具给每个字段都
    喂了非默认值，所以只要 _user_out 漏传一个，那个字段就会掉回默认值而被抓到。
    """
    out = _user_out(
        _mk_user(created_at=None, last_active_at=None, plan_expires_at=None), 3
    )
    defaults = {
        name: f.default
        for name, f in AdminUserOut.model_fields.items()
        if f.default is not None
    }
    dumped = out.model_dump()
    # createdAt / lastActiveAt / planExpiresAt 三个夹具里就是 None，不参与比对
    nullable_in_fixture = {"createdAt", "lastActiveAt", "planExpiresAt"}
    stuck = [
        name
        for name, default in defaults.items()
        if name not in nullable_in_fixture and dumped[name] == default
    ]
    assert not stuck, f"这些字段停在 schema 默认值上，很可能漏传了: {stuck}"


# ---------- PATCH 可空字段：省略与显式 null 必须分得开 ----------
#
# update_strategy 靠 `字段名 in body.model_fields_set` 区分「没传」与「传了 null」，
# 下面钉住这个前提。前端把编辑器里的 0（不启用）转成 null 发出，判据一旦退回
# `is not None`，用户就再也关不掉这些限制，而保存仍然提示成功。


NULLABLE_FIELDS = ["exitTimeoutBars", "sessionFilter", "dailySignalCap", "cooldownMinutes"]


def test_omitted_field_is_absent_from_fields_set():
    body = StrategyUpdate()
    for name in NULLABLE_FIELDS:
        assert name not in body.model_fields_set
        assert getattr(body, name) is None


def test_explicit_null_is_present_in_fields_set():
    """显式 null 与省略在取值上完全一样（都是 None），只有 model_fields_set 分得开。"""
    body = StrategyUpdate(**{name: None for name in NULLABLE_FIELDS})
    for name in NULLABLE_FIELDS:
        assert name in body.model_fields_set
        assert getattr(body, name) is None


def test_real_value_is_present_too():
    body = StrategyUpdate(exitTimeoutBars=30, dailySignalCap=5, cooldownMinutes=60)
    assert body.model_fields_set >= {"exitTimeoutBars", "dailySignalCap", "cooldownMinutes"}
    assert body.exitTimeoutBars == 30


def test_update_strategy_keys_off_fields_set_not_is_not_none():
    """上面三条钉的是 Pydantic 的前提，钉不住 update_strategy 有没有用上它。

    带 Depends 与限流装饰器的路由在本仓库不做端到端测试（惯例见 test_invite_links），
    所以这里照 test_migration_index_order 的做法对源码做结构断言：这四个可空字段的
    判据必须是 `in body.model_fields_set`，任何一个退回 `body.X is not None` 都会被
    抓住——那正是它们此前关不掉的原因。
    """
    import inspect
    import re

    from app.routers import strategies

    src = inspect.getsource(strategies.update_strategy)
    for name in NULLABLE_FIELDS:
        assert re.search(rf'"{name}" in body\.model_fields_set', src), (
            f"{name} 的判据不是 model_fields_set，显式 null 会被当成「没传」而清不掉"
        )
        assert not re.search(rf"if body\.{name} is not None:", src), (
            f"{name} 退回了 `is not None` 判据，用户将无法把它关掉"
        )
