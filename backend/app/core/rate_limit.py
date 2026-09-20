"""限流器：基于 slowapi，按客户端 IP 维度限速。
Rate limiter: slowapi-based, keyed by client IP.
"""
import hashlib

from slowapi import Limiter
from slowapi.util import get_remote_address

from app.services import shared_state

# 存储后端：默认进程内内存，单实例部署足够。多实例部署必须指向 Redis，否则每个
# 实例各算各的计数，等比放大攻击者可试的次数——两个实例就等于限流放宽一倍。
#
# 取值走 shared_state.redis_url()，不直接读 RATE_LIMIT_STORAGE_URI：文档与
# config.py 的启动闸门都以 REDIS_URL 为「开多 worker 的那一个开关」，只读老键
# 的话，照文档只配 REDIS_URL 的部署会拿到进程内存储，而启动闸门看到 REDIS_URL
# 非空就放行——限流被 worker 数静默稀释且无人报警，正是那道闸门要消灭的降级。
# redis_url() 已实现「REDIS_URL 优先、回落 RATE_LIMIT_STORAGE_URI」的取值逻辑。
#
# Storage backend: in-process memory by default, fine for a single instance;
# multi-instance deployments must point at Redis or each instance counts
# separately and the effective limit is multiplied by the instance count.
#
# The URI comes from shared_state.redis_url() rather than RATE_LIMIT_STORAGE_URI
# directly: both the docs and config.py's startup gate treat REDIS_URL as *the*
# switch that makes multiple workers supported. Reading only the older key would
# leave a REDIS_URL-only deployment (the documented one) on memory storage while
# the gate happily lets it start — the silent, unalarmed degradation that gate
# exists to prevent. redis_url() already implements "REDIS_URL first, else
# RATE_LIMIT_STORAGE_URI".
limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=shared_state.redis_url() or None,
)

# ---------------------------------------------------------------------------
# 失败计数与临时锁定 / failed-attempt tracking and temporary lockout
#
# 用途是限流器挡不住的那一类攻击：攻击者轮换出口 IP，对**同一个标的**（一个邮箱、
# 一个 MT5 账号）持续撞库。按 IP 的限流对此完全无效，必须按标的本身计数。
#
# 计数放在 services/shared_state：配了 REDIS_URL 就是全体 worker 共享的一份，没配
# 就是进程内内存（与从前的 dict 行为一致）。键带过期：距最后一次失败超过锁定时长
# 就整条清掉，所以阈值以下的失败也会在安静一段时间后归零——比原来「永不遗忘」
# 更合理，也免得 Redis 里堆积键。
#
# Covers the attack the IP limiter cannot: rotating egress IPs against one
# *target* (a single email, a single MT5 login). Per-IP limits do nothing there,
# so the count has to be keyed by the target itself. Like the limiter, this is
# in-process state — multi-instance deployments dilute the threshold by the
# instance count. Counters now live in services/shared_state: one shared copy
# across workers with REDIS_URL, in-process memory otherwise. Entries expire a
# lockout-window after the last failure, so sub-threshold counts reset after a
# quiet spell (saner than "never forget", and no key pile-up in Redis).
# ---------------------------------------------------------------------------

# (最大失败次数, 锁定秒数) / (max failures, lockout seconds), per namespace
_POLICIES: dict[str, tuple[int, int]] = {
    # 陌生来源对某个账号连错：阈值与从前按邮箱锁定时一致（见下面「三个计数器」）。
    # A stranger source failing against one account: same threshold the old
    # per-email lockout used.
    "login": (8, 300),
    # 该账号近期成功登录过的来源：阈值放宽到约 4 倍。这里仍然有上限，是因为
    # 「常用来源」并不等于「本人」——公司/家里的出口 IP 是一群人共用的，其中
    # 一台被控的机器同样可以对着这个账号慢慢猜。放宽只是让真用户忘记密码、
    # 连试十几次时不至于被自己锁在门外。
    # A source this account recently logged in from successfully: ~4x looser.
    # Still capped, because "a familiar source" is not "the account owner" — a
    # home/office egress IP is shared, and a compromised machine behind it can
    # still grind at this one account. The slack exists so a real user who
    # forgot their password isn't locked out by their own dozen attempts.
    "login_known": (32, 300),
    # 单个来源对**陌生**账号的失败总数（撞库/密码喷洒）。只统计陌生对，所以
    # 一间办公室里各自敲错密码的老用户永远碰不到它；而攻击者每个账号最多能吃到
    # 8 次（上面那条），要凑满 20 次至少得换三个邮箱——那正是撒网的特征。
    # 命中后只挡这个来源上的陌生对，老用户照常登录（见 is_login_locked）：
    # 否则一个 NAT 后面有人被撞库，整栋楼都进不来，那就是把 DoS 从「按邮箱」
    # 挪到了「按 IP」，而不是修掉它。
    # Total failures from one source against *unfamiliar* accounts (credential
    # stuffing / password spraying). Only unfamiliar pairs count, so long-time
    # users mistyping behind one office NAT never reach it; an attacker is capped
    # at 8 per account by the policy above, so reaching 20 takes at least three
    # different emails — the signature of spraying. A tripped source blocks only
    # unfamiliar pairs on it (see is_login_locked); blocking everything would
    # move the DoS from "per email" to "per IP" instead of fixing it.
    "login_source": (20, 900),
    # MT5 账号验证比登录更严：这个端点把「账号+密码」转发给券商 Manager API 验证，
    # 等于让平台替攻击者去券商侧撞库。正常用户绑定账号时不会连错 5 次，而 15 分钟
    # 的锁定足以让全量账号号段的枚举变得不可行。
    # Stricter than login: this endpoint forwards login+password to the broker's
    # Manager API, which would make the platform a brute-force proxy against the
    # broker. Real users don't mistype five times, and a 15-minute lockout makes
    # sweeping the broker's login range impractical.
    "mt5_verify": (5, 900),
}

