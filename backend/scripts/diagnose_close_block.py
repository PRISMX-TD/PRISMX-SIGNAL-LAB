"""只读诊断：一张仓位为什么平不掉（MT_RET_REQUEST_CLOSE_ORDER_EXIST）。

MT5 服务器对同一张仓位只允许存在一张平仓单。券商那边若有一张平仓单迟迟没
执行也没撤销，仓位就被锁住，之后每一次平仓都在 dealer 侧直接驳回。这个脚本
把三处对照着打出来，用来区分"谁把单挂上去的"：

  1. orders 表里这张仓位的全部 CLOSE 指令——有没有一条标成 FILLED 却没带
     成交号。网关把 MT_RET_REQUEST_PLACED 当成交，但平仓路径不做成交确认
     （开仓做，见 Mt5Link.OpenPosition 的成交事件回填），所以一笔"只是被接进
     队列、并未成交"的平仓会被记成成功，仓位其实还开着。这种就是我们自己
     发的挡路单。
  2. 券商当前持仓——仓位还在不在。不在就说明那张单后来成交了，问题已自愈。
  3. 券商当前挂单——挡路的那张单本体。注意网关 /orders 不返回挂单所属的
     仓位号，所以这里只能按品种列出候选，最终确认要去 MT5 管理端看。

只读：不下单、不撤单、不写库。

用法 / Usage（在后端 VPS 上，从 backend/ 目录）：
    .venv/bin/python -m scripts.diagnose_close_block --login 603689 --ticket 36109204

--ticket 可省略，省略时列出该账号最近的全部 CLOSE 指令。
"""
import argparse
import asyncio

import httpx

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import MT5Account, Order, User
from app.utils.timeutil import aware as _aware


def _fmt(dt) -> str:
    if dt is None:
        return "—"
    return _aware(dt).strftime("%Y-%m-%d %H:%M:%S UTC")


def _gw(path: str, body: dict) -> dict:
    """直接打网关的只读接口。这里不复用 gateway_client 的连接池单例，
    那个池要在 FastAPI 启动时初始化，脚本进程里没有。"""
    url = settings.GATEWAY_URL.rstrip("/") + path
    headers = {
        "X-Gateway-Token": settings.GATEWAY_TOKEN,
        "Content-Type": "application/json",
    }
    with httpx.Client(timeout=20.0) as c:
        r = c.post(url, json=body, headers=headers)
        r.raise_for_status()
        return r.json()


def main() -> int:
    ap = argparse.ArgumentParser(description="诊断平仓被拒：仓位上是否挂着平仓单（只读）")
    ap.add_argument("--login", required=True, help="MT5 账户号")
    ap.add_argument("--ticket", type=int, default=0, help="仓位号，省略则列出全部 CLOSE")
    ap.add_argument("--limit", type=int, default=20, help="不带 --ticket 时列出多少条")
    ap.add_argument("--skip-gateway", action="store_true", help="只查库，不打网关")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        # 只取需要的列，不整行映射 ORM：库的 schema 比模型落后一两列时（本地开发
        # 库常见）整行查询会直接报 no such column，而诊断脚本必须能跑起来。
        # Select only the needed columns: a schema slightly behind the models
        # makes a full-entity load fail outright, and a diagnostic must still run.
        accts = (db.query(MT5Account.login, MT5Account.server,
                          MT5Account.source, MT5Account.user_id)
                   .filter(MT5Account.login == str(args.login)).all())
        if not accts:
            print(f"没有账户 {args.login}")
            return 1
        for login, server, source, user_id in accts:
            email = db.query(User.email).filter(User.id == user_id).scalar()
            print(f"账户 {login}  user={email or user_id}  "
                  f"source={source}  server={server}")
        print()

        q = (db.query(Order.created_at, Order.ticket, Order.volume, Order.status,
                      Order.mt5_ticket, Order.mt5_position, Order.filled_price,
                      Order.message, Order.client_order_id)
               .filter(Order.mt5_login == str(args.login), Order.action == "CLOSE"))
        if args.ticket:
            q = q.filter(Order.ticket == args.ticket)
        rows = q.order_by(Order.created_at.desc()).limit(args.limit).all()

        title = f"仓位 {args.ticket} 的" if args.ticket else "最近的"
        print(f"── orders 表里{title} CLOSE 指令（{len(rows)} 条）──")
        if not rows:
            print("（无）")
        suspects = []
        for r in rows:
            # 真成交带成交号/订单号；只被接进队列的单两者都没有。
            flag = ""
            if r.status == "FILLED" and not r.mt5_ticket:
                flag = "   <== 可疑：记为成交却没有成交号/订单号"
                suspects.append(r)
            print(f"{_fmt(r.created_at)}  ticket={r.ticket}  vol={r.volume}  "
                  f"status={r.status}  mt5_ticket={r.mt5_ticket or 0}  "
                  f"price={r.filled_price or 0}{flag}")
            if r.message:
                print(f"                       message={r.message}")
        print()

        if suspects:
            print(f"!! 有 {len(suspects)} 条『记为成交但没有成交号』的平仓指令。")
            print("   这正是被接进 dealer 队列却没执行的形态——挡路的单很可能是我们自己发的。")
            print()

        if args.skip_gateway:
            return 0
        if not settings.GATEWAY_TOKEN:
            print("（GATEWAY_TOKEN 未配置，跳过网关查询）")
            return 0

        print("── 券商当前持仓 ──")
        try:
            data = _gw("/positions", {"login": int(args.login)})
            positions = data.get("positions", []) if data.get("ok") else []
            if not data.get("ok"):
                print(f"读取失败：{data.get('error')}")
            hit = None
            for p in positions:
                mark = ""
                if args.ticket and p.get("ticket") == args.ticket:
                    hit = p
                    mark = "   <== 就是它"
                print(f"ticket={p.get('ticket')}  {p.get('symbol')}  {p.get('side')}  "
                      f"{p.get('volume')} 手  profit={p.get('profit')}{mark}")
            if not positions:
                print("（无持仓）")
            if args.ticket:
                print()
                if hit:
                    print(f"仓位 {args.ticket} 仍然开着 => 那张平仓单确实没执行，问题还在。")
                else:
                    print(f"仓位 {args.ticket} 已不在持仓里 => 那张单后来成交了，问题已自愈。")
        except Exception as e:  # noqa: BLE001
            print(f"查询持仓出错：{e}")
        print()

        print("── 券商当前挂单 ──")
        print("（网关 /orders 不返回挂单所属仓位号，所以只能按品种对照；")
        print("  要确认哪张绑在目标仓位上，需到 MT5 管理端看 Position 字段）")
        try:
            data = _gw("/orders", {"login": int(args.login)})
            orders = data.get("orders", []) if data.get("ok") else []
            if not data.get("ok"):
                print(f"读取失败：{data.get('error')}")
            for o in orders:
                print(f"order={o.get('ticket')}  {o.get('symbol')}  type={o.get('type')}  "
                      f"{o.get('volume')} 手  price={o.get('priceOrder')}  "
                      f"comment={o.get('comment')}")
            if not orders:
                print("（无挂单）")
                print()
                print("账号上没有任何挂单，却仍被 CLOSE_ORDER_EXIST 拒绝 =>")
                print("挡路的请求卡在券商 dealer 队列里，还没落成一张可见的单，需券商处理。")
        except Exception as e:  # noqa: BLE001
            print(f"查询挂单出错：{e}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
