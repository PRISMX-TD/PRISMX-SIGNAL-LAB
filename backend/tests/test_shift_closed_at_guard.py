"""`scripts/shift_closed_at.py` 的幂等护栏：`--confirm-range` 的解析与比对。

平移 closed_at 是不可逆的（`--hours -3` 跑两遍就是 -6h），而库里没有任何「已平移
过」的痕迹可以事后分辨。护栏的做法是要求操作者把**平移前**的 closed_at 区间写进
命令行，脚本算出实际区间后逐边比对——第二次照抄同一条命令时实际区间已经整体挪了
N 小时，必然对不上，于是被挡下。这里钉住解析这一环：格式认哪几种、认错了必须返回
None 而不是猜一个出来（猜错 = 护栏形同虚设）。

Pins the parsing half of shift_closed_at's idempotency guard: the operator states
the pre-shift closed_at range, the script compares it against the real one, and a
second run of the same command can't match because the range itself has moved.
"""
from datetime import datetime, timezone

from scripts.shift_closed_at import _RANGE_TOLERANCE, _fmt_range, _parse_confirm_range

UTC = timezone.utc


def test_parses_date_and_time_pairs():
    got = _parse_confirm_range("2026-08-30 07:15 2026-09-04 18:40")
    assert got == (datetime(2026, 8, 30, 7, 15, tzinfo=UTC),
                   datetime(2026, 9, 4, 18, 40, tzinfo=UTC))


def test_parses_bare_dates_as_midnight():
    got = _parse_confirm_range("2026-08-30 2026-09-04")
    assert got == (datetime(2026, 8, 30, 0, 0, tzinfo=UTC),
                   datetime(2026, 9, 4, 0, 0, tzinfo=UTC))


def test_rejects_garbage_instead_of_guessing():
    """解析不出来一律 None：脚本据此拒绝执行。宁可让人重敲一遍，也不能猜。"""
    for raw in ("", "   ", "2026-08-30", "not a date at all",
                "2026-08-30 07:15 2026-09-04", "2026-13-45 00:00 2026-09-04 00:00"):
        assert _parse_confirm_range(raw) is None


def test_preview_output_round_trips_into_confirm_range():
    """预览打印的区间必须能原样抄回 --confirm-range —— 那是设计好的工作流：
    跑预览、抄区间、加 --apply。格式对不上的话这道闸就没人用得起来。"""
    lo = datetime(2026, 8, 30, 7, 15, 42, tzinfo=UTC)
    hi = datetime(2026, 9, 4, 18, 40, 9, tzinfo=UTC)
    printed = f"{_fmt_range(lo)} {_fmt_range(hi)}"
    parsed = _parse_confirm_range(printed)
    assert parsed is not None
    # 秒被格式化掉了，差异必须落在容差内（脚本比对时用的就是这个容差）
    assert abs(parsed[0] - lo) <= _RANGE_TOLERANCE
    assert abs(parsed[1] - hi) <= _RANGE_TOLERANCE
