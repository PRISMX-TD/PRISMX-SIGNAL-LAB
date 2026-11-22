"""交易报告的月底 AI 点评（方案第 10 节：只在月底存档时写一次，当月实时报告不显示点评）。

由 DeepSeek 写（2026-11-22 用户决定，沿用财经日历那条 DeepSeek 链路和 DEEPSEEK_API_KEY）。
隐私：发出去的只有**匿名的汇总数字**——人格代号、四个主轴的分数、本月胜率 / 盈亏比 / 笔数 / 净盈亏、
分品种和分时段的汇总、标签次数。不发邮箱、昵称、账号、单号、具体时间，也不发用户 id。

一次请求同时拿五种语言（zh / en / ja / th / vi）。DeepSeek 的 JSON 模式不能按结构强制，所以
回来的结果在这里逐个语言检查：缺一种就当失败。
没配 DEEPSEEK_API_KEY、后台开关关着、或请求失败时返回 None，报告照常存档，只是没有点评。

Month-end AI comment for the trading report, written once at archive time by DeepSeek (same client
and DEEPSEEK_API_KEY as the economic calendar). Only anonymous aggregates are sent — never e-mail,
nickname, account, ticket, timestamps or user id. All five UI languages come back in one JSON-mode
call and are checked here, since JSON mode can't enforce a schema. Returns None when the key or the
admin switch is missing, or when the call fails; the report is archived without a comment.
"""
from __future__ import annotations

import json
import logging

from app.core.config import settings
from app.services.econ import deepseek

logger = logging.getLogger("prismx.persona.ai")

LANGS = ("zh", "en", "ja", "th", "vi")

# DeepSeek 的 JSON 模式要求提示词里出现「json」并给出示例。
# DeepSeek's JSON mode needs the word "json" and an example in the prompt.
_SYSTEM = (
    "You write a short month-end comment for a retail trader's trading report inside a trading app. "
    "You get anonymous aggregate numbers only. Write like a frank, friendly coach: 3 to 5 short sentences, "
    "mention one concrete strength and one or two concrete things to fix, each tied to a number you were given. "
    "No investment advice, no market predictions, no symbols to buy or sell, no promises of profit, "
    "no emojis, no headings, no bullet lists. Do not invent numbers. "
    "Return the same comment in five languages: zh (Simplified Chinese, plain everyday wording), "
    "en (English), ja (Japanese), th (Thai), vi (Vietnamese). "
    "Reply with one json object and nothing else, exactly these five string keys, for example: "
    '{"zh": "……", "en": "...", "ja": "...", "th": "...", "vi": "..."}'
)


def _facts(report: dict) -> dict:
    """从月报里挑出发给模型的匿名事实。/ The anonymous facts sent to the model."""
    s = report.get("summary") or {}
    persona = report.get("persona") or {}
    bd = report.get("breakdowns") or {}
    tags = report.get("tags") or {}
    return {
        "persona": {
            "code": persona.get("code"),
            "axes": {k: {"letter": v.get("letter"), "value": v.get("value")}
                     for k, v in (persona.get("axes") or {}).items()},
        },
        "month": {k: s.get(k) for k in (
            "trades", "wins", "losses", "winRate", "profit", "avgWin", "avgLoss", "payoff",
            "profitFactor", "medianHoldMin", "tradingDays", "greenDays", "maxDrawdown", "score")},
        "bySymbol": [{k: r[k] for k in ("key", "trades", "wins", "profit")} for r in (bd.get("symbol") or [])[:5]],
        "bySessionUtc": [{k: r[k] for k in ("key", "trades", "wins", "profit")} for r in bd.get("session") or []],
        "byHold": [{k: r[k] for k in ("key", "trades", "wins", "profit")} for r in bd.get("hold") or []],
        "tags": {k: v for k, v in tags.items() if v.get("count")},
        "badges": report.get("badges") or [],
        "changedFrom": (report.get("change") or {}).get("from"),
    }


def generate(report: dict) -> tuple[dict | None, str]:
    """返回 (五种语言的点评 | None, 模型名)。/ Returns (comment per language | None, model)."""
    model = settings.DEEPSEEK_MODEL
    if not deepseek.configured():
        return None, model
    try:
        reply = deepseek.chat_json(_SYSTEM, json.dumps(_facts(report), ensure_ascii=False), temperature=0.5)
    except deepseek.DeepSeekError as e:
        logger.warning("persona comment failed: %s", e)
        return None, model
    data = reply.data
    out = {lang: (data.get(lang) if isinstance(data.get(lang), str) else "").strip()[:1200] for lang in LANGS}
    if not all(out.values()):
        logger.warning("persona comment missing languages: %s", [k for k, v in out.items() if not v])
        return None, reply.model
    return out, reply.model
