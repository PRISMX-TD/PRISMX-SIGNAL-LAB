//+------------------------------------------------------------------+
//|                                                  PRISMX_EA_WS.mq5 |
//|                              PRISMX Signal Lab - WebSocket bridge |
//|        棱镜信号实验室 - WebSocket 实时桥接 EA / WebSocket bridge EA |
//+------------------------------------------------------------------+
#property copyright "PRISMX Signal Lab"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

//--- 语言枚举 / Language enum
enum ENUM_LANG { LANG_ZH = 0, LANG_EN = 1 };

//--- 输入参数 / Input parameters
input string   InpServerHost   = "127.0.0.1";   // 平台主机 / Server host
input int      InpServerPort   = 8000;           // 平台端口 / Server port
input string   InpApiToken     = "";             // API Token (来自网页 / from web)
input bool     InpUseTLS       = false;          // 使用 TLS(wss) / Use TLS
input ENUM_LANG InpLanguage    = LANG_ZH;        // 语言 / Language
input int      InpMagic        = 880088;         // 魔术号 / Magic number
input int      InpHeartbeatSec = 10;             // 心跳间隔秒 / Heartbeat seconds
input int      InpSlippage     = 20;             // 允许滑点(点) / Slippage points

//--- 全局变量 / Globals
int      g_socket    = INVALID_HANDLE;
bool     g_connected = false;
bool     g_authed    = false;
string   g_recvbuf   = "";
datetime g_last_hb   = 0;
datetime g_last_pos  = 0;
CTrade   g_trade;

//+------------------------------------------------------------------+
//| 双语文本 / Bilingual text helper                                  |
//+------------------------------------------------------------------+
string L(const string zh, const string en)
{
   return(InpLanguage == LANG_ZH ? zh : en);
}
void Log(const string zh, const string en)
{
   Print("[PRISMX] " + L(zh, en));
}

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
//| 自动探测券商品种后缀 / Auto-detect broker symbol suffix           |
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
         if(StringFind(name, base) == 0 && StringLen(name) > StringLen(base))
            return(StringSubstr(name, StringLen(base)));
         if(name == base)
            return("");
      }
   }
   return("");
}

//+------------------------------------------------------------------+
//| 智能解析品种名：处理后缀不匹配 / Resolve symbol against broker     |
//+------------------------------------------------------------------+
string ResolveSymbol(const string requested)
{
   if(SymbolSelect(requested, true) && SymbolInfoInteger(requested, SYMBOL_SELECT))
      return(requested);

   string bare = requested;
   int dot = StringFind(requested, ".");
   if(dot > 0) bare = StringSubstr(requested, 0, dot);

   string suffix = DetectSuffix();
   string candidate = bare + suffix;
   if(SymbolSelect(candidate, true))
      return(candidate);

   if(SymbolSelect(bare, true))
      return(bare);

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
   return("");
}

//+------------------------------------------------------------------+
//| 简易 JSON 取值 / Minimal JSON value extraction                    |
//| 仅用于解析平台下发的扁平 JSON / for flat JSON from the platform    |
//+------------------------------------------------------------------+
string JsonGetStr(const string json, const string key)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return("");
   p = StringFind(json, ":", p);
   if(p < 0) return("");
   p++;
   // 跳过空白 / skip whitespace
   while(p < StringLen(json) && (StringGetCharacter(json, p) == ' ')) p++;
   if(p >= StringLen(json)) return("");
   ushort ch = StringGetCharacter(json, p);
   if(ch == '"')
   {
      p++;
      int e = StringFind(json, "\"", p);
      if(e < 0) return("");
      return(StringSubstr(json, p, e - p));
   }
   // 数字或布尔 / number or boolean
   int e = p;
   while(e < StringLen(json))
   {
      ushort c = StringGetCharacter(json, e);
      if(c == ',' || c == '}' || c == ' ') break;
      e++;
   }
   return(StringSubstr(json, p, e - p));
}

double JsonGetNum(const string json, const string key)
{
   string s = JsonGetStr(json, key);
   if(s == "") return(0.0);
   return(StringToDouble(s));
}

//+------------------------------------------------------------------+
//| Base64 编码（用于 WebSocket 握手 key）/ Base64 for WS key          |
//+------------------------------------------------------------------+
string Base64Encode(const uchar &src[])
{
   string tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
   string out = "";
   int n = ArraySize(src);
   for(int i = 0; i < n; i += 3)
   {
      int b0 = src[i];
      int b1 = (i + 1 < n) ? src[i + 1] : 0;
      int b2 = (i + 2 < n) ? src[i + 2] : 0;
      out += StringSubstr(tbl, b0 >> 2, 1);
      out += StringSubstr(tbl, ((b0 & 0x03) << 4) | (b1 >> 4), 1);
      out += (i + 1 < n) ? StringSubstr(tbl, ((b1 & 0x0f) << 2) | (b2 >> 6), 1) : "=";
      out += (i + 2 < n) ? StringSubstr(tbl, b2 & 0x3f, 1) : "=";
   }
   return(out);
}

