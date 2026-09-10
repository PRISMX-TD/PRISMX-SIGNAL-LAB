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


def display_name(nickname, email, nickname_public: bool) -> str:
    if nickname:
        return nickname if nickname_public else mask_name(nickname)
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
