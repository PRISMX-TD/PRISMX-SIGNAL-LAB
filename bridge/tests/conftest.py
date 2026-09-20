"""把 bridge/ 放进 sys.path，让测试能 `import bridge_app` / `import mt5_worker`。

以前这一行在四个测试文件里各抄一份（外加各自的 `import os, sys` 和 `# noqa: E402`）。
桥接不是一个包（没有 __init__.py，PyInstaller 直接打 bridge_app.py），所以这一步
省不掉；但它只该出现一次，新加测试文件不该再抄。
Puts bridge/ on sys.path so tests can import bridge_app / mt5_worker. The bridge is
not a package (no __init__.py; PyInstaller bundles bridge_app.py directly), so this
step is necessary — but it belongs here once, not copied into every test file.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
