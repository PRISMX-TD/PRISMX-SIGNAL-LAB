"""一次性邮箱（temp mail）域名判定。

这个模块只有一件事重要：**放行永远赢过拦截**，而且是前置短路，不是"黑名单的例外"。

    1. 内置放行表 ALLOW_DOMAINS —— 命中直接返回"不是一次性邮箱"，根本不查黑名单
    2. 后台「额外放行」          —— 运营现场救火，不用改代码不用部署
    3. 打包的黑名单快照 + 后台「额外拦截」

为什么顺序要写死成这样：黑名单是上游开源列表的快照，内容不由我们控制。各家
一次性邮箱列表把正规邮箱误列进去是真实发生过的事（尤其是名字看着不像正规邮箱
的那批：yeah.net、188.com、21cn.com、tom.com、sina.cn、wo.cn 全是国内真实
在用的邮箱）。前置短路能保证这类误列一个真人都伤不到。写成"先查黑名单，命中
后再看有没有例外"在功能上等价，但那个顺序一旦被后人调整就会静默失效——而"静默
失效"在这里的后果是把中国用户挡在注册页外面，没人会来报 bug，只会不注册。

放行表按"域名 + 它的所有父域"匹配，两边都是。所以 ALLOW_DOMAINS 里有 163.com
时，mail.163.com 也自动放行；黑名单里有 mailinator.com 时，随便编的
x.mailinator.com 也一样挡掉（mailinator 这类服务本来就送无限子域名，只匹配
精确域名等于白做）。

Disposable-email domain checks. The only thing that matters here: **allow always
beats block**, as a leading short-circuit rather than an exception carved out of
the blocklist. The blocklist is a snapshot of an upstream open-source list whose
contents we don't control, and every such list has at some point mislabelled a
legitimate mailbox — particularly the Chinese ones whose names don't look like
mailboxes (yeah.net, 188.com, 21cn.com, tom.com, sina.cn, wo.cn are all real,
widely used). Ordering it this way means a bad upstream entry cannot reach a real
user. Matching walks the parent-domain chain on both sides, so subdomains of a
blocked host (mailinator hands out unlimited ones) are caught, and subdomains of
an allowed host stay allowed.
"""
import logging
import os
import threading

from app.services.settings_store import get_email_gate_settings

logger = logging.getLogger("prismx.email_domains")

_DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "disposable_domains.txt"
)

# 内置放行表：任何情况下都不判定为一次性邮箱的域名。
#
# 中国的主流邮箱全部在列——这是这次改动最主要的风险点，上游列表对国内域名的
# 判断不可信，所以不依赖它。企业自建域名和高校域名枚举不完，救不了，那类误伤
# 只能靠后台「额外放行」兜底。
#
# Built-in allowlist: domains never treated as disposable. Every mainstream
# Chinese mailbox is here on purpose — upstream lists are unreliable about them.
# Corporate and university domains can't be enumerated; those fall to the
# admin-editable allowlist instead.
ALLOW_DOMAINS: frozenset = frozenset({
    # 腾讯 / Tencent
    "qq.com", "vip.qq.com", "foxmail.com",
    # 网易 / NetEase
    "163.com", "126.com", "yeah.net", "vip.163.com", "vip.126.com", "188.com",
    # 新浪 / Sina
    "sina.com", "sina.cn", "vip.sina.com", "sina.com.cn",
    # 搜狐 / Sohu
    "sohu.com", "vip.sohu.com",
    # 阿里 / Alibaba
    "aliyun.com",
    # 运营商 / Chinese carriers
    "139.com", "189.cn", "wo.cn",
    # 其他老牌国内邮箱 / other long-standing Chinese mailboxes
    "21cn.com", "tom.com", "263.net", "chinaren.com",
    # 港台常见 / Hong Kong & Taiwan
    "hinet.net", "pchome.com.tw", "netvigator.com",
    # 国际主流 / international mainstream
    "gmail.com", "googlemail.com",
    "outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.jp",
    "icloud.com", "me.com", "mac.com",
    "yahoo.com", "yahoo.co.jp", "ymail.com",
    "protonmail.com", "proton.me", "pm.me",
    "aol.com", "gmx.com", "gmx.de", "gmx.net", "web.de",
    "mail.ru", "yandex.com", "yandex.ru",
    "zoho.com", "fastmail.com", "hey.com", "tutanota.com", "tuta.com",
    "naver.com", "daum.net", "hanmail.net",
    "docomo.ne.jp", "ezweb.ne.jp", "softbank.ne.jp",
})

