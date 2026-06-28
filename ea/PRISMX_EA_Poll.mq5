//+------------------------------------------------------------------+
//|                                                PRISMX_EA_Poll.mq5 |
//|                            PRISMX Signal Lab - HTTP polling bridge |
//|        棱镜信号实验室 - HTTP 轮询桥接 EA / HTTP polling bridge EA   |
//+------------------------------------------------------------------+
#property copyright "PRISMX Signal Lab"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

//--- 语言枚举 / Language enum
enum ENUM_LANG { LANG_ZH = 0, LANG_EN = 1 };

//--- 输入参数 / Input parameters
input string    InpServerUrl    = "http://127.0.0.1:8000"; // 平台地址 / Server URL
input string    InpApiToken     = "";                       // API Token (来自网页 / from web)
input ENUM_LANG InpLanguage     = LANG_ZH;                  // 语言 / Language
input int       InpMagic        = 880088;                   // 魔术号 / Magic number
input int       InpPollSec      = 3;                         // 轮询间隔秒 / Poll interval seconds
input int       InpSlippage     = 20;                        // 允许滑点(点) / Slippage points

//--- 全局变量 / Globals
datetime g_last_poll = 0;
datetime g_last_pos  = 0;
CTrade   g_trade;

//+------------------------------------------------------------------+
//| 双语文本 / Bilingual helpers                                       |
//+------------------------------------------------------------------+
string L(const string zh, const string en) { return(InpLanguage == LANG_ZH ? zh : en); }
void   Log(const string zh, const string en) { Print("[PRISMX] " + L(zh, en)); }

//+------------------------------------------------------------------+
//| JSON 字符串转义 / Escape a string for JSON                        |
//+------------------------------------------------------------------+
string JsonEscape(const string s)
{
   string out = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(c == '"')       out += "\\\"";
      else if(c == '\\') out += "\\\\";
      else if(c == '\n') out += " ";
      else if(c == '\r') out += " ";
      else if(c == '\t') out += " ";
      else               out += ShortToString(c);
   }
   return(out);
}

//+------------------------------------------------------------------+
//| 简易 JSON 取值 / Minimal JSON value extraction                    |
//+------------------------------------------------------------------+
string JsonGetStr(const string json, const string key, const int from = 0)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat, from);
   if(p < 0) return("");
   p = StringFind(json, ":", p);
   if(p < 0) return("");
   p++;
   while(p < StringLen(json) && StringGetCharacter(json, p) == ' ') p++;
   if(p >= StringLen(json)) return("");
   if(StringGetCharacter(json, p) == '"')
   {
      p++;
      int e = StringFind(json, "\"", p);
      if(e < 0) return("");
      return(StringSubstr(json, p, e - p));
   }
   int e = p;
   while(e < StringLen(json))
   {
      ushort c = StringGetCharacter(json, e);
      if(c == ',' || c == '}' || c == ']' || c == ' ') break;
      e++;
   }
   return(StringSubstr(json, p, e - p));
}

double JsonGetNum(const string json, const string key, const int from = 0)
{
   string s = JsonGetStr(json, key, from);
   if(s == "") return(0.0);
   return(StringToDouble(s));
}

//+------------------------------------------------------------------+
//| 发起 HTTP POST（JSON），返回响应体 / HTTP POST JSON, return body    |
//+------------------------------------------------------------------+
bool HttpPost(const string path, const string body, string &response)
{
   string url = InpServerUrl + path;
   string headers =
      "Content-Type: application/json\r\n" +
      "X-Api-Token: " + InpApiToken + "\r\n";

   char post[];
   char result[];
   string result_headers;
   // 转 UTF-8 字节；StringToCharArray 会在末尾追加 '\0'，必须去掉，
   // 否则请求体多一个字节导致后端 JSON 报 "Extra data" (HTTP 422)。
   // Convert to UTF-8 bytes; StringToCharArray appends a trailing '\0'
   // which must be removed, otherwise the body has one extra byte and the
   // backend rejects it with a JSON "Extra data" error (HTTP 422).
   int blen = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(blen < 0) blen = 0;
   ArrayResize(post, blen);

   ResetLastError();
   int code = WebRequest("POST", url, headers, 5000, post, result, result_headers);
   if(code == -1)
   {
      int err = GetLastError();
      if(err == 4014 || err == 5203)
         Log("WebRequest 被拒绝。请在 工具->选项->智能交易 中把 " + InpServerUrl + " 加入允许的 URL 列表。",
             "WebRequest blocked. Add " + InpServerUrl + " to the allowed URLs in Tools->Options->Expert Advisors.");
      else
         Log("HTTP 请求失败，错误码=" + IntegerToString(err),
             "HTTP request failed, error=" + IntegerToString(err));
      return(false);
   }

   response = CharArrayToString(result, 0, ArraySize(result), CP_UTF8);
   if(code < 200 || code >= 300)
   {
      Log("HTTP 状态码=" + IntegerToString(code) + " 响应=" + response,
          "HTTP status=" + IntegerToString(code) + " body=" + response);
      return(false);
   }
   return(true);
}

