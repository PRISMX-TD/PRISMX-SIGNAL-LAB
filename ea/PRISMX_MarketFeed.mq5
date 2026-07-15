//+------------------------------------------------------------------+
//|                                        PRISMX_MarketFeed.mq5     |
//|                                                                    |
//| PRISMX 行情推送 EA / PRISMX market-data feed EA                   |
//|                                                                    |
//| 挂在任意一张图表上即可：按 InpSymbols 里配置的品种（图表不需要为   |
//| 每个品种单独打开），把 K 线、买卖报价、多周期趋势推送给 PRISMX     |
//| 后端，取代原本的 chart_feeder.py（K 线）、桥接程序的全站报价、以及 |
//| TradingView 的多周期趋势指标。                                     |
//|                                                                    |
//| Attach to any single chart. For every symbol listed in InpSymbols  |
//| (no need to open a chart per symbol), this EA pushes candles,      |
//| bid/ask quotes and multi-timeframe trend to the PRISMX backend —   |
//| replacing chart_feeder.py (candles), the bridge's site-wide quote  |
//| reporting, and the TradingView multi-timeframe trend indicator.    |
//|                                                                    |
//| 三条推送，端点与鉴权:                                              |
//| Three push channels, endpoints & auth:                             |
//|   1) K 线   POST /api/feed/candles   header X-EA-Token             |
//|   2) 报价   POST /api/feed/quotes    header X-EA-Token             |
//|   3) 趋势   POST /api/webhook/trend  body field "secret"=EA Token  |
//|                                                                    |
//| 不下单、不读持仓，只读行情 —— 与负责下单执行的 PRISMX Bridge       |
//| （bridge/ 目录，Windows 桌面程序）完全独立。                       |
//| Read-only: never places orders or reads positions — fully          |
//| independent from the order-executing PRISMX Bridge desktop app     |
//| (bridge/ folder).                                                  |
//+------------------------------------------------------------------+
#property copyright "PRISMX Signal Lab"
#property link      "https://prismxsignallab.com"
#property version   "1.00"
#property strict

//---------------------------------------------------------------------
// 输入参数 / Inputs
//---------------------------------------------------------------------
input string InpBackendUrl        = "https://api.prismxsignallab.com"; // 后端地址 / backend base URL
input string InpEaToken           = "";                                // EA 令牌，须与后端 EA_TOKEN 一致 / EA token, must match backend EA_TOKEN
input string InpSymbols           = "XAUUSD,XAGUSD,USOIL,EURUSD,GBPUSD,USDJPY,BTCUSD"; // 推送的品种，逗号分隔 / symbols to push, comma-separated
input int    InpQuoteIntervalSec  = 2;   // 报价推送间隔（秒）/ quote push interval (s)
input int    InpTrendIntervalSec  = 5;   // 趋势推送间隔（秒）/ trend push interval (s)
input int    InpCandleTickSec     = 3;   // K 线增量推送间隔（秒）/ candle tick-push interval (s)
input int    InpCandleBackfillSec = 60;  // K 线全量回补间隔（秒）/ candle backfill interval (s)
input int    InpMaxBars           = 500; // 全量回补的最大根数 / max bars per backfill
input int    InpTrendFastLen      = 10;  // 趋势快线 EMA 周期 / trend fast EMA period
input int    InpTrendSlowLen      = 30;  // 趋势慢线 EMA 周期 / trend slow EMA period
input int    InpTrendSlopeLen     = 3;   // 慢线斜率回看根数 / slow-EMA slope lookback bars
input int    InpHttpTimeoutMs     = 5000; // HTTP 超时（毫秒）/ HTTP timeout (ms)
input bool   InpVerboseLog        = false; // 打印每次推送的详细日志 / verbose push logging

//---------------------------------------------------------------------
// 品种 / 周期矩阵 / Symbol & interval matrices
//---------------------------------------------------------------------
string g_symbols[];   // 解析自 InpSymbols / parsed from InpSymbols
int    g_symCount = 0;

// K 线周期：code 须与后端 chart.py 的 ALLOWED_INTERVALS 一致
// Candle intervals: codes must match the backend's ALLOWED_INTERVALS
string           g_candleCode[6] = {"1", "5", "15", "60", "240", "D"};
ENUM_TIMEFRAMES  g_candleTf[6]   = {PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_H1, PERIOD_H4, PERIOD_D1};

