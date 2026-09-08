"""公告一键翻译：管理员后台用，把一批中文（或英文）文本译成另一种语言。

TRANSLATE_PROVIDER 是一条逗号分隔的候选链，按顺序尝试、首个成功者胜出：
  google_free  Google 翻译的公开接口（clients5 的 dict-chrome-ex 端点），不需要密钥。
               非官方接口，会被限流或变更；失败就落到下一个。
  mymemory     MyMemory 公开接口，不需要密钥；匿名额度每天约 5000 字符，单次 500 字符
               （超长段落按句切块再拼回）。质量略逊，作为兜底。
  deepl        DeepL API（DEEPL_API_KEY），官方、质量最好，免费档每月 50 万字符；
               密钥以 ":fx" 结尾的走 api-free 域名。
  anthropic    Anthropic Messages API（ANTHROPIC_API_KEY），可选。
默认 "google_free,mymemory"：不配任何密钥按钮就能用；配了 DeepL 把它排到最前即可。

为什么放后端而不是前端直调：密钥只能留在服务器，免密接口也不该让浏览器直连第三方。
为什么 httpx 裸调而不装 SDK：项目已依赖 httpx，这里都只是一个 GET/POST。

输入是一个字符串数组，输出同长度、同顺序的数组：管理端把标题、摘要、每个内容块的
文字一次性打包送来，回来后按位置填回。任何一段失败就整体失败（换下一个后端），
绝不错位填回。

Admin-only one-click translation. TRANSLATE_PROVIDER is a comma-separated chain
tried in order, first success wins: google_free (Google's public clients5 endpoint,
no key; unofficial, may throttle), mymemory (public, no key, ~5000 chars/day
anonymous, 500 chars per call so long paragraphs are chunked by sentence), deepl
(official, best quality, DEEPL_API_KEY; ":fx" keys use the api-free host) and
anthropic (optional). Default "google_free,mymemory" works with no configuration.
Runs on the backend so keys stay server-side. Input is a list of strings, output the
same length and order; any failure fails that provider as a whole and the chain moves
on, so nothing is ever written into the wrong field.
"""
import json
import logging
import re

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.translate")

_LANG_NAME = {"en": "English", "zh": "Simplified Chinese"}
_GOOGLE_LANG = {"en": "en", "zh": "zh-CN"}
_DEEPL_TARGET = {"en": "EN", "zh": "ZH-HANS"}
_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
KNOWN_PROVIDERS = ("google_free", "mymemory", "deepl", "anthropic")


class TranslateError(Exception):
    """翻译失败，message 为面向管理员的双语说明。
    Translation failure; message is a bilingual explanation for the admin."""


def providers() -> list[str]:
    """配置里的候选链，去掉未知项 / the configured chain, unknown names dropped."""
    raw = settings.TRANSLATE_PROVIDER or "google_free,mymemory"
    out = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return [p for p in out if p in KNOWN_PROVIDERS]


def _usable(p: str) -> bool:
    if p in ("google_free", "mymemory"):
        return True
    if p == "deepl":
        return bool(settings.DEEPL_API_KEY)
    if p == "anthropic":
        return bool(settings.ANTHROPIC_API_KEY)
    return False


def is_configured() -> bool:
    """候选链里至少有一个可用的后端 / at least one provider in the chain is usable."""
    return any(_usable(p) for p in providers())


