"""交易报告的月底 AI 点评（方案第 10 节：只在月底存档时写一次，当月实时报告不显示点评）。

隐私：发出去的只有**匿名的汇总数字**——人格代号、四个主轴的分数、本月胜率 / 盈亏比 / 笔数 / 净盈亏、
分品种和分时段的汇总、标签次数。不发邮箱、昵称、账号、单号、具体时间。
（不走 DeepSeek：services/econ/deepseek.py 写明了那条线只发公开行情数据。）

一次请求同时拿五种语言（zh / en / ja / th / vi），用结构化输出保证是合法 JSON。
没配 ANTHROPIC_API_KEY、后台开关关着、或请求失败时返回 None，报告照常存档，只是没有点评。

Month-end AI comment for the trading report (written once at archive time). Only anonymous
aggregates are sent — never e-mail, nickname, account, ticket or timestamps. All five UI
languages come back in one structured-output call. Returns None when the key or the admin
switch is missing, or when the call fails; the report is archived without a comment.
"""
from __future__ import annotations

import json
import logging

from app.core.config import settings

logger = logging.getLogger("prismx.persona.ai")

LANGS = ("zh", "en", "ja", "th", "vi")

_SYSTEM = (
    "You write a short month-end comment for a retail trader's trading report inside a trading app. "
    "You get anonymous aggregate numbers only. Write like a frank, friendly coach: 3 to 5 short sentences, "
    "mention one concrete strength and one or two concrete things to fix, each tied to a number you were given. "
    "No investment advice, no market predictions, no symbols to buy or sell, no promises of profit, "
    "no emojis, no headings, no bullet lists. Do not invent numbers. "
    "Return the same comment in five languages: zh (Simplified Chinese, plain everyday wording), "
    "en (English), ja (Japanese), th (Thai), vi (Vietnamese)."
)

_SCHEMA = {
    "type": "object",
    "properties": {lang: {"type": "string"} for lang in LANGS},
    "required": list(LANGS),
    "additionalProperties": False,
}


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
    model = settings.PERSONA_AI_MODEL
    if not settings.ANTHROPIC_API_KEY:
        return None, model
    try:
        import anthropic
    except ImportError:  # pragma: no cover - 依赖缺失时安静地不写 / quietly skip without the SDK
        logger.warning("anthropic SDK not installed; persona comment skipped")
        return None, model
    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY, timeout=60.0, max_retries=2)
    try:
        # 被安全分类器拒绝时由服务端换模型重跑（fallbacks="default"）。
        # On a policy decline the server re-runs the request on a fallback model.
        resp = client.beta.messages.create(
            model=model,
            max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            system=_SYSTEM,
            messages=[{"role": "user", "content": json.dumps(_facts(report), ensure_ascii=False)}],
        )
    except anthropic.APIStatusError as e:
        logger.warning("persona comment failed: HTTP %s", e.status_code)
        return None, model
    except anthropic.APIConnectionError:
        logger.warning("persona comment failed: connection error")
        return None, model
    if resp.stop_reason in ("refusal", "max_tokens"):
        logger.warning("persona comment stopped: %s", resp.stop_reason)
        return None, getattr(resp, "model", model)
    text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
    try:
        data = json.loads(text)
    except ValueError:
        logger.warning("persona comment was not JSON")
        return None, getattr(resp, "model", model)
    out = {lang: str(data.get(lang) or "").strip()[:1200] for lang in LANGS}
    if not all(out.values()):
        return None, getattr(resp, "model", model)
    return out, getattr(resp, "model", model)
