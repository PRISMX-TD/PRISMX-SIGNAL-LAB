"""一次性修数：把某个账户已落库的平仓时刻整体平移若干小时。

背景：gateway 通道在 2026-09-05 之前把券商服务器墙钟的 epoch 当 UTC 落库
（见 routers/gateway.observe_server_offset 的说明），该通道账户的 closed_at 整体
领先真 UTC 一个服务器时区（常见 +2 / +3 小时）。代码修好后新记录是对的，旧记录
仍然偏着，会让它们落进错误的比赛窗口。

先用 `python -m scripts.diagnose_account --login X` 看清偏了多少（对照开仓单的
created_at 与 closed_at 的差），再用本脚本平移。默认只预览，加 --apply 才写库。
只平移该账户的记录；桥接通道的账户早已是真 UTC，不要动它们。

**幂等：为什么要两道闸** / Idempotency: why two gates
------------------------------------------------------
平移是**不可逆**的：`--hours -3` 跑两遍就是 -6h，而数据库里没有任何「这批行已经
平移过」的痕迹可以事后分辨——平移后的时刻和一个本来就那么早的时刻长得一模一样。
所以这里不去猜，改成要求操作者自己把预期讲清楚：

  1. `--confirm-range "<min> <max>"`：把**平移前**的 closed_at 区间（UTC，
     `YYYY-MM-DD HH:MM` 或 `YYYY-MM-DD`）显式写进命令行。脚本先算出实际区间，
     对不上就直接拒绝——已经平移过一次的话，实际区间整体挪了 N 小时，第二次
     照抄同一条命令必然对不上，第二遍就被挡在这里。
  2. `--apply` 仍然照旧：不加只预览。

预览模式会把实际区间原样打印出来，方便照抄进 `--confirm-range`——也就是说
「先跑一次预览、把区间抄进来、再跑 --apply」这个流程本身就是一次人工复核。

The shift is irreversible (`--hours -3` twice is -6h) and leaves no marker: a
shifted instant is indistinguishable from one that was always that early. Rather
than guessing, the operator must state the expected *pre-shift* closed_at range
with --confirm-range; the script computes the real range and refuses on any
mismatch. A second run of the same command can't match, because the range has
itself moved by N hours — that's the idempotency guard. Preview mode prints the
range in exactly the format --confirm-range wants, so the intended flow (preview,
copy the range, re-run with --apply) is a human double-check by construction.

**过滤口径** / Filtering: 与 `diagnose_account.py` 一致，按 `(mt5_login, user_id)`
过滤，不只按 login。同一个 login 理论上可以出现在多个用户名下（诊断脚本就是
按这个口径打印的），只按 login 平移会连带改掉别人的行。

    python -m scripts.shift_closed_at --login 100039 --hours -3
    python -m scripts.shift_closed_at --login 100039 --hours -3 \
        --confirm-range "2026-08-30 07:15 2026-09-04 18:40" --apply
"""
import argparse
from datetime import datetime, timedelta, timezone

from app.core.database import SessionLocal
from app.models import ClosedTrade, MT5Account
from app.utils.timeutil import aware as _aware

_RANGE_FMT = "%Y-%m-%d %H:%M"
# 区间比对的容差：命令行只精确到分钟，秒级的差异不算不一致。
# Tolerance for the range check: the CLI takes minutes, so don't fail on seconds.
_RANGE_TOLERANCE = timedelta(seconds=60)


def _fmt_range(dt) -> str:
    return _aware(dt).strftime(_RANGE_FMT)


def _parse_confirm_range(raw: str) -> tuple[datetime, datetime] | None:
    """`"<min> <max>"`，两端都是 UTC 的 `YYYY-MM-DD HH:MM` 或 `YYYY-MM-DD`。"""
    parts = (raw or "").split()
    if len(parts) == 4:                       # 两个「日期 时间」
        chunks = [f"{parts[0]} {parts[1]}", f"{parts[2]} {parts[3]}"]
    elif len(parts) == 2:                     # 两个纯日期
        chunks = [f"{parts[0]} 00:00", f"{parts[1]} 00:00"]
    else:
        return None
    out = []
    for c in chunks:
        try:
            out.append(datetime.strptime(c, _RANGE_FMT).replace(tzinfo=timezone.utc))
        except ValueError:
            return None
    return out[0], out[1]


