"""/trends 10 秒共享缓存：同一窗口内不重复读表，clear 后才看到新值（仅 TTL 失效）。
/trends is cached 10s in shared_cache; new rows show up only after the TTL/clear."""
import json
from datetime import datetime, timezone

from app.models import Trend, User
from app.routers.trends import TRENDS_CACHE_KEY, list_trends
from app.services import shared_cache


def _row(db, symbol, tf):
    db.add(Trend(symbol=symbol, timeframes=json.dumps(tf), updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))
    db.commit()


def test_trends_served_from_cache_within_ttl(db_session):
    u = User(email="t@t.co", api_token="tok_t")
    db_session.add(u)
    db_session.commit()
    _row(db_session, "XAUUSD", {"M5": "UP"})
    first = list_trends(user=u, db=db_session)
    assert first == {"trends": [{"symbol": "XAUUSD", "timeframes": {"M5": "UP"},
                                 "updatedAt": "2026-01-01T00:00:00"}]}
    _row(db_session, "EURUSD", {"M5": "DOWN"})
    assert list_trends(user=u, db=db_session) == first          # 缓存窗口内：看不到新行
    shared_cache.delete(TRENDS_CACHE_KEY)                        # 模拟 TTL 到期
    assert {t["symbol"] for t in list_trends(user=u, db=db_session)["trends"]} == {"XAUUSD", "EURUSD"}
