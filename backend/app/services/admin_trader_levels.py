"""管理页「交易员等级」卡：每一级现在有多少人、具体是谁、什么时候升上来的。

**等级不是库里的一列**，它由 `user_tasks` 派生（见 gamification.conditions.level_of：
连续完整完成的组数 + 1，取值 1~6）。所以「达到第 N 级的时间」同样只能派生——
第 N 级要求前 N-1 组条件全部完成，那一刻就是这些条件里**最晚**的一条 completed_at。
第 1 级没有条件、注册即是，达成时间取注册时间。

「连续」这两个字是关键：只完成了第 2 组、第 1 组还缺一条的人**仍是 1 级**，
他第 2 组那些 completed_at 不参与任何达成时间的计算。照着"完成了哪些条件"去数组数，
会把这种人错算成 2 级。

一次把全部用户与全部任务拉回来在内存里算完，而不是"先数人数、点开名单再查一次"：
`user_tasks` 每人最多 22 行（5 组共 22 个条件），一次全表比逐级往返便宜得多；更重要的是
卡片上的人数与展开的名单出自同一次计算，两个数字不可能对不上。

Admin "trader levels" card: how many users sit at each level, who they are and
when they got there.

The level is derived, never stored: it is 1 + the number of CONSECUTIVELY
completed condition groups. "Reached level N" is therefore the latest
completed_at among the conditions of groups 1..N-1; level 1 needs no conditions,
so its moment is the signup time. The "consecutive" part matters — someone who
finished group 2 while group 1 is still short of one condition is still level 1,
and none of their group-2 timestamps count.

Everything is computed in one pass over users and tasks rather than counting
first and querying again on expand: at most 22 task rows per user, and the count
on the card and the list behind it can never disagree.
"""
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models import User, UserTask
from app.schemas import (
    AdminTraderLevelsOut, AdminTraderLevelUsersOut, TraderLevelRowOut, TraderLevelUserOut,
)
from app.services.gamification import GROUPS, LEVEL_TITLES, level_of
from app.services.stats_time import RangeSpec, local_day
from app.utils.timeutil import aware

LEVEL_COUNT = len(LEVEL_TITLES)  # 6：level 取值 1..6，标题是 LEVEL_TITLES[level - 1]
# 名单默认上限。这张卡是用来"点开看看都有谁"的，不是导出工具；要全量走用户管理页。
# Default list cap: this card is for a look at who's there, not a bulk export.
DEFAULT_USER_LIMIT = 200
# 排序兜底：达成时刻缺失的行排到最后，而不是让排序抛异常。
_TIME_FLOOR = datetime.min.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class UserLevel:
    """一名用户的当前等级，外加他升到每一级的时刻（键是 1..level）。"""
    user: User
    level: int
    reached: dict[int, datetime | None]

    @property
    def reached_at(self) -> datetime | None:
        """升到**当前**这一级的时刻。"""
        return self.reached.get(self.level)


def _reached_map(level: int, done: dict[str, datetime], created_at: datetime | None) -> dict[int, datetime | None]:
    """升到 1..level 每一级的时刻。

    第 N 级（N ≥ 2）= 前 N-1 组条件全部完成的那一刻 = 这些条件里最晚的一条。
    条件是逐组累加的，所以边扫组边取 max 就够，不必每级重新遍历。
    Moment for each level 1..level: the latest completed_at among the conditions
    of all preceding groups, accumulated group by group.
    """
    moments: dict[int, datetime | None] = {1: created_at}
    latest: datetime | None = None
    for index in range(level - 1):
        for cond in GROUPS[index][1]:
            stamp = done.get(cond)
            if stamp is not None and (latest is None or stamp > latest):
                latest = stamp
        # completed_at 理论上不会缺（能到这一级说明条件都记过），真缺了就退回注册时间：
        # 名单里给个偏早的时间也好过空着一格。
        # Fall back to signup if a timestamp is somehow missing.
        moments[index + 2] = latest if latest is not None else created_at
    return moments


