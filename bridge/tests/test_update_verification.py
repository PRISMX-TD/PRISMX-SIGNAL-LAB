"""自更新的来源校验：验签通过 / 哈希不符 / 签名不符 / 公钥未配置。

自更新是整条链路上唯一一处「把远端二进制装到用户机器上并执行」的地方，而运行它
的机器上正登录着用户真实的 MT5 账号。这组用例把四条判据钉死：

  1. 签名合法且哈希一致 → 放行；
  2. 下载到的字节与已签名的清单对不上 → 拒绝，且**删掉**那个文件；
  3. 清单被改过 / 用别的私钥签的 → 拒绝；
  4. 公钥还是占位符 → update_signing_ready() 为 False，且任何验签调用直接抛错，
     绝不能因为「没配公钥」而放行。

运行：cd bridge && python -m pytest tests
The self-update path is the only place that installs and runs a remote binary on a
machine signed into the user's real trading account; these four cases pin it down.
"""
import hashlib
import os
import sys

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bridge_app  # noqa: E402


# ---------- 工具 / helpers ----------

def _b64(raw: bytes) -> str:
    import base64
    return base64.b64encode(raw).decode("ascii")


def _public_key_b64(private_key: Ed25519PrivateKey) -> str:
    from cryptography.hazmat.primitives import serialization
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _b64(raw)


@pytest.fixture()
def signer(monkeypatch):
    """造一对发布密钥，并把公钥装进被测模块 / a release keypair pinned into the module."""
    key = Ed25519PrivateKey.generate()
    monkeypatch.setattr(bridge_app, "UPDATE_PUBLIC_KEY_B64", _public_key_b64(key))
    return key


def _installer_bytes(payload: bytes = b"x") -> bytes:
    """一个「看起来像安装包」的字节串：MZ 头 + 超过体积下限。
    Bytes that pass the cheap sanity check so the digest check is what's exercised."""
    return b"MZ" + payload * (bridge_app.UPDATE_MIN_BYTES + 1024)


def _write(tmp_path, name, data: bytes) -> str:
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


# ---------- 1) 验签通过 / valid signature accepted ----------

def test_signed_manifest_and_matching_digest_are_accepted(signer, tmp_path):
    blob = _installer_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    sums = f"{digest}  {bridge_app.BRIDGE_ASSET_FILENAME}\n".encode()
    sig = _b64(signer.sign(sums))

    bridge_app.verify_sums_signature(sums, sig)                     # 不抛即通过 / no raise
    assert bridge_app.expected_sha256_from_sums(
        sums.decode(), bridge_app.BRIDGE_ASSET_FILENAME
    ) == digest

    dest = _write(tmp_path, "setup.exe", blob)
    bridge_app.verify_downloaded_installer(dest, digest)            # 不抛即通过 / no raise
    assert os.path.exists(dest)


def test_fetch_expected_sha256_walks_the_whole_path(signer, monkeypatch):
    """清单与签名都从 Release 资产取回，验签后吐出应有的哈希。
    End-to-end over the two release assets, with the network stubbed out."""
    digest = "a" * 64
    sums = f"{digest} *{bridge_app.BRIDGE_ASSET_FILENAME}\n".encode()   # 二进制模式的 "*" 前缀
    sig = _b64(signer.sign(sums)).encode()
    fetched = {"https://github.com/sums": sums, "https://github.com/sig": sig}
    monkeypatch.setattr(bridge_app, "_http_get_bytes", lambda url, **kw: fetched[url])

    release = {"sums_url": "https://github.com/sums", "sums_sig_url": "https://github.com/sig"}
    assert bridge_app.fetch_expected_sha256(release) == digest


def test_release_without_signature_assets_is_refused(signer):
    """Release 里没附清单/签名时必须报错，而不是「没有就不校验」。
    A release missing the manifest must fail, not skip verification."""
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.fetch_expected_sha256({"download_url": "https://github.com/x"})


# ---------- 2) 哈希不符 / digest mismatch ----------

def test_digest_mismatch_is_refused_and_file_discarded(signer, tmp_path):
    dest = _write(tmp_path, "setup.exe", _installer_bytes(b"tampered"))
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.verify_downloaded_installer(dest, hashlib.sha256(b"something else").hexdigest())
    # 校验不过的文件不能留在原地等着被 swap_in_update 换进去。
    # A rejected download must not be left lying next to the exe.
    assert not os.path.exists(dest)


def test_manifest_without_our_filename_is_refused(signer):
    sums = f"{'b' * 64}  SomeOtherThing.exe\n"
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.expected_sha256_from_sums(sums, bridge_app.BRIDGE_ASSET_FILENAME)


