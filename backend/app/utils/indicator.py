"""跨模块共享的指标归一化，把前端与后端的类型判定统一在一个地方。
   Shared indicator normalization used by both frontend and backend."""
import re
from typing import Optional


def indicator_category(indicator: Optional[str]) -> str:
    """归一化：把类似 MA5/MA20 金叉, RSI=44.7 归为 MA5/MA20 金叉, RSI。
       供前端分组展示和后端推送匹配时使用。"""
    raw = (indicator or "").strip()
    if not raw:
        return ""
    raw = re.sub(r"RSI\s*=\s*[\d.]+", "RSI", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*,\s*", ", ", raw)
    raw = re.sub(r"\s+", " ", raw)
    return raw.strip()
