"""桥接器本地配置：API Token 只以 DPAPI 密文落盘，加密失败**不再退回明文**。

以前 DPAPI 不可用时 save_config 会把 token 明文写进 ~/.prismx_bridge.json。现在：
只保存后端地址、不保存 token、抛 TokenStorageError 让界面提示"下次要重输"。

运行：cd bridge && python -m pytest tests
The bridge never writes the API token in plaintext; a DPAPI failure persists the
backend URL only and raises TokenStorageError for the UI to warn about.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bridge_app  # noqa: E402


@pytest.fixture()
def cfg_path(tmp_path, monkeypatch):
    p = tmp_path / "cfg.json"
    monkeypatch.setattr(bridge_app, "CONFIG_PATH", str(p))
    return p


def test_encrypted_round_trip(cfg_path, monkeypatch):
    # 假密文用 hex 表示，确保明文子串不会原样出现在文件里
    # fake cipher as hex so the plaintext never appears verbatim in the file
    monkeypatch.setattr(bridge_app, "_dpapi_encrypt", lambda s: s.encode().hex())
    monkeypatch.setattr(bridge_app, "_dpapi_decrypt", lambda s: bytes.fromhex(s).decode())
    bridge_app.save_config({"token": "prismx_secret", "backend": "https://b"})
    raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert raw == {"backend": "https://b", "token_enc": "prismx_secret".encode().hex()}
    assert "prismx_secret" not in cfg_path.read_text(encoding="utf-8")
    assert bridge_app.load_config()["token"] == "prismx_secret"


def test_dpapi_failure_never_writes_plaintext(cfg_path, monkeypatch):
    monkeypatch.setattr(bridge_app, "_dpapi_encrypt", lambda s: None)
    with pytest.raises(bridge_app.TokenStorageError):
        bridge_app.save_config({"token": "prismx_secret", "backend": "https://b"})
    raw = json.loads(cfg_path.read_text(encoding="utf-8"))
    assert raw == {"backend": "https://b"}                 # 后端地址照存，token 不落盘
    assert "prismx_secret" not in cfg_path.read_text(encoding="utf-8")


def test_empty_token_is_not_an_error(cfg_path, monkeypatch):
    monkeypatch.setattr(bridge_app, "_dpapi_encrypt", lambda s: None)
    bridge_app.save_config({"token": "", "backend": "https://b"})
    assert json.loads(cfg_path.read_text(encoding="utf-8")) == {"backend": "https://b"}
