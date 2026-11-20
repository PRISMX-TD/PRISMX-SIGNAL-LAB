"""财经日历的规则：重要度、主指标、公布值与预期值的比较。全部是纯函数，不碰库、不发请求。

Narwhal 没有重要度字段，所以按「指标名（measure）」维护一张表。不按 series_id：同一个 series_id
会装不同的东西（usa-consumer-confidence 既有密歇根也有世企研究所，usa-retail-sales 既有人口普查局
也有同店销售）。表里没有的指标默认「低」。

Calendar rules: importance, the primary figure, actual vs consensus. Pure functions only.
Narwhal has no importance field, so we keep a table keyed by measure name (not series_id — one
series_id can carry different releases). Measures missing from the table default to low.
"""
from decimal import Decimal, InvalidOperation

# 第一期关注的国家（后台可改）/ countries watched in phase 1 (editable in admin)
DEFAULT_COUNTRIES = ["USA", "EMU", "DEU", "GBR", "JPN", "CAN", "AUS", "NZL", "CHE", "CHN"]

CURRENCY = {
    "USA": "USD", "EMU": "EUR", "DEU": "EUR", "FRA": "EUR", "ITA": "EUR", "ESP": "EUR",
    "GBR": "GBP", "JPN": "JPY", "CAN": "CAD", "AUS": "AUD", "NZL": "NZD", "CHE": "CHF", "CHN": "CNY",
}

NONE, LOW, MEDIUM, HIGH = 0, 1, 2, 3

# 重要度尽量对齐 Forex Factory 的红 / 橙 / 黄（2026-11-20 按 FF 当周页面和常见分级逐项对照）。
# 按国家逐项列：同一个指标在不同国家分量不同（例如瑞士工业产出是黄、美国 CPI 是红）。
# 表里没有的一律「低」（黄）。
# Importance follows Forex Factory's red / orange / yellow, per country (the same measure weighs
# differently by country). Anything not listed is low (yellow).
_HIGH: dict[str, set[str]] = {
    "USA": {"nonfarm_payrolls_change", "unemployment_rate", "average_hourly_earnings_mom", "cpi_mom", "cpi_yoy",
            "core_cpi_mom", "core_pce_price_index_mom", "gdp_qoq", "gdp_qoq_annualized", "retail_sales_mom",
            "retail_sales_ex_autos_mom", "ism_manufacturing_pmi", "ism_services_pmi", "job_openings",
            "producer_prices_mom", "core_producer_price_change_mom"},
    "EMU": set(),
    "DEU": set(),
    "GBR": {"cpi_yoy", "gdp_mom", "gdp_3m"},
    "JPN": set(),
    "CAN": {"cpi_mom", "cpi_median_yoy", "cpi_trim_yoy", "employment_change", "unemployment_rate",
            "retail_sales_mom", "retail_sales_ex_autos_mom"},
    "AUS": {"employment_change", "unemployment_rate", "cpi_yoy", "cpi_qoq", "cpi_trim_qoq", "cpi_trim_yoy", "gdp_qoq"},
    "NZL": {"cpi_qoq", "employment_qoq", "unemployment_rate", "gdp_qoq", "inflation_expectations"},
    "CHE": set(),
    "CHN": set(),
}

_MEDIUM_BY_COUNTRY: dict[str, set[str]] = {
    "USA": {"initial_claims", "philly_fed_manufacturing", "empire_state_manufacturing", "consumer_sentiment_michigan",
            "inflation_expectations_1y", "consumer_confidence_index", "consumer_confidence", "durable_goods_orders_mom",
            "durable_goods_orders_ex_transport_mom", "core_cpi_yoy", "core_pce_price_index_yoy", "pce_price_index_mom",
            "personal_spending_mom", "personal_income_mom", "adp_employment_change", "manufacturing_pmi",
            "services_pmi", "new_home_sales", "existing_home_sales", "pending_home_sales_mom", "building_permits",
            "employment_cost_index_qoq", "average_hourly_earnings_yoy"},
    "EMU": {"cpi_yoy", "core_cpi_yoy", "hicp_yoy", "gdp_qoq", "manufacturing_pmi", "services_pmi",
            "zew_economic_sentiment"},
    "DEU": {"cpi_mom", "hicp_mom", "manufacturing_pmi", "services_pmi", "ifo_business_climate", "zew_economic_sentiment",
            "employment_change"},
    "GBR": {"claimant_count_change", "average_earnings_total_pay_yoy", "retail_sales_mom", "manufacturing_pmi",
            "services_pmi", "core_cpi_yoy", "gdp_qoq", "unemployment_rate"},
    "JPN": {"core_cpi_yoy", "core_cpi_tokyo_yoy", "gdp_qoq"},
    "CAN": {"cpi_common_yoy", "gdp_mom", "ivey_pmi", "core_cpi_mom"},
    "AUS": {"wage_price_index_qoq", "cpi_mom", "retail_sales_mom", "capital_expenditure_qoq"},
    "NZL": {"anz_business_confidence", "retail_sales_qoq", "labour_cost_index_qoq"},
    "CHE": {"cpi_mom", "gdp_qoq"},
    "CHN": {"manufacturing_pmi_official", "non_manufacturing_pmi_official", "manufacturing_pmi", "services_pmi",
            "cpi_yoy", "gdp_yoy", "industrial_production_yoy", "retail_sales_yoy", "exports_yoy"},
}

