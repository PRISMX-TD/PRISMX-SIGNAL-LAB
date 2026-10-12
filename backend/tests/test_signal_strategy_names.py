"""信号面板策略下拉的策略名（2026-10-12）：只列管理员「策略公开」勾选的策略，
此刻有没有信号无关；没公开的不出现。

Strategy names for the signal board's filter (2026-10-12): exactly the admin's
published list, regardless of live signals; unpublished strategies never appear.
"""
from datetime import datetime, timezone

from app.models import Signal, User
from app.routers.signals import strategy_names
from app.services.settings_store import invalidate_winrate_settings_cache, save_winrate_settings


def test_lists_only_published_strategies(db_session):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for sid, ind in [("s1", "AIFT"), ("s2", "云指标")]:
        db_session.add(Signal(id=sid, symbol="XAUUSD", side="BUY", indicator=ind, status="ACTIVE", created_at=now))
    db_session.commit()
    save_winrate_settings(db_session, {"public_strategies": ["响尾蛇", "AIFT"]})
    db_session.commit()
    invalidate_winrate_settings_cache()

    out = strategy_names(_user=User(id="u"), db=db_session)

    # 响尾蛇此刻没信号也列出；云指标有信号但没公开，不列 / quiet but published stays, unpublished goes
    assert out == {"names": ["AIFT", "响尾蛇"]}


def test_empty_when_nothing_published(db_session):
    invalidate_winrate_settings_cache()
    assert strategy_names(_user=User(id="u"), db=db_session) == {"names": []}
