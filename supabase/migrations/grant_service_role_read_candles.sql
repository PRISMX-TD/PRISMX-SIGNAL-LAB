-- 让后端专用的 service_role 能通过 PostgREST 读写 candles 表（表由后端 SQLAlchemy
-- 创建，默认没有授予 Supabase 的内置角色）。刻意只授 service_role：anon / authenticated
-- 不获得任何权限，前端拿 anon key 依然读不到这张表。
grant usage on schema public to service_role;
grant select on table public.candles to service_role;
