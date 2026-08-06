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
