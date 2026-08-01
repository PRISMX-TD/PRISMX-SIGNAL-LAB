-- 清空 candles 表,准备用 EA 重新推送干净数据。
--
-- ⚠ 执行前提:后端必须已经部署了 candle_store.py 的重放过滤修复(基线从"最近 8 根"
--   改为"最近 26 小时"),否则清空后旧代码会立刻把整段平移的重放数据再写一遍。
--
-- 只动 candles 一张表。订单、信号、账号、策略配置等全部不受影响。
-- candles_replay_backup(之前四轮清理删掉的 9016 行)一并清掉——那些是已确认的伪造
-- 数据,重推后不再有回插的意义;保留它反而会让后续核对查询把它误当基线。
--
-- 用 truncate 而不是 delete:123 万行 delete 会产生大量 WAL 且留下待 vacuum 的死行,
-- truncate 直接回收空间、并把自增序列一起重置。
truncate table public.candles;
truncate table public.candles_replay_backup;

-- 清掉核对过程中建的临时表,它们只在排查期间有用,留着会让后来人误以为是业务表。
drop table if exists public.candle_cleanup_verify;
drop table if exists public.candle_weekend_dryrun;
drop table if exists public.candle_weekend_summary;
drop table if exists public.candle_widen_dryrun;
drop table if exists public.candle_isolated_dryrun;
drop table if exists public.candle_remaining_dups;
drop table if exists public.candle_240_detail;
drop table if exists public.candle_tz_check;
drop table if exists public.candle_final_verify;
