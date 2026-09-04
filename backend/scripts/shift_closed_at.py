"""一次性修数：把某个账户已落库的平仓时刻整体平移若干小时。

背景：gateway 通道在 2026-09-05 之前把券商服务器墙钟的 epoch 当 UTC 落库
（见 routers/gateway.observe_server_offset 的说明），该通道账户的 closed_at 整体
领先真 UTC 一个服务器时区（常见 +2 / +3 小时）。代码修好后新记录是对的，旧记录
仍然偏着，会让它们落进错误的比赛窗口。

先用 `python -m scripts.diagnose_account --login X` 看清偏了多少（对照开仓单的
created_at 与 closed_at 的差），再用本脚本平移。默认只预览，加 --apply 才写库。
只平移该账户的记录；桥接通道的账户早已是真 UTC，不要动它们。

One-off repair: shift a login's stored close instants by N hours. Preview by
default; --apply writes. Only that login's rows are touched.

    python -m scripts.shift_closed_at --login 100039 --hours -3
    python -m scripts.shift_closed_at --login 100039 --hours -3 --apply
"""
import argparse
from datetime import timedelta

from app.core.database import SessionLocal
from app.models import ClosedTrade
from app.utils.timeutil import aware as _aware


def main() -> int:
    ap = argparse.ArgumentParser(description="平移某账户已落库的 closed_at（默认预览）")
    ap.add_argument("--login", required=True)
    ap.add_argument("--hours", type=float, required=True, help="平移量，负数 = 往前拨（服务器领先 UTC 时用负数）")
    ap.add_argument("--apply", action="store_true", help="真的写库；不加只预览")
    args = ap.parse_args()
    if abs(args.hours) > 14.5:
        print("平移量超过 14.5 小时，不可能是时区偏移，拒绝执行")
        return 2
    delta = timedelta(hours=args.hours)
    db = SessionLocal()
    try:
        rows = (db.query(ClosedTrade).filter(ClosedTrade.mt5_login == args.login)
                  .order_by(ClosedTrade.closed_at).all())
        if not rows:
            print(f"账户 {args.login} 没有平仓记录")
            return 1
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
        else:
            print(f"预览 {len(rows)} 条，未写库。确认无误后加 --apply。")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