def compute_levels(db: Session) -> list[UserLevel]:
    """全部非管理员用户的当前等级与各级达成时刻。"""
    users = db.query(User).filter(User.role != "admin").all()
    done_by_user: dict[str, dict[str, datetime]] = defaultdict(dict)
    for user_id, task_id, completed_at in db.query(
        UserTask.user_id, UserTask.task_id, UserTask.completed_at
    ).all():
        done_by_user[user_id][task_id] = completed_at

    out: list[UserLevel] = []
    for user in users:
        done = done_by_user.get(user.id, {})
        level = level_of(set(done))
        out.append(UserLevel(user=user, level=level, reached=_reached_map(level, done, user.created_at)))
    return out


def _in_range(moment: datetime | None, spec: RangeSpec) -> bool:
    """达成时刻按 STATS_TZ 归日后是否落在所选区间内。"""
    return moment is not None and spec.start <= local_day(moment) <= spec.end


def level_rows(db: Session, spec: RangeSpec) -> AdminTraderLevelsOut:
    """每一级：现有人数（当前处于该等级，**不跟时间范围走**）+ 本期达成人数（跟范围走）。

    两个数字口径不同是有意的：「现有」回答"现在盘子长什么样"，「本期达成」回答
    "这段时间涨了多少"。所以本期达成**不是**现有人数的子集——这段时间升到 3 级的人，
    现在可能已经是 4 级，他算进 3 级的"本期达成"，却不在 3 级的"现有"里。
    Two different questions on purpose: the stock now vs the flow in the period.
    Someone who reached level 3 during the period may already be level 4, so the
    flow is not a subset of the stock.
    """
    rows = compute_levels(db)
    totals = Counter(r.level for r in rows)
    reached: Counter[int] = Counter()
    for row in rows:
        for level, moment in row.reached.items():
            if _in_range(moment, spec):
                reached[level] += 1

    return AdminTraderLevelsOut(
        rangeStart=spec.start.isoformat(),
        rangeEnd=spec.end.isoformat(),
        totalUsers=len(rows),
        levels=[
            TraderLevelRowOut(
                level=level,
                key=LEVEL_TITLES[level - 1],
                total=totals.get(level, 0),
                reachedInRange=reached.get(level, 0),
            )
            for level in range(1, LEVEL_COUNT + 1)
        ],
    )


def level_users(
    db: Session,
    level: int,
    spec: RangeSpec,
    scope: str = "all",
    limit: int = DEFAULT_USER_LIMIT,
) -> AdminTraderLevelUsersOut:
    """某一级的用户名单，按达成时间倒序（最近升上来的在最前）。

    scope="all"：当前正处于该等级的人。
    scope="range"：在所选时间段内升到该等级的人——含之后又往上走的，所以名单里可能
    有人现在已经不在这一级，每行都带上他现在的等级免得读错。
    scope="all" lists who is at this level now; scope="range" lists who reached it
    during the period, including people who have since moved up — each row carries
    the user's current level so it can't be misread.
    """
    rows = compute_levels(db)
    if scope == "range":
        picked = [(r, r.reached[level]) for r in rows if level in r.reached and _in_range(r.reached[level], spec)]
    else:
        picked = [(r, r.reached_at) for r in rows if r.level == level]

    picked.sort(key=lambda pair: aware(pair[1]) or _TIME_FLOOR, reverse=True)

    return AdminTraderLevelUsersOut(
        level=level,
        key=LEVEL_TITLES[level - 1],
        scope="range" if scope == "range" else "all",
        rangeStart=spec.start.isoformat(),
        rangeEnd=spec.end.isoformat(),
        total=len(picked),
        users=[
            TraderLevelUserOut(
                id=r.user.id,
                email=r.user.email,
                nickname=r.user.nickname,
                phone=r.user.phone,
                currentLevel=r.level,
                reachedAt=moment,
                createdAt=r.user.created_at,
            )
            for r, moment in picked[:limit]
        ],
    )
