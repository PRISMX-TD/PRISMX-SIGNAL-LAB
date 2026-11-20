"""DeepSeek 客户端（OpenAI 兼容的 /chat/completions），只用 JSON 模式。

沿用项目惯例用 httpx 直连、不装 SDK（同 services/translate.py）。官方文档的几点要求：
- JSON 模式只有 response_format={"type": "json_object"}，不能按结构强制校验，所以结果一律由调用方
  用 Pydantic 校验；提示词里必须出现「json」并给出示例。
- 返回内容可能是一串空格，当作失败重试一次。
- 排队时服务端会先发空行保持连接；我们不用流式，httpx 拿到的是完整响应，只设总超时。
只送公开的财经数据，**不要把任何用户数据送进这条链路**（数据存放在中国境内，条款没写清 API 流量是否
用于训练）。阻塞网络调用，调用方放线程池。

DeepSeek client (OpenAI-compatible), JSON mode only. Plain httpx, no SDK, like translate.py.
JSON mode can't enforce a schema, so callers validate with Pydantic; the prompt must say "json";
an all-whitespace reply is retried once. Only public market data goes here — never user data.
"""
import json
import logging

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.econ")

TIMEOUT = httpx.Timeout(90.0, connect=10.0)


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


def chat_json(system: str, user: str, *, max_tokens: int = 2000, temperature: float = 0.3) -> DeepSeekReply:
    if not configured():
        raise DeepSeekError("未配置 DEEPSEEK_API_KEY / DEEPSEEK_API_KEY is not set")
    url = settings.DEEPSEEK_API_BASE.rstrip("/") + "/chat/completions"
    body = {
        "model": settings.DEEPSEEK_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {settings.DEEPSEEK_API_KEY.strip()}", "Content-Type": "application/json"}
    tokens_in = tokens_out = 0
    last_error = "empty reply"
    for _attempt in range(2):
        try:
            resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT)
        except httpx.HTTPError as exc:
            raise DeepSeekError(f"无法连接 DeepSeek / could not reach DeepSeek: {exc}") from exc
        if resp.status_code in (401, 403):
            raise DeepSeekError("DeepSeek 拒绝了密钥，请检查 DEEPSEEK_API_KEY / DeepSeek rejected the key")
        if resp.status_code == 402:
            raise DeepSeekError("DeepSeek 余额不足 / DeepSeek balance is insufficient")
        if resp.status_code >= 400:
            raise DeepSeekError(f"DeepSeek 返回 {resp.status_code}: {resp.text[:200]}")
        try:
            payload = resp.json()
            usage = payload.get("usage") or {}
            tokens_in += int(usage.get("prompt_tokens") or 0)
            tokens_out += int(usage.get("completion_tokens") or 0)
            content = payload["choices"][0]["message"].get("content") or ""
            model = str(payload.get("model") or settings.DEEPSEEK_MODEL)
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise DeepSeekError("DeepSeek 返回格式异常 / malformed DeepSeek response") from exc
        text = content.strip()
        if text.startswith("```"):
            text = text.strip("`")
            text = text[text.find("{"):]
        if not text:
            last_error = "empty reply"
            continue
        try:
            data = json.loads(text)
        except ValueError:
            last_error = "reply is not valid JSON"
            continue
        if not isinstance(data, dict):
            last_error = "reply is not a JSON object"
            continue
        return DeepSeekReply(data, model, tokens_in, tokens_out)
    raise DeepSeekError(f"DeepSeek 两次都没给出可用的 JSON / no usable JSON after a retry ({last_error})")
