"""时间相关的公共小工具 / shared time helpers."""
from datetime import datetime, timezone


def aware(dt: datetime | None) -> datetime | None:
    """把库里读出来的 naive datetime 按 UTC 补上时区，已带时区的原样返回。

    为什么需要它：SQLite 与部分驱动读回的 datetime 不带 tzinfo，而代码里到处都在
    与 `datetime.now(timezone.utc)` 做比较——naive 与 aware 相减会直接抛
    TypeError。补时区这一步本身没有难度，问题在于它此前以逐字节相同的 `_aware`
    出现在三个模块里（admin / signals / discipline），另有约十几处内联的
    `dt.replace(tzinfo=timezone.utc)` 散落各文件。同一个约定散在十几处的代价不是
    重复几行，而是当"库里存的到底是不是 UTC"这个前提需要重新审视时，没有一个地方
    可以改。

    Attach UTC to a naive datetime read from the database; return an
    already-aware one unchanged.

    Needed because SQLite and some drivers return datetimes without tzinfo while
    the code compares them against datetime.now(timezone.utc) — subtracting naive
    from aware raises TypeError outright. The conversion is trivial; what wasn't
    is that a byte-identical `_aware` lived in three modules (admin, signals,
    discipline) plus a dozen or so inline `dt.replace(tzinfo=timezone.utc)` calls.
    The cost of scattering one convention across a dozen sites isn't the repeated
    lines — it's that when the "stored values are UTC" premise needs revisiting,
    there is no single place to revisit it.
    """
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
