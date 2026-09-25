"""测试用的最小 Redis 替身：只实现 services/shared_state、quotes_store、chart_store
用到的那几条命令，语义按 redis-py（decode_responses=True）。不装 fakeredis 依赖。
Minimal in-memory stand-in for the redis-py commands the shared-state code uses."""
import fnmatch
import time


class FakeRedis:
    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.exp: dict[str, float] = {}
        self.hashes: dict[str, dict[str, str]] = {}
        self.lists: dict[str, list[str]] = {}
        self.zsets: dict[str, dict[str, float]] = {}
        self.published: list[tuple[str, str]] = []

    # -- helpers --
    def _gc(self, key: str) -> None:
        e = self.exp.get(key)
        if e is not None and e <= time.time():
            self.kv.pop(key, None); self.exp.pop(key, None)

    # -- strings --
    def get(self, key):
        self._gc(key); return self.kv.get(key)

    def set(self, key, value, ex=None, nx=False):
        self._gc(key)
        if nx and key in self.kv:
            return None
        self.kv[key] = str(value)
        if ex is not None:
            self.exp[key] = time.time() + ex
        else:
            self.exp.pop(key, None)
        return True

    def delete(self, *keys):
        n = 0
        for k in keys:
            n += int(self.kv.pop(k, None) is not None); self.exp.pop(k, None)
            n += int(self.hashes.pop(k, None) is not None) + int(self.lists.pop(k, None) is not None) + int(self.zsets.pop(k, None) is not None)
        return n

    def incr(self, key, amount=1):
        self._gc(key)
        v = int(self.kv.get(key, "0")) + amount
        self.kv[key] = str(v); return v

    def expire(self, key, seconds):
        if key in self.kv:
            self.exp[key] = time.time() + seconds; return True
        return False

    def keys(self, pattern="*"):
        return [k for k in list(self.kv) if fnmatch.fnmatch(k, pattern)]

    def ping(self):
        return True

    # -- Lua：只认 shared_state 里那一条脚本 --
    def eval(self, script, numkeys, *args):
        """按脚本原文匹配，不解释 Lua。

        替身的价值在于把真实语义钉住：认得出的脚本照 Redis 的语义执行，认不出的
        直接报错——将来谁加了第二条脚本，测试会当场说话，而不是静默跳过。
        Matches the script by its text instead of interpreting Lua. A recognised
        script runs with Redis's semantics; an unknown one raises, so adding a
        second script makes the tests speak up instead of silently passing.
        """
        from app.services.shared_state import _RELEASE_LOCK_LUA

        keys, argv = list(args[:numkeys]), list(args[numkeys:])
        if " ".join(script.split()) == " ".join(_RELEASE_LOCK_LUA.split()):
            key = keys[0]
            self._gc(key)
            if self.kv.get(key) == argv[0]:
                return self.delete(key)
            return 0
        raise NotImplementedError(f"FakeRedis 未实现这条 Lua 脚本 / unsupported Lua script: {script!r}")

    # -- hashes --
    def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    def hset(self, key, field=None, value=None, mapping=None):
        h = self.hashes.setdefault(key, {})
        n = 0
        if field is not None:
            n += int(field not in h); h[field] = str(value)
        for f, v in (mapping or {}).items():
            n += int(f not in h); h[f] = str(v)
        return n

    def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    # -- lists --
    def rpush(self, key, *values):
        self.lists.setdefault(key, []).extend(str(v) for v in values); return len(self.lists[key])

    def lrange(self, key, start, end):
        lst = self.lists.get(key, [])
        end = len(lst) if end == -1 else end + 1 if end >= 0 else len(lst) + end + 1
        start = start if start >= 0 else max(0, len(lst) + start)
        return lst[start:end]

    def llen(self, key):
        return len(self.lists.get(key, []))

    def lindex(self, key, index):
        lst = self.lists.get(key, [])
        try:
            return lst[index]
        except IndexError:
            return None

    def lset(self, key, index, value):
        self.lists[key][index] = str(value); return True

    def ltrim(self, key, start, end):
        lst = self.lists.get(key, [])
        self.lists[key] = self.lrange(key, start, end) if lst else []
        return True

    # -- sorted sets --
    def zadd(self, key, mapping):
        self.zsets.setdefault(key, {}).update({m: float(s) for m, s in mapping.items()}); return len(mapping)

    def zrem(self, key, *members):
        z = self.zsets.get(key, {}); return sum(1 for m in members if z.pop(m, None) is not None)

    def zremrangebyscore(self, key, lo, hi):
        z = self.zsets.get(key, {})
        lo_f = float("-inf") if lo == "-inf" else float(lo); hi_f = float("inf") if hi == "+inf" else float(hi)
        dead = [m for m, s in z.items() if lo_f <= s <= hi_f]
        for m in dead:
            z.pop(m)
        return len(dead)

    def zrangebyscore(self, key, lo, hi):
        z = self.zsets.get(key, {})
        lo_f = float("-inf") if lo == "-inf" else float(lo); hi_f = float("inf") if hi == "+inf" else float(hi)
        return [m for m, s in sorted(z.items(), key=lambda kv: kv[1]) if lo_f <= s <= hi_f]

    # -- pub/sub（只记录）--
    def publish(self, channel, message):
        self.published.append((channel, message)); return 1

    # -- pipeline：顺序执行，够用 / sequential, good enough --
    def pipeline(self):
        return _Pipe(self)


class _Pipe:
    def __init__(self, r: FakeRedis) -> None:
        self.r = r; self.ops: list = []

    def __getattr__(self, name):
        def rec(*a, **kw):
            self.ops.append((name, a, kw)); return self
        return rec

    def execute(self):
        return [getattr(self.r, n)(*a, **kw) for n, a, kw in self.ops]


class AsyncFakeRedis:
    """redis.asyncio 同形的最小替身：命令转给同一个 FakeRedis（模拟几个 worker 共用
    一台 Redis），只实现 connection_manager 的异步路径用到的那几条。fail=True 时每条
    命令都抛 ConnectionError，用来钉「Redis 不可达就退回本地投递」。
    Minimal redis.asyncio stand-in delegating to a shared FakeRedis; fail=True makes
    every command raise ConnectionError."""

    def __init__(self, sync: FakeRedis, fail: bool = False) -> None:
        self.sync = sync
        self.fail = fail
        self.commands: list[str] = []
        self.closed = False

    def _run(self, name, *a, **kw):
        self.commands.append(name)
        if self.fail:
            raise ConnectionError("fake redis is down")
        return getattr(self.sync, name)(*a, **kw)

    async def publish(self, channel, message):
        return self._run("publish", channel, message)

    async def zadd(self, key, mapping):
        return self._run("zadd", key, mapping)

    def pipeline(self, transaction=True):
        return _AsyncPipe(self)

    async def aclose(self):
        self.closed = True


class _AsyncPipe:
    def __init__(self, r: AsyncFakeRedis) -> None:
        self.r = r; self.ops: list = []

    def __getattr__(self, name):
        def rec(*a, **kw):
            self.ops.append((name, a, kw)); return self
        return rec

    async def execute(self):
        self.r.commands.append("pipeline")
        if self.r.fail:
            raise ConnectionError("fake redis is down")
        return [getattr(self.r.sync, n)(*a, **kw) for n, a, kw in self.ops]