// 趋势周期：对齐原 TradingView 指标的 M5/M15/M30/H1/H4
// Trend timeframes: aligned with the original TradingView indicator's M5/M15/M30/H1/H4
string           g_trendCode[5] = {"M5", "M15", "M30", "H1", "H4"};
ENUM_TIMEFRAMES  g_trendTf[5]   = {PERIOD_M5, PERIOD_M15, PERIOD_M30, PERIOD_H1, PERIOD_H4};

// 指标句柄：按 symbolIdx*5 + tfIdx 展开成一维 / indicator handles, flattened as symbolIdx*5+tfIdx
int g_fastHandle[];
int g_slowHandle[];

// 每个品种自上次趋势推送以来的滚动最高/最低价，用于止盈止损判定，覆盖两次
// 推送之间的全部报价变化，不留空档（比原 Pine 脚本仅取一根 K 线高低点更严密）。
// Per-symbol rolling high/low since the last trend push, used for TP/SL
// resolution — covers every quote change between pushes with no gap (tighter
// than the original Pine script's single-bar high/low).
double g_rollHigh[];
double g_rollLow[];
bool   g_rollInit[];

// 上一次推送的报价，用于判断是否变化 / last pushed quote, to detect changes
double g_lastBid[];
double g_lastAsk[];

// 各推送节拍的上次执行时间 / last-run time per push cadence
datetime g_lastQuotePush     = 0;
datetime g_lastTrendPush     = 0;
datetime g_lastCandleTick    = 0;
datetime g_lastCandleBackfill = 0;

//+------------------------------------------------------------------+
//| 字符串工具 / string helpers                                       |
//+------------------------------------------------------------------+
string TrimBoth(string s)
{
   string r = s;
   StringTrimLeft(r);
   StringTrimRight(r);
   return r;
}

// 按逗号切分并去空白、转大写 / split on comma, trim & uppercase each part
int SplitSymbols(string csv, string &out[])
{
   string parts[];
   int n = StringSplit(csv, ',', parts);
   int count = 0;
   ArrayResize(out, n);
   for(int i = 0; i < n; i++)
   {
      string s = TrimBoth(parts[i]);
      StringToUpper(s);
      if(StringLen(s) > 0)
      {
         out[count] = s;
         count++;
      }
   }
   ArrayResize(out, count);
   return count;
}

//+------------------------------------------------------------------+
//| HTTP：POST JSON / HTTP: POST JSON                                 |
//+------------------------------------------------------------------+
bool HttpPostJson(string path, string extraHeaders, string json, int &httpCode, string &responseBody)
{
   string url = InpBackendUrl + path;
   string headers = "Content-Type: application/json\r\n" + extraHeaders;

   uchar data[];
   int len = StringToCharArray(json, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0) ArrayResize(data, len - 1); // 去掉字符串结尾的 \0 / drop the trailing null terminator

   uchar result[];
   string resultHeaders;
   ResetLastError();
   int code = WebRequest("POST", url, headers, InpHttpTimeoutMs, data, result, resultHeaders);
   if(code == -1)
   {
      httpCode = -1;
      responseBody = StringFormat(
         "WebRequest error %d — 请把 %s 加入 工具>选项>EA交易>允许的 WebRequest URL 列表 / "
         "add %s to Tools>Options>Expert Advisors>Allow WebRequest for listed URL",
         GetLastError(), InpBackendUrl, InpBackendUrl
      );
      return false;
   }
   httpCode = code;
   responseBody = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return code == 200;
}

