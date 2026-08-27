"""下单路径的品种名解析：别名 + 账号组后缀。

钉的是"比特币下不了单"这个线上故障。链路上有两处各自独立的错，凑齐了就是
每一单必失败：

1. **名字**：TradingView 的警报发 `BTCUSDT`，信号就按这个名字入库，下单指令也
   原样带着它走。而券商的品种表里根本没有 `BTCUSDT` 这个名字。
2. **后缀**：后缀是**按账号组**定的（STD 是 `.s`，PLUS 是 `.p`），旧的探测逻辑
   拿探测列表里第一个撞上的名字就下结论——`EURUSD` 裸名恰好存在，于是判定
   "该券商无后缀"，可黄金和加密只有带后缀的写法。

两处叠加，`BTCUSDT` + `""` 拼出来的还是 `BTCUSDT`，MT5 里不存在，回执永远是
"Symbol not available"。

下面的 `MAKE_CAPITAL_SYMBOLS` 不是编的，是从合作券商 Make Capital 的实盘终端
品种表里原样导出的 108 个名字（`history/<server>/symbols.raw`）。这份清单本身
就是断言的依据：比特币在那边叫 `BTCUSD.s`，`BTCUSDT` 一次都没出现过，黄金、
原油、全部加密品种都只有 `.s` 写法，而外汇主流对同时有裸名和 `.s` 两种——
最后这一条正是旧后缀探测栽跟头的地方。

Symbol resolution on the order path: aliases plus the account-group suffix.

Pins the "Bitcoin orders always fail" production bug, which needed two
independent mistakes to line up:

1. *The name*: TradingView alerts send `BTCUSDT`, signals are stored under that
   name, and order commands carried it through — but no such name exists in the
   broker's symbol table.
2. *The suffix*: it is per account group (`.s` for STD, `.p` for PLUS), and the
   old detection returned the first probe hit. The bare `EURUSD` happens to
   exist, so it concluded "this broker has no suffix" — while gold and crypto
   exist only in suffixed form.

Together, `BTCUSDT` + `""` stays `BTCUSDT`, which MT5 doesn't have, so every
receipt came back "Symbol not available".

`MAKE_CAPITAL_SYMBOLS` below is not invented: it is the 108 names exported
verbatim from the partner broker's live terminal symbol table
(`history/<server>/symbols.raw`). That listing is itself the evidence for these
assertions — Bitcoin is `BTCUSD.s` there, `BTCUSDT` never appears, gold, oil and
every crypto exist only as `.s`, and the major FX pairs are the only ones listed
both bare and as `.s`, which is exactly what tripped the old detection.
"""
import sys
from pathlib import Path

import pytest

from app.services.symbol_aliases import broker_symbol, symbol_match_set

# 桥接不是后端包的一部分（它是用户机器上的独立 exe），但下单路径最后一公里的
# 解析逻辑住在那里，所以测试按路径把它引进来。mt5_worker 里 MetaTrader5 的
# import 是带兜底的，非 Windows 环境同样能导入。
# The bridge isn't part of the backend package (it's a standalone exe on the
# user's machine), but the last mile of order-path resolution lives there, so
# the test imports it by path. mt5_worker guards its MetaTrader5 import, so this
# works off Windows too.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bridge"))

import mt5_worker  # noqa: E402


