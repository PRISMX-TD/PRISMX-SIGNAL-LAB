"""榜单 / 比赛分数的出口清洗：库里已经存着的非有限值（NaN / ±Inf）不能把 JSON 响应打成 500。

计算侧早已把 NaN / ±Inf 挡在外面（score 非有限 = 不上榜，见 boards.return_score 与
competitions._comp_return），但修复之前写进库的 final_score / 快照 score 还可能是 NaN。
Starlette 的 JSONResponse 用 allow_nan=False 渲染，碰到一个就整条响应 500——一行坏数据
拖垮整个榜单页。出口上按「缺分」的既有含义处理：
  · finalScore 本来就可空（null = 没有终审成绩），非有限 → null；
  · 榜单行的 score 不可空、前端按数字画条形图，非有限的行整行不出——与计算时「分数非有限
    = 不上榜」同一口径；其余行保留库里的名次（名次可能出现空档，但不会悄悄挪动别人的名次）。
    「我的名次」与「上期冠军」同理，置 None（= 未上榜 / 没有）；
  · 其它零散数值兜底换成 null。
所有函数都返回新对象，绝不改传进来的原件——它们可能是 shared_cache 里缓存的那一份。

Sanitising stored board / competition scores on the way out. The compute side already
keeps NaN / ±Inf out (a non-finite score is "not on the board"), but values stored
before that fix may still be NaN, and Starlette renders with allow_nan=False, so a single
one 500s the whole response. Follow the existing meaning of "no score": nullable finals
-> null; board rows (non-null score, drawn as a number by the frontend) with a non-finite
score are left out — the compute-time rule — while the rest keep their stored rank (a gap
is possible, nobody else's rank silently moves); "me" / "previousWinner" become None;
any other stray float becomes null. Every function returns new containers and never
mutates its input, which may be the copy held in shared_cache.
"""
import math
from typing import Any


def finite_or_none(v: Any) -> Any:
    """非有限浮点 → None，其余原样。/ Non-finite float -> None, anything else unchanged."""
    return None if isinstance(v, float) and not math.isfinite(v) else v


def score_ok(v: Any) -> bool:
    """可以当分数展示的值：有限的 int / float（不含布尔）。
    A value fit to show as a score: a finite int / float (not a bool)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def scrub(obj: Any) -> Any:
    """递归把非有限浮点换成 None，返回新容器。/ Recursively null non-finite floats, new containers."""
    if isinstance(obj, float):
        return finite_or_none(obj)
    if isinstance(obj, dict):
        return {k: scrub(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [scrub(v) for v in obj]
    return obj


def _scored_row_ok(row: Any) -> bool:
    return not (isinstance(row, dict) and "score" in row) or score_ok(row["score"])


def finite_rows(rows: list) -> list:
    """去掉 score 非有限的行（没有 score 键的行原样保留）。
    Drop rows whose score is non-finite (rows without a score key are kept)."""
    return [r for r in rows if _scored_row_ok(r)]


def finite_board(payload: dict) -> dict:
    """榜单载荷：rows 去掉非有限分数的行；me / previousWinner 分数非有限 → None；其余兜底清洗。
    Board payload: drop non-finite rows; me / previousWinner -> None likewise; scrub the rest."""
    out = dict(payload)
    if isinstance(out.get("rows"), list):
        out["rows"] = finite_rows(out["rows"])
    for key in ("me", "previousWinner"):
        if isinstance(out.get(key), dict) and not _scored_row_ok(out[key]):
            out[key] = None
    return scrub(out)
