"""JWT 库从 python-jose 3.3.0 换成 PyJWT 2.9。

**为什么要测。** python-jose 3.3.0 有公开披露的算法混淆 / 拒绝服务类漏洞且长期未升级。
换库最怕的是静默改口径：签出来的 token 别的地方读不了、tv 校验失效、过期不再拒绝、
或者换成 alg=none 的 token 混进来。这里把这几条各钉一下，另外确认 python-jose
已不再被 import。

Swapped python-jose for PyJWT. Pins: round-trip of sub/tv, expiry rejection,
wrong-secret and tampered-alg rejection, and that jose is gone.
"""
import base64
import json
import sys
from datetime import datetime, timedelta, timezone

import jwt

from app.core import security
from app.core.config import settings


def test_round_trip_keeps_sub_and_token_version():
    tok = security.create_access_token("user-1", token_version=3)
    payload = security.decode_token_payload(tok)
    assert payload["sub"] == "user-1" and payload["tv"] == 3
    assert security.decode_access_token(tok) == "user-1"
    assert isinstance(tok, str)                      # PyJWT 2.x 直接给 str


def test_expired_and_foreign_tokens_are_rejected():
    expired = jwt.encode(
        {"sub": "u", "exp": datetime.now(timezone.utc) - timedelta(seconds=5), "tv": 0},
        settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM,
    )
    assert security.decode_token_payload(expired) is None
    foreign = jwt.encode({"sub": "u", "exp": datetime.now(timezone.utc) + timedelta(hours=1)},
                         "someone-elses-secret", algorithm=settings.JWT_ALGORITHM)
    assert security.decode_token_payload(foreign) is None
    assert security.decode_token_payload("not.a.jwt") is None
    assert security.decode_token_payload("") is None


def test_alg_none_token_is_rejected():
    """算法混淆：把头改成 alg=none、去掉签名，必须当作无效。"""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "none", "typ": "JWT"}).encode()).rstrip(b"=")
    body = base64.urlsafe_b64encode(json.dumps({"sub": "admin", "tv": 0}).encode()).rstrip(b"=")
    assert security.decode_token_payload(f"{header.decode()}.{body.decode()}.") is None


def test_python_jose_is_gone():
    assert "jose" not in sys.modules or "app.core.security" not in sys.modules \
        or not hasattr(security, "JWTError")
    import importlib
    src = importlib.util.find_spec("app.core.security").origin
    assert "from jose" not in open(src, encoding="utf-8").read()
