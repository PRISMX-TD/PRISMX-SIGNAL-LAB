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


def nickname_reserved(nick: str) -> bool:
    norm = unicodedata.normalize("NFKC", nick or "").lower().replace(" ", "")
    return any(w in norm for w in RESERVED_WORDS)
