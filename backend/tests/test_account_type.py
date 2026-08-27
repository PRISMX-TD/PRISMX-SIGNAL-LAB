"""账户实盘判定：组名 → 实盘/竞赛/模拟。

**为什么这件事值得测**：它是"这笔交易算不算真金白银"的唯一判据，下游是实盘任务、
胜率考核、收益率榜、比赛。判错的方向如果是"把非真仓算成实盘"，整套战绩就失去意义
——模拟盘可以零成本无限下单。所以这里重点锁两件事：**判不出来时绝不猜**，以及
**最长前缀命中**（配置里更具体的前缀必须压过更宽泛的）。

MT5 的 Manager API 没有 per-account 的 demo/real 布尔，只能靠券商的组名划分——这也是
本平台 `allowed_groups` 下单白名单一直在用的依据。详见 services/account_type.py。

文件分两段：前半段用显式配置测**算法**，后半段拿线上真实组名测**出厂配置**。分开是
故意的——算法与"这家券商的组叫什么"是两件会各自变化的事，混在一起改一个就得动另一个。

Account-type classification from the broker's group name. Split in two: the
algorithm (explicit settings) and the shipped defaults (real production group
names), because those two change for different reasons.
"""
import pytest

from app.services.account_type import CONTEST, DEMO, REAL, classify_group, is_real
from app.services.settings_store import ACCOUNT_TYPE_DEFAULTS


# ---------- 算法本身 / the algorithm ----------

_SETTINGS = {
    "real_group_prefixes": ["real"],
    "contest_group_prefixes": ["contest"],
    "demo_group_prefixes": ["demo", "preliminary"],
}


@pytest.mark.parametrize("group,expected", [
    ("real\\forex\\standard", REAL),
    ("REAL\\ECN", REAL),                 # 大小写不敏感
    ("  real\\vip  ", REAL),             # 首尾空白
    ("demo\\forex", DEMO),
    ("preliminary\\a", DEMO),
    ("contest\\may2026", CONTEST),
])
def test_prefix_matching(group, expected):
    assert classify_group(group, _SETTINGS) == expected


@pytest.mark.parametrize("group", ["", "   ", None, "managers", "coverage\\hedge", "vip"])
def test_unknown_groups_are_never_guessed(group):
    """判不出来一律 None。

    这是本模块最重要的性质：宁可漏算一个账号（它被排除在实盘统计外，等运维把
    前缀补进配置后自动纠正），也不能猜错方向把非真仓算成实盘。
    """
    assert classify_group(group, _SETTINGS) is None


def test_longest_prefix_wins():
    """更具体的前缀压过更宽泛的——否则两条配置会互相打架。

    真实场景：券商用 `demo` 放普通模拟户，又用 `demo-live-test` 放一批走真实
    撮合的测试户。按声明顺序匹配会把后者误判成模拟。
    """
    settings = {
        "demo_group_prefixes": ["demo"],
        "real_group_prefixes": ["demo-live"],
        "contest_group_prefixes": [],
    }
    assert classify_group("demo\\forex", settings) == DEMO
    assert classify_group("demo-live\\ecn", settings) == REAL


def test_empty_config_classifies_nothing():
    """前缀表清空 = 全部未知，而不是全部实盘。"""
    empty = {"real_group_prefixes": [], "contest_group_prefixes": [], "demo_group_prefixes": []}
    assert classify_group("real\\forex", empty) is None


def test_malformed_config_entries_are_skipped():
    """配置里混进空串/空白不能把所有组都判成命中（空前缀 startswith 恒真）。"""
    settings = {"real_group_prefixes": ["", "   "], "contest_group_prefixes": [], "demo_group_prefixes": []}
    assert classify_group("demo\\forex", settings) is None


def test_is_real_treats_unknown_as_not_real():
    assert is_real(REAL) is True
    assert is_real(DEMO) is False
    assert is_real(CONTEST) is False
    assert is_real(None) is False, "未知必须按非实盘处理"


# ---------- 出厂配置 / the shipped defaults ----------
#
# 用的是线上真实组名。合作券商 (Make Capital) 专门为本平台开了两个真仓组，只有被
# 加进这两个组的账号才连得上 gateway；其余一律不是本平台的真仓接入。

REAL_GROUPS = ["MCSA\\I-STD-SLAB-USD", "MCSA\\I-PLUS-SLAB-USD"]


@pytest.mark.parametrize("group", REAL_GROUPS)
def test_the_two_live_groups_are_recognised(group):
    assert classify_group(group, ACCOUNT_TYPE_DEFAULTS) == REAL


def test_live_groups_match_case_insensitively():
    """券商上报的大小写不保证与配置一致。"""
    assert classify_group("mcsa\\i-std-slab-usd", ACCOUNT_TYPE_DEFAULTS) == REAL


def test_the_broker_demo_group_is_recognised():
    """线上实际存在的模拟组。"""
    assert classify_group("demo\\STD-USD", ACCOUNT_TYPE_DEFAULTS) == DEMO


@pytest.mark.parametrize("group", [
    "MCSA\\SOMETHING-ELSE",      # 同一实体下的其他子组
    "MCSA",                      # 只有实体前缀
    "MCSA\\I-STD-SLAB-EUR",      # 形似但不是那两个组
])
def test_other_mcsa_subgroups_are_not_live(group):
    """**不能用 `MCSA` 这个宽前缀**。

    券商将来在同一实体下新开的任何子组（包括他们自己的测试组）都会被宽前缀扫成
    实盘，方向正好是最危险的那个。新开真仓组时改一次配置，比这个风险便宜得多。
    """
    assert classify_group(group, ACCOUNT_TYPE_DEFAULTS) is None


def test_generic_real_prefix_is_deliberately_absent():
    """出厂配置刻意不含通用的 `real` 前缀——本平台的真仓接入是严格白名单。"""
    assert classify_group("real\\forex", ACCOUNT_TYPE_DEFAULTS) is None