# 合作券商 Make Capital 实盘终端的完整品种表（原样导出，未增删）。
# The partner broker's full live symbol table, exported verbatim.
MAKE_CAPITAL_SYMBOLS = [
    "ADAUSD.s", "AUDCAD", "AUDCAD.s", "AUDCHF", "AUDCHF.s", "AUDJPY", "AUDJPY.s",
    "AUDNZD", "AUDNZD.s", "AUDUSD", "AUDUSD.s", "AUS200.s", "BCHUSD.s", "BNBUSD.s",
    "BRENT.s", "BTCUSD.s", "CADCHF", "CADCHF.s", "CADJPY", "CADJPY.s", "CHFJPY",
    "CHFJPY.s", "CN50.s", "DE30.s", "DOGUSD.s", "EOSUSD.s", "ETHUSD.s", "EURAUD",
    "EURAUD.s", "EURCAD", "EURCAD.s", "EURCHF", "EURCHF.s", "EURGBP", "EURGBP.s",
    "EURHKD", "EURHKD.s", "EURJPY", "EURJPY.s", "EURNOK", "EURNOK.s", "EURNZD",
    "EURNZD.s", "EURSEK", "EURSEK.s", "EURUSD", "EURUSD.s", "F40.s", "GBPAUD",
    "GBPAUD.s", "GBPCAD", "GBPCAD.s", "GBPCHF", "GBPCHF.s", "GBPJPY", "GBPJPY.s",
    "GBPNZD", "GBPNZD.s", "GBPUSD", "GBPUSD.s", "HK50.s", "JP225.s", "LNKUSD.s",
    "LTCUSD.s", "NZDCAD", "NZDCAD.s", "NZDCHF", "NZDCHF.s", "NZDJPY", "NZDJPY.s",
    "NZDUSD", "NZDUSD.s", "STOXX50.s", "UK100.s", "US30.s", "US500.s", "USCUSD",
    "USDCAD", "USDCAD.s", "USDCHF", "USDCHF.s", "USDCNH", "USDCNH.s", "USDHKD",
    "USDHKD.s", "USDJPY", "USDJPY.s", "USDMXN", "USDMXN.s", "USDNOK", "USDNOK.s",
    "USDSEK", "USDSEK.s", "USDSGD", "USDSGD.s", "USDTRY", "USDTRY.s", "USDUSC",
    "USDUSC.pc", "USDUSC.sc", "USDZAR", "USDZAR.s", "USI.s", "USTEC.s", "WTI.s",
    "XAGUSD.s", "XAUUSD.s", "XRPUSD.s",
]

# PLUS 组看到的是同一批品种的 .p 家族（券商的品种分组表里 Crypto.p / FX
# Majors.p 等与 .s 一一对应）。用 .s 表机械替换出来，用于验证"同一套代码，
# 换个组就该解析出 .p"。
# The PLUS group sees the .p family of the same instruments (the broker's group
# table pairs Crypto.p / FX Majors.p one-for-one with the .s ones). Derived
# mechanically from the .s table to check that the same code resolves .p for a
# PLUS account.
MAKE_CAPITAL_PLUS_SYMBOLS = [
    name[:-2] + ".p" if name.endswith(".s") else name
    for name in MAKE_CAPITAL_SYMBOLS
]

# 无后缀券商：所有品种都是裸名，且比特币也叫 BTCUSD。
# A suffix-free broker: every symbol bare, Bitcoin included.
PLAIN_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "XAGUSD", "BTCUSD", "WTI"]


# ---------- 后缀探测 / suffix detection ----------

def test_detects_group_suffix_despite_bare_fx_names():
    """裸 EURUSD 的存在不能再让探测断定"无后缀"——这正是原始 bug。
    A bare EURUSD must no longer convince detection there's no suffix."""
    assert mt5_worker.detect_suffix(MAKE_CAPITAL_SYMBOLS) == ".s"
    assert mt5_worker.detect_suffix(MAKE_CAPITAL_PLUS_SYMBOLS) == ".p"


def test_suffixless_broker_still_detects_empty():
    """反向：真的没有后缀的券商必须仍然返回 ""，不能被"覆盖率"逻辑带偏。
    Reverse: a broker that genuinely has no suffix must still yield ""."""
    assert mt5_worker.detect_suffix(PLAIN_SYMBOLS) == ""


def test_empty_symbol_table_is_not_a_suffix_guess():
    """品种表取不到时不猜，返回 ""，让上层按老路走。
    No table, no guess."""
    assert mt5_worker.detect_suffix([]) == ""


# ---------- 名字解析 / name resolution ----------

def test_btcusdt_resolves_to_the_brokers_btcusd_with_group_suffix():
    """故障的核心：BTCUSDT -> BTCUSD.s（STD）/ BTCUSD.p（PLUS）。
    The bug itself: BTCUSDT resolves to the broker's real Bitcoin symbol."""
    std = mt5_worker.broker_symbol_candidates("BTCUSDT", ".s", MAKE_CAPITAL_SYMBOLS)
    assert std[0] == "BTCUSD.s"

    plus = mt5_worker.broker_symbol_candidates("BTCUSDT", ".p", MAKE_CAPITAL_PLUS_SYMBOLS)
    assert plus[0] == "BTCUSD.p"


