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
                        case 'u':
                            if (i + 4 < s.Length)
                            {
                                sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16));
                                i += 4;
                            }
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

            // 数字 / true / false / null:读到分隔符为止
            int start = i;
            while (i < s.Length && s[i] != ',' && s[i] != '}')
                i++;

            return s.Substring(start, i - start).Trim();
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

        public bool GetBool(string key, bool fallback = false)
        {
            string v;
            if (!_values.TryGetValue(key, out v))
                return fallback;

            return string.Equals(v, "true", StringComparison.OrdinalIgnoreCase);
        }
    }
}