//+------------------------------------------------------------------+
//| 初始化 / OnInit                                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   if(StringLen(InpEaToken) == 0)
   {
      Print("PRISMX_MarketFeed: InpEaToken 为空，后端会拒绝所有推送 / InpEaToken is empty, the backend will reject every push");
   }

   g_symCount = SplitSymbols(InpSymbols, g_symbols);
   if(g_symCount == 0)
   {
      Print("PRISMX_MarketFeed: InpSymbols 未解析出任何品种 / InpSymbols parsed to zero symbols");
      return INIT_PARAMETERS_INCORRECT;
   }

   ArrayResize(g_fastHandle, g_symCount * 5);
   ArrayResize(g_slowHandle, g_symCount * 5);
   ArrayResize(g_rollHigh, g_symCount);
   ArrayResize(g_rollLow, g_symCount);
   ArrayResize(g_rollInit, g_symCount);
   ArrayResize(g_lastBid, g_symCount);
   ArrayResize(g_lastAsk, g_symCount);

   for(int i = 0; i < g_symCount; i++)
   {
      // 确保品种在市场报价窗口里，否则取不到报价/K 线（不需要为它单独开图表）。
      // Make sure the symbol is in Market Watch, otherwise no quotes/candles
      // are available (no need to open a dedicated chart for it).
      if(!SymbolSelect(g_symbols[i], true))
         Print("PRISMX_MarketFeed: 无法选中品种 / cannot select symbol: ", g_symbols[i]);

      g_rollInit[i] = false;
      g_lastBid[i] = 0;
      g_lastAsk[i] = 0;

      for(int t = 0; t < 5; t++)
      {
         int idx = i * 5 + t;
         g_fastHandle[idx] = iMA(g_symbols[i], g_trendTf[t], InpTrendFastLen, 0, MODE_EMA, PRICE_CLOSE);
         g_slowHandle[idx] = iMA(g_symbols[i], g_trendTf[t], InpTrendSlowLen, 0, MODE_EMA, PRICE_CLOSE);
      }
   }

   EventSetTimer(1);
   Print("PRISMX_MarketFeed: 已启动，推送 ", g_symCount, " 个品种 / started, pushing ", g_symCount, " symbol(s)");
   // 启动即做一次全量回补，避免等到第一个 backfill 周期才有图表数据。
   // Do an initial full backfill immediately instead of waiting for the first cycle.
   PushCandles("backfill", InpMaxBars);
   g_lastCandleBackfill = TimeCurrent();
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| 反初始化 / OnDeinit                                               |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int i = 0; i < ArraySize(g_fastHandle); i++)
   {
      if(g_fastHandle[i] != INVALID_HANDLE) IndicatorRelease(g_fastHandle[i]);
      if(g_slowHandle[i] != INVALID_HANDLE) IndicatorRelease(g_slowHandle[i]);
   }
}

// 补建初始化时失败（品种当时还没就绪）的指标句柄 / lazily (re)create handles that failed at init
void EnsureHandles()
{
   for(int i = 0; i < g_symCount; i++)
   {
      for(int t = 0; t < 5; t++)
      {
         int idx = i * 5 + t;
         if(g_fastHandle[idx] == INVALID_HANDLE)
            g_fastHandle[idx] = iMA(g_symbols[i], g_trendTf[t], InpTrendFastLen, 0, MODE_EMA, PRICE_CLOSE);
         if(g_slowHandle[idx] == INVALID_HANDLE)
            g_slowHandle[idx] = iMA(g_symbols[i], g_trendTf[t], InpTrendSlowLen, 0, MODE_EMA, PRICE_CLOSE);
      }
   }
}

//+------------------------------------------------------------------+
//| 定时器：驱动全部推送节拍 / Timer: drives every push cadence       |
//+------------------------------------------------------------------+
void OnTimer()
{
   datetime now = TimeCurrent();

   // 每次 tick 都累积滚动高低点，覆盖趋势推送之间的全部报价变化。
   // Accumulate the rolling high/low on every tick, covering every quote
   // change between trend pushes.
   UpdateRollingHighLow();

   if(now - g_lastQuotePush >= InpQuoteIntervalSec)
   {
      PushQuotes();
      g_lastQuotePush = now;
   }
   if(now - g_lastTrendPush >= InpTrendIntervalSec)
   {
      EnsureHandles();
      PushTrends();
      g_lastTrendPush = now;
   }
   if(now - g_lastCandleTick >= InpCandleTickSec)
   {
      PushCandles("tick", 2);
      g_lastCandleTick = now;
   }
   if(now - g_lastCandleBackfill >= InpCandleBackfillSec)
   {
      PushCandles("backfill", InpMaxBars);
      g_lastCandleBackfill = now;
   }
}