def _lock_key(namespace: str, key: str) -> str:
    return f"lockout:{namespace}:{key}"


def _read(namespace: str, key: str) -> int | None:
    """当前失败计数；键不存在或已过期返回 None。
    The current failure count; None when the entry is absent or expired."""
    raw = shared_state.kv_get(_lock_key(namespace, key))
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        # 升级前留在 Redis 里的旧格式（[count, 时间戳] 的 JSON）。当作"没有计数"，
        # 下一次失败会用新格式重建——这些键最长只活一个锁定窗口，不值得为它写
        # 兼容读取路径。/ Pre-upgrade entries used a [count, ts] JSON list. Treat
        # them as absent; the next failure rebuilds the key in the new format, and
        # they live at most one lockout window anyway.
        return None


def _is_locked(namespace: str, key: str) -> bool:
    max_attempts, _lockout_seconds = _POLICIES[namespace]
    count = _read(namespace, key)
    # 不再单独比对"锁定时刻 + 窗口"：键本身带着滑动过期（见 _record_failure），
    # 键还在就说明距最后一次失败不足一个窗口，过期判定由存储后端唯一裁定，
    # 避免两处各算一遍时间。
    # No separate "locked_at + window" comparison: the key carries a sliding
    # expiry (see _record_failure), so its mere presence means the last failure
    # is less than one window ago. One arbiter of expiry instead of two.
    return count is not None and count >= max_attempts


def _record_failure(namespace: str, key: str) -> None:
    _max_attempts, lockout_seconds = _POLICIES[namespace]
    # 原子自增，不是"读出来加一再写回"：同一个邮箱 / MT5 账号被并发撞库时，多个
    # worker（或同进程多线程）会读到同一个旧值，写回后实际只记了一次失败——阈值
    # 就按并发数被放大。INCR 由 Redis 单线程串行执行，内存后端也在同一把锁里做，
    # 每一次失败都算得上。
    # An atomic increment rather than read-modify-write: under a concurrent
    # credential-stuffing burst against one email / MT5 login, several workers (or
    # threads) read the same stale value and the writes collapse into one, which
    # inflates the effective threshold by the concurrency. INCR is serialised by
    # Redis, and the memory backend does it under its own lock, so every failure
    # counts.
    #
    # refresh=True 保持原来的"距最后一次失败一个窗口后整条归零"语义：不刷新的话
    # 过期时间只由第一次失败决定，攻击者可以卡着窗口边界让计数周期性清零。
    # refresh=True keeps the original "expires one window after the *last*
    # failure" semantics; without it the expiry is pinned to the first failure and
    # an attacker could ride the window boundary to reset the count.
    shared_state.incr_with_ttl(_lock_key(namespace, key), lockout_seconds + 1, refresh=True)


def _clear_failures(namespace: str, key: str) -> None:
    shared_state.kv_delete(_lock_key(namespace, key))


class _FailuresCompat:
    """老测试写 `rate_limit._failures.clear()` 清状态；保留这个名字，清的是共享状态。
    Kept for tests that call `_failures.clear()`; resets the shared-state backend."""

    def clear(self) -> None:
        shared_state.reset_for_tests()


_failures = _FailuresCompat()


