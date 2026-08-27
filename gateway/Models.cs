//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 数据结构                                    |
//+------------------------------------------------------------------+
namespace Prismx.Mt5Gateway
{
    internal sealed class AccountInfo
    {
        public ulong Login;
        public string Name = "";
        public string Group = "";
        public uint Leverage;
        public double Balance;
        public double Equity;
        public double Margin;
        public double MarginFree;

        // 该账号上次修改密码的时间(Unix 秒),由 MT5 服务器填写。
        //
        // 用途只有一个:让平台能发现"用户改了密码"。gateway 绑定之后所有操作都走
        // manager,不再校验任何密码,所以密码改了平台本来是零感知的——旧绑定仍能
        // 代客下单。后端在绑定时记下这个值,之后每轮资金刷新比对,对不上就撤销绑定。
        //
        // 0 表示服务器没填这个字段(或读不到)。后端把 0 当作"没有信号",不撤销任何
        // 绑定——宁可这道闸不生效,也不能因为字段不可用就把所有人踢下线。
        //
        // Unix seconds of this account's last password change, filled by MT5.
        // The only consumer is binding revocation: after a gateway bind every
        // operation goes through the manager and no password is ever re-checked,
        // so a password change was previously invisible and a stale binding kept
        // full trading rights. The backend records this at bind time and compares
        // it on each funds refresh. 0 means the server didn't fill it, which the
        // backend treats as "no signal" rather than revoking everyone.
        public long LastPassChange;
    }

    internal sealed class PositionInfo
    {
        public ulong Ticket;
        public string Symbol = "";
        public string Side = "";
        public double Volume;
        public double PriceOpen;
        public double PriceCurrent;
        public double StopLoss;
        public double TakeProfit;
        public double Profit;
        public string Comment = "";
    }

    internal sealed class OrderInfo
    {
        public ulong Ticket;
        public string Symbol = "";
        public uint Type;
        public double Volume;
        public double PriceOrder;
        public double StopLoss;
        public double TakeProfit;
        public string Comment = "";
    }

    /// <summary>
    /// 一笔成交(历史)。后端用它补齐 Gateway 账号的平仓明细——Bridge 那侧是
    /// 桥接程序扫 history_deals_get() 上报,Gateway 没有桥接,只能由后端来拉。
    /// </summary>
    internal sealed class DealInfo
    {
        public ulong Ticket;        // 成交编号
        public ulong PositionId;    // 所属仓位编号
        public string Symbol = "";
        public uint Action;         // 0=buy 1=sell,其余为非交易类(入金/手续费等)
        public uint Entry;          // 0=in 1=out 2=inout 3=out_by
        public double Volume;
        public double Price;
        public double Profit;
        public double Commission;
        public double Storage;      // 隔夜利息
        public long Time;           // Unix 秒(服务器给的就是 UTC 秒)
        public string Comment = "";
    }
}
