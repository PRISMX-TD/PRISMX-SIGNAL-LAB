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
}
