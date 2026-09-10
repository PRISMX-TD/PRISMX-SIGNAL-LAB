"""页面访问统计的路径白名单：防漂移 + 上报行为。

这张统计表是拿来做产品决策的，而它只统计白名单里的路径——**漏加一个页面等于
那个页面在数据上不存在**，而且不会报错、不会有任何症状，只会在几个月后被人
发现"怎么排行榜页从来没出现在统计里"。2026-09-10 就是这么发现的：成长三页、
客服、公告、桥接设置、三条带参路由全都从没被统计过。

所以这里把三条一致性钉死：后端白名单 == 前端上报集合 == 中英文页面名，任何
一处漏改都直接红；以及新增路由必须显式表态（统计它，或写进豁免表说明为什么
不统计），不能靠"以后记得改"。

The path whitelist behind the admin page-stats card. Missing a page there makes
that page statistically invisible with no error and no symptom — which is
exactly how the growth pages, support, announcements, bridge setup and all
three parameterised routes went uncounted for months. These tests pin backend
whitelist == frontend tracked set == zh/en labels, and force every new route to
declare itself either tracked or explicitly exempt.
"""
import json
import re
from pathlib import Path

import pytest

from app.routers.telemetry import ALLOWED_PATHS, MAX_DWELL_SECONDS, report_pageview
from app.models import PageVisitorDay, PageViewStat, User
from app.schemas import PageViewIn

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src"


def _read(rel: str) -> str:
    path = FRONTEND / rel
    if not path.exists():
        pytest.skip(f"{path} not found; skipping frontend mirror check")
    return path.read_text(encoding="utf-8")


def _tracked_paths_from_frontend() -> set[str]:
    src = _read("utils/pageTracking.ts")
    block = re.search(r"const TRACKED_PATHS = new Set\(\[(.*?)\]\)", src, re.S)
    assert block, "TRACKED_PATHS 的写法变了，这个测试的解析要跟着改"
    return set(re.findall(r"'([^']+)'", block.group(1)))


def _labels(locale: str) -> dict:
    data = json.loads(_read(f"i18n/{locale}.json"))
    return data["admin"]["pageStats"]["page"]


# App.tsx 里**有意不统计**的路由，每条都要有理由。新增页面时如果不想统计它，
# 加到这里；想统计就加进 ALLOWED_PATHS —— 两者都不做的话下面那条测试会红。
# Routes deliberately not counted; each needs a reason. A new page must land in
# one list or the other, or the test below fails.
UNTRACKED_ROUTES = {
    # 未登录可访问：上报端点要 Bearer token 且人数靠 user_id 去重，匿名访问
    # 这套机制根本记不了。要统计落地页得另做一套匿名埋点，是另一件事。
    "/": "落地页，未登录可访问",
    "/en": "落地页英文版，未登录可访问",
    "/login": "登录页，未登录",
    "/terms": "法务页，未登录可访问",
    "/privacy": "法务页，未登录可访问",
    "/risk": "法务页，未登录可访问",
    "/en/terms": "法务页，未登录可访问",
    "/en/privacy": "法务页，未登录可访问",
    "/en/risk": "法务页，未登录可访问",
    "/faq": "FAQ，未登录可访问",
    "/en/faq": "FAQ，未登录可访问",
    # 登录后但不该统计的
    "/complete-profile": "补全资料的守卫页，人人必过一次，统计它只会得到一个恒等于新用户数的数字",
    "/admin": "后台自己，统计它等于统计自己看统计的次数",
    "*": "兜底重定向，不是页面",
}


def test_backend_whitelist_mirrors_frontend_tracked_paths():
    """后端白名单与前端上报集合必须逐条相同。

    只改一边的后果是静默的：前端多了后端会 204 丢弃，后端多了前端压根不发。
    """
    assert ALLOWED_PATHS == _tracked_paths_from_frontend()


