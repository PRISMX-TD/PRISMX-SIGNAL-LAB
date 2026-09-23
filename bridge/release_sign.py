"""给桥接安装包出 Release 需要的两个校验资产：SHA256SUMS 与 SHA256SUMS.sig。

用法（在 bridge/ 目录下，先跑完 pyinstaller 出 dist/PRISMX-Bridge-Setup.exe）：
    python release_sign.py
    python release_sign.py --key D:\\keys\\bridge-release-private.pem   # 私钥不在默认位置时

做的事：
  1. 对 dist/PRISMX-Bridge-Setup.exe 算 SHA-256，写成 sha256sum 标准格式的一行
     "<64 位十六进制>  <文件名>" → dist/SHA256SUMS
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

    digest = hashlib.sha256(open(exe, "rb").read()).hexdigest()
    sums = f"{digest}  {ASSET}\n".encode()          # 两个空格：sha256sum 的标准格式
    sig = _load_private_key(args.key).sign(sums)

    # 先用代码里的公钥验，再落盘：验不过说明私钥与公钥不是一对，别把坏资产发出去
    _public_key_from_source().verify(sig, sums)

    with open(os.path.join(args.dist, "SHA256SUMS"), "wb") as f:
        f.write(sums)
    with open(os.path.join(args.dist, "SHA256SUMS.sig"), "w", encoding="ascii", newline="\n") as f:
        f.write(base64.b64encode(sig).decode() + "\n")

    print(f"SHA256SUMS      {digest}  {ASSET}")
    print("SHA256SUMS.sig  已写出并用 bridge_app.py 里的公钥验证通过")
    print("下一步：把 dist/ 下的 exe、SHA256SUMS、SHA256SUMS.sig 三个文件一起上传到 GitHub Release（资产名不能改）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
