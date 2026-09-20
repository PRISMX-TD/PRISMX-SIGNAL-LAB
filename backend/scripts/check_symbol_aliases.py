"""只读检查：四份品种别名表是否还对得上。

背景 / Background
-----------------
同一品种在四个地方各维护一份别名表，**刻意不合并**（各自回答的问题不同、语言
不同，见各处注释）：
  · 后端  backend/app/services/symbol_aliases.py  `_ALIAS_GROUPS`（判定用集合语义）
  · 桥接  bridge/mt5_worker.py                    `_ALIAS_GROUPS`（下单前找券商品种名）
  · 网关  gateway/Mt5Link.cs                      `AliasGroups`（同上，C#）
  · EA    ea/PRISMX_MarketFeed.mq5                `GetAliasCandidates`（喂价时解析券商品种名）
不合并的代价是新增一个品种要改四处，漏一处不报错、只静默失效（BTCUSDT 那次
失效了 38 天）。这个脚本把四份表都解析出来对一遍：以后端那份为基准，其余三份
里每个别名组都必须**包含**基准组的全部名字（EA 允许多出 "BTCUSD."、"BTC/USD"
这类券商写法）。对不上就非零退出并逐条打印。

用法：从 backend/ 目录 `python -m scripts.check_symbol_aliases`；tests/ 里也有
一条用例跑同一个函数，全量测试就会顺带查。

Read-only consistency check across the four symbol-alias tables, which are kept
separate on purpose. Backend is the reference; every other table must contain a
superset of each backend group (the EA may add broker spellings). Non-zero exit
on drift; also run from the test suite.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRIDGE = REPO / "bridge" / "mt5_worker.py"
GATEWAY = REPO / "gateway" / "Mt5Link.cs"
EA = REPO / "ea" / "PRISMX_MarketFeed.mq5"


def backend_groups() -> list[frozenset[str]]:
    from app.services.symbol_aliases import _ALIAS_GROUPS
    return [frozenset(n.upper() for n in g) for g in _ALIAS_GROUPS]


def _groups_from_python(text: str) -> list[frozenset[str]]:
    block = re.search(r"_ALIAS_GROUPS[^=]*=\s*\((.*?)\n\)", text, re.S)
    if not block:
        return []
    return [frozenset(n.upper() for n in re.findall(r'"([^"]+)"', fs))
            for fs in re.findall(r"frozenset\(\{(.*?)\}\)", block.group(1), re.S)]


def _groups_from_csharp(text: str) -> list[frozenset[str]]:
    block = re.search(r"AliasGroups\s*=\s*new string\[\]\[\]\s*\{(.*?)\n\s*\};", text, re.S)
    if not block:
        return []
    return [frozenset(n.upper() for n in re.findall(r'"([^"]+)"', arr))
            for arr in re.findall(r"new string\[\]\s*\{(.*?)\}", block.group(1), re.S)]


def _groups_from_mql(text: str) -> list[frozenset[str]]:
    block = re.search(r"(int GetAliasCandidates\(.*?\n\})", text, re.S)
    if not block:
        return []
    return [frozenset(n.upper() for n in re.findall(r'"([^"]+)"', arr))
            for arr in re.findall(r"string c\[\]\s*=\s*\{(.*?)\};", block.group(1), re.S)]


def load_all() -> dict[str, list[frozenset[str]]]:
    """四份表；`ea/` 按设计不进仓库（.gitignore），文件不在时那一张表**不出现在结果里**，
    而不是解析成空表——空表会被 find_drift 报成「解析规则过期」，那是另一种故障。
    CI（全新克隆）上就是这种情况，EA 那一份只能在开发机上核对。
    All four tables; the EA source is kept out of the repo by design, so when the file
    is absent that table is omitted rather than parsed as empty (an empty table reads
    as "parser broken" in find_drift). A fresh clone / CI is exactly this case."""
    tables = {
        "backend": backend_groups(),
        "bridge": _groups_from_python(BRIDGE.read_text(encoding="utf-8")),
        "gateway": _groups_from_csharp(GATEWAY.read_text(encoding="utf-8")),
    }
    if EA.exists():
        tables["ea"] = _groups_from_mql(EA.read_text(encoding="utf-8"))
    return tables


def find_drift(tables: dict[str, list[frozenset[str]]]) -> list[str]:
    """返回不一致说明；空列表 = 四份表对得上。"""
    problems: list[str] = []
    ref = tables["backend"]
    if not ref:
        return ["backend: 没解析到任何别名组 / no alias groups parsed"]
    for side, groups in tables.items():
        if side == "backend":
            continue
        if not groups:
            problems.append(f"{side}: 没解析到任何别名组（解析规则可能过期）/ nothing parsed")
            continue
        for g in ref:
            match = [x for x in groups if g & x]
            if not match:
                problems.append(f"{side}: 缺少别名组 {sorted(g)} / group missing")
                continue
            union = frozenset().union(*match)
            missing = g - union
            if missing:
                problems.append(f"{side}: 别名组 {sorted(g)} 缺少 {sorted(missing)} / names missing")
            # 桥接与网关必须与后端完全一致（它们回答的是同一个问题：券商叫什么名）；
            # EA 允许多出 "BTCUSD."、"BTC/USD" 这类券商写法，只要求是超集。
            # Bridge and gateway must match the backend exactly; the EA may add
            # broker spellings and only has to be a superset.
            extra = union - g
            if extra and side != "ea":
                problems.append(f"{side}: 别名组 {sorted(g)} 多出 {sorted(extra)}，后端没有 / extra names")
    return problems


def main() -> int:
    tables = load_all()
    for side, groups in tables.items():
        print(f"{side:8s} " + " | ".join("/".join(sorted(g)) for g in groups))
    if "ea" not in tables:
        print(f"ea       （跳过：{EA.relative_to(REPO)} 不在本机，ea/ 不进仓库 / skipped, file absent）")
    problems = find_drift(tables)
    if problems:
        print("\n不一致 / drift:")
        for p in problems:
            print("  - " + p)
        return 1
    print(f"\n{len(tables)} 份别名表一致 / all {len(tables)} alias tables agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