# ---------------------------------------------------------------------------
# 登录失败锁定 / login lockout
#
# **为什么不再只按邮箱锁**：原来「同一邮箱连错 8 次锁 5 分钟」谁都能用来锁别人
# ——知道你邮箱的人从自己的网络连错 8 次，你就 5 分钟登不进来，循环着做就是永久
# 的。这道闸门本来要挡的是撞库，结果自己成了一个只需要知道邮箱就能发起的 DoS。
#
# 改成按「账号 + 来源」计数，来源 = 客户端真实 IP（走 ProxyHeadersMiddleware 还原
# 后的 request.client.host，见 main.py）。三个计数器各管一件事：
#
#   ① login        (账号, 陌生来源)  8 次 / 5 分钟   —— 挡对单个账号的定点爆破
#   ② login_known  (账号, 常用来源) 32 次 / 5 分钟   —— 本人手滑的余量
#   ③ login_source (来源)           20 次 / 15 分钟  —— 挡一个来源对多个账号撒网
#
# 「常用来源」= 该账号近期从这个 IP **成功**登录过（成功时记一笔，见
# remember_login_source）。攻击者从自己的 IP 打谁都只吃 ①，真用户从自己家里走 ②，
# 两条互不相干——这就是取消 DoS 面的那一步。
#
# **这个折衷放弃了什么**：攻击者换 IP 就能把 ① 的 8 次重新拿一遍，所以纯按 IP
# 算，单账号的爆破上限从「8 次」变成了「8 × 他有多少个 IP」。接受它，是因为
# ③ 把「一个 IP 打很多账号」这条便宜路堵死了，而剩下的「很多 IP 各打一个账号」
# 需要真的持有一个代理池，成本与收益完全不成比例（密码还有 bcrypt 兜底）；
# 反过来，为了守住那 8 次而保留按邮箱锁，代价是任何人都能随手锁掉任何人。
# 真正要防「一人一 IP 慢速爆破」，该上的是登录风控/二次验证，不是把闸门调紧。
#
# 另一处折衷：IP 会变（移动网络、CGNAT），所以 ② 的命中率不会高——它是锦上添花，
# 不是主路径；没命中的真用户退回 ① 的 8 次，与改动前一样，不会更差。
#
# Why the lockout is no longer keyed by email alone: "8 failures on one email
# locks it for 5 minutes" is a denial-of-service anyone can fire at anyone whose
# address they know, on repeat, forever. The gate meant to stop credential
# stuffing had become the cheapest way to lock a real user out.
#
# Counting is now per (account, source), source being the real client IP as
# restored by ProxyHeadersMiddleware. Three counters, three jobs: ① unfamiliar
# source against one account, ② a source that account recently logged in from
# successfully (room for the owner's own typos), ③ one source against many
# accounts. An attacker on their own IP only ever moves ①, the real user rides
# ②, and the two never touch — that is the DoS surface gone.
#
# What the trade-off gives up: rotating IPs buys a fresh 8 attempts each time, so
# the per-account ceiling is now "8 × however many IPs they hold" instead of a
# flat 8. Accepted, because ③ closes the cheap version (one host, many accounts)
# and the remaining attack needs a real proxy pool for a payoff bcrypt already
# guards; the alternative — keeping the per-email lock — hands everyone a
# one-click lockout of anyone. Slow single-account grinding is a job for login
# risk scoring / 2FA, not for a tighter counter.
#
# Second trade-off: IPs move (mobile, CGNAT), so ② will often miss. It is a
# bonus path, not the main one — a real user who misses it falls back to ①'s 8
# attempts, exactly the behaviour that shipped before, never worse.
# ---------------------------------------------------------------------------

# 一个账号最多记住几个常用来源，以及记多久。有上限是必须的：没有上限的话，一个
# 账号被换 IP 登录一年就攒出成千上万个成员，而这份名单每次登录都要整份读出来。
# 超出上限时淘汰最旧的一个（Redis 侧按到期时间排序，内存侧按插入序，都够用）。
# 30 天与 JWT 有效期同量级：手里的 token 还没过期的那段时间，来源也还认得。
# How many familiar sources one account keeps, and for how long. A cap is
# required — without one a year of roaming logins accumulates thousands of
# members in a list that is read in full on every login. The oldest entry is
# evicted past the cap. 30 days matches the JWT lifetime: as long as a session
# could still be alive, its source is still recognised.
KNOWN_SOURCES_PER_ACCOUNT = 8
KNOWN_SOURCE_TTL_SECONDS = 30 * 24 * 3600