# 央行相关、没有数值的发布按名称判断 / central-bank items without figures, by name
_CB_HIGH_WORDS = ("decision", "statement", "press conference", "vote")
_CB_MEDIUM_WORDS = ("minutes", "report", "speech")

# 同等重要度下谁当「主指标」：越靠前越优先 / tie-break for the primary figure, earlier wins
_PRIORITY = [
    "policy_rate", "nonfarm_payrolls_change", "cpi_yoy", "core_cpi_mom", "cpi_mom", "core_cpi_yoy", "hicp_yoy",
    "core_pce_price_index_mom", "core_pce_price_index_yoy", "gdp_qoq", "gdp_qoq_annualized", "gdp_yoy", "gdp_mom",
    "employment_change", "unemployment_rate", "retail_sales_mom", "retail_sales_control_group_mom",
    "average_earnings_total_pay_yoy", "initial_claims", "ism_manufacturing_pmi", "manufacturing_pmi",
    "services_pmi", "composite_pmi", "zew_economic_sentiment", "ifo_business_climate", "consumer_sentiment_michigan",
    "consumer_confidence_index", "philly_fed_manufacturing", "empire_state_manufacturing",
]
_RANK = {m: i for i, m in enumerate(_PRIORITY)}

LEVEL_NAMES = {NONE: "none", LOW: "low", MEDIUM: "medium", HIGH: "high"}


def measure_importance(country: str, family: str | None, measure: str) -> int:
    """单个数值的重要度。利率决议（family=policy_rate 且带数值）一律高。
    Importance of one figure. A rate decision (family policy_rate with a figure) is always high."""
    if family == "policy_rate" or "policy_rate" in measure or measure.endswith("_cash_rate"):
        return HIGH
    if measure in _HIGH.get(country, set()):
        return HIGH
    if measure in _MEDIUM_BY_COUNTRY.get(country, set()):
        return MEDIUM
    return LOW


def release_importance(country: str, family: str | None, name: str, values: list[dict]) -> int:
    """一次发布的重要度 = 组内最高的那个数值；没有数值的（讲话、会议、纪要）按名称判断。
    A release's importance is its highest figure; releases without figures go by name."""
    if values:
        return max(measure_importance(country, family, str(v.get("measure") or "")) for v in values)
    lowered = (name or "").lower()
    if family == "policy_rate":
        # 美联储纪要在 FF 是红的，其它央行纪要是橙 / FOMC minutes are red on FF, other minutes orange
        if "minutes" in lowered and country == "USA":
            return HIGH
        if any(w in lowered for w in _CB_HIGH_WORDS):
            return HIGH
        if any(w in lowered for w in _CB_MEDIUM_WORDS):
            return MEDIUM
        return LOW
    return NONE if "positioning" in lowered else LOW


def primary_measure(country: str, family: str | None, values: list[dict]) -> dict | None:
    """一组数值里的主指标：带预期值的里面重要度最高的，同级按 _PRIORITY，再按原顺序。
    The primary figure: highest importance among figures that have a consensus, then _PRIORITY."""
    best = None
    best_key = None
    for i, v in enumerate(values):
        m = str(v.get("measure") or "")
        if not m or v.get("consensus") in (None, ""):
            continue
        key = (-measure_importance(country, family, m), _RANK.get(m, len(_PRIORITY)), i)
        if best_key is None or key < best_key:
            best, best_key = v, key
    return best


def _dec(s) -> Decimal | None:
    if s is None or s == "":
        return None
    try:
        return Decimal(str(s))
    except (InvalidOperation, ValueError):
        return None


def compare(actual, consensus) -> str | None:
    """公布值对预期值：above / inline / below。「持平」按预期值报出来的精度算——预期 0.3、
    公布 0.3 算持平，公布 0.4 算高于；预期 197、公布 203 算高于。任一缺失返回 None。
    方向的好坏（失业率越高越差）不在这里判断，由预案里写好。
    Actual vs consensus: above / inline / below, judged at the precision the consensus was quoted in.
    Whether higher is good or bad is not decided here — the preview already says so."""
    a, c = _dec(actual), _dec(consensus)
    if a is None or c is None:
        return None
    exp = c.as_tuple().exponent
    places = -exp if isinstance(exp, int) and exp < 0 else 0
    half_step = Decimal(5) * (Decimal(10) ** -(places + 1))
    diff = a - c
    if abs(diff) < half_step:
        return "inline"
    return "above" if diff > 0 else "below"


def consensus_signature(values: list[dict]) -> str:
    """把一组数值的预期值拼成签名：预期值变了，预案就要重写。
    A signature of the group's consensus figures; a change means the preview must be rewritten."""
    parts = sorted(f"{v.get('measure')}={v.get('consensus')}" for v in values if v.get("consensus") not in (None, ""))
    return ";".join(parts)