//+------------------------------------------------------------------+
//| 自动探测券商品种后缀 / Auto-detect broker symbol suffix           |
//| 以 EURUSD 为基准，找到形如 EURUSD.sc 的品种并返回其后缀 ".sc"。    |
//| Uses EURUSD as a probe: find a symbol like EURUSD.sc, return ".sc".|
//+------------------------------------------------------------------+
string DetectSuffix()
{
   string bases[] = {"EURUSD", "GBPUSD", "USDJPY", "XAUUSD"};
   int total = SymbolsTotal(false);
   for(int b = 0; b < ArraySize(bases); b++)
   {
      string base = bases[b];
      for(int i = 0; i < total; i++)
      {
         string name = SymbolName(i, false);
         // 名字以 base 开头且长度更长 -> 余下部分即后缀
         // name starts with base and is longer -> remainder is the suffix
         if(StringFind(name, base) == 0 && StringLen(name) > StringLen(base))
            return(StringSubstr(name, StringLen(base)));
         if(name == base)
            return("");  // 无后缀 / no suffix
      }
   }
   return("");
}

//+------------------------------------------------------------------+
//| 智能解析品种名：处理后缀不匹配 / Resolve symbol against broker     |
//| 1) 原名直接可用 -> 用原名                                          |
//| 2) 去掉已知后缀后匹配 / strip suffix then re-match                 |
//| 3) 用裸名+探测后缀 / bare name + detected suffix                   |
//| 4) 前缀模糊匹配 / prefix fuzzy match                               |
//+------------------------------------------------------------------+
string ResolveSymbol(const string requested)
{
   // 1) 原名可用 / requested works as-is
   if(SymbolSelect(requested, true) && SymbolInfoInteger(requested, SYMBOL_SELECT))
      return(requested);

   // 2) 取裸名：去掉第一个 '.' 及之后内容 / bare name = strip from first '.'
   string bare = requested;
   int dot = StringFind(requested, ".");
   if(dot > 0) bare = StringSubstr(requested, 0, dot);

   // 3) 裸名 + 探测后缀 / bare + detected suffix
   string suffix = DetectSuffix();
   string candidate = bare + suffix;
   if(SymbolSelect(candidate, true))
      return(candidate);

   // 4) 裸名本身 / bare name itself
   if(SymbolSelect(bare, true))
      return(bare);

   // 5) 前缀模糊匹配：找以裸名开头的第一个品种 / prefix fuzzy match
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
   {
      string name = SymbolName(i, false);
      if(StringFind(name, bare) == 0)
      {
         if(SymbolSelect(name, true))
            return(name);
      }
   }
   return("");  // 实在找不到 / not found
}

//+------------------------------------------------------------------+
//| 规整手数到券商步长与上下限 / Clamp volume to broker step & limits  |
//+------------------------------------------------------------------+
double NormalizeVolume(const string sym, const double vol)
{
   double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double v = vol;
   if(vstep > 0.0) v = MathRound(v / vstep) * vstep;
   if(vmin > 0.0 && v < vmin) v = vmin;
   if(vmax > 0.0 && v > vmax) v = vmax;
   return(v);
}