def test_btcusdt_resolves_even_when_the_suffix_is_wrong_or_missing():
    """后缀探测出错（或旧版桥接压根没探对）时也要能落到 BTCUSD.s：
    候选里会补上"该基础名在品种表里实际出现过的后缀"。
    Resolution must still land on BTCUSD.s when the suffix is empty or wrong."""
    for suffix in ("", ".p", ".x"):
        candidates = mt5_worker.broker_symbol_candidates(
            "BTCUSDT", suffix, MAKE_CAPITAL_SYMBOLS
        )
        assert candidates == ["BTCUSD.s"], suffix


def test_already_resolved_name_passes_through_untouched():
    """后端多数时候已经拼好了名字，解析不能把它改掉。
    A name the backend already resolved must survive unchanged."""
    candidates = mt5_worker.broker_symbol_candidates(
        "BTCUSD.s", ".s", MAKE_CAPITAL_SYMBOLS
    )
    assert candidates[0] == "BTCUSD.s"


def test_bare_fx_prefers_the_tradable_group_symbol():
    """外汇主流对两种写法都在表里，候选里带后缀的那个必须排在裸名前面：
    裸名对该组是只读的（券商把它归在 *no trade* 组）。
    Majors exist both ways; the group's suffixed symbol must outrank the bare
    one, which is read-only for that group."""
    candidates = mt5_worker.broker_symbol_candidates(
        "EURUSD", ".s", MAKE_CAPITAL_SYMBOLS
    )
    assert candidates[0] == "EURUSD.s"
    assert "EURUSD" in candidates  # 裸名仍留作兜底 / kept as a fallback


def test_other_symbols_resolve_to_their_own_suffixed_names():
    """黄金/原油/以太坊：同一条路径，不是给比特币开的特例。
    Gold, oil and Ether go through the same path — no Bitcoin special case."""
    for requested, expected in (
        ("XAUUSD", "XAUUSD.s"),
        ("WTI", "WTI.s"),
        ("ETHUSDT", "ETHUSD.s"),
        ("XRPUSDT", "XRPUSD.s"),
        ("US30", "US30.s"),
    ):
        candidates = mt5_worker.broker_symbol_candidates(
            requested, ".s", MAKE_CAPITAL_SYMBOLS
        )
        assert candidates[0] == expected, requested


def test_unknown_symbol_resolves_to_nothing():
    """反向断言：表里没有的品种绝不能被"解析"成别的品种——静默下错单比
    下单失败严重得多。
    Reverse: a symbol the broker doesn't offer must resolve to nothing at all.
    Silently trading the wrong instrument is far worse than a failed order."""
    assert mt5_worker.broker_symbol_candidates(
        "SOLUSDT", ".s", MAKE_CAPITAL_SYMBOLS
    ) == []
    assert mt5_worker.broker_symbol_candidates(
        "ETHUSDT", ".s", PLAIN_SYMBOLS
    ) == []  # 该券商不提供以太坊 / this broker offers no Ether at all


def test_resolution_never_crosses_instruments():
    """反向断言之二：解析出来的候选，基础名必须还是同一个品种。
    Second reverse guard: every candidate must still be the same instrument."""
    for requested in ("XAUUSD", "XAGUSD", "EURUSD", "EURGBP", "BTCUSDT", "ETHUSDT"):
        for candidate in mt5_worker.broker_symbol_candidates(
            requested, ".s", MAKE_CAPITAL_SYMBOLS
        ):
            base = candidate.split(".")[0]
            assert base in mt5_worker._alias_candidates(
                requested.split(".")[0]
            ), (requested, candidate)


# ---------- 后端侧的名字收敛 / backend-side name collapsing ----------

def test_backend_sends_the_broker_name_not_the_signal_name():
    """后端下发前就把名字收敛成券商写法：旧版桥接（没有上面那套解析）也能
    因此下单成功，gateway 通道同理。
    The backend collapses the name before dispatch, so older bridges — and the
    gateway channel, which has no bridge at all — benefit too."""
    assert broker_symbol("BTCUSDT") == "BTCUSD"
    assert broker_symbol("btcusdt") == "BTCUSD"
    assert broker_symbol("ETHUSDT") == "ETHUSD"
    assert broker_symbol("USOIL") == "WTI"