//+------------------------------------------------------------------+
//| 滚动高低点 / rolling high-low accumulator                         |
//+------------------------------------------------------------------+
void UpdateRollingHighLow()
{
   for(int i = 0; i < g_symCount; i++)
   {
      double bid = SymbolInfoDouble(g_symbols[i], SYMBOL_BID);
      double ask = SymbolInfoDouble(g_symbols[i], SYMBOL_ASK);
      if(bid <= 0 || ask <= 0) continue;
      if(!g_rollInit[i])
      {
         g_rollHigh[i] = ask;
         g_rollLow[i]  = bid;
         g_rollInit[i] = true;
         continue;
      }
      if(ask > g_rollHigh[i]) g_rollHigh[i] = ask;
      if(bid < g_rollLow[i])  g_rollLow[i]  = bid;
   }
}

//+------------------------------------------------------------------+
//| 报价推送 / quote push                                             |
//+------------------------------------------------------------------+
void PushQuotes()
{
   string items = "";
   int n = 0;
   for(int i = 0; i < g_symCount; i++)
   {
      double bid = SymbolInfoDouble(g_symbols[i], SYMBOL_BID);
      double ask = SymbolInfoDouble(g_symbols[i], SYMBOL_ASK);
      if(bid <= 0 || ask <= 0) continue;
      if(g_lastBid[i] == bid && g_lastAsk[i] == ask) continue; // 未变化，跳过 / unchanged, skip
      g_lastBid[i] = bid;
      g_lastAsk[i] = ask;

      int digits = (int)SymbolInfoInteger(g_symbols[i], SYMBOL_DIGITS);
      if(n > 0) items += ",";
      items += StringFormat(
         "{\"symbol\":\"%s\",\"bid\":%s,\"ask\":%s,\"digits\":%d}",
         g_symbols[i], DoubleToString(bid, digits), DoubleToString(ask, digits), digits
      );
      n++;
   }
   if(n == 0) return;

   string json = "{\"data\":[" + items + "]}";
   int code; string body;
   if(!HttpPostJson("/api/feed/quotes", "X-EA-Token: " + InpEaToken + "\r\n", json, code, body))
      Print("PRISMX_MarketFeed: quotes push failed (", code, "): ", body);
   else if(InpVerboseLog)
      Print("PRISMX_MarketFeed: pushed ", n, " quote(s)");
}

//+------------------------------------------------------------------+
//| 趋势推送：每个品种一条 POST，与原 TradingView 指标行为一致        |
//| Trend push: one POST per symbol, matching the original            |
//| TradingView indicator's behavior                                  |
//+------------------------------------------------------------------+
string TrendDir(double c, double fast, double slow, double slowPrev)
{
   if(c > slow && fast > slow && slow > slowPrev) return "UP";
   if(c < slow && fast < slow && slow < slowPrev) return "DOWN";
   return "FLAT";
}

