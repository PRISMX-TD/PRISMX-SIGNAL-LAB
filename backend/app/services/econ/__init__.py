"""财经日历（2026-11-20，rev 52）。第一期只给管理员看（/admin/econ），不对普通用户开放。

- narwhal.py   Narwhal API 客户端（日程、预期值、公布值）
- rules.py     我们自己的规则：重要度表、主指标、公布值与预期值的比较
- store.py     入库、分组、后台设置、给系统状态页的共享状态
- deepseek.py  DeepSeek 客户端（只用 JSON 模式）
- previews.py  公布前的影响预案：提示词、校验、生成
- loop.py      后台循环：每小时同步日程，到点补查公布值，生成预案

条款限制（Narwhal）：这份数据只用于展示和分析，不能接进自动下单或信号生成。

Economic calendar (2026-11-20, rev 52), admin-only for now. Narwhal's terms forbid using this
data for trade execution: display and analysis only, never order or signal logic.
"""