_blocklist: frozenset | None = None
_blocklist_lock = threading.Lock()


def _load_blocklist() -> frozenset:
    """读取打包的黑名单快照，进程内只读一次。

    文件只会随部署变化（服务器上 git pull + 重启），所以不需要 TTL，也不需要
    热重载——重启就是刷新。

    读不出来时返回空集合并记 error：一个数据文件读失败不应该让整个注册接口挂掉。
    这里刻意 fail-open（放行）而不是 fail-close（全拦）——拦错的代价是所有新用户
    都注册不了，而放行的代价只是这段时间里一次性邮箱能进来，两者不是一个量级。

    Load the vendored snapshot once per process — the file only changes on deploy
    (git pull + restart on the server), so a restart is the refresh mechanism.
    Deliberately fail-open on a read error: a missing data file must not take the
    whole registration endpoint down, and letting a few disposable addresses
    through costs far less than blocking every new user.
    """
    global _blocklist
    if _blocklist is not None:
        return _blocklist
    with _blocklist_lock:
        if _blocklist is not None:
            return _blocklist
        domains = set()
        try:
            with open(_DATA_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    d = line.strip().lower()
                    if d and not d.startswith("#"):
                        domains.add(d)
        except OSError:
            logger.error("disposable blocklist unreadable at %s — gate degrades to open", _DATA_PATH)
        _blocklist = frozenset(domains)
        return _blocklist


def normalize_domain(raw: str) -> str:
    """把用户/管理员输入的域名规范化。空字符串 = 不是合法域名。

    容忍 "@qq.com"（管理员习惯带 @ 粘贴）和结尾的点（FQDN 写法 "qq.com."）。
    """
    d = (raw or "").strip().lower().lstrip("@").rstrip(".")
    # 只做最基本的形状检查：必须有点、不能有空格和 @。真正的邮箱合法性由
    # pydantic 的 EmailStr 在更外层保证，这里只防管理员在后台输入框里填错。
    if not d or " " in d or "@" in d or "." not in d:
        return ""
    return d


def domain_of(email: str) -> str:
    """取邮箱的域名部分（小写、规范化）。

    用 rpartition 而不是 split("@")[1]：RFC 5321 允许本地部分用引号包住 @
    （形如 `"a@b"@example.com`），split 会取错那一段。EmailStr 已经保证了
    整体合法，这里只负责切对位置。
    """
    _, _, domain = (email or "").rpartition("@")
    return normalize_domain(domain)


def _matches(domain: str, domains: frozenset | set) -> bool:
    """域名或它的任一父域命中集合即为真。

    "x.mailinator.com" 会依次比对 x.mailinator.com → mailinator.com → com。
    顶级域自身不比对到"空"，但集合里本来也不该有裸 TLD；真混进去一个 "com"
    会造成大面积误伤，所以更新脚本会拦掉不含点的条目（见 scripts/）。
    """
    parts = domain.split(".")
    for i in range(len(parts) - 1):
        if ".".join(parts[i:]) in domains:
            return True
    return False


def is_disposable_email(db, email: str) -> bool:
    """判定一个邮箱是否为一次性邮箱。True = 应当拒绝。

    总开关关掉时恒为 False——后台随时能把这道闸整个放下来，不需要发版。
    """
    cfg = get_email_gate_settings(db)
    if not cfg["disposable_block_enabled"]:
        return False

    domain = domain_of(email)
    if not domain:
        # 切不出域名说明邮箱本身就不合法，那是 EmailStr 该报的错，不是这里的事。
        return False

    # 1. 放行永远赢：内置表 + 后台额外放行，两者都前置短路。
    if _matches(domain, ALLOW_DOMAINS):
        return False
    extra_allowed = {normalize_domain(d) for d in cfg["extra_allowed_domains"]}
    if _matches(domain, extra_allowed - {""}):
        return False

    # 2. 后台额外拦截：上游快照还没收录的新域名，运营当场补一条即可。
    extra_blocked = {normalize_domain(d) for d in cfg["extra_blocked_domains"]}
    if _matches(domain, extra_blocked - {""}):
        return True

    # 3. 打包快照
    return _matches(domain, _load_blocklist())