//+------------------------------------------------------------------+
//| 建立 WebSocket 连接（握手）/ Establish WebSocket (handshake)       |
//+------------------------------------------------------------------+
bool WSConnect()
{
   g_socket = SocketCreate();
   if(g_socket == INVALID_HANDLE)
   {
      Log("创建 Socket 失败，请在终端选项中允许算法交易与 DLL/Socket。",
          "Failed to create socket. Enable algo trading and socket access in terminal options.");
      return(false);
   }

   if(!SocketConnect(g_socket, InpServerHost, InpServerPort, 5000))
   {
      Log("无法连接到平台，请检查主机/端口与后端是否启动。",
          "Cannot connect to platform. Check host/port and that the backend is running.");
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
      return(false);
   }

   if(InpUseTLS)
   {
      if(!SocketTlsHandshake(g_socket, InpServerHost))
      {
         Log("TLS 握手失败。", "TLS handshake failed.");
         SocketClose(g_socket);
         g_socket = INVALID_HANDLE;
         return(false);
      }
   }

   // 生成随机握手 key / random handshake key
   uchar keybytes[16];
   for(int i = 0; i < 16; i++) keybytes[i] = (uchar)(MathRand() & 0xFF);
   string wskey = Base64Encode(keybytes);

   string req =
      "GET /ws/ea HTTP/1.1\r\n" +
      "Host: " + InpServerHost + ":" + IntegerToString(InpServerPort) + "\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Key: " + wskey + "\r\n" +
      "Sec-WebSocket-Version: 13\r\n\r\n";

   uchar reqbytes[];
   int len = StringToCharArray(req, reqbytes, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(InpUseTLS)
   {
      if(SocketTlsSend(g_socket, reqbytes, len) != len) { WSClose(); return(false); }
   }
   else
   {
      if(SocketSend(g_socket, reqbytes, len) != len) { WSClose(); return(false); }
   }

   // 读取握手响应 / read handshake response
   string resp = "";
   uint timeout = GetTickCount() + 5000;
   while(GetTickCount() < timeout)
   {
      uint avail = SocketIsReadable(g_socket);
      if(avail > 0)
      {
         uchar rb[];
         int got = InpUseTLS ? SocketTlsRead(g_socket, rb, avail)
                             : SocketRead(g_socket, rb, avail, 1000);
         if(got > 0)
         {
            resp += CharArrayToString(rb, 0, got, CP_UTF8);
            if(StringFind(resp, "\r\n\r\n") >= 0) break;
         }
      }
      Sleep(10);
   }

   if(StringFind(resp, "101") < 0)
   {
      Log("WebSocket 握手未成功。", "WebSocket handshake failed.");
      WSClose();
      return(false);
   }

   g_connected = true;
   Log("已连接平台，开始认证。", "Connected to platform, authenticating.");
   return(true);
}

void WSClose()
{
   if(g_socket != INVALID_HANDLE)
   {
      SocketClose(g_socket);
      g_socket = INVALID_HANDLE;
   }
   g_connected = false;
   g_authed    = false;
   g_recvbuf   = "";
}

//+------------------------------------------------------------------+
//| 发送文本帧（客户端必须掩码）/ Send masked text frame              |
//+------------------------------------------------------------------+
bool WSSendText(const string text)
{
   if(!g_connected) return(false);

   uchar payload[];
   int plen = StringToCharArray(text, payload, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(plen < 0) plen = 0;

   uchar frame[];
   int idx = 0;
   ArrayResize(frame, 2);
   frame[idx++] = (uchar)0x81; // FIN + 文本帧 / FIN + text opcode

   // 长度字段 + 掩码位 / length field with mask bit
   if(plen <= 125)
   {
      ArrayResize(frame, idx + 1);
      frame[idx++] = (uchar)(0x80 | plen);
   }
   else if(plen <= 65535)
   {
      ArrayResize(frame, idx + 3);
      frame[idx++] = (uchar)(0x80 | 126);
      frame[idx++] = (uchar)((plen >> 8) & 0xFF);
      frame[idx++] = (uchar)(plen & 0xFF);
   }
   else
   {
      ArrayResize(frame, idx + 9);
      frame[idx++] = (uchar)(0x80 | 127);
      for(int i = 7; i >= 0; i--) frame[idx++] = (uchar)((plen >> (8 * i)) & 0xFF);
   }

   // 掩码 key / masking key
   uchar mask[4];
   for(int i = 0; i < 4; i++) mask[i] = (uchar)(MathRand() & 0xFF);
   ArrayResize(frame, idx + 4 + plen);
   for(int i = 0; i < 4; i++) frame[idx++] = mask[i];

   for(int i = 0; i < plen; i++)
      frame[idx++] = (uchar)(payload[i] ^ mask[i % 4]);

   int total = ArraySize(frame);
   int sent = InpUseTLS ? SocketTlsSend(g_socket, frame, total)
                        : SocketSend(g_socket, frame, total);
   return(sent == total);
}

//+------------------------------------------------------------------+
//| 读取并解析帧，返回一条文本消息 / Read & parse one text message     |
//+------------------------------------------------------------------+
bool WSReadMessage(string &out_msg)
{
   if(!g_connected) return(false);

   uint avail = SocketIsReadable(g_socket);
   if(avail > 0)
   {
      uchar rb[];
      int got = InpUseTLS ? SocketTlsRead(g_socket, rb, avail)
                          : SocketRead(g_socket, rb, avail, 200);
      if(got > 0)
         g_recvbuf += CharArrayToString(rb, 0, got, CP_UTF8);
   }

   // 服务端->客户端帧不带掩码 / server frames are unmasked
   int buflen = StringLen(g_recvbuf);
   if(buflen < 2) return(false);

   uchar b0 = (uchar)StringGetCharacter(g_recvbuf, 0);
   uchar b1 = (uchar)StringGetCharacter(g_recvbuf, 1);
   int opcode = b0 & 0x0F;
   int len = b1 & 0x7F;
   int offset = 2;

   if(len == 126)
   {
      if(buflen < 4) return(false);
      len = ((int)StringGetCharacter(g_recvbuf, 2) << 8) | (int)StringGetCharacter(g_recvbuf, 3);
      offset = 4;
   }
   else if(len == 127)
   {
      if(buflen < 10) return(false);
      len = 0;
      for(int i = 0; i < 8; i++)
         len = (len << 8) | (int)StringGetCharacter(g_recvbuf, 2 + i);
      offset = 10;
   }

   if(buflen < offset + len) return(false); // 帧未收全 / frame incomplete

   string payload = StringSubstr(g_recvbuf, offset, len);
   g_recvbuf = StringSubstr(g_recvbuf, offset + len);

   if(opcode == 0x8) // 关闭帧 / close frame
   {
      WSClose();
      return(false);
   }
   if(opcode == 0x9 || opcode == 0xA) return(false); // ping/pong 忽略 / ignore

   out_msg = payload;
   return(StringLen(out_msg) > 0);
}

//+------------------------------------------------------------------+
//| 发送认证消息 / Send AUTH message                                  |
//+------------------------------------------------------------------+
void SendAuth()
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

   string msg = "{\"type\":\"AUTH\",\"apiToken\":\"" + JsonEscape(InpApiToken) +
                "\",\"mt5Login\":" + IntegerToString(login) +
                ",\"mt5Server\":\"" + JsonEscape(server) +
                "\",\"accountName\":\"" + JsonEscape(name) +
                "\",\"accountCurrency\":\"" + JsonEscape(currency) +
                "\",\"company\":\"" + JsonEscape(company) +
                "\",\"balance\":" + DoubleToString(balance, 2) +
                ",\"equity\":" + DoubleToString(equity, 2) +
                ",\"leverage\":" + IntegerToString(leverage) +
                ",\"detectedSuffix\":\"" + JsonEscape(suffix) + "\"}";
   WSSendText(msg);
}

//+------------------------------------------------------------------+
//| 发送心跳 / Send heartbeat                                         |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   string msg = "{\"type\":\"HEARTBEAT\",\"ts\":" + IntegerToString((long)TimeCurrent()) + "}";
   WSSendText(msg);
}

