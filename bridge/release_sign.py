"""给桥接安装包出 Release 需要的两个校验资产：SHA256SUMS 与 SHA256SUMS.sig。

用法（在 bridge/ 目录下，先跑完 pyinstaller 出 dist/PRISMX-Bridge-Setup.exe）：
    python release_sign.py
    python release_sign.py --key D:\\keys\\bridge-release-private.pem   # 私钥不在默认位置时

做的事：
  0. （可选）设置了环境变量 SIGNTOOL_CERT 时先用 signtool 给 exe 做 Authenticode 签名——
     必须在算哈希之前，因为 Authenticode 会改写 exe 的字节。没设就跳过（目前没有代码签名证书）。
  1. 对 dist/PRISMX-Bridge-Setup.exe 算 SHA-256，写成 sha256sum 标准格式的一行
     "<64 位十六进制>  <文件名>"，并在前面加一行已签名的 "version=<APP_VERSION>"
     （版本号从 bridge_app.py 的 APP_VERSION 读出）→ dist/SHA256SUMS。
     1.4.9 起桥接要求这一行存在、等于 Release tag、且严格新于自身版本（防降级）；
     旧版桥接解析时会跳过这一行，所以格式向后兼容。**以后每一版都必须用本脚本签。**
  2. 用 Ed25519 私钥对 SHA256SUMS 的**原始字节**签名，base64 单行 → dist/SHA256SUMS.sig
  3. 用 bridge_app.py 里硬编码的发布公钥 UPDATE_PUBLIC_KEY_B64 反过来验一次——私钥和
     代码里的公钥不是一对时当场报错，而不是等用户机器上的一键更新全部静默退回手动下载。

私钥**不在任何仓库里**，默认读项目根的 keys\\bridge\\bridge-release-private.pem（被 .gitignore 排除；PKCS8
PEM；加了口令就会提示输入）。泄漏它等于能给全体桥接用户推送任意可执行文件，见
bridge_app.py 顶部关于自更新来源校验的说明。换钥的注意事项见 README。

Produces the two provenance assets a bridge release needs: SHA256SUMS (sha256sum
format) and SHA256SUMS.sig (base64 Ed25519 signature over the raw manifest bytes),
then verifies the signature against the public key hard-coded in bridge_app.py so a
key/code mismatch fails here rather than silently on every user's machine.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import os
import re
import subprocess
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

HERE = os.path.dirname(os.path.abspath(__file__))
# 项目根的 keys/ 目录（.gitignore 的 /keys/ 排除，不入库）。/ keys/ at the project root, git-ignored.
DEFAULT_KEY = os.path.join(os.path.dirname(HERE), "keys", "bridge", "bridge-release-private.pem")
ASSET = "PRISMX-Bridge-Setup.exe"   # 须与 bridge_app.BRIDGE_ASSET_FILENAME 一致


def _public_key_from_source() -> Ed25519PublicKey:
    """从 bridge_app.py 正则抠出公钥常量，不 import 它（会拖进 pystray / Pillow）。"""
    src = open(os.path.join(HERE, "bridge_app.py"), encoding="utf-8").read()
    m = re.search(r'^UPDATE_PUBLIC_KEY_B64 = "([^"]+)"', src, re.M)
    if not m or m.group(1).startswith("!!!"):
        sys.exit("bridge_app.py 里没有配置发布公钥（UPDATE_PUBLIC_KEY_B64 仍是占位符）")
    return Ed25519PublicKey.from_public_bytes(base64.b64decode(m.group(1)))


def _app_version_from_source() -> str:
    """从 bridge_app.py 正则抠出 APP_VERSION（同上，不 import）。必须是 x.y.z。"""
    src = open(os.path.join(HERE, "bridge_app.py"), encoding="utf-8").read()
    m = re.search(r'^APP_VERSION = "([^"]+)"', src, re.M)
    if not m or not re.fullmatch(r"\d+\.\d+\.\d+", m.group(1)):
        sys.exit("bridge_app.py 里的 APP_VERSION 不是 x.y.z 格式，无法写入已签名的版本号")
    return m.group(1)


def build_manifest(version: str, digest: str, asset: str = ASSET) -> bytes:
    """清单原始字节：先一行 "version=<x.y.z>"，再一行 sha256sum 格式（两个空格）。
    LF 换行、无 BOM——签的就是这些字节，改一个都验不过。
    The exact bytes that get signed: a version line, then a sha256sum line."""
    return f"version={version}\n{digest}  {asset}\n".encode("ascii")


def _maybe_authenticode_sign(exe: str) -> None:
    """可选的 Authenticode 签名钩子（目前没有代码签名证书，默认跳过）。

    只有设置了环境变量 SIGNTOOL_CERT（证书在 Windows 证书库里的 SHA-1 指纹，适用于
    导入证书库的 .pfx 或 EV 硬件令牌）才会执行；signtool.exe 不在 PATH 时用 SIGNTOOL
    指定完整路径，时间戳服务器可用 SIGNTOOL_TIMESTAMP_URL 覆盖。
    必须在算 SHA-256 之前调用：Authenticode 会改写 exe，先算哈希再签会让清单失配。

    Optional Authenticode hook, skipped unless SIGNTOOL_CERT (cert-store SHA-1
    thumbprint) is set. Must run before hashing, since signing rewrites the exe.
    """
    thumb = os.environ.get("SIGNTOOL_CERT", "").strip()
    if not thumb:
        print("Authenticode   跳过（未设置 SIGNTOOL_CERT）")
        return
    signtool = os.environ.get("SIGNTOOL", "signtool")
    ts_url = os.environ.get("SIGNTOOL_TIMESTAMP_URL", "http://timestamp.digicert.com")
    subprocess.run(
        [signtool, "sign", "/sha1", thumb, "/fd", "sha256", "/tr", ts_url, "/td", "sha256", exe],
        check=True,
    )
    subprocess.run([signtool, "verify", "/pa", exe], check=True)
    print("Authenticode   已签名并通过 signtool verify /pa")


def _load_private_key(path: str) -> Ed25519PrivateKey:
    data = open(path, "rb").read()
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except TypeError:
        pw = getpass.getpass("私钥口令 / private key passphrase: ").encode()
        key = serialization.load_pem_private_key(data, password=pw)
    if not isinstance(key, Ed25519PrivateKey):
        sys.exit(f"{path} 不是 Ed25519 私钥")
    return key


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--key", default=DEFAULT_KEY, help="Ed25519 私钥 PEM 路径")
    ap.add_argument("--dist", default=os.path.join(HERE, "dist"), help="安装包所在目录")
    args = ap.parse_args()

    exe = os.path.join(args.dist, ASSET)
    if not os.path.isfile(exe):
        sys.exit(f"找不到 {exe}，先跑 pyinstaller --clean --noconfirm PRISMX-Bridge.spec")
    if not os.path.isfile(args.key):
        sys.exit(f"找不到私钥 {args.key}（用 --key 指定；它不在仓库里）")

    version = _app_version_from_source()
    # 先加载私钥（可能要输口令），再做可选的 Authenticode 签名，最后才算哈希。
    key = _load_private_key(args.key)
    _maybe_authenticode_sign(exe)                   # 会改写 exe，必须在算哈希之前
    digest = hashlib.sha256(open(exe, "rb").read()).hexdigest()
    sums = build_manifest(version, digest)
    sig = key.sign(sums)

    # 先用代码里的公钥验，再落盘：验不过说明私钥与公钥不是一对，别把坏资产发出去
    _public_key_from_source().verify(sig, sums)

    with open(os.path.join(args.dist, "SHA256SUMS"), "wb") as f:
        f.write(sums)
    with open(os.path.join(args.dist, "SHA256SUMS.sig"), "w", encoding="ascii", newline="\n") as f:
        f.write(base64.b64encode(sig).decode() + "\n")

    print(f"SHA256SUMS      version={version}")
    print(f"                {digest}  {ASSET}")
    print(f"Release tag 必须是 v{version}（桥接会核对已签名的版本号与 tag 一致）")
    print("SHA256SUMS.sig  已写出并用 bridge_app.py 里的公钥验证通过")
    print("下一步：把 dist/ 下的 exe、SHA256SUMS、SHA256SUMS.sig 三个文件一起上传到 GitHub Release（资产名不能改）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