//+------------------------------------------------------------------+
//| 把信号 SL/TP 换算到真实市价 / Rescale signal SL/TP to live price   |
//| 信号价格是平台合成价，与券商真实价差异巨大，直接用会触发           |
//| "Invalid stops"。这里用信号的比例关系套用到真实市价，并夹紧到      |
//| 券商最小止损距离。                                                 |
//| The signal price is a synthetic platform price; using it directly |
//| triggers "Invalid stops". Re-derive SL/TP as ratios off the signal|
//| entry, apply them to the live price, then clamp to broker's stop. |
//+------------------------------------------------------------------+
void ComputeStops(const string sym, const string side, const double entry,
                  const double sig_sl, const double sig_tp,
                  double &out_sl, double &out_tp)
{
   out_sl = 0.0;
   out_tp = 0.0;
   if(entry <= 0.0) return;  // 无参考价则不带止损止盈 / no reference -> no SL/TP

   double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
   double price  = (side == "BUY") ? ask : bid;
   if(price <= 0.0) return;

   // 用信号比例换算到真实市价 / map signal ratios onto the live price
   if(sig_sl > 0.0)
      out_sl = price * (sig_sl / entry);
   if(sig_tp > 0.0)
      out_tp = price * (sig_tp / entry);

   // 券商最小止损距离（点）/ broker minimum stop distance in points
   long   stop_level = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double min_dist   = (stop_level > 0 ? stop_level : 10) * point;

   if(side == "BUY")
   {
      if(out_sl > 0.0 && price - out_sl < min_dist) out_sl = price - min_dist;
      if(out_tp > 0.0 && out_tp - price < min_dist) out_tp = price + min_dist;
   }
   else // SELL
   {
      if(out_sl > 0.0 && out_sl - price < min_dist) out_sl = price + min_dist;
      if(out_tp > 0.0 && price - out_tp < min_dist) out_tp = price - min_dist;
   }

   if(out_sl > 0.0) out_sl = NormalizeDouble(out_sl, digits);
   if(out_tp > 0.0) out_tp = NormalizeDouble(out_tp, digits);
}

//+------------------------------------------------------------------+
//| 执行单条下单指令，返回回报 JSON / Execute one order, return result  |
//+------------------------------------------------------------------+
void ExecuteCommand(const string clientOrderId, const string symbol,
                    const string side, const double volume,
                    const double entry, const double sl, const double tp)
{
   Log("收到下单指令: " + symbol + " " + side + " " + DoubleToString(volume, 2),
       "Order command: " + symbol + " " + side + " " + DoubleToString(volume, 2));

   bool ok = false;
   string message = "";
   ulong ticket = 0;
   double fill_price = 0.0;

   // 智能解析品种，兼容后缀差异 / resolve symbol to tolerate suffix mismatch
   string real_symbol = ResolveSymbol(symbol);
   if(real_symbol == "")
   {
      message = L("品种不可用: ", "Symbol not available: ") + symbol;
   }
   else
   {
      if(real_symbol != symbol)
         Log("品种已映射: " + symbol + " -> " + real_symbol,
             "Symbol mapped: " + symbol + " -> " + real_symbol);

      g_trade.SetExpertMagicNumber(InpMagic);
      g_trade.SetDeviationInPoints(InpSlippage);

      // 把信号止损止盈换算到真实市价 / rescale SL/TP onto the live price
      double real_sl = 0.0, real_tp = 0.0;
      ComputeStops(real_symbol, side, entry, sl, tp, real_sl, real_tp);

      // 规整手数到券商步长与上下限 / clamp volume to broker step & limits
      double vol = NormalizeVolume(real_symbol, volume);

      bool sent = false;
      if(side == "BUY")
         sent = g_trade.Buy(vol, real_symbol, 0.0, real_sl, real_tp, "PRISMX");
      else if(side == "SELL")
         sent = g_trade.Sell(vol, real_symbol, 0.0, real_sl, real_tp, "PRISMX");
      else
         message = L("方向无效", "Invalid side");

      if(sent)
      {
         uint retcode = g_trade.ResultRetcode();
         if(retcode == TRADE_RETCODE_DONE || retcode == TRADE_RETCODE_PLACED)
         {
            ok = true;
            ticket = g_trade.ResultOrder();
            fill_price = g_trade.ResultPrice();
            message = L("下单成功", "Order executed");
         }
         else
         {
            message = L("下单被拒绝, 代码=", "Order rejected, code=") + IntegerToString(retcode);
         }
      }
      else if(message == "")
      {
         message = L("发送订单失败, 代码=", "Failed to send order, code=") +
                   IntegerToString(g_trade.ResultRetcode());
      }
   }

   string body =
      "{\"clientOrderId\":\"" + JsonEscape(clientOrderId) +
      "\",\"success\":" + (ok ? "true" : "false") +
      ",\"mt5Ticket\":" + IntegerToString((long)ticket) +
      ",\"filledPrice\":" + DoubleToString(fill_price, 5) +
      ",\"message\":\"" + JsonEscape(message) + "\"}";
   string resp;
   HttpPost("/api/ea/poll/result", body, resp);
   Log(message, message);
}