//+------------------------------------------------------------------+
//| 上报持仓 / Report open positions                                  |
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
   WSSendText("{\"type\":\"POSITIONS\",\"data\":" + arr + "}");
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
//| "Invalid stops"。这里用信号比例套用到真实市价并夹紧最小止损距离。  |
//| The signal price is synthetic; using it directly triggers         |
//| "Invalid stops". Re-derive SL/TP as ratios off the signal entry,  |
//| apply to the live price, then clamp to the broker's stop level.   |
//+------------------------------------------------------------------+
void ComputeStops(const string sym, const string side, const double entry,
                  const double sig_sl, const double sig_tp,
                  double &out_sl, double &out_tp)
{
   out_sl = 0.0;
   out_tp = 0.0;
   if(entry <= 0.0) return;

   double point  = SymbolInfoDouble(sym, SYMBOL_POINT);
   int    digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double ask    = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid    = SymbolInfoDouble(sym, SYMBOL_BID);
   double price  = (side == "BUY") ? ask : bid;
   if(price <= 0.0) return;

   if(sig_sl > 0.0) out_sl = price * (sig_sl / entry);
   if(sig_tp > 0.0) out_tp = price * (sig_tp / entry);

   long   stop_level = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double min_dist   = (stop_level > 0 ? stop_level : 10) * point;

   if(side == "BUY")
   {
      if(out_sl > 0.0 && price - out_sl < min_dist) out_sl = price - min_dist;
      if(out_tp > 0.0 && out_tp - price < min_dist) out_tp = price + min_dist;
   }
   else
   {
      if(out_sl > 0.0 && out_sl - price < min_dist) out_sl = price + min_dist;
      if(out_tp > 0.0 && price - out_tp < min_dist) out_tp = price - min_dist;
   }

   if(out_sl > 0.0) out_sl = NormalizeDouble(out_sl, digits);
   if(out_tp > 0.0) out_tp = NormalizeDouble(out_tp, digits);
}