def test_backend_name_collapsing_is_a_no_op_for_everything_else():
    """非别名品种原样返回，不引入任何新的改名行为。
    Symbols without an alias pass through untouched."""
    for symbol in ("EURUSD", "XAUUSD", "BTCUSD", "WTI", "US30", "USDT"):
        assert broker_symbol(symbol) == symbol


def test_dispatch_name_and_resolution_name_agree():
    """两侧必须收敛到同一个名字，否则又是一处"各改一半"的静默不一致
    （symbol_aliases 顶部记的就是那次事故）。
    Both sides must land on the same name, or this becomes another "only one
    side was changed" silent mismatch — the very accident documented at the top
    of symbol_aliases."""
    for signal_name in ("BTCUSDT", "ETHUSDT", "USOIL"):
        dispatched = broker_symbol(signal_name) + ".s"
        via_bridge = mt5_worker.broker_symbol_candidates(
            signal_name, ".s", MAKE_CAPITAL_SYMBOLS
        )
        if via_bridge:
            assert via_bridge[0] == dispatched, signal_name


def test_alias_match_set_still_covers_both_spellings():
    """名字收敛不影响判定侧的集合语义（两者职责不同，见各自文件顶部）。
    Collapsing for dispatch must not disturb resolution's set semantics."""
    assert set(symbol_match_set("BTCUSDT")) == {"BTCUSD", "BTCUSDT"}
    assert set(symbol_match_set("BTCUSD")) == {"BTCUSD", "BTCUSDT"}


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))


# ---------- 端到端：下单指令走完整条解析路径 / end to end through _execute_order ----------

class _FakeSymbolInfo:
    def __init__(self, name, tradable=True):
        self.name = name
        # 4 = SYMBOL_TRADE_MODE_FULL，0 = DISABLED（只读，券商的 *no trade* 组）
        self.trade_mode = 4 if tradable else 0
        self.volume_step = 0.01
        self.volume_min = 0.01
        self.volume_max = 100.0
        self.point = 0.01
        self.digits = 2
        self.trade_stops_level = 10


class _FakeTick:
    bid = 60000.0
    ask = 60001.0


class _FakeResult:
    retcode = 10009  # TRADE_RETCODE_DONE
    price = 60001.0
    order = 4242
    deal = 1


class _FakeMt5:
    """够 _execute_order 跑完的最小 MT5 替身。

    品种表就是上面那份真实导出：BTCUSDT 不在其中，BTCUSD.s 在；裸 EURUSD 在表里
    但对该组只读，EURUSD.s 才可交易——与券商的实际配置一致。
    A minimal MT5 stand-in: the symbol table is the real export above, where
    BTCUSDT is absent, BTCUSD.s is present, and the bare EURUSD exists but is
    read-only for the group while EURUSD.s is tradable — as the broker has it.
    """
    SYMBOL_TRADE_MODE_DISABLED = 0
    TRADE_ACTION_DEAL = 1
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TIME_GTC = 0
    ORDER_FILLING_IOC = 1
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008

    def __init__(self, names, untradable=()):
        self._names = list(names)
        self._untradable = {n.upper() for n in untradable}
        self.sent = []
        self.table_reads = 0

    # --- 品种表 / symbol table ---
    def symbols_get(self):
        self.table_reads += 1
        return [_FakeSymbolInfo(n) for n in self._names]

    def symbol_select(self, name, enable=True):
        return name.upper() in {n.upper() for n in self._names}

    def symbol_info(self, name):
        if not self.symbol_select(name):
            return None
        return _FakeSymbolInfo(name, tradable=name.upper() not in self._untradable)

    def symbol_info_tick(self, name):
        return _FakeTick() if self.symbol_select(name) else None

    # --- 下单 / order placement ---
    def order_send(self, request):
        self.sent.append(request)
        return _FakeResult()

    def account_info(self):
        class _Acc:
            login = 80412337
        return _Acc()

    def last_error(self):
        return (0, "")


