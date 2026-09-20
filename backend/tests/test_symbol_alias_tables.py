"""四份品种别名表（后端 / 桥接 / 网关 / EA）必须对得上。

刻意不合并这四份表（各自回答的问题与语言不同），代价是新增品种要改四处，漏一处
只会静默失效——BTCUSDT 那次失效了 38 天。scripts/check_symbol_aliases.py 把四份表
解析出来对一遍，这里让全量测试顺带跑它；解析规则本身也钉一下，免得哪天格式一改
脚本"解析到空表"却还报一致。
The four alias tables are kept separate on purpose; this runs the drift check in
the test suite and pins the parsers against the real files.
"""
from scripts import check_symbol_aliases as chk


def test_all_four_tables_parse_and_agree():
    tables = chk.load_all()
    # ea/ 不进仓库（.gitignore），全新克隆 / CI 上没有那份源码：EA 那张表只能在开发机上
    # 核对，这里只要求其余三份齐全并一致；开发机上四份都在，仍是全量对比。
    # ea/ is kept out of the repo, so on a fresh clone / CI only three tables exist; the
    # EA one is checked on dev machines, where all four are present.
    assert {"backend", "bridge", "gateway"} <= set(tables)
    if not chk.EA.exists():
        assert "ea" not in tables
    for side, groups in tables.items():
        assert groups, f"{side} 没解析到别名组"
        assert any("BTCUSD" in g and "BTCUSDT" in g for g in groups), side
        assert any("WTI" in g and "USOIL" in g for g in groups), side
    assert chk.find_drift(tables) == []


def test_drift_is_reported():
    ref = [frozenset({"BTCUSD", "BTCUSDT"}), frozenset({"WTI", "USOIL"})]
    tables = {"backend": ref,
              "bridge": [frozenset({"BTCUSD", "BTCUSDT"})],                 # 少一个组
              "gateway": [frozenset({"BTCUSD", "BTCUSDT"}), frozenset({"WTI"})],  # 组里少名字
              "ea": []}                                                        # 没解析到
    problems = chk.find_drift(tables)
    assert any("bridge" in p and "缺少别名组" in p for p in problems)
    assert any("gateway" in p and "USOIL" in p for p in problems)
    assert any("ea" in p for p in problems)