//+------------------------------------------------------------------+
//| 执行下单指令并回报 / Execute order command and report result      |
//+------------------------------------------------------------------+
void HandleOrderCmd(const string json)
{
   string clientOrderId = JsonGetStr(json, "clientOrderId");
   string symbol        = JsonGetStr(json, "symbol");
   string side          = JsonGetStr(json, "side");
   double volume        = JsonGetNum(json, "volume");
   double entry         = JsonGetNum(json, "entry");
   double sl            = JsonGetNum(json, "stopLoss");
   double tp            = JsonGetNum(json, "takeProfit");

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

   string result =
      "{\"type\":\"ORDER_RESULT\",\"clientOrderId\":\"" + JsonEscape(clientOrderId) +
      "\",\"success\":" + (ok ? "true" : "false") +
      ",\"mt5Ticket\":" + IntegerToString((long)ticket) +
      ",\"filledPrice\":" + DoubleToString(fill_price, 5) +
      ",\"message\":\"" + JsonEscape(message) + "\"}";
   WSSendText(result);

   Log(message, message);
   SendPositions();
}

//+------------------------------------------------------------------+
//| 分发平台消息 / Dispatch platform message                          |
//+------------------------------------------------------------------+
void HandleMessage(const string json)
{
   string mtype = JsonGetStr(json, "type");

   if(mtype == "AUTH_OK")
   {
      g_authed = true;
      Log("认证成功，绑定完成。", "Authenticated, binding complete.");
      SendPositions();
   }
   else if(mtype == "AUTH_FAIL")
   {
      Log("认证失败: " + JsonGetStr(json, "reason"),
          "Auth failed: " + JsonGetStr(json, "reason"));
      WSClose();
   }
   else if(mtype == "ORDER_CMD")
   {
      HandleOrderCmd(json);
   }
}

//+------------------------------------------------------------------+
//| EA 初始化 / Expert initialization                                 |
//+------------------------------------------------------------------+
int OnInit()
{
   if(InpApiToken == "")
   {
      Log("请填写 API Token（在网页 EA 绑定页复制）。",
          "Please set API Token (copy from the web EA binding page).");
      return(INIT_FAILED);
   }
   MathSrand((int)GetTickCount());
   EventSetTimer(1);
   Log("PRISMX WebSocket EA 启动。", "PRISMX WebSocket EA started.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| EA 反初始化 / Expert deinitialization                             |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   WSClose();
   Log("PRISMX WebSocket EA 停止。", "PRISMX WebSocket EA stopped.");
}

//+------------------------------------------------------------------+
//| 定时器：维护连接、心跳、收消息 / Timer: connection, heartbeat, recv|
//+------------------------------------------------------------------+
void OnTimer()
{
   // 断线重连 / reconnect if needed
   if(!g_connected)
   {
      if(WSConnect())
         SendAuth();
      else
         return;
   }

   // 读取所有待处理消息 / drain all pending messages
   string msg;
   int guard = 0;
   while(WSReadMessage(msg) && guard < 50)
   {
      HandleMessage(msg);
      guard++;
   }

   if(!g_connected) return; // 可能在读取中关闭 / may have closed during read

   // 心跳 / heartbeat
   if(g_authed && TimeCurrent() - g_last_hb >= InpHeartbeatSec)
   {
      SendHeartbeat();
      g_last_hb = TimeCurrent();
   }

   // 定期上报持仓 / periodically report positions
   if(g_authed && TimeCurrent() - g_last_pos >= 5)
   {
      SendPositions();
      g_last_pos = TimeCurrent();
   }
}
//+------------------------------------------------------------------+
