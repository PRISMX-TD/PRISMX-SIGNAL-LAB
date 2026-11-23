"""财经日历的存取：后台设置、Narwhal 结果入库、分组、运行状态。

运行状态（最近同步时间、余额、报错、今天调过几次模型）只在领导 worker 上产生（后台循环只在那里跑），
所以除了留在本进程，还写进 shared_cache 给其它 worker 的管理接口读，做法同 sentiment_store。

Calendar storage: admin settings, upserting Narwhal rows, grouping, run status. Run status is
produced on the leader worker only, so it is also published to shared_cache for the other workers'
admin endpoints, as sentiment_store does.
"""
import json
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import EconRelease, PlatformSetting
from app.services import shared_cache
from app.services.econ import rules
from app.services.settings_store import set_setting

logger = logging.getLogger("prismx.econ")

SETTINGS_KEY = "econ_calendar"
SETTINGS_DEFAULTS: dict = {
    # 总开关：关着时后台循环什么都不做，不花 Narwhal 额度也不调模型 / master switch, off = no calls
    "enabled": False,
    # 公布前预案（DeepSeek）/ pre-release previews
    "previews": True,
    "countries": list(rules.DEFAULT_COUNTRIES),
    # 只给这个重要度及以上的组写预案（2 = 中）/ write previews for groups at or above this level
    "previewMinImportance": rules.MEDIUM,
    # 每天最多调多少次模型（UTC 日）/ model calls per UTC day
    "dailyLlmCap": 120,
    # 对用户开放（2026-11-21）：关掉后用户端接口返回空、仪表盘卡片和日历页不显示内容；管理台不受影响
    # Open to users: off = the user endpoint returns nothing (card and page go empty); admin unaffected
    "public": True,
    # 红色数据公布前 30 分钟推送提醒（2026-11-23，rev 54）；还要求对用户开放
    # Push an alert 30 minutes before each red release (rev 54); also requires "public"
    "alerts": True,
}

STATUS_KEY = "econ:status"
STATUS_TTL = 7 * 86400


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean_settings(stored: dict) -> dict:
    data = dict(SETTINGS_DEFAULTS)
    for key in ("enabled", "previews", "public", "alerts"):
        if isinstance(stored.get(key), bool):
            data[key] = stored[key]
    countries = stored.get("countries")
    if isinstance(countries, list):
        valid = [c for c in countries if isinstance(c, str) and len(c) == 3 and c.isalpha() and c.isupper()]
        if valid:
            data["countries"] = list(dict.fromkeys(valid))[:50]
    level = stored.get("previewMinImportance")
    if isinstance(level, int) and not isinstance(level, bool) and rules.LOW <= level <= rules.HIGH:
        data["previewMinImportance"] = level
    cap = stored.get("dailyLlmCap")
    if isinstance(cap, int) and not isinstance(cap, bool) and 0 <= cap <= 2000:
        data["dailyLlmCap"] = cap
    return data


def get_settings(db: Session) -> dict:
    """后台循环每轮读一次，量很小，不加缓存。坏值逐项回落默认。
    Read once per loop pass (tiny), no cache. Bad values fall back to defaults one by one."""
    row = db.query(PlatformSetting).filter(PlatformSetting.key == SETTINGS_KEY).first()
    stored: dict = {}
    if row:
        try:
            parsed = json.loads(row.value)
            if isinstance(parsed, dict):
                stored = parsed
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for %s, using defaults", SETTINGS_KEY)
    return _clean_settings(stored)


def save_settings(db: Session, patch: dict) -> dict:
    """合并写入（不提交）。/ Merge and write (no commit)."""
    merged = get_settings(db)
    merged.update({k: v for k, v in patch.items() if k in SETTINGS_DEFAULTS and v is not None})
    cleaned = _clean_settings(merged)
    set_setting(db, SETTINGS_KEY, cleaned)
    return cleaned


# ---- 运行状态 / run status ----

_status: dict = {}


def update_status(**fields) -> None:
    # 先并上共享缓存里的最新状态：后台循环在领导 worker、手动整周任务可能在别的 worker，
    # 各写各的本地副本会互相覆盖（例如今日模型调用次数）。
    # Merge with the shared copy first: the loop runs on the leader worker and an admin week job may
    # run on another, so writing a local copy would clobber the other's fields (e.g. today's LLM count).
    shared = shared_cache.get_json(STATUS_KEY)
    if isinstance(shared, dict):
        _status.update(shared)
    _status.update(fields)
    shared_cache.set_json(STATUS_KEY, _status, STATUS_TTL)


def get_status() -> dict:
    shared = shared_cache.get_json(STATUS_KEY)
    if isinstance(shared, dict) and shared:
        return shared
    return dict(_status)


def llm_calls_today() -> int:
    st = get_status()
    today = utcnow().date().isoformat()
    return int(st.get("llmCalls", 0)) if st.get("llmDay") == today else 0


def count_llm_call(tokens_in: int, tokens_out: int) -> None:
    today = utcnow().date().isoformat()
    st = get_status()
    if st.get("llmDay") != today:
        st.update(llmDay=today, llmCalls=0, llmTokensIn=0, llmTokensOut=0)
    _status.update(st)
    update_status(llmDay=today, llmCalls=int(st.get("llmCalls", 0)) + 1,
                  llmTokensIn=int(st.get("llmTokensIn", 0)) + tokens_in,
                  llmTokensOut=int(st.get("llmTokensOut", 0)) + tokens_out)


