"""共享状态的三处收口：失败计数的原子性、锁释放的原子性、内存后端的过期回收。

三条的共同点是"两步之间有人插进来"——读出来再写回去、GET 完再 DELETE、写进去却
没人负责回收。单 worker 时前两条只在多线程下才显形，配了 REDIS_URL 开多 worker
后就是常态。

Three tightenings in the shared-state layer: atomic failure counting, atomic lock
release, and expiry reclamation in the memory backend. All three are "somebody
slips in between the two steps" problems, which become routine once REDIS_URL
turns multi-worker on.
"""
import threading
import time

import pytest

from app.core import rate_limit
from app.core.config import settings
from app.services import shared_state
from tests.fake_redis import FakeRedis


@pytest.fixture(autouse=True)
def _memory_backend(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


# ---------- 失败计数 / failure counting ----------

def test_concurrent_failures_are_all_counted(monkeypatch):
    """并发撞库不能丢计数。

    原来是「读出 count、加一、写回」：多个线程读到同一个旧值，写回后只记了一次，
    8 次阈值就按并发数被放大。改成原子 INCR 之后，每一次失败都算得上。

    这里给 `kv_get` 塞一个可见的延迟，让「先读后写」的实现必然互相看不见对方的
    写入——这样这条用例才是真的在验原子性，而不是靠 GIL 的调度碰运气。原子实现
    根本不读，这个延迟对它是个空操作。
    A visible delay is injected into kv_get so that any read-then-write
    implementation is guaranteed to miss its peers' writes; otherwise this case
    would be at the mercy of GIL scheduling. The atomic path never reads, so the
    delay is a no-op for it.
    """
    real_kv_get = shared_state.kv_get

    def slow_kv_get(key):
        time.sleep(0.02)
        return real_kv_get(key)

    monkeypatch.setattr(shared_state, "kv_get", slow_kv_get)

    threads = 8
    barrier = threading.Barrier(threads)

    def hit():
        barrier.wait()          # 让所有线程落在同一个读-改-写窗口里
        rate_limit.record_failed_login("victim@t.co")

    workers = [threading.Thread(target=hit) for _ in range(threads)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()

    monkeypatch.setattr(shared_state, "kv_get", real_kv_get)
    assert rate_limit._read("login", "victim@t.co") == threads


def test_lockout_trips_exactly_at_the_threshold():
    max_attempts, _ = rate_limit._POLICIES["login"]
    for _ in range(max_attempts - 1):
        rate_limit.record_failed_login("a@t.co")
    assert not rate_limit.is_login_locked("a@t.co")
    rate_limit.record_failed_login("a@t.co")
    assert rate_limit.is_login_locked("a@t.co")


def test_the_window_slides_with_the_latest_failure(monkeypatch):
    """窗口从**最后一次**失败算起。固定窗口的话，攻击者卡着边界就能让计数周期性清零。"""
    _max, lockout = rate_limit._POLICIES["login"]
    real = time.time
    rate_limit.record_failed_login("b@t.co")

    monkeypatch.setattr(time, "time", lambda: real() + lockout - 1)
    rate_limit.record_failed_login("b@t.co")          # 第二次失败把过期时间推后
    monkeypatch.setattr(time, "time", lambda: real() + lockout + 2)
    assert rate_limit._read("login", "b@t.co") == 2   # 按第一次算的话这时已经归零了


def test_legacy_entries_do_not_crash_the_counter():
    """升级前留在 Redis 里的旧格式（[count, ts]）读出来不能抛，当作没有计数即可。"""
    shared_state.kv_set_json(rate_limit._lock_key("login", "old@t.co"), [3, time.time()], ttl=60)
    assert rate_limit._read("login", "old@t.co") is None
    assert not rate_limit.is_login_locked("old@t.co")


# ---------- 锁的释放 / lock release ----------

def test_release_only_removes_your_own_lock():
    assert shared_state.try_lock("L", 60, owner="A")
    shared_state.release_lock("L", owner="B")              # 不是持有者：不该删
    assert not shared_state.try_lock("L", 60, owner="C")
    shared_state.release_lock("L", owner="A")
    assert shared_state.try_lock("L", 60, owner="C")


def test_a_stale_holder_cannot_delete_the_new_owners_lock(monkeypatch):
    """锁过期换主之后，旧持有者再来释放不能把**新主**的锁删掉（否则短暂双领导）。"""
    real = time.time
    assert shared_state.try_lock("leader", 10, owner="old")
    monkeypatch.setattr(time, "time", lambda: real() + 11)  # 旧锁过期
    assert shared_state.try_lock("leader", 10, owner="new")

    shared_state.release_lock("leader", owner="old")        # 旧持有者姗姗来迟

    assert not shared_state.try_lock("leader", 10, owner="third")   # 新主还握着


def test_release_is_atomic_on_redis_too():
    """Redis 分支走 Lua 脚本，语义必须与内存分支一致。"""
    fake = FakeRedis()
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(settings, "REDIS_URL", "redis://fake")
        shared_state.reset_for_tests(fake)
        assert shared_state.try_lock("L", 60, owner="A")
        shared_state.release_lock("L", owner="B")
        assert not shared_state.try_lock("L", 60, owner="C")
        shared_state.release_lock("L", owner="A")
        assert shared_state.try_lock("L", 60, owner="C")


# ---------- 内存后端的过期回收 / expiry reclamation ----------

def test_expired_keys_are_reclaimed_without_anyone_reading_them():
    """锁定键的键名就是攻击者枚举的邮箱：枚举完再没人读，只靠 get() 清理等于不清理。

    这里先写一批带 TTL 的键并让它们过期，再持续写入触发清扫，确认它们真的被回收
    ——而不是停留在「读到才删」。
    """
    backend = shared_state._memory
    for i in range(300):
        shared_state.kv_set(f"lockout:login:probe{i}@t.co", "1", ttl=1)
    assert len(backend._kv) >= 300

    real = time.time
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(time, "time", lambda: real() + 5)         # 全部过期
        for i in range(shared_state._MEMORY_SWEEP_EVERY_WRITES + 1):
            shared_state.kv_set(f"live:{i}", "x")            # 无 TTL 的长寿键
        leftover = [k for k in backend._kv if "probe" in k]

    assert leftover == []


def test_the_sweep_is_not_blocked_by_long_lived_keys():
    """按插入序只扫前几条的话，前面压着的无 TTL 键（行情缓存那类）会把过期键全挡住。"""
    backend = shared_state._memory
    for i in range(500):
        shared_state.kv_set(f"quotes:{i}", "x")              # 先写一大批不过期的
    shared_state.kv_set("lockout:login:late@t.co", "1", ttl=1)

    real = time.time
    with pytest.MonkeyPatch().context() as mp:
        mp.setattr(time, "time", lambda: real() + 5)
        for i in range(shared_state._MEMORY_SWEEP_EVERY_WRITES + 1):
            shared_state.kv_set(f"more:{i}", "x")
        assert shared_state._k("lockout:login:late@t.co") not in backend._kv
