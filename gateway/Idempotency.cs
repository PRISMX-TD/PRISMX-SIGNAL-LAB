using System;
using System.Collections.Generic;
using System.Threading;

namespace Prismx.Mt5Gateway
{
    /// <summary>
    /// 交易请求的幂等缓存:同一个 (login, clientOrderId, 动作) 只真正执行一次。
    ///
    /// 为什么需要:/trade/open 等 dealer 回执最长 60 秒(dealer_timeout_ms),后端那头
    /// 65 秒超时。网络一抖、或后端超时后再发一次同样的请求,旧实现会老老实实再开一
    /// 次仓——用户看到的是"下单失败",账户里却多了一笔真仓。桥接程序早就按
    /// clientOrderId 做了 24 小时结果缓存(~/.prismx_bridge_executed.json),这里是
    /// 网关版。
    ///
    /// 三种状态:
    ///   · 没见过 → 登记为"执行中",调用方去下单,完成后 Complete();
    ///   · 执行中 → 等它完成(最多 waitMs),拿同一份结果;等不到就告诉调用方
    ///     仍在执行,由后端决定怎么办;
    ///   · 已完成 → 直接回缓存结果,不碰 dealer。
    /// 抛异常也记成失败结果而不是删掉条目:异常发生在 dealer 请求发出之后的话,仓位
    /// 可能已经开了,让重试再开一次比让它拿到"失败"更危险。后端本来就按失败处理、
    /// 用户重下会换新的 clientOrderId。
    ///
    /// 只在内存里:网关重启即空。重启期间 dealer 连接本身也断了,不会有"上一进程
    /// 还在执行"的请求,所以不需要落盘。
    ///
    /// Idempotency cache for trade requests: one real execution per
    /// (login, clientOrderId, action). The dealer round trip can take up to 60s
    /// and the backend times out at 65s; a retry after a timeout used to open the
    /// position a second time. Mirrors the bridge's 24h clientOrderId cache.
    /// Unseen keys are registered as in-flight; a duplicate arriving mid-flight
    /// waits (bounded) for the same result; a completed key returns the cached
    /// result without touching the dealer. Exceptions are recorded as failures
    /// rather than dropped — a re-execution is the more dangerous outcome.
    /// Memory-only: a restart also drops the dealer link, so nothing survives it.
    /// </summary>
    internal sealed class IdempotencyCache
    {
        private sealed class Entry
        {
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public TradeResult Result;
            public DateTime CompletedAt = DateTime.MaxValue;
        }

        private readonly Dictionary<string, Entry> _entries =
            new Dictionary<string, Entry>(StringComparer.Ordinal);
        private readonly object _lock = new object();
        private readonly TimeSpan _ttl;
        private DateTime _lastSweep = DateTime.UtcNow;

        public IdempotencyCache(TimeSpan ttl)
        {
            _ttl = ttl;
        }

        public static string Key(ulong login, string action, string clientOrderId)
        {
            return login.ToString() + "|" + action + "|" + clientOrderId;
        }

        /// <summary>
        /// 尝试开始执行。返回 true = 由调用方执行(之后必须 Complete);返回 false 且
        /// existing 非空 = 已有结果(或等到了结果),直接回它;返回 false 且 existing
        /// 为空 = 另一个请求还在执行且等超时了。
        /// </summary>
        public bool TryBegin(string key, int waitMs, out TradeResult existing, out bool replayed)
        {
            Entry entry;
            bool created = false;

            lock (_lock)
            {
                SweepLocked();

                if (!_entries.TryGetValue(key, out entry))
                {
                    entry = new Entry();
                    _entries[key] = entry;
                    created = true;
                }
            }

            if (created)
            {
                existing = null;
                replayed = false;
                return true;
            }

            replayed = true;

            if (entry.Done.Wait(waitMs))
            {
                existing = entry.Result;
                return false;
            }

            existing = null;
            return false;
        }

        public void Complete(string key, TradeResult result)
        {
            Entry entry;

            lock (_lock)
            {
                if (!_entries.TryGetValue(key, out entry))
                    return;

                entry.Result = result;
                entry.CompletedAt = DateTime.UtcNow;
            }

            entry.Done.Set();
        }

        public int Count
        {
            get { lock (_lock) { return _entries.Count; } }
        }

        // 每分钟最多扫一次,过期条目才删;执行中的条目(CompletedAt=MaxValue)永不过期。
        // Swept at most once a minute; in-flight entries never expire.
        private void SweepLocked()
        {
            DateTime now = DateTime.UtcNow;

            if (now - _lastSweep < TimeSpan.FromMinutes(1))
                return;

            _lastSweep = now;
            List<string> dead = null;

            foreach (KeyValuePair<string, Entry> kv in _entries)
            {
                if (kv.Value.CompletedAt != DateTime.MaxValue && now - kv.Value.CompletedAt > _ttl)
                {
                    if (dead == null)
                        dead = new List<string>();
                    dead.Add(kv.Key);
                }
            }

            if (dead == null)
                return;

            foreach (string k in dead)
            {
                _entries[k].Done.Dispose();
                _entries.Remove(k);
            }
        }
    }
}
