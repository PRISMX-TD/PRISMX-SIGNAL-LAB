"""平台设置读取的两处收口：只查要用的键，和布尔开关不猜。

**只查要用的键**：券商锁设置每 30 秒回源一次，而它挂在桥接 1.5 秒轮询的路径上。
原来是 `query(PlatformSetting).all()` —— 同一张表里还存着带图文的策略 JSON、
一次性邮箱名单、account_type 规则这些大值，整表拉回来只为取四个小键，99% 是白烧
Supabase 的出网流量（本项目对 Egress 敏感）。

**布尔开关不猜**：原来用 `bool(stored[k])` 收敛，而 `bool("false")` 是 True。手改库
或旧数据把开关写成字符串时，读出来反而是「开」——这些开关控制的正是游戏化内容
对用户可见不可见，猜错的方向恰好是往「更公开」走。数值键早就是「坏值回退默认」，
布尔键现在也一样。

Two tightenings in settings_store: fetch only the keys in use, and never guess a
boolean.
"""
import json

from app.models import PlatformSetting
from app.services import settings_store
from app.services.settings_store import (
    BROKER_DEFAULTS,
    GAMIFICATION_DEFAULTS,
    _load_broker_from_db,
    _load_gamification_from_db,
)


# ---------- 只查要用的键 / narrow the query ----------

class _RecordingDB:
    """记下 query 链上都调了什么，用来看这次读取到底问了库什么。"""

    def __init__(self, rows: list) -> None:
        self.rows = rows
        self.filtered = False

    def query(self, _model):
        return self

    def filter(self, *_args):
        self.filtered = True
        return self

    def all(self):
        return self.rows

    def first(self):
        return self.rows[0] if self.rows else None


def test_broker_settings_do_not_pull_the_whole_table():
    db = _RecordingDB([])
    _load_broker_from_db(db)
    assert db.filtered, "券商设置只要 4 个键，不能 query(...).all() 整表拉回来"


def test_broker_settings_still_read_their_keys(db_session):
    """收窄查询不能把功能改坏：存进去的值照样读得出来，没存的回落默认值。"""
    key = next(iter(BROKER_DEFAULTS))
    other = {k for k in BROKER_DEFAULTS if k != key}
    db_session.add(PlatformSetting(key=key, value=json.dumps(True)))
    # 同表里的大值（策略 JSON 那类）不该被这次读取碰到，但存在也不能出错
    db_session.add(PlatformSetting(key="platform_strategies", value=json.dumps({"big": "x" * 5000})))
    db_session.commit()

    data = _load_broker_from_db(db_session)

    assert data[key] is True
    for k in other:
        assert data[k] == BROKER_DEFAULTS[k]
    assert "platform_strategies" not in data


# ---------- 布尔开关不猜 / booleans are not guessed ----------

def _bool_key() -> str:
    return next(k for k, v in GAMIFICATION_DEFAULTS.items() if isinstance(v, bool))


def _store(db, payload: dict) -> None:
    db.add(PlatformSetting(key="gamification", value=json.dumps(payload)))
    db.commit()
    settings_store.invalidate_gamification_cache()


def test_the_string_false_does_not_read_back_as_on(db_session):
    """`bool("false")` 是 True——这条正是那个坑。类型不对就回退默认，不猜。"""
    key = _bool_key()
    _store(db_session, {key: "false"})

    assert _load_gamification_from_db(db_session)[key] == GAMIFICATION_DEFAULTS[key]


def test_other_wrong_types_fall_back_too(db_session):
    key = _bool_key()
    for bad in (1, 0, "true", "", None, [], {}):
        db_session.query(PlatformSetting).filter(PlatformSetting.key == "gamification").delete()
        _store(db_session, {key: bad})
        got = _load_gamification_from_db(db_session)[key]
        assert got == GAMIFICATION_DEFAULTS[key], f"{bad!r} 不该被当成布尔值"


def test_real_booleans_still_win(db_session):
    """真正的 JSON 布尔照常生效，否则这个设置就等于改不动了。"""
    key = _bool_key()
    flipped = not GAMIFICATION_DEFAULTS[key]
    _store(db_session, {key: flipped})

    assert _load_gamification_from_db(db_session)[key] is flipped
