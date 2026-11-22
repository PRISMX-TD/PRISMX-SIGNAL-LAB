"""DeepSeek 客户端（OpenAI 兼容的 /chat/completions），只用 JSON 模式。

沿用项目惯例用 httpx 直连、不装 SDK（同 services/translate.py）。官方文档的几点要求：
- JSON 模式只有 response_format={"type": "json_object"}，不能按结构强制校验，所以结果一律由调用方
  用 Pydantic 校验；提示词里必须出现「json」并给出示例。
- 返回内容可能是空的（思考把 max_tokens 吃完、或服务端偶发），按 chat_json 的规则重试。
- 排队时服务端会先发空行保持连接；我们不用流式，httpx 拿到的是完整响应，只设总超时。
只送公开的财经数据，以及交易报告月底点评用的**匿名统计数字**（services/persona/ai_comment.py，
2026-11-22 用户决定）；**不要把能认出用户的数据送进这条链路**（邮箱、昵称、账号、单号、用户 id 都不行；
数据存放在中国境内，条款没写清 API 流量是否用于训练）。阻塞网络调用，调用方放线程池。

DeepSeek client (OpenAI-compatible), JSON mode only. Plain httpx, no SDK, like translate.py.
JSON mode can't enforce a schema, so callers validate with Pydantic; the prompt must say "json";
empty, truncated or non-JSON replies are retried (see chat_json). Only public market data and the
anonymous aggregates of the month-end trading-report comment go here — never anything that identifies a user.
"""
import json
import logging
import time

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.econ")

TIMEOUT = httpx.Timeout(180.0, connect=10.0)
# deepseek-flash 先思考再作答，思考的 token 也算进 max_tokens（实测一组预案思考 + 正文 1.5k–3.5k）。
# 2026-11-21 线上出现「empty reply」：预算 2000 被思考吃完，finish_reason=length、正文为空。
# 所以默认给足 8000；万一还被截断，下一次把预算翻倍（封顶 16000）再试。
# deepseek-flash reasons before answering and reasoning counts against max_tokens (1.5k–3.5k per
# preview). A 2000 budget ran out mid-reasoning in prod (finish_reason=length, empty content), so
# default to 8000 and double it (capped at 16000) on a truncated reply.
DEFAULT_MAX_TOKENS = 8000
MAX_TOKENS_CAP = 16000
ATTEMPTS = 4
# 限流 / 服务端错误 / 网络错误的退避秒数 / backoff for 429, 5xx and network errors
BACKOFF = (2, 5, 10)


class DeepSeekError(Exception):
    pass


class DeepSeekReply:
    def __init__(self, data: dict, model: str, tokens_in: int, tokens_out: int) -> None:
        self.data = data
        self.model = model
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out


def configured() -> bool:
    return bool(settings.DEEPSEEK_API_KEY.strip())


def _parse(text: str) -> dict | None:
    """从回复里取出 JSON 对象：去掉 ``` 包裹，必要时截取第一个 { 到最后一个 }。
    Pull the JSON object out of a reply: strip ``` fences, else take first "{" .. last "}"."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
    for candidate in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text else ""):
        if not candidate:
            continue
        try:
            data = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return None


def chat_json(system: str, user: str, *, max_tokens: int = DEFAULT_MAX_TOKENS,
              temperature: float = 0.3) -> DeepSeekReply:
    """最多 ATTEMPTS 次：空回复 / 非 JSON 直接重试；被截断（finish_reason=length）把预算翻倍再试；
    429、5xx、网络错误按 BACKOFF 退避后再试。401/403/402 这类配置问题立即报错不重试。
    Up to ATTEMPTS tries: empty / non-JSON replies retry; truncated replies retry with double the
    budget; 429, 5xx and network errors back off and retry. Key / balance errors fail fast."""
    if not configured():
        raise DeepSeekError("未配置 DEEPSEEK_API_KEY / DEEPSEEK_API_KEY is not set")
    url = settings.DEEPSEEK_API_BASE.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {settings.DEEPSEEK_API_KEY.strip()}", "Content-Type": "application/json"}
    tokens_in = tokens_out = 0
    budget = max_tokens
    last_error = "empty reply"
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(BACKOFF[min(attempt - 1, len(BACKOFF) - 1)] if last_error.startswith("retryable") else 0.5)
        body = {
            "model": settings.DEEPSEEK_MODEL,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_object"},
            "max_tokens": budget,
            "temperature": temperature,
            "stream": False,
        }
        try:
            resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT)
        except httpx.HTTPError as exc:
            last_error = f"retryable: network error {type(exc).__name__}"
            continue
        if resp.status_code in (401, 403):
            raise DeepSeekError("DeepSeek 拒绝了密钥，请检查 DEEPSEEK_API_KEY / DeepSeek rejected the key")
        if resp.status_code == 402:
            raise DeepSeekError("DeepSeek 余额不足 / DeepSeek balance is insufficient")
        if resp.status_code == 429 or resp.status_code >= 500:
            last_error = f"retryable: HTTP {resp.status_code}"
            continue
        if resp.status_code >= 400:
            raise DeepSeekError(f"DeepSeek 返回 {resp.status_code}: {resp.text[:200]}")
        try:
            payload = resp.json()
            usage = payload.get("usage") or {}
            tokens_in += int(usage.get("prompt_tokens") or 0)
            tokens_out += int(usage.get("completion_tokens") or 0)
            choice = payload["choices"][0]
            content = choice["message"].get("content") or ""
            finish = choice.get("finish_reason")
            model = str(payload.get("model") or settings.DEEPSEEK_MODEL)
        except (ValueError, KeyError, IndexError, TypeError):
            last_error = "malformed response"
            continue
        if finish == "length":
            # 预算被思考吃完：翻倍再试 / budget ran out while reasoning: double it
            last_error = f"truncated at max_tokens={budget}"
            budget = min(budget * 2, MAX_TOKENS_CAP)
            continue
        data = _parse(content) if content.strip() else None
        if data is None:
            last_error = "empty reply" if not content.strip() else "reply is not a JSON object"
            continue
        if attempt:
            logger.info("deepseek succeeded on attempt %d after: %s", attempt + 1, last_error)
        return DeepSeekReply(data, model, tokens_in, tokens_out)
    raise DeepSeekError(f"DeepSeek {ATTEMPTS} 次都没给出可用的 JSON / no usable JSON after {ATTEMPTS} tries "
                        f"({last_error.removeprefix('retryable: ')})")