void PushTrends()
{
   for(int i = 0; i < g_symCount; i++)
   {
      string tfJson = "";
      bool ok = true;
      for(int t = 0; t < 5; t++)
      {
         int idx = i * 5 + t;
         if(g_fastHandle[idx] == INVALID_HANDLE || g_slowHandle[idx] == INVALID_HANDLE) { ok = false; break; }

         // 显式按 series 索引（下标 0 = 当前，下标越大越早），避免依赖默认排序
         // Explicit series indexing (index 0 = current, larger index = older),
         // don't rely on the implicit default ordering
         double fastBuf[]; ArraySetAsSeries(fastBuf, true);
         double slowBuf[]; ArraySetAsSeries(slowBuf, true);
         if(CopyBuffer(g_fastHandle[idx], 0, 0, 1, fastBuf) != 1) { ok = false; break; }
         if(CopyBuffer(g_slowHandle[idx], 0, 0, InpTrendSlopeLen + 1, slowBuf) != InpTrendSlopeLen + 1) { ok = false; break; }

         double c = iClose(g_symbols[i], g_trendTf[t], 0);
         string dir = TrendDir(c, fastBuf[0], slowBuf[0], slowBuf[InpTrendSlopeLen]);

         if(t > 0) tfJson += ",";
         tfJson += StringFormat("\"%s\":\"%s\"", g_trendCode[t], dir);
      }
      if(!ok) continue; // 该品种指标尚未就绪，下次再试 / indicators not ready yet, retry next cycle

      int digits = (int)SymbolInfoInteger(g_symbols[i], SYMBOL_DIGITS);
      // 用自上次推送以来累积的滚动高低点做止盈止损判定，随后重置累积窗口。
      // 尚未采集到任何报价时发 null（而不是 0），避免后端把 0 当真实低点，
      // 误判任何正数止损为"已触发"。
      // Use the rolling high/low accumulated since the last push for TP/SL
      // resolution, then reset the accumulation window. Send null (not 0)
      // when no quote has been captured yet, so the backend never treats 0 as
      // a real low and falsely resolves any positive stop-loss as "hit".
      string highJson = g_rollInit[i] ? DoubleToString(g_rollHigh[i], digits) : "null";
      string lowJson  = g_rollInit[i] ? DoubleToString(g_rollLow[i], digits)  : "null";
      g_rollInit[i] = false;

      string json = StringFormat(
         "{\"secret\":\"%s\",\"symbol\":\"%s\",\"trends\":{%s},\"high\":%s,\"low\":%s,\"id\":\"%s-%d\"}",
         InpEaToken, g_symbols[i], tfJson,
         highJson, lowJson,
         g_symbols[i], (int)TimeCurrent()
      );
      int code; string body;
      if(!HttpPostJson("/api/webhook/trend", "", json, code, body))
         Print("PRISMX_MarketFeed: trend push failed for ", g_symbols[i], " (", code, "): ", body);
      else if(InpVerboseLog)
         Print("PRISMX_MarketFeed: pushed trend for ", g_symbols[i]);
   }
}

//+------------------------------------------------------------------+
//| K 线推送 / candle push                                            |
//+------------------------------------------------------------------+
void PushCandles(string mode, int count)
{
   // 服务器时间与真实 UTC 的秒差，自动探测，不需要像 chart_feeder.py 那样
   // 手动配置 server_utc_offset。/ Auto-detected server-to-UTC offset —
   // unlike chart_feeder.py, no manual server_utc_offset config needed.
   int gmtOffset = (int)TimeGMTOffset();

   string series = "";
   int seriesCount = 0;
   for(int i = 0; i < g_symCount; i++)
   {
      for(int t = 0; t < 6; t++)
      {
         MqlRates rates[];
         int got = CopyRates(g_symbols[i], g_candleTf[t], 0, count, rates);
         if(got <= 0) continue;

         string bars = "";
         for(int b = 0; b < got; b++)
         {
            if(b > 0) bars += ",";
            // epoch 秒转 int 足够用到 2038 年，与后端/其它喂价器的处理口径一致
            // epoch seconds fit in int until 2038, consistent with the backend
            // and the other feeders' handling
            int trueUtc = (int)((long)rates[b].time - gmtOffset);
            bars += StringFormat(
               "{\"t\":%d,\"o\":%s,\"h\":%s,\"l\":%s,\"c\":%s}",
               trueUtc,
               DoubleToString(rates[b].open, 8),
               DoubleToString(rates[b].high, 8),
               DoubleToString(rates[b].low, 8),
               DoubleToString(rates[b].close, 8)
            );
         }
         if(seriesCount > 0) series += ",";
         series += StringFormat("{\"symbol\":\"%s\",\"interval\":\"%s\",\"bars\":[%s]}", g_symbols[i], g_candleCode[t], bars);
         seriesCount++;
      }
   }
   if(seriesCount == 0) return;

   string json = StringFormat("{\"mode\":\"%s\",\"series\":[%s]}", mode, series);
   int code; string body;
   if(!HttpPostJson("/api/feed/candles", "X-EA-Token: " + InpEaToken + "\r\n", json, code, body))
      Print("PRISMX_MarketFeed: candles push (", mode, ") failed (", code, "): ", body);
   else if(InpVerboseLog)
      Print("PRISMX_MarketFeed: pushed candles (", mode, "), ", seriesCount, " series");
}

//+------------------------------------------------------------------+
//| OnTick：本 EA 不依赖图表自身品种的报价，留空即可                  |
//| OnTick: this EA doesn't depend on the chart's own symbol ticks    |
//+------------------------------------------------------------------+
void OnTick()
{
}