@pytest.mark.parametrize("locale", ["zh", "en"])
def test_every_tracked_path_has_a_label(locale):
    """每条被统计的路径都要有中英文页面名。

    缺了不会报错——前端 `t(key, {defaultValue: path})` 会退回显示原始路径，
    管理页上就出现一行光秃秃的 `/leaderboard` 混在中文名里。
    """
    labels = _labels(locale)
    assert set(labels) == ALLOWED_PATHS, (
        f"{locale}.json 的页面名与 ALLOWED_PATHS 不一致："
        f"缺 {sorted(ALLOWED_PATHS - set(labels))}，多 {sorted(set(labels) - ALLOWED_PATHS)}"
    )
    for path, name in labels.items():
        assert name.strip(), f"{locale}: {path} 的页面名是空的"


def test_every_route_is_either_tracked_or_explicitly_exempt():
    """App.tsx 里的每条路由都要表态：要么统计，要么写进 UNTRACKED_ROUTES。

    这条是为了根治「加了页面忘了加统计」——那种漏加没有任何症状，只会让新页面
    在数据上不存在。带参路由按模板比对（`/u/:publicId`），与上报侧的归一一致。
    """
    app_tsx = _read("App.tsx")
    routes = set(re.findall(r'<Route\s+path="([^"]+)"', app_tsx))
    # 换行写的 <Route\n path="..."> 也要抓到 / also catch multi-line <Route> tags
    routes |= set(re.findall(r'<Route\s*\n\s*path="([^"]+)"', app_tsx))

    def as_template(route: str) -> str:
        # react-router 的 :param 与我们模板里的名字未必一样，按位置归一
        return re.sub(r":[^/]+", ":param", route)

    tracked = {as_template(p) for p in ALLOWED_PATHS}
    exempt = {as_template(p) for p in UNTRACKED_ROUTES}

    undeclared = sorted(
        r for r in routes if as_template(r) not in tracked and as_template(r) not in exempt
    )
    assert not undeclared, (
        f"这些路由既没被统计也没写进 UNTRACKED_ROUTES：{undeclared}。"
        "加进 telemetry.ALLOWED_PATHS（同时改前端 TRACKED_PATHS 与两个 i18n），"
        "或写进 UNTRACKED_ROUTES 并说明为什么不统计。"
    )


def test_untracked_list_has_no_stale_entries():
    """豁免表里不该留已经不存在的路由——留着会让下一个人以为那页还在。"""
    app_tsx = _read("App.tsx")
    routes = set(re.findall(r'path="([^"]+)"', app_tsx))
    stale = sorted(r for r in UNTRACKED_ROUTES if r not in routes)
    assert not stale, f"UNTRACKED_ROUTES 里这些路由 App.tsx 已经没有了：{stale}"


# ── 上报行为 / reporting behaviour ────────────────────────────────────────────

def _user(db, email="pv@t.co", role="user"):
    u = User(email=email, api_token="tok_" + email, role=role)
    db.add(u); db.commit(); return u


def test_unknown_path_is_dropped(db_session):
    u = _user(db_session)
    report_pageview(PageViewIn(path="/../../etc/passwd", seconds=10), db_session, u)
    report_pageview(PageViewIn(path="/u/gebnck49j5", seconds=10), db_session, u)  # 未归一的实路径
    assert db_session.query(PageViewStat).count() == 0


def test_template_path_is_counted(db_session):
    u = _user(db_session)
    report_pageview(PageViewIn(path="/u/:publicId", seconds=12), db_session, u)
    row = db_session.query(PageViewStat).one()
    assert row.path == "/u/:publicId" and row.views == 1


def test_admin_visits_are_never_recorded(db_session):
    a = _user(db_session, "admin@t.co", role="admin")
    report_pageview(PageViewIn(path="/leaderboard", seconds=30), db_session, a)
    assert db_session.query(PageViewStat).count() == 0
    assert db_session.query(PageVisitorDay).count() == 0


def test_dwell_is_capped(db_session):
    u = _user(db_session)
    report_pageview(PageViewIn(path="/leaderboard", seconds=99999), db_session, u)
    assert db_session.query(PageViewStat).one().total_seconds == MAX_DWELL_SECONDS


def test_same_user_same_day_counts_once_as_a_visitor(db_session):
    u = _user(db_session)
    for _ in range(3):
        report_pageview(PageViewIn(path="/competitions", seconds=5), db_session, u)
    assert db_session.query(PageViewStat).one().views == 3      # 次数累加
    assert db_session.query(PageVisitorDay).count() == 1        # 人数去重