def main() -> int:
    ap = argparse.ArgumentParser(description="平移某账户已落库的 closed_at（默认预览）")
    ap.add_argument("--login", required=True)
    ap.add_argument("--hours", type=float, required=True, help="平移量，负数 = 往前拨（服务器领先 UTC 时用负数）")
    ap.add_argument("--apply", action="store_true", help="真的写库；不加只预览")
    ap.add_argument("--confirm-range", dest="confirm_range",
                    help='平移前 closed_at 的预期区间（UTC），如 "2026-08-30 07:15 2026-09-04 18:40"。'
                         "--apply 时必填；对不上就拒绝执行（幂等护栏）")
    args = ap.parse_args()
    if abs(args.hours) > 14.5:
        print("平移量超过 14.5 小时，不可能是时区偏移，拒绝执行")
        return 2
    delta = timedelta(hours=args.hours)
    db = SessionLocal()
    try:
        # 口径与 diagnose_account.py 一致：按 (login, user_id) 过滤。同一个 login
        # 可能挂在多个用户名下，只按 login 会连带改掉别人的行。
        # Same filter as diagnose_account.py: (login, user_id), because one login
        # may sit under several users and a login-only filter would touch theirs.
        uids = {a.user_id for a in
                db.query(MT5Account).filter(MT5Account.login == args.login)}
        if not uids:
            print(f"没有账户 {args.login}（没有任何 mt5_accounts 行），拒绝执行")
            return 1
        if len(uids) > 1:
            print(f"⚠ 账户 {args.login} 挂在 {len(uids)} 个用户名下，将全部平移")
        rows = (db.query(ClosedTrade)
                  .filter(ClosedTrade.mt5_login == args.login,
                          ClosedTrade.user_id.in_(uids))
                  .order_by(ClosedTrade.closed_at).all())
        if not rows:
            print(f"账户 {args.login} 没有平仓记录")
            return 1

        lo, hi = _aware(rows[0].closed_at), _aware(rows[-1].closed_at)
        actual = f"{_fmt_range(lo)} {_fmt_range(hi)}"
        print(f"账户 {args.login}：{len(rows)} 条平仓记录，closed_at 区间（平移前，UTC）")
        print(f"  {actual}")
        print()

        if args.apply:
            if not args.confirm_range:
                print("--apply 需要同时给出 --confirm-range（平移前的 closed_at 区间）。")
                print("先跑一次预览，把上面那行区间原样抄进来：")
                print(f'  --confirm-range "{actual}"')
                return 2
            expected = _parse_confirm_range(args.confirm_range)
            if expected is None:
                print(f"--confirm-range 解析失败：{args.confirm_range!r}")
                print('格式为 "YYYY-MM-DD HH:MM YYYY-MM-DD HH:MM"（或两个纯日期）')
                return 2
            if (abs(expected[0] - lo) > _RANGE_TOLERANCE
                    or abs(expected[1] - hi) > _RANGE_TOLERANCE):
                print("✗ 区间对不上，拒绝执行。")
                print(f"  你说的：{_fmt_range(expected[0])} {_fmt_range(expected[1])}")
                print(f"  实际的：{actual}")
                print("如果这批记录**已经平移过一次**，实际区间就会整体挪了 N 小时——")
                print("那正是这道闸要挡的情况，请先确认是否真的还需要再平移。")
                return 2

        for t in rows:
            before = _aware(t.closed_at)
            after = before + delta
            print(f"  deal={t.deal_ticket} pos={t.position_ticket} {t.symbol} profit={t.profit:+.2f}"
                  f"  {before.strftime('%Y-%m-%d %H:%M:%S')} → {after.strftime('%Y-%m-%d %H:%M:%S')} UTC")
            if args.apply:
                t.closed_at = after.replace(tzinfo=None)
        if args.apply:
            db.commit()
            print(f"已平移 {len(rows)} 条。进行中的比赛榜下次读取时自动重算；已终审的比赛名次不会自动改。")
            print(f"平移后的区间：{_fmt_range(lo + delta)} {_fmt_range(hi + delta)}")
        else:
            print(f"预览 {len(rows)} 条，未写库。确认无误后加：")
            print(f'  --confirm-range "{actual}" --apply')
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
