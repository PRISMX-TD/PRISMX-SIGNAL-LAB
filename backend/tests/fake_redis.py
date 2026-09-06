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

    def incr(self, key):
        self._gc(key)
        v = int(self.kv.get(key, "0")) + 1
        self.kv[key] = str(v); return v

    def expire(self, key, seconds):
        if key in self.kv:
            self.exp[key] = time.time() + seconds; return True
        return False

    def keys(self, pattern="*"):
        return [k for k in list(self.kv) if fnmatch.fnmatch(k, pattern)]

    def ping(self):
        return True

    # -- hashes --
    def hget(self, key, field):
        return self.hashes.get(key, {}).get(field)

    def hset(self, key, field, value):
        self.hashes.setdefault(key, {})[field] = str(value); return 1

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
