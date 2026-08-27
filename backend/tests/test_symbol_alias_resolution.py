"""品种别名判定的回归测试。

钉的是一个在线上静默跑了 38 天的失效：行情侧推 `BTCUSD`、信号侧存 `BTCUSDT`，
判定用 `Signal.symbol == symbol` 精确匹配，于是该品种 4400 条信号里 4081 条
（93%）从未被判定逻辑碰过——而且全程不报错、webhook 照常 200、日志一行没有。
它还是平台信号量最大的品种，占全平台两成。

这类失效的共同特征是"什么都没发生"：没有异常、没有日志、数字只是静静地少。
所以这里的断言不能只测"别名能匹配上"，还要测**反向**——不同品种绝不能被
误判成同一个，否则修一个静默 bug 会换来另一个（把 XAUUSD 的行情拿去判 XAGUSD
的信号，症状同样是数字静静地错）。

Regression tests for alias-aware resolution.

Pins a failure that ran silently in production for 38 days: the price side
pushed `BTCUSD` while signals were stored as `BTCUSDT`, and resolution matched
`Signal.symbol == symbol` exactly, so 4081 of that symbol's 4400 signals (93%)
were never touched — with no exception, a 200 from the webhook, and nothing in
the logs. It was the platform's highest-volume symbol, a fifth of all signals.

The signature of this class of bug is that nothing happens: no error, no log,
numbers merely quietly missing. So these cases assert the reverse direction too
— unrelated symbols must never collapse into one another, or fixing one silent
bug would introduce another (resolving XAGUSD signals off XAUUSD's prices fails
exactly as quietly).
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import Signal
from app.services.signal_resolution import resolve_signals_with_price
from app.services.symbol_aliases import symbol_match_set


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _add(db, symbol: str, side: str = "BUY") -> str:
    """一条 PENDING 信号，入场 2000、止损 1990、止盈 2010。
    A pending signal: entry 2000, stop 1990, target 2010."""
    sig = Signal(
        symbol=symbol, side=side, entry=2000.0,
        stop_loss=1990.0 if side == "BUY" else 2010.0,
        take_profit=2010.0 if side == "BUY" else 1990.0,
        indicator="T", source="tradingview", result="PENDING",
        created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1),
    )
    db.add(sig)
    db.commit()
    return sig.id


def _result(db, sid: str) -> str:
    return db.query(Signal).filter(Signal.id == sid).first().result


# ---------- 别名表本身 / the alias table ----------

def test_alias_set_is_symmetric():
    """别名是对称的：从任一写法出发都得到同一组。行情侧推哪个名字都该判得出。
    Aliases are symmetric: either spelling yields the same group, so resolution
    works whichever name the price side happens to push."""
    assert set(symbol_match_set("BTCUSD")) == set(symbol_match_set("BTCUSDT"))
    assert "BTCUSDT" in symbol_match_set("BTCUSD")
    assert "BTCUSD" in symbol_match_set("BTCUSDT")


def test_symbol_without_alias_matches_only_itself():
    """没有别名的品种只匹配自己——别名机制不能顺手把无关品种拉进来。
    A symbol with no alias matches only itself; the mechanism must not quietly
    widen unrelated symbols."""
    assert symbol_match_set("XAUUSD") == ("XAUUSD",)
    assert symbol_match_set("EURUSD") == ("EURUSD",)


def test_alias_lookup_is_case_and_space_insensitive():
    assert set(symbol_match_set(" btcusdt ")) == set(symbol_match_set("BTCUSD"))


# ---------- 判定链路 / the resolution path ----------

def test_price_under_one_name_resolves_signal_stored_under_the_other(db):
    """**这条就是线上那 38 天**：行情推 BTCUSD，信号存 BTCUSDT，必须判得出。
    The 38-day production failure itself: price arrives as BTCUSD, the signal is
    stored as BTCUSDT, and it must still resolve."""
    sid = _add(db, "BTCUSDT")

    # 首次观测只记基线、不判定（baseline 机制）/ first observation only baselines
    resolve_signals_with_price(db, "BTCUSD", 1999.0, 2001.0)
    db.commit()
    assert _result(db, sid) == "PENDING"
    assert db.query(Signal).filter(Signal.id == sid).first().baseline_high is not None, \
        "行情侧用别名推送时，信号连基线都没拿到——判定逻辑根本没看见它"

    # 第二次观测越过止盈 / a later observation clears the target
    resolve_signals_with_price(db, "BTCUSD", 2005.0, 2012.0)
    db.commit()
    assert _result(db, sid) == "HIT_TP"


def test_resolution_works_in_the_reverse_direction_too(db):
    """反过来也要成立：行情推 BTCUSDT、信号存 BTCUSD。
    The reverse must hold too: price as BTCUSDT, signal as BTCUSD."""
    sid = _add(db, "BTCUSD")
    resolve_signals_with_price(db, "BTCUSDT", 1999.0, 2001.0)
    resolve_signals_with_price(db, "BTCUSDT", 1985.0, 2001.0)
    db.commit()
    assert _result(db, sid) == "HIT_SL"


def test_unrelated_symbols_never_collapse(db):
    """**反向保护**：别名不能把无关品种混在一起。XAUUSD 的行情绝不能判 XAGUSD
    的信号——那种错法与它要修的 bug 一样安静。
    The reverse guard: aliases must not merge unrelated symbols. XAUUSD's prices
    must never resolve XAGUSD's signals — a mistake that would fail just as
    quietly as the bug being fixed."""
    gold = _add(db, "XAUUSD")
    silver = _add(db, "XAGUSD")

    # 两次观测必须递进：基线机制只认"超出基线的新极值"，推两次相同的高低点
    # 第二次不会判定（首次只记基线）。这不是别名的问题，是判定本身的设计。
    # The two observations must widen: the baseline mechanism only counts a new
    # extreme beyond the recorded one, so pushing identical highs and lows twice
    # never resolves. That is resolution's design, not an alias concern.
    resolve_signals_with_price(db, "XAUUSD", 1998.0, 2002.0)
    resolve_signals_with_price(db, "XAUUSD", 1985.0, 2012.0)
    db.commit()

    assert _result(db, gold) != "PENDING"          # 金被判了
    assert _result(db, silver) == "PENDING"        # 银一动不动
    assert db.query(Signal).filter(Signal.id == silver).first().baseline_high is None, \
        "别名把无关品种拉进了同一次判定"


def test_wti_group_covers_broker_spellings(db):
    """原油的券商别名同样生效——这一组当初两侧一起改对了，别在重构时改坏。
    The oil group's broker spellings resolve too; this one was gotten right on
    both sides originally, and must not regress."""
    sid = _add(db, "WTI")
    resolve_signals_with_price(db, "USOIL", 1999.0, 2001.0)
    resolve_signals_with_price(db, "USOIL", 1999.0, 2015.0)
    db.commit()
    assert _result(db, sid) == "HIT_TP"