def translate_texts(texts: list[str], target: str) -> list[str]:
    """按顺序翻译一批文本；同步阻塞 IO，调用方放线程池。
    Translate a batch in order; blocking IO, callers use the thread pool."""
    if target not in _LANG_NAME:
        raise TranslateError("不支持的目标语言 / unsupported target language")
    chain = [p for p in providers() if _usable(p)]
    if not chain:
        raise TranslateError(
            f"翻译服务未配置（TRANSLATE_PROVIDER={settings.TRANSLATE_PROVIDER}）/ translation isn't configured (TRANSLATE_PROVIDER={settings.TRANSLATE_PROVIDER})"
        )
    # 全空就不用发请求 / nothing to translate, don't make a call
    if all(not t.strip() for t in texts):
        return list(texts)

    last: TranslateError | None = None
    for p in chain:
        try:
            out = _PROVIDERS[p](texts, target)
        except TranslateError as exc:
            logger.warning("translate provider %s failed: %s", p, exc)
            last = exc
            continue
        if len(out) != len(texts):
            last = TranslateError("翻译结果与原文条数不一致 / translated count doesn't match the input")
            logger.warning("translate provider %s returned %d of %d", p, len(out), len(texts))
            continue
        return out
    raise last or TranslateError("翻译失败，请稍后重试 / translation failed, please retry")


def _each(texts: list[str], fn) -> list[str]:
    """逐段调用 fn，空段原样保留 / call fn per non-empty string, keep empties as is."""
    return [fn(t) if t.strip() else t for t in texts]


# ---------- google_free ----------

def _google_free(texts: list[str], target: str) -> list[str]:
    source = "zh-CN" if target == "en" else "en"
    with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}) as client:
        def one(text: str) -> str:
            try:
                resp = client.get(
                    "https://clients5.google.com/translate_a/t",
                    params={"client": "dict-chrome-ex", "sl": source, "tl": _GOOGLE_LANG[target], "q": text},
                )
            except httpx.HTTPError as exc:
                raise TranslateError("翻译服务连接失败 / could not reach the translation service") from exc
            if resp.status_code >= 400:
                raise TranslateError(f"Google 翻译返回 {resp.status_code} / Google translate returned {resp.status_code}")
            try:
                data = resp.json()
                # 形如 ["译文"] 或 [["译文","源语言"]] / either ["text"] or [["text","src"]]
                first = data[0]
                return first[0] if isinstance(first, list) else str(first)
            except (ValueError, TypeError, IndexError) as exc:
                raise TranslateError("翻译结果格式异常 / malformed translation response") from exc
        return _each(texts, one)


# ---------- mymemory ----------

_SENT_SPLIT = re.compile(r"(?<=[。！？!?.;；\n])")
_MYMEMORY_MAX = 480


def _chunks(text: str) -> list[str]:
    """按句切到 480 字以内，保留换行 / split by sentence to stay under the per-call cap."""
    if len(text) <= _MYMEMORY_MAX:
        return [text]
    out: list[str] = []
    buf = ""
    for piece in _SENT_SPLIT.split(text):
        if not piece:
            continue
        if len(buf) + len(piece) > _MYMEMORY_MAX and buf:
            out.append(buf)
            buf = ""
        buf += piece
    if buf:
        out.append(buf)
    return out


def _mymemory(texts: list[str], target: str) -> list[str]:
    pair = "zh-CN|en" if target == "en" else "en|zh-CN"
    with httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": _UA}) as client:
        def one(text: str) -> str:
            parts: list[str] = []
            for chunk in _chunks(text):
                if not chunk.strip():
                    parts.append(chunk)
                    continue
                try:
                    resp = client.get("https://api.mymemory.translated.net/get", params={"q": chunk, "langpair": pair})
                except httpx.HTTPError as exc:
                    raise TranslateError("翻译服务连接失败 / could not reach the translation service") from exc
                if resp.status_code >= 400:
                    raise TranslateError(f"MyMemory 返回 {resp.status_code} / MyMemory returned {resp.status_code}")
                try:
                    data = resp.json()
                    if int(data.get("responseStatus", 200)) != 200:
                        raise TranslateError(f"MyMemory: {str(data.get('responseDetails', ''))[:120]}")
                    translated = data["responseData"]["translatedText"]
                except (ValueError, KeyError, TypeError) as exc:
                    raise TranslateError("翻译结果格式异常 / malformed translation response") from exc
                # 保留切块末尾的换行 / keep the newline the chunk ended with
                parts.append(translated + ("\n" if chunk.endswith("\n") and not translated.endswith("\n") else ""))
            return "".join(parts)
        return _each(texts, one)


