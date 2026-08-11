"""手机号规范化与校验。

统一存 E.164：`+` + 国家区号 + 用户号码，全程无空格无分隔符，例如 `+60123456789`。

**这里只做格式校验，不做归属地校验、更不做短信验证。** 号码是「用户填了什么」，
不是「这个号码真实存在且属于他」。所以：不要拿它做找回密码、不要当作二次验证因子。
真要验证得接短信服务商，那是另一件事。

刻意不引入 phonenumbers 之类的依赖：它能做的额外的事（按国家校验号段长度）对
「记录」这个目的收益有限，而多一个依赖意味着部署要多一步 pip install ——这个项目
的发布流程是服务器上 git pull + 重启，加依赖会让某次部署静默起不来。

Phone normalisation and validation. Stored as E.164 throughout. Format checks
only — never carrier lookup, never SMS verification: this records what the user
typed, it does not prove the number is theirs, so don't build account recovery on
it. No phonenumbers dependency on purpose: the deploy flow is git pull + restart,
and a new dependency would silently break it.
"""
import re

# E.164 的硬性上限是 15 位数字（含国家区号），ITU-T E.164 规定。
# 下限取 8：国家区号最短 1 位，最短的国内号码（如部分岛国）约 7 位。
# 定太紧会把真实号码挡在门外，而挡住真实用户比放进一个假号码更糟——
# 这个字段的目的是「有得联系」，不是「杜绝伪造」（没做短信验证，本来也杜绝不了）。
# E.164 caps at 15 digits including the country code. The lower bound of 8 is
# deliberately loose: rejecting a real user is worse than accepting a fake one
# here, since without SMS verification this can't stop fakes anyway.
_E164 = re.compile(r"^\+[1-9]\d{7,14}$")

# 允许用户输入里出现的分隔符，规范化时一律去掉。
# 用户从通讯录复制粘贴时常常带上这些，直接判非法会显得很蠢。
# Separators users routinely paste in; stripped rather than rejected.
_SEPARATORS = re.compile(r"[\s\-()./]")


def normalize_phone(raw: str) -> str | None:
    """把用户输入规范化成 E.164；无法确定是合法号码时返回 None。

    处理三种常见输入形态：
      "+60 12-345 6789"  -> "+60123456789"   去分隔符
      "0060123456789"    -> "+60123456789"   国际拨号前缀 00 换成 +
      "60123456789"      -> None             没有 + 无法判断是区号还是国内号

    最后一种刻意不猜。前端是「区号下拉 + 号码输入框」，拼出来一定带 +；
    真收到不带 + 的，说明调用方绕过了前端，这时猜错的代价（把马来西亚号码
    当成美国号码存下来）比让它失败大得多。
    """
    if not raw:
        return None

    s = _SEPARATORS.sub("", raw.strip())

    # 国际拨号前缀：00 是多数国家的写法，011 是北美的。都等价于 +
    if s.startswith("00"):
        s = "+" + s[2:]
    elif s.startswith("011"):
        s = "+" + s[3:]

    if not s.startswith("+"):
        return None

    # 这里**不能**去「区号后的前导 0」（本地拨号习惯的国内前缀）。
    # 因为只拿到一整串时无从知道区号在哪里断开，任何猜法都会毁掉合法号码：
    # 马来西亚的 +60123456789 里，如果把区号猜成 "6"，后面正好是 0，就会被
    # 削成 +6123456789 —— 一个有效号码被静默改错，比直接拒收严重得多。
    # 号码分段由**知道区号**的那一侧负责（前端是区号下拉 + 号码输入框，
    # 见 compose_phone），这里只做不需要分段知识的判断。
    #
    # Deliberately does NOT strip a national trunk prefix here: with only the
    # combined string there's no way to know where the dial code ends, and every
    # guess corrupts real numbers — in +60123456789 a guessed dial code of "6" is
    # followed by a 0, silently mangling it to +6123456789. Splitting is the job
    # of whoever knows the dial code (see compose_phone).
    return s if _E164.match(s) else None


def compose_phone(dial_code: str, national: str) -> str | None:
    """由「区号 + 国内号码」两段合成 E.164。

    与 normalize_phone 的区别只有一点：这里知道区号在哪断开，所以可以安全地去掉
    国内号码的前导 0（本地拨号前缀，E.164 里不保留）。用户从通讯录粘 "012-345 6789"
    是常态，不去掉这个 0 会得到一个多一位的错号码。
    """
    dial = _SEPARATORS.sub("", (dial_code or "").strip()).lstrip("+")
    num = _SEPARATORS.sub("", (national or "").strip())

    if not dial.isdigit() or not num.isdigit():
        return None

    # 只去一个前导 0（本地拨号前缀）。去完还以 0 开头就直接拒收：E.164 的国内
    # 号码不会以 0 开头，剩下的 0 说明输入本身有问题。宁可让用户改，也不要静默
    # 存下一个打不通的号码——手机号的整个价值就是"能联系上"。
    # Strip exactly one trunk zero. If another remains, reject: an E.164 national
    # number never starts with 0, so that's malformed input. Better to make the
    # user fix it than to silently store an unreachable number.
    if num.startswith("0"):
        num = num[1:]
        if num.startswith("0"):
            return None

    return normalize_phone(f"+{dial}{num}")