# ---- 入库 / upsert ----

def _parse_at(raw) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def report_slug(family: str | None, name: str | None) -> str:
    """同一时刻按「哪份报告」再分组（2026-11-21：美国 21:30 常同时出 PCE、GDP、耐用品、初请，
    合成一份预案只讲得了一个主指标）。Narwhal 有时把同一份报告拆成几条发布，这里并回去：
    就业类（初请除外）合成一份，利率决议 / 声明 / 会议合成一份，各类 PMI 合成一份，其余按发布名。
    Split a moment's releases by report (US 08:30 ET often carries PCE, GDP, durables and claims at
    once). Narwhal sometimes splits one report into several releases, so merge those back: labour
    (except claims), rate decision / statement / meeting, and PMIs; everything else by release name."""
    lowered = (name or "").lower()
    if family == "labour" and "claims" not in lowered:
        return "labour"
    if family == "policy_rate" and any(w in lowered for w in ("decision", "statement", "meeting")):
        return "rate-decision"
    if "pmi" in lowered and "ism" not in lowered and "chicago" not in lowered:
        return "pmi"
    slug = "".join(c if c.isalnum() else "-" for c in lowered).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:40] or "release"


def group_key(country: str, at: datetime | None, family: str | None = None, name: str | None = None) -> str | None:
    """国家 | 时刻 | 报告。/ country | moment | report."""
    if at is None:
        return None
    return f"{country}|{at:%Y-%m-%dT%H:%M}|{report_slug(family, name)}"


def values_of(row: EconRelease) -> list[dict]:
    try:
        parsed = json.loads(row.values_json or "[]")
    except (ValueError, TypeError):
        return []
    return [v for v in parsed if isinstance(v, dict)] if isinstance(parsed, list) else []


def _clean_values(raw) -> list[dict]:
    out = []
    for v in raw if isinstance(raw, list) else []:
        if not isinstance(v, dict) or not v.get("measure"):
            continue
        out.append({k: v[k] for k in ("measure", "concept", "unit", "transformation", "actual", "consensus",
                                      "previous", "previous_revised_from", "provisional", "period", "value_status")
                    if k in v and v[k] is not None})
    return out


def upsert_releases(db: Session, releases: list[dict], now: datetime | None = None) -> dict:
    """把 Narwhal 的发布写进库（不提交）。返回计数和「这一轮新出现公布值」的组。
    Write Narwhal releases (no commit). Returns counts and the groups that gained an actual."""
    now = now or utcnow()
    stats = {"seen": 0, "new": 0, "updated": 0, "newActuals": 0}
    actual_groups: set[str] = set()
    ids = [r.get("release_id") for r in releases if isinstance(r.get("release_id"), str)]
    existing = {row.id: row for row in db.query(EconRelease).filter(EconRelease.id.in_(ids)).all()} if ids else {}
    for r in releases:
        rid = r.get("release_id")
        country = r.get("country")
        if not isinstance(rid, str) or not isinstance(country, str):
            continue
        stats["seen"] += 1
        values = _clean_values(r.get("values"))
        at = _parse_at(r.get("at"))
        has_actual = any(v.get("actual") not in (None, "") for v in values)
        row = existing.get(rid)
        if row is None:
            row = EconRelease(id=rid, country=country, created_at=now)
            db.add(row)
            existing[rid] = row
            stats["new"] += 1
        elif (row.revision or 0) != int(r.get("revision") or 0) or row.status != r.get("status"):
            stats["updated"] += 1
        row.revision = int(r.get("revision") or 0)
        row.currency = rules.CURRENCY.get(country)
        row.series_id = r.get("series_id")
        row.name = str(r.get("name") or row.name or "")
        row.family = r.get("family")
        row.topic = r.get("topic")
        row.period = r.get("period")
        row.status = str(r.get("status") or "scheduled")
        row.at = at
        row.date = r.get("date") if isinstance(r.get("date"), str) else (at.date().isoformat() if at else None)
        row.indicative = r.get("date_basis") == "indicative"
        row.values_json = json.dumps(values, ensure_ascii=False)
        row.importance = rules.release_importance(country, row.family, row.name, values)
        row.group_key = group_key(country, at, row.family, row.name)
        if has_actual and not row.has_actual:
            row.actual_seen_at = now
            stats["newActuals"] += 1
            if row.group_key:
                actual_groups.add(row.group_key)
        row.has_actual = has_actual
        row.fetched_at = now
    stats["actualGroups"] = sorted(actual_groups)
    return stats


def merged_values(rows: list[EconRelease]) -> list[dict]:
    """同组多次发布合并数值：同名指标只留一份，优先留有预期值 / 有公布值的那份（Narwhal 偶尔把
    同一组数据拆成几条发布、数值重叠，例如澳洲就业）。
    Merge figures across a group: one entry per measure, preferring the copy with a consensus /
    actual (Narwhal sometimes splits one release into several overlapping ones)."""
    best: dict[str, dict] = {}
    order: list[str] = []
    for row in rows:
        for v in values_of(row):
            m = v["measure"]
            score = (v.get("consensus") not in (None, ""), v.get("actual") not in (None, ""))
            if m not in best:
                order.append(m)
                best[m] = v
            elif score > (best[m].get("consensus") not in (None, ""), best[m].get("actual") not in (None, "")):
                best[m] = v
    return [best[m] for m in order]