def login_source(request) -> str:
    """把请求折算成一个来源标识 / reduce a request to a source identifier.

    真实 IP 只从 `request.client.host` 取——ProxyHeadersMiddleware 已经按
    TRUSTED_PROXY_IPS 把 X-Forwarded-For 还原进去了（见 main.py）。这里绝不自己
    去读那个头：中间件只在对端可信时才采信它，自己解析就等于把攻击者随手伪造的
    一行 header 当成来源，锁定与放行两侧同时失效。get_remote_address 是 slowapi
    的同一口径，按 IP 限流与这里用的是同一个值。

    存的是哈希而不是 IP 本身：键的长度固定（IPv6 很长），共享状态里也不留一份
    「谁从哪登录」的明文轨迹。短哈希足够——这只是个分桶用的标识，不是凭证。

    The real IP comes only from request.client.host, which ProxyHeadersMiddleware
    has already rewritten from X-Forwarded-For for trusted peers. Parsing that
    header here would honour a forged one from any client and break both halves
    of this gate. get_remote_address is what the per-IP limiter keys on, so both
    use the same value. The value is hashed: fixed-length keys (IPv6 is long) and
    no plaintext "who logged in from where" trail in shared state. A short digest
    is plenty — this is a bucket label, not a credential.
    """
    ip = ""
    try:
        ip = get_remote_address(request) or ""
    except Exception:  # pragma: no cover - request 没有 client 的极端情况
        ip = ""
    if not ip:
        # 取不到来源（测试替身、极少数代理配置）：全部落进同一个桶，退化成改动
        # 前的按邮箱锁定。宁可退化成「更严」，也不能因为取不到 IP 就放行。
        # No source available: everything falls into one bucket, degrading to the
        # old per-email behaviour. Degrade to stricter, never to open.
        return "unknown"
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()[:16]


def _known_sources_key(email: str) -> str:
    return f"login_sources:{email}"


def _pair(email: str, source: str) -> str:
    return f"{email}|{source}"


def is_known_login_source(email: str, source: str) -> bool:
    """该账号近期是否从这个来源成功登录过 / has this account logged in from here."""
    return source in shared_state.set_members(_known_sources_key(email))


def remember_login_source(email: str, source: str) -> None:
    """登录成功后把来源记进该账号的常用名单（超上限淘汰最旧的）。
    Record the source on success, evicting the oldest past the cap."""
    members = shared_state.set_members(_known_sources_key(email))
    if source not in members and len(members) >= KNOWN_SOURCES_PER_ACCOUNT:
        for stale in members[: len(members) - KNOWN_SOURCES_PER_ACCOUNT + 1]:
            shared_state.set_remove(_known_sources_key(email), stale)
    shared_state.set_add(_known_sources_key(email), source, KNOWN_SOURCE_TTL_SECONDS)


def is_login_locked(email: str, source: str) -> bool:
    """这个「账号 + 来源」组合此刻是否被拒 / whether this (account, source) is locked out."""
    if is_known_login_source(email, source):
        # 常用来源只看自己那条宽松计数：来源级的撒网计数**刻意不适用**于它，
        # 否则同一个出口 IP 上有人被撞库，会把这个 IP 后面的真用户一起挡掉。
        # A familiar source is judged only by its own loose counter; the
        # source-level spray counter deliberately does not apply, or one attacked
        # account behind a NAT would lock out everyone else sharing that egress.
        return _is_locked("login_known", _pair(email, source))
    return _is_locked("login", _pair(email, source)) or _is_locked("login_source", source)


def record_failed_login(email: str, source: str) -> None:
    """记一次失败。陌生对额外计进来源级的撒网计数。
    Record one failure; unfamiliar pairs also feed the per-source spray counter."""
    if is_known_login_source(email, source):
        _record_failure("login_known", _pair(email, source))
        return
    _record_failure("login", _pair(email, source))
    _record_failure("login_source", source)


def clear_failed_logins(email: str, source: str) -> None:
    """清掉这个「账号 + 来源」的失败计数（登录成功、或改完密码时调）。

    只清这一对，**不清来源级计数**：那个计数记的是「这个来源在对陌生账号撒网」，
    攻击者拿自己的账号成功登录一次就把它清零的话，绕过方法就写在门口了。

    Clears only this pair. The per-source spray counter is deliberately left
    alone: it records "this source is spraying unfamiliar accounts", and letting
    one successful login on the attacker's own account reset it would publish the
    bypass right next to the lock.
    """
    _clear_failures("login", _pair(email, source))
    _clear_failures("login_known", _pair(email, source))


# ---- MT5 账号验证 / MT5 account verification ----


def is_mt5_verify_locked(login: int | str) -> bool:
    """该 MT5 账号是否因验证失败过多被临时锁定 / whether this MT5 login is locked out."""
    return _is_locked("mt5_verify", str(login))


def record_failed_mt5_verify(login: int | str) -> None:
    _record_failure("mt5_verify", str(login))


def clear_failed_mt5_verify(login: int | str) -> None:
    _clear_failures("mt5_verify", str(login))
