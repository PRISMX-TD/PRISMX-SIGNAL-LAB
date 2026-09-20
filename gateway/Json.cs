//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 最小 JSON 读写                              |
//|                                                                  |
//| .NET Framework 没有内置 JSON,为了不引入第三方依赖(VPS 上少一个   |
//| 要拷的 dll),这里手写。只覆盖本网关用到的形态:                    |
//|   写:对象/数组/字符串/数字/布尔                                  |
//|   读:平坦的一层对象,值为字符串或数字                             |
//| 不追求通用,够用且正确即可。                                      |
//+------------------------------------------------------------------+
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Prismx.Mt5Gateway
{
    /// <summary>JSON 输出。</summary>
    internal sealed class JsonWriter
    {
        private readonly StringBuilder _sb = new StringBuilder();
        private bool _needComma;

        public JsonWriter BeginObject()
        {
            Separate();
            _sb.Append('{');
            _needComma = false;
            return this;
        }

        public JsonWriter EndObject()
        {
            _sb.Append('}');
            _needComma = true;
            return this;
        }

        public JsonWriter BeginArray(string name)
        {
            Separate();
            WriteName(name);
            _sb.Append('[');
            _needComma = false;
            return this;
        }

        public JsonWriter EndArray()
        {
            _sb.Append(']');
            _needComma = true;
            return this;
        }

        public JsonWriter Field(string name, string value)
        {
            Separate();
            WriteName(name);
            WriteString(value);
            _needComma = true;
            return this;
        }

        public JsonWriter Field(string name, bool value)
        {
            Separate();
            WriteName(name);
            _sb.Append(value ? "true" : "false");
            _needComma = true;
            return this;
        }

        public JsonWriter Field(string name, ulong value)
        {
            Separate();
            WriteName(name);
            _sb.Append(value.ToString(CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public JsonWriter Field(string name, uint value)
        {
            return Field(name, (ulong)value);
        }

        public JsonWriter Field(string name, double value)
        {
            Separate();
            WriteName(name);

            // NaN/Infinity 不是合法 JSON,退化成 0
            if (double.IsNaN(value) || double.IsInfinity(value))
                _sb.Append('0');
            else
                _sb.Append(value.ToString("R", CultureInfo.InvariantCulture));

            _needComma = true;
            return this;
        }

        private void Separate()
        {
            if (_needComma)
                _sb.Append(',');
        }

        private void WriteName(string name)
        {
            WriteString(name);
            _sb.Append(':');
        }

        private void WriteString(string value)
        {
            if (value == null)
            {
                _sb.Append("null");
                return;
            }

            _sb.Append('"');

            foreach (char ch in value)
            {
                switch (ch)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    default:
                        // 控制字符与非 ASCII 一律转义,避免编码问题
                        if (ch < 0x20 || ch > 0x7E)
                            _sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else
                            _sb.Append(ch);
                        break;
                }
            }

            _sb.Append('"');
        }

        public override string ToString()
        {
            return _sb.ToString();
        }
    }

    /// <summary>极简 JSON 对象解析。只支持一层平坦对象。</summary>
    internal sealed class JsonObject
    {
        private readonly Dictionary<string, string> _values =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static JsonObject Parse(string text)
        {
            JsonObject obj = new JsonObject();

            if (string.IsNullOrEmpty(text))
                return obj;

            int i = 0;
            SkipWs(text, ref i);

            if (i >= text.Length || text[i] != '{')
                throw new FormatException("请求体不是 JSON 对象");

            i++; // 跳过 {

            while (true)
            {
                SkipWs(text, ref i);

                if (i >= text.Length)
                    throw new FormatException("JSON 意外结束");

                if (text[i] == '}')
                    break;

                if (text[i] == ',')
                {
                    i++;
                    continue;
                }

                if (text[i] != '"')
                    throw new FormatException("JSON 键必须是字符串,位置 " + i);

                string key = ReadString(text, ref i);

                SkipWs(text, ref i);
                if (i >= text.Length || text[i] != ':')
                    throw new FormatException("JSON 键 " + key + " 后缺少冒号");
                i++;

                SkipWs(text, ref i);
                string value = ReadValue(text, ref i);

                obj._values[key] = value;
            }

            return obj;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n'))
                i++;
        }

        private static string ReadString(string s, ref int i)
        {
            i++; // 跳过起始引号
            StringBuilder sb = new StringBuilder();

            while (i < s.Length && s[i] != '"')
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    i++;
                    switch (s[i])
                    {
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case '/': sb.Append('/'); break;
                        case 'u':
                            // 长度不够时原来什么都不追加也不报错——字符被悄悄吞掉。
                            // 宁可明确失败:静默改写品种名/comment/tag 比 400 难查得多。
                            // A short \u used to append nothing and not complain,
                            // silently rewriting a symbol name, comment or tag.
                            if (i + 4 >= s.Length)
                                throw new FormatException("JSON 字符串里的 \\u 转义不完整,位置 " + i);

                            int code;
                            if (!int.TryParse(s.Substring(i + 1, 4), NumberStyles.HexNumber,
                                    CultureInfo.InvariantCulture, out code))
                                throw new FormatException("JSON 字符串里的 \\u 转义不是十六进制,位置 " + i);

                            sb.Append((char)code);
                            i += 4;
                            break;
                        default: sb.Append(s[i]); break;
                    }
                }
                else
                {
                    sb.Append(s[i]);
                }

                i++;
            }

            i++; // 跳过结束引号
            return sb.ToString();
        }

        private static string ReadValue(string s, ref int i)
        {
            if (i >= s.Length)
                return "";

            if (s[i] == '"')
                return ReadString(s, ref i);

            // 嵌套对象/数组:整段跳过(不解析内容),值记成原文。
            //
            // 原来这里是"一路读到 , 或 } 为止":`{"meta":{"a":1},"login":500}` 会把值
            // 读成 `{"a":1`、停在那个 `}` 上,主循环随即 break,**login 被静默丢掉**;
            // 数组值则会在下一轮抛"JSON 键必须是字符串"。现状后端只发平坦对象所以
            // 不触发,但这是一颗定时炸弹:哪天请求里多一个嵌套字段,login 变 0 → 400,
            // 或者更糟——某个交易参数被悄悄丢成默认值。
            // Nested objects/arrays are now skipped by bracket matching. The old
            // "read until , or }" truncated the value at the first inner brace and
            // silently dropped every field after it — harmless while requests stay
            // flat, fatal the day one isn't.
            if (s[i] == '{' || s[i] == '[')
                return SkipContainer(s, ref i);

            // 数字 / true / false / null:读到分隔符为止
            int start = i;
            while (i < s.Length && s[i] != ',' && s[i] != '}')
                i++;

            return s.Substring(start, i - start).Trim();
        }

        /// <summary>
        /// 跳过一个 {...} 或 [...],返回它的原文。括号配对,并正确忽略字符串里的括号。
        /// Skips a balanced container, returning its raw text; braces inside strings
        /// do not count.
        /// </summary>
        private static string SkipContainer(string s, ref int i)
        {
            int start = i;
            int depth = 0;
            bool inString = false;

            while (i < s.Length)
            {
                char ch = s[i];

                if (inString)
                {
                    if (ch == '\\')
                        i++;                 // 跳过被转义的那个字符 / skip the escaped char
                    else if (ch == '"')
                        inString = false;
                }
                else if (ch == '"')
                {
                    inString = true;
                }
                else if (ch == '{' || ch == '[')
                {
                    depth++;
                }
                else if (ch == '}' || ch == ']')
                {
                    depth--;

                    if (depth == 0)
                    {
                        i++;
                        return s.Substring(start, i - start);
                    }

                    if (depth < 0)
                        break;
                }

                i++;
            }

            throw new FormatException("JSON 里有没配对的括号,位置 " + start);
        }

        public bool Has(string key)
        {
            return _values.ContainsKey(key);
        }

        public string GetString(string key, string fallback = "")
        {
            string v;
            return _values.TryGetValue(key, out v) ? v : fallback;
        }

        public ulong GetUlong(string key, ulong fallback = 0)
        {
            string v;
            if (!_values.TryGetValue(key, out v))
                return fallback;

            ulong result;
            return ulong.TryParse(v, out result) ? result : fallback;
        }

        public double GetDouble(string key, double fallback = 0)
        {
            string v;
            if (!_values.TryGetValue(key, out v))
                return fallback;

            double result;
            return double.TryParse(v, NumberStyles.Float,
                CultureInfo.InvariantCulture, out result) ? result : fallback;
        }

        /// <summary>
        /// 可空 double:键不存在、值是 JSON null、或解析不出数字时返回 null 而不是 0。
        /// 用在「没传 = 保留现状,传 0 = 清除」这类必须区分「没说」与「说了 0」的字段上
        /// (改单的 stopLoss / takeProfit)。GetDouble 的 fallback=0 在那里会把「没传」
        /// 变成「清除」。
        /// Nullable double: a missing key, a JSON null or an unparsable value yield null
        /// rather than 0 — for fields where "unspecified" and "explicitly zero" must
        /// differ (the modify endpoint's stopLoss / takeProfit). GetDouble's fallback of
        /// 0 would turn "not sent" into "clear it".
        /// </summary>
        public double? GetNullableDouble(string key)
        {
            string v;
            if (!_values.TryGetValue(key, out v) || v == null || v == "null")
                return null;

            double result;
            if (!double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out result))
                return null;

            return result;
        }

        public bool GetBool(string key, bool fallback = false)
        {
            string v;
            if (!_values.TryGetValue(key, out v))
                return fallback;

            return string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
        }
    }
}