# ---------- 3) 签名不符 / bad signature ----------

def test_signature_from_another_key_is_refused(signer):
    sums = f"{'c' * 64}  {bridge_app.BRIDGE_ASSET_FILENAME}\n".encode()
    attacker = Ed25519PrivateKey.generate()
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.verify_sums_signature(sums, _b64(attacker.sign(sums)))


def test_tampered_manifest_is_refused(signer):
    """签名是对原清单签的，清单被改一个字节就必须失败——这正是把哈希换成攻击者
    那份 exe 的哈希的场景。Swapping the digest invalidates the signature."""
    sums = f"{'c' * 64}  {bridge_app.BRIDGE_ASSET_FILENAME}\n".encode()
    sig = _b64(signer.sign(sums))
    tampered = sums.replace(b"c" * 64, b"d" * 64)
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.verify_sums_signature(tampered, sig)


def test_garbage_signature_is_refused(signer):
    sums = b"whatever"
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.verify_sums_signature(sums, "not base64 at all !!")
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.verify_sums_signature(sums, _b64(b"too short"))


# ---------- 4) 公钥未配置 / key not configured ----------

def test_placeholder_key_disables_self_update(monkeypatch):
    """占位符必须让自更新**自动关闭**，而不是放行。
    A placeholder key disables self-update; it must never mean "don't check"."""
    monkeypatch.setattr(
        bridge_app, "UPDATE_PUBLIC_KEY_B64", bridge_app._UPDATE_PUBLIC_KEY_PLACEHOLDER
    )
    assert bridge_app.update_signing_ready() is False
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.verify_sums_signature(b"anything", _b64(b"\x00" * 64))


def test_shipped_default_is_the_placeholder():
    """仓库里的默认值就该是占位符：真公钥是发版时才填的。
    The checked-in default must stay the placeholder; the real key is filled at release."""
    assert bridge_app.UPDATE_PUBLIC_KEY_B64 == bridge_app._UPDATE_PUBLIC_KEY_PLACEHOLDER
    assert bridge_app.update_signing_ready() is False


def test_blank_or_malformed_key_disables_self_update(monkeypatch):
    for bad in ("", "   ", "!!!not-base64!!!", _b64(b"\x01" * 31)):   # 31 字节 ≠ Ed25519
        monkeypatch.setattr(bridge_app, "UPDATE_PUBLIC_KEY_B64", bad)
        assert bridge_app.update_signing_ready() is False


# ---------- 下载入口本身 / the download entry point ----------

def test_download_release_requires_an_expected_digest():
    """expected_sha256 是必填位置参数：漏传是 TypeError，不是「静默不校验」。
    Omitting the digest is a TypeError, never a silent skip."""
    with pytest.raises(TypeError):
        bridge_app.download_release("https://github.com/x", "dest", lambda d, t: None)


def test_download_release_rejects_non_github_hosts(signer):
    """域名钉死：被改写的 Release JSON 不能把下载指到任意主机上。
    Host pinning: a rewritten release JSON can't redirect the download anywhere."""
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.download_release(
            "https://evil.example.com/PRISMX-Bridge-Setup.exe", "dest", lambda d, t: None, "a" * 64
        )


def test_download_release_verifies_what_it_actually_wrote(signer, tmp_path, monkeypatch):
    """跑通「下载 → 校验」这条真实路径：网络被打桩，喂进去的字节与清单不符 → 拒绝。
    Exercise the real download→verify path with the socket stubbed out."""
    class _FakeResponse:
        def __init__(self, data):
            self._data, self.headers = data, {"Content-Length": str(len(data))}
        def read(self, n=-1):
            chunk, self._data = self._data[:n], self._data[n:]
            return chunk
        def geturl(self):
            return "https://objects.githubusercontent.com/whatever"
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    served = _installer_bytes(b"evil")
    monkeypatch.setattr(bridge_app.request, "urlopen", lambda req, timeout=None: _FakeResponse(served))
    dest = str(tmp_path / "setup.exe")
    url = f"https://github.com/owner/repo/releases/download/v1/{bridge_app.BRIDGE_ASSET_FILENAME}"

    # 清单里写的是另一份字节的哈希 → 必须拒绝 / manifest lists different bytes
    with pytest.raises(bridge_app.UpdateVerificationError):
        bridge_app.download_release(url, dest, lambda d, t: None, hashlib.sha256(b"real build").hexdigest())
    assert not os.path.exists(dest)

    # 清单与实际字节一致 → 放行 / matching digest passes
    bridge_app.download_release(url, dest, lambda d, t: None, hashlib.sha256(served).hexdigest())
    assert os.path.exists(dest)