# ---------- deepl ----------

def _deepl(texts: list[str], target: str) -> list[str]:
    key = settings.DEEPL_API_KEY
    host = "api-free.deepl.com" if key.endswith(":fx") else "api.deepl.com"
    idx = [i for i, t in enumerate(texts) if t.strip()]
    try:
        resp = httpx.post(
            f"https://{host}/v2/translate",
            headers={"Authorization": f"DeepL-Auth-Key {key}"},
            json={"text": [texts[i] for i in idx], "target_lang": _DEEPL_TARGET[target], "preserve_formatting": True},
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise TranslateError("翻译服务连接失败 / could not reach the translation service") from exc
    if resp.status_code in (401, 403):
        raise TranslateError("DeepL 拒绝了密钥，请检查 DEEPL_API_KEY / DeepL rejected the key, check DEEPL_API_KEY")
    if resp.status_code == 456:
        raise TranslateError("DeepL 本月额度已用完 / DeepL monthly quota exhausted")
    if resp.status_code >= 400:
        raise TranslateError(f"DeepL 返回 {resp.status_code} / DeepL returned {resp.status_code}")
    try:
        translated = [t["text"] for t in resp.json()["translations"]]
    except (ValueError, KeyError, TypeError) as exc:
        raise TranslateError("翻译结果格式异常 / malformed translation response") from exc
    if len(translated) != len(idx):
        raise TranslateError("翻译结果与原文条数不一致 / translated count doesn't match the input")
    out = list(texts)
    for i, t in zip(idx, translated):
        out[i] = t
    return out


# ---------- anthropic ----------

def _anthropic(texts: list[str], target: str) -> list[str]:
    lang = _LANG_NAME[target]
    system = (
        "You translate UI copy for a trading-signal platform (forex, gold, crypto CFDs). "
        f"Translate every string in the JSON array the user sends into {lang}. "
        "Keep the meaning, tone and any line breaks; keep numbers, symbols (XAUUSD, MT5), "
        "product names (PRISMX, Signal Lab, Bridge) and URLs unchanged. "
        "A string already in the target language is returned unchanged; an empty string stays empty. "
        "Reply with ONLY a JSON array of strings, same length and order as the input, no commentary."
    )
    try:
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            json={
                "model": settings.TRANSLATE_MODEL,
                "max_tokens": 8000,
                "system": system,
                "messages": [{"role": "user", "content": json.dumps(texts, ensure_ascii=False)}],
            },
            headers={"x-api-key": settings.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
    except httpx.HTTPError as exc:
        raise TranslateError("翻译服务连接失败 / could not reach the translation service") from exc
    if resp.status_code in (401, 403):
        raise TranslateError("翻译服务拒绝了密钥，请检查 ANTHROPIC_API_KEY / the translation service rejected the key")
    if resp.status_code >= 400:
        raise TranslateError(f"Anthropic 返回 {resp.status_code} / Anthropic returned {resp.status_code}")
    try:
        content = resp.json()["content"]
        text = "".join(part.get("text", "") for part in content if part.get("type") == "text").strip()
        if text.startswith("```"):
            text = text.strip("`")
            text = text[text.find("["):]
        out = json.loads(text)
    except (KeyError, ValueError, TypeError) as exc:
        raise TranslateError("翻译结果格式异常 / malformed translation response") from exc
    if not isinstance(out, list) or not all(isinstance(s, str) for s in out):
        raise TranslateError("翻译结果格式异常 / malformed translation response")
    return out


_PROVIDERS = {
    "google_free": _google_free,
    "mymemory": _mymemory,
    "deepl": _deepl,
    "anthropic": _anthropic,
}
