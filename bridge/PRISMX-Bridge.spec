# -*- mode: python ; coding: utf-8 -*-
"""PRISMX Bridge 打包配置 / PyInstaller build spec.

用法 / usage:
    pip install -r requirements.txt pyinstaller
    pyinstaller --clean --noconfirm PRISMX-Bridge.spec
产出 dist/PRISMX-Bridge-Setup.exe（单文件，双击即用），文件名必须与 GitHub
Release 的资产名、以及 bridge_app.py 的 BRIDGE_ASSET_FILENAME 保持一致。

两条**不要改回去**的设置（改了会明显抬高杀软误报率，见 README）：
  * onefile：所有内容打进一个 exe，不产出一堆散文件；
  * upx=False：不压缩。UPX 壳是 Windows Defender / 第三方杀软的高危特征之一，
    对本程序体积收益也有限。

本文件**入库**（2026-09-20 起，见 .gitignore 里 `!bridge/PRISMX-Bridge.spec` 那段说明）：
它不是 PyInstaller 的生成物，而是手工维护的——hiddenimports（pystray/PIL 的运行时
后端、cryptography 的 ed25519 与 Rust 扩展）、datas、upx/console 的取舍都写在这里。
不入库的话只有打过包的那台机器能复现构建，重新生成的 spec 漏掉的依赖不会报错，
只会让「一键更新」悄悄退回手动下载。打包与发版签名流程见 README。
"""

block_cipher = None


a = Analysis(
    ['bridge_app.py'],
    pathex=[],
    binaries=[],
    # 图标文件本身也要进包：托盘图标在运行时通过 resource_path() 读取，
    # 只靠 exe 图标是不够的（那只是文件图标，不是运行时资源）。
    datas=[('app.ico', '.'), ('app.png', '.')],
    # pystray / PIL 的后端是运行时按平台动态导入的，静态分析扫不到。
    # 漏掉它们的话，打包出来的程序在最小化到托盘那一步才会崩。
    #
    # cryptography 那三条是 1.4.2 起新增的，必须显式列出，原因有两层：
    #   ① 它在 bridge_app._load_update_public_key() 里是**函数内惰性 import**——
    #      这是刻意的（打包漏了只禁用自更新，不让整个程序起不来），但也正因为如此，
    #      静态分析未必扫得到；
    #   ② ed25519 的实现落在 cryptography 的 Rust 扩展 `_rust` 里，它是原生模块，
    #      不在纯 Python 的 import 图上。
    # 漏掉的后果特别隐蔽：程序照常启动、照常交易，只有「一键更新」那条路会静默
    # 退回手动下载——而验签自更新正是 1.4.2 的主要内容。所以宁可显式写死。
    # 打包完必须用 --selftest 之类的方式确认 `import cryptography` 在产物里可用。
    #
    # The cryptography entries are new in 1.4.2 and must be explicit: it is imported
    # lazily inside a function (deliberately — a packaging miss should only disable
    # self-update, not the app), and its ed25519 implementation lives in the native
    # `_rust` extension, which is not on the pure-Python import graph. Missing it
    # fails silently: the app runs fine and only one-click update quietly degrades to
    # manual download — which is the whole point of 1.4.2.
    hiddenimports=[
        'pystray._win32',
        'PIL._tkinter_finder',
        'cryptography',
        'cryptography.hazmat.primitives.asymmetric.ed25519',
        'cryptography.hazmat.bindings._rust',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='PRISMX-Bridge-Setup',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # ⚠ 不要开启：UPX 壳会显著抬高杀软误报率
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,      # GUI 程序，不要弹黑框
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='app.ico',
)
