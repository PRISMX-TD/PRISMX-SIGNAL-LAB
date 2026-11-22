"""交易报告月底点评走 DeepSeek：只发匿名数字、五种语言缺一不可、失败时不写。
Month-end trading-report comment via DeepSeek: anonymous facts only, all five languages required."""
import json

from app.core.config import settings
from app.services.econ import deepseek
from app.services.persona import ai_comment

REPORT = {
    "summary": {"trades": 30, "wins": 18, "losses": 12, "winRate": 60.0, "profit": 120.5, "payoff": 0.8},
    "persona": {"code": "AXQM", "axes": {"judge": {"letter": "A", "value": 80}}},
    "breakdowns": {"symbol": [{"key": "XAUUSD", "trades": 30, "wins": 18, "profit": 120.5}],
                   "session": [], "hold": []},
    "tags": {"noSl": {"count": 4}, "revenge": {"count": 0}},
    "badges": ["steady"],
    "change": {"from": "AGQM"},
    "userId": "u-secret", "email": "someone@example.com", "nickname": "secret-nick",
}

FULL = {lang: f"comment {lang}" for lang in ai_comment.LANGS}


def test_no_key_skips_without_calling(monkeypatch):
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "")
    called = []
    monkeypatch.setattr(deepseek, "chat_json", lambda *a, **k: called.append(1))
    assert ai_comment.generate(REPORT) == (None, settings.DEEPSEEK_MODEL)
    assert not called


def test_sends_only_anonymous_facts(monkeypatch):
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "k")
    seen = {}

    def fake(system, user, **kw):
        seen["system"], seen["user"] = system, user
        return deepseek.DeepSeekReply(FULL, "deepseek-flash", 10, 20)

    monkeypatch.setattr(deepseek, "chat_json", fake)
    out, model = ai_comment.generate(REPORT)
    assert out == FULL and model == "deepseek-flash"
    assert "json" in seen["system"]  # DeepSeek JSON 模式要求 / required by JSON mode
    sent = json.loads(seen["user"])
    assert sent["persona"]["code"] == "AXQM"
    assert sent["tags"] == {"noSl": {"count": 4}}
    for secret in ("u-secret", "someone@example.com", "secret-nick"):
        assert secret not in seen["user"]


def test_missing_language_counts_as_failure(monkeypatch):
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "k")
    partial = dict(FULL, th="")
    monkeypatch.setattr(deepseek, "chat_json",
                        lambda *a, **k: deepseek.DeepSeekReply(partial, "deepseek-flash", 1, 1))
    assert ai_comment.generate(REPORT)[0] is None


def test_deepseek_error_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "DEEPSEEK_API_KEY", "k")

    def boom(*a, **k):
        raise deepseek.DeepSeekError("balance")

    monkeypatch.setattr(deepseek, "chat_json", boom)
    assert ai_comment.generate(REPORT) == (None, settings.DEEPSEEK_MODEL)