//+------------------------------------------------------------------+
//| 解析 commands 数组并逐条执行 / parse commands array and execute    |
//+------------------------------------------------------------------+
void ProcessCommands(const string json)
{
   int p = StringFind(json, "\"commands\"");
   if(p < 0) return;

   // 逐个对象解析 / parse each object by locating clientOrderId occurrences
   int search = p;
   while(true)
   {
      int co = StringFind(json, "\"clientOrderId\"", search);
      if(co < 0) break;
      string clientOrderId = JsonGetStr(json, "clientOrderId", co);
      string symbol        = JsonGetStr(json, "symbol", co);
      string side          = JsonGetStr(json, "side", co);
      double volume        = JsonGetNum(json, "volume", co);
      double entry         = JsonGetNum(json, "entry", co);
      double sl            = JsonGetNum(json, "stopLoss", co);
      double tp            = JsonGetNum(json, "takeProfit", co);
      ExecuteCommand(clientOrderId, symbol, side, volume, entry, sl, tp);
      search = co + 15;
   }
}

//+------------------------------------------------------------------+
//| 上报持仓 / Report open positions                                   |
//+------------------------------------------------------------------+
void SendPositions()
{
   string arr = "[";
   int total = PositionsTotal();
   int count = 0;
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      long ptype = PositionGetInteger(POSITION_TYPE);
      double vol = PositionGetDouble(POSITION_VOLUME);
      double profit = PositionGetDouble(POSITION_PROFIT);
      if(count > 0) arr += ",";
      arr += "{\"symbol\":\"" + sym + "\",\"side\":\"" +
             (ptype == POSITION_TYPE_BUY ? "BUY" : "SELL") +
             "\",\"volume\":" + DoubleToString(vol, 2) +
             ",\"profit\":" + DoubleToString(profit, 2) + "}";
      count++;
   }
   arr += "]";
   string resp;
   HttpPost("/api/ea/poll/positions", "{\"data\":" + arr + "}", resp);
}

//+------------------------------------------------------------------+
//| 轮询：上报在线 + 拉取并执行指令 / Poll: report online + pull & exec |
//+------------------------------------------------------------------+
void PollOnce()
{
   long   login    = AccountInfoInteger(ACCOUNT_LOGIN);
   string server   = AccountInfoString(ACCOUNT_SERVER);
   string name     = AccountInfoString(ACCOUNT_NAME);
   string currency = AccountInfoString(ACCOUNT_CURRENCY);
   string company  = AccountInfoString(ACCOUNT_COMPANY);
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity   = AccountInfoDouble(ACCOUNT_EQUITY);
   long   leverage = AccountInfoInteger(ACCOUNT_LEVERAGE);
   string suffix   = DetectSuffix();

   // 转义账户名/券商名中的引号与反斜杠 / escape quotes & backslashes
   string body =
      "{\"mt5Login\":\"" + IntegerToString(login) +
      "\",\"mt5Server\":\"" + JsonEscape(server) +
      "\",\"accountName\":\"" + JsonEscape(name) +
      "\",\"accountCurrency\":\"" + JsonEscape(currency) +
      "\",\"company\":\"" + JsonEscape(company) +
      "\",\"balance\":" + DoubleToString(balance, 2) +
      ",\"equity\":" + DoubleToString(equity, 2) +
      ",\"leverage\":" + IntegerToString(leverage) +
      ",\"detectedSuffix\":\"" + JsonEscape(suffix) + "\"}";
   string resp;
   if(!HttpPost("/api/ea/poll/poll", body, resp))
      return;
   ProcessCommands(resp);
}

//+------------------------------------------------------------------+
//| EA 初始化 / Expert initialization                                  |
//+------------------------------------------------------------------+
int OnInit()
{
   if(InpApiToken == "")
   {
      Log("请填写 API Token（在网页 EA 绑定页复制）。",
          "Please set API Token (copy from the web EA binding page).");
      return(INIT_FAILED);
   }
   EventSetTimer(1);
   Log("PRISMX 轮询 EA 启动。请确认已在选项中允许 " + InpServerUrl,
       "PRISMX polling EA started. Make sure " + InpServerUrl + " is allowed in options.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| EA 反初始化 / Expert deinitialization                              |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Log("PRISMX 轮询 EA 停止。", "PRISMX polling EA stopped.");
}

//+------------------------------------------------------------------+
//| 定时器 / Timer                                                     |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(TimeCurrent() - g_last_poll >= InpPollSec)
   {
      PollOnce();
      g_last_poll = TimeCurrent();
   }
   if(TimeCurrent() - g_last_pos >= 5)
   {
      SendPositions();
      g_last_pos = TimeCurrent();
   }
}
//+------------------------------------------------------------------+