@pytest.fixture()
def fake_mt5(monkeypatch):
    """装上替身 MT5，并清掉模块级缓存，让每个用例互不影响。
    Install the stand-in and clear module caches so cases don't leak."""
    def _install(names, untradable=()):
        fake = _FakeMt5(names, untradable)
        monkeypatch.setattr(mt5_worker, "mt5", fake)
        monkeypatch.setattr(mt5_worker, "_symbols_cache", None, raising=False)
        monkeypatch.setattr(mt5_worker, "_attached_path", "C:/fake/terminal64.exe", raising=False)
        mt5_worker._resolved_cache.clear()
        mt5_worker._unresolved_until.clear()
        return fake
    yield _install
    mt5_worker._resolved_cache.clear()
    mt5_worker._unresolved_until.clear()


def _order(symbol):
    return {
        "clientOrderId": "c-1", "symbol": symbol, "side": "BUY",
        "volume": 0.01, "entry": 0.0, "stopLoss": 0.0, "takeProfit": 0.0,
    }


def test_order_on_btcusdt_reaches_the_broker_as_btcusd_dot_s(fake_mt5):
    """故障复现点：这条指令以前必然返回 Symbol not available。
    The exact failing command: it used to come back "Symbol not available"."""
    fake = fake_mt5(MAKE_CAPITAL_SYMBOLS)
    result = mt5_worker._execute_order(_order("BTCUSDT"), ".s")
    assert result["success"] is True
    assert fake.sent[0]["symbol"] == "BTCUSD.s"


def test_order_survives_a_wrong_suffix_from_the_server(fake_mt5):
    """后端拼错了后缀（或压根没探测到）也要下得出去。
    A wrong or missing suffix from the server must not sink the order."""
    for suffix, requested in ((".p", "BTCUSD.p"), ("", "BTCUSDT"), ("", "BTCUSD")):
        fake = fake_mt5(MAKE_CAPITAL_SYMBOLS)
        result = mt5_worker._execute_order(_order(requested), suffix)
        assert result["success"] is True, (suffix, requested)
        assert fake.sent[0]["symbol"] == "BTCUSD.s", (suffix, requested)


def test_order_picks_the_tradable_copy_over_the_read_only_one(fake_mt5):
    """裸 EURUSD 在表里但该组不可交易，必须走 EURUSD.s。
    The bare EURUSD exists but is read-only for the group; use EURUSD.s."""
    fake = fake_mt5(MAKE_CAPITAL_SYMBOLS, untradable=["EURUSD"])
    result = mt5_worker._execute_order(_order("EURUSD"), ".s")
    assert result["success"] is True
    assert fake.sent[0]["symbol"] == "EURUSD.s"


def test_order_on_a_symbol_the_broker_lacks_still_fails_cleanly(fake_mt5):
    """反向：券商没有的品种必须干脆失败，并且回执里报的是用户请求的名字。
    Reverse: a symbol the broker doesn't offer must fail outright, and the
    receipt must name what was asked for."""
    fake = fake_mt5(MAKE_CAPITAL_SYMBOLS)
    result = mt5_worker._execute_order(_order("SOLUSDT"), ".s")
    assert result["success"] is False
    assert "SOLUSDT" in result["message"]
    assert fake.sent == []


def test_a_missing_symbol_does_not_refetch_the_table_every_time(fake_mt5):
    """券商没有的品种不能变成"每次解析都重取一遍整张品种表"：报价面板 7 个
    品种每 1.5 秒解析一次，少一个品种就会把终端问穿。
    A symbol the broker lacks must not cost a full symbol-table fetch on every
    resolution: the quote panel resolves seven symbols every 1.5s."""
    fake = fake_mt5(MAKE_CAPITAL_SYMBOLS)
    assert mt5_worker._resolve_broker_symbol("SOLUSDT", ".s") is None
    reads_after_first = fake.table_reads
    for _ in range(5):
        assert mt5_worker._resolve_broker_symbol("SOLUSDT", ".s") is None
    assert fake.table_reads == reads_after_first


def test_a_resolved_symbol_is_only_resolved_once(fake_mt5):
    """解析成功的结果也走缓存，别每轮重来。
    Successful resolutions are cached too."""
    fake = fake_mt5(MAKE_CAPITAL_SYMBOLS)
    assert mt5_worker._resolve_broker_symbol("BTCUSDT", ".s") == "BTCUSD.s"
    reads_after_first = fake.table_reads
    assert mt5_worker._resolve_broker_symbol("BTCUSDT", ".s") == "BTCUSD.s"
    assert fake.table_reads == reads_after_first
