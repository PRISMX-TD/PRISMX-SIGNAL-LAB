"""榜单/成就展示身份：打码与保留词（设计 §4.3）。前端不做打码，全部后端算好下发。"""
import unicodedata

RESERVED_WORDS = (
    "prismx", "官方", "客服", "管理员", "admin", "administrator",
    "staff", "support", "official", "系统",
)


def mask_name(name: str) -> str:
    name = (name or "").strip()
    if len(name) <= 2:
        return "**"
    return name[0] + "***" + name[-1]   # 固定 3 星，不泄露长度


def mask_account(login) -> str:
    """交易账户号的展示口径：只露后 3 位，其余换成 `*`（12345678 → *****678）。

    榜单（常设榜与比赛榜）、公开主页、代理名单上别人的账户号都走这里；真实账户号
    只在「这行就是观众自己」或管理端 reveal 两种情况下出现。2026-10-08 由「中间两位
    打码」收紧为只露后 3 位（设计 §1.9）。长度不藏——用户能一眼核对自己的号有几位；
    短号至少盖住 2 位，露出位数随之减少。

    Display form for a trading account number: only the last three characters
    stay, the rest become `*` (12345678 → *****678). Used for other people's
    numbers on boards, public profiles and agent lists; the real number appears
    only for the viewer's own row or on the admin reveal path. Tightened from
    "middle two masked" on 2026-10-08 (design §1.9). Length is not hidden; short
    numbers still hide at least two characters.
    """
    s = str(login or "").strip()
    n = len(s)
    if n <= 2:
        return "**"
    shown = min(3, n - 2)
    return "*" * (n - shown) + s[-shown:]


def display_name(nickname, email) -> str:
    """展示名：昵称原样。没设昵称的（存量老账号）退回打码后的邮箱前缀。

    昵称是用户自己挑的公开名号，榜单/主页上就是给人看的，不再按开关打码
    （2026-09-19：「榜单完整展示昵称」开关随之下线，藏的东西换成了账户号，
    见 `mask_account`）。邮箱不是用户挑的、还是登录凭据的一半，所以那条
    回落路径永远打码。
    Display name: the nickname as typed. Accounts without one (legacy) fall back
    to a masked email local part. The nickname is a public handle the user chose,
    so boards and profiles show it as-is — the per-user masking switch is gone as
    of 2026-09-19 and what's hidden now is the account number (see mask_account).
    An email is neither chosen for display nor safe to show (half a credential),
    so that fallback stays masked.
    """
    if nickname:
        return nickname
    local = (email or "").split("@")[0]
    return mask_name(local)             # 邮箱是登录凭据的一半：永远打码


def nickname_key(nick: str) -> str:
    """昵称的重名比较口径：NFKC 归一 + 去掉所有空白 + 转小写。

    存进 users.nickname_key 并加唯一索引，展示仍用用户原样输入的 nickname。
    与保留词检查共用同一套归一，免得出现「同一个名字在保留词那关算撞、在重名
    这关算不撞」的两套口径——归一分叉是这类校验最典型的裂缝。

    Comparison form for nickname uniqueness: NFKC, whitespace stripped,
    lowercased. Stored in users.nickname_key under a unique index while the
    display value stays exactly as the user typed it. Shared with the reserved
    word check so the two never normalize differently.
    """
    return "".join(unicodedata.normalize("NFKC", nick or "").lower().split())


def nickname_reserved(nick: str) -> bool:
    return any(w in nickname_key(nick) for w in RESERVED_WORDS)
