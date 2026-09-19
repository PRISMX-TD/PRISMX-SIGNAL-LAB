"""两个 slowapi Limiter 都必须用共享存储，只要 REDIS_URL 配了。

**为什么要测。** 配置与文档把 REDIS_URL 定成「开多 worker 的那一个开关」，
core/config.py 的启动闸门也只看它：非空就放行多 worker。可限流器一直读的是另一个
键（RATE_LIMIT_STORAGE_URI），按用户的那个连 storage_uri 参数都没写。照文档只配
REDIS_URL 的部署因此会得到「闸门说没问题、限流却还在进程内各算各的」——登录
10/min、找回密码 3/min、MT5 验证 6/min 全部被 worker 数等比稀释，而且一声不吭。

这条测试钉住的就是那个静默降级：REDIS_URL 非空时，两个 limiter 的存储都不能是
MemoryStorage。

Both slowapi limiters must use shared storage whenever REDIS_URL is set. Config
and docs treat REDIS_URL as *the* switch that makes multiple workers supported,
and the startup gate only checks that key — while the limiters read a different
one (the user-keyed limiter read nothing at all). A REDIS_URL-only deployment,
which is the documented one, would pass the gate with per-process counters and
silently divide every limit by the worker count.
"""
import importlib

import pytest
from limits.storage import MemoryStorage

from app.core.config import settings
from app.services import shared_state

# 不连真 Redis：limits 建 RedisStorage 时只构造客户端，不发命令。
# No live Redis needed: limits only builds the client at construction.
FAKE_REDIS_URI = "redis://127.0.0.1:6379/15"


@pytest.fixture()
def reloaded():
    """按当前设置重新构造两个 Limiter，用完还原。

    Limiter 是模块导入时构造的，所以只能重载模块才看得到不同配置下的结果。
    重载是原地更新模块字典，别处 `from ... import limiter` 拿到的旧对象不受影响。
    Rebuild both limiters under the current settings and restore afterwards. They
    are constructed at import time, so a reload is the only way to observe a
    different configuration. reload updates the module dict in place, so objects
    imported elsewhere keep working.
    """
    from app.core import rate_limit, strategy_limits

    def _reload():
        return importlib.reload(rate_limit), importlib.reload(strategy_limits)

    yield _reload
    # 还原成测试会话原本的配置（settings 由 monkeypatch 负责回滚，这里只重建对象）
    _reload()


def test_redis_url_alone_gives_both_limiters_shared_storage(monkeypatch, reloaded):
    """只配 REDIS_URL（文档指定的多 worker 路径）：两个 limiter 都不能是进程内内存。"""
    monkeypatch.setattr(settings, "REDIS_URL", FAKE_REDIS_URI)
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")

    rate_limit, strategy_limits = reloaded()

    assert not isinstance(rate_limit.limiter._storage, MemoryStorage)
    assert not isinstance(strategy_limits.user_limiter._storage, MemoryStorage)


def test_legacy_key_alone_still_works(monkeypatch, reloaded):
    """老写法 RATE_LIMIT_STORAGE_URI 单独配也要照常生效，不能因为改读 REDIS_URL 而失效。"""
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", FAKE_REDIS_URI)

    rate_limit, strategy_limits = reloaded()

    assert not isinstance(rate_limit.limiter._storage, MemoryStorage)
    assert not isinstance(strategy_limits.user_limiter._storage, MemoryStorage)


def test_nothing_configured_stays_in_process(monkeypatch, reloaded):
    """两个键都空：单 worker 部署，进程内内存，与从前完全一致。"""
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")

    rate_limit, strategy_limits = reloaded()

    assert isinstance(rate_limit.limiter._storage, MemoryStorage)
    assert isinstance(strategy_limits.user_limiter._storage, MemoryStorage)


def test_redis_url_wins_over_the_legacy_key(monkeypatch):
    """两者都配以 REDIS_URL 为准——config.py 的注释是这么承诺的。"""
    monkeypatch.setattr(settings, "REDIS_URL", "redis://new/0")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "redis://old/0")

    assert shared_state.redis_url() == "redis://new/0"
