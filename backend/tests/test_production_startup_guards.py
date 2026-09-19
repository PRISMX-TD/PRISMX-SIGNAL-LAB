"""生产启动硬拒：弱 JWT_SECRET 与打开的 MAIL_DEBUG_LOG_LINKS。

**为什么用子进程测。** 这几条检查是 core/config.py 的模块级语句，只在**第一次
import** 时跑一遍。在同一个 pytest 进程里无论怎么改 settings 都触发不到，只有另起
一个解释器、带着那份环境变量去 import 才是真正跑过的那条路径。

**为什么这两条要有闸门。** JWT_SECRET 只比对「是不是那个默认字面量」的话，
`JWT_SECRET=secret` 这种自己换过但能离线爆破的值照样通行，而 HS256 的全部安全性就
在这一个字符串上——还原出来就能签任意 sub 的 token。MAIL_DEBUG_LOG_LINKS 打开后
找回密码的完整链接会写进日志，拿到日志即可接管任意账号；它和另外四项危险开关是
同一类「漏配一行 .env 就出事」，此前却只有一句注释拦着。

Production startup refusals: a weak JWT_SECRET and MAIL_DEBUG_LOG_LINKS left on.
Tested in a subprocess because the checks are module-level statements in
core/config.py that run once, at first import — no in-process settings juggling
reaches them.
"""
import os
import subprocess
import sys

import pytest

# 满足其余三条生产硬拒，好让用例只对着自己那一条失败 / satisfy the other guards
_BASE_ENV = {
    "ENV": "production",
    "WEBHOOK_SECRET": "w" * 40,
    "ENABLE_MOCK_SIGNAL_ENGINE": "false",
    "NOWPAYMENTS_SANDBOX": "false",
    "MAIL_DEBUG_LOG_LINKS": "false",
    "JWT_SECRET": "J" * 48,
}


def _import_config(**overrides) -> subprocess.CompletedProcess:
    env = {**os.environ, **_BASE_ENV, **overrides, "PYTHONUTF8": "1"}
    return subprocess.run(
        [sys.executable, "-c", "import app.core.config"],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_a_strong_production_config_starts():
    """先钉住基线：四项都合规时能正常 import，否则下面的失败断言说明不了问题。"""
    assert _import_config().returncode == 0


@pytest.mark.parametrize("secret", ["secret", "prismx", "x" * 31])
def test_short_jwt_secret_refuses_to_start(secret):
    """短密钥同样拒启动——不改成默认值以外的任何值就算过关。"""
    done = _import_config(JWT_SECRET=secret)
    assert done.returncode != 0
    assert "JWT_SECRET" in done.stderr


def test_thirty_two_chars_is_the_floor():
    """32 字符是下限而不是建议值：刚好 32 要放行，免得把合规部署拦在门外。"""
    assert _import_config(JWT_SECRET="x" * 32).returncode == 0


def test_mail_debug_log_links_refuses_to_start_in_production():
    """打开它等于把改任意账号密码的能力交给任何能读日志的人。"""
    done = _import_config(MAIL_DEBUG_LOG_LINKS="true")
    assert done.returncode != 0
    assert "MAIL_DEBUG_LOG_LINKS" in done.stderr


def test_mail_debug_log_links_still_allowed_outside_production():
    """本地开发的用途没有被砍掉——它本来就是为了省掉配发信商。"""
    assert _import_config(ENV="development", MAIL_DEBUG_LOG_LINKS="true").returncode == 0
