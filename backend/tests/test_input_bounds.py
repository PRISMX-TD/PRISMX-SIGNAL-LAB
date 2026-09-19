"""入参边界：非数值的浮点（NaN / Inf）与密码的真实长度上限。

**NaN 为什么必须拦在 schema。** 路由层的夹取对它完全无效：`max(nan, 0.0)` 还是
nan，`min(nan, 1800)` 还是 nan。一条 `{"path":"/x","seconds":NaN}` 的页面停留上报
就能把对应小时桶的 total_seconds 变成 NaN，均值与全站均值跟着 NaN，看板吐出的
JSON 连合法都不是（裸 `NaN` 不是 JSON），而且随桶累加不会自愈——只能手工改库。
同类的还有管理端的 minBaselineUsd：NaN 参与比较恒为 False，门槛等于形同虚设。

**密码为什么按字节。** bcrypt 只看前 72 字节（core/security._to_72），后面的被静默
丢弃：两个只在第 73 字节之后不同的密码在登录时是同一个密码。原来的 max_length=128
按字符算，而一个汉字在 UTF-8 里占 3 字节——24 个汉字就到顶，用户以为「更长更安全」
其实后面全白打。设置密码的入口（注册 / 重置）按字节卡住并明确告知；登录侧刻意不
收紧，否则存量里密码超过 72 字节的用户会被直接挡在门外。

Input bounds: non-numeric floats (NaN / Inf) and the real password length cap.
"""
import pytest
from pydantic import ValidationError

from app.schemas import (
    MAX_PASSWORD_BYTES,
    AuthRequest,
    CompetitionCreateIn,
    GamificationSettingsPatchIn,
    ModifyPositionRequest,
    OrderRequest,
    PageViewIn,
    RegisterRequest,
    ResetPasswordRequest,
)

BAD_FLOATS = [float("nan"), float("inf"), float("-inf")]


# ---------- 页面停留时长 / page dwell time ----------

def test_page_view_rejects_nan_from_raw_json():
    """必须挡住**原始 JSON** 里的裸 NaN——pydantic v2 默认是放行的，真实请求走的就是这条路。"""
    with pytest.raises(ValidationError):
        PageViewIn.model_validate_json('{"path":"/x","seconds":NaN}')


@pytest.mark.parametrize("bad", BAD_FLOATS)
def test_page_view_rejects_non_numeric_seconds(bad):
    with pytest.raises(ValidationError):
        PageViewIn(path="/x", seconds=bad)


def test_page_view_rejects_negative_seconds():
    """负的停留时长没有任何合法产生路径，只能来自坏客户端。"""
    with pytest.raises(ValidationError):
        PageViewIn(path="/x", seconds=-1.0)


def test_page_view_still_accepts_an_over_long_visit():
    """上限依旧交给路由层夹取：挂着页面不看是常态，不该 422 掉整次访问计数。"""
    assert PageViewIn(path="/x", seconds=99999.0).seconds == 99999.0
    assert PageViewIn(path="/x", seconds=0.0).seconds == 0.0


# ---------- 管理端门槛 / admin gates ----------

@pytest.mark.parametrize("bad", BAD_FLOATS)
def test_min_baseline_rejects_non_numeric(bad):
    """NaN 门槛会让所有比较恒为 False，等于门槛没开——比报错更难发现。"""
    with pytest.raises(ValidationError):
        GamificationSettingsPatchIn(minBaselineUsd=bad)
    with pytest.raises(ValidationError):
        CompetitionCreateIn(
            name="n", metric="return", enrollment="auto",
            startsAt="2026-01-01T00:00:00", endsAt="2026-02-01T00:00:00",
            minBaselineUsd=bad,
        )


def test_min_baseline_accepts_a_real_number_and_none():
    assert GamificationSettingsPatchIn(minBaselineUsd=100.0).minBaselineUsd == 100.0
    assert GamificationSettingsPatchIn().minBaselineUsd is None


# ---------- 下单与改单的止损止盈 / order SL·TP ----------

@pytest.mark.parametrize("bad", BAD_FLOATS)
def test_order_stops_reject_non_numeric(bad):
    """无穷大的止损价会被原样发到 MT5；没有任何合法用途，拦在入口。"""
    with pytest.raises(ValidationError):
        OrderRequest(symbol="XAUUSD", side="BUY", volume=0.1, clientOrderId="c1", stopLoss=bad)
    with pytest.raises(ValidationError):
        ModifyPositionRequest(clientOrderId="c1", ticket=1, symbol="XAUUSD", side="BUY", takeProfit=bad)


def test_order_stops_accept_normal_prices():
    assert OrderRequest(
        symbol="XAUUSD", side="BUY", volume=0.1, clientOrderId="c1",
        stopLoss=3300.0, takeProfit=3400.0,
    ).stopLoss == 3300.0


# ---------- 密码长度 / password length ----------

def _ok_kwargs(password: str) -> dict:
    return {"email": "u@t.co", "password": password, "phoneCountry": "60", "phone": "123456789"}


def test_registration_rejects_passwords_past_the_bcrypt_limit():
    with pytest.raises(ValidationError) as err:
        RegisterRequest(**_ok_kwargs("a" * (MAX_PASSWORD_BYTES + 1)))
    # 提示必须说清是「字节」以及为什么，否则用户只会看到一个数不上的长度
    assert "字节" in str(err.value) and "bytes" in str(err.value)


def test_the_limit_counts_bytes_not_characters():
    """25 个汉字 = 75 字节，早于 128 字符就该被拒——这正是原来漏掉的那一类密码。"""
    with pytest.raises(ValidationError):
        RegisterRequest(**_ok_kwargs("密" * 25))
    assert RegisterRequest(**_ok_kwargs("密" * 24)).password == "密" * 24   # 72 字节，刚好到顶


def test_reset_uses_the_same_rule_as_registration():
    """两个设密码的入口规则必须一致，否则会出现「注册时能用、重置时被拒」。"""
    with pytest.raises(ValidationError):
        ResetPasswordRequest(token="t" * 20, password="a" * (MAX_PASSWORD_BYTES + 1))
    assert ResetPasswordRequest(token="t" * 20, password="a" * MAX_PASSWORD_BYTES)


def test_login_is_deliberately_not_tightened():
    """存量里可能已有超过 72 字节的密码，bcrypt 用前 72 字节照样验得通——
    在登录侧收紧只会把这些人锁在门外，而不解决任何问题。"""
    assert AuthRequest(email="u@t.co", password="a" * 100).password == "a" * 100


def test_the_limit_matches_what_bcrypt_actually_reads():
    """上限不是随手定的数字，必须等于 core/security 真正喂给 bcrypt 的字节数。"""
    from app.core.security import _to_72

    assert len(_to_72("a" * 200)) == MAX_PASSWORD_BYTES
    assert len(_to_72("密" * 200)) == MAX_PASSWORD_BYTES
