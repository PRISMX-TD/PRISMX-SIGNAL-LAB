//+------------------------------------------------------------------+
//| PRISMX MT5 Gateway - 事件环(2026-11-11 架构优化阶段 3)           |
//|                                                                  |
//| 成交、仓位、挂单变动与连接起落都按顺序编号放进一个固定大小的环。  |
//| 后端用 GET /events?cursor=N&wait=20000 长轮询:有新事件立刻返回,  |
//| 没有就挂着等到超时。游标太旧(被环覆盖)或网关重启过(instance 变了)|
//| 时回 resync=true,后端整账号重读一次再接着跟。                     |
//|                                                                  |
//| Phase 3: positions, deals, orders and link up/down go into a     |
//| fixed ring with sequence numbers. The backend long-polls          |
//| /events; a cursor that fell off the ring, or a restarted gateway |
//| (new instance id), answers resync=true and the backend re-reads. |
//+------------------------------------------------------------------+
using System;
using System.Collections.Generic;
using System.Threading;

namespace Prismx.Mt5Gateway
{
    internal sealed class EventRing
    {
        private struct Entry
        {
            public long Seq;
            public string Json;
        }

        /// <summary>本进程的标识;网关一重启就变,后端据此知道要整体重读。
        /// This process's id; it changes on restart so the backend knows to resync.</summary>
        public static readonly string InstanceId = Guid.NewGuid().ToString("N").Substring(0, 12);

        private readonly Entry[] _buf;
        private readonly object _lock = new object();
        private long _seq;   // 最后一条的编号;0 = 还没有 / last seq, 0 = none yet

        public EventRing(int capacity)
        {
            _buf = new Entry[Math.Max(256, capacity)];
        }

        public long Head
        {
            get { lock (_lock) return _seq; }
        }

        /// <summary>
        /// 发一条事件。fill 往对象里写业务字段;seq、type、login、at 由这里写。
        /// Publish an event; fill writes the payload, seq/type/login/at are added here.
        /// </summary>
        public long Publish(string type, ulong login, Action<JsonWriter> fill)
        {
            lock (_lock)
            {
                long seq = _seq + 1;

                JsonWriter j = new JsonWriter();
                j.BeginObject()
                    .FieldLong("seq", seq)
                    .Field("type", type)
                    .Field("login", login)
                    .FieldLong("at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

                if (fill != null)
                {
                    try { fill(j); }
                    catch (Exception ex) { j.Field("fillError", ex.Message); }
                }

                j.EndObject();

                _buf[(int)(seq % _buf.Length)] = new Entry { Seq = seq, Json = j.ToString() };
                _seq = seq;

                Monitor.PulseAll(_lock);
                return seq;
            }
        }

        /// <summary>
        /// 取 cursor 之后的事件(最多 max 条)。没有新事件就最多等 waitMs。
        /// resync=true:cursor 已被覆盖或比当前编号还大(网关重启过),调用方该整体重读。
        /// Events after cursor (at most max), waiting up to waitMs when there are none.
        /// resync means the cursor fell off the ring or is ahead of us (a restart).
        /// </summary>
        public List<string> Read(long cursor, int max, int waitMs, out long head, out bool resync)
        {
            List<string> list = new List<string>();
            resync = false;

            lock (_lock)
            {
                if (cursor > _seq)
                {
                    resync = true;
                    head = _seq;
                    return list;
                }

                if (cursor == _seq && waitMs > 0)
                {
                    int until = unchecked(Environment.TickCount + waitMs);
                    while (cursor == _seq)
                    {
                        int left = unchecked(until - Environment.TickCount);
                        if (left <= 0)
                            break;
                        Monitor.Wait(_lock, left);
                    }
                }

                head = cursor;
                long oldest = Math.Max(1, _seq - _buf.Length + 1);

                if (cursor > 0 && cursor + 1 < oldest)
                {
                    resync = true;
                    cursor = oldest - 1;
                }

                // head 回"本次读到的最后一条";条数被 max 截断时,下次从这里接着读,不丢。
                // head is the last seq delivered, so a max-truncated read resumes from there.
                for (long s = Math.Max(cursor + 1, oldest); s <= _seq && list.Count < max; s++)
                {
                    Entry e = _buf[(int)(s % _buf.Length)];
                    if (e.Seq == s)
                        list.Add(e.Json);
                    head = s;
                }
            }

            return list;
        }
    }
}
