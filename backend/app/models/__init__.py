"""ORM 数据模型 / ORM data models."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint

from app.core.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """用户 / Platform user."""
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, unique=True, nullable=False, index=True)
    # 密码哈希：Google 登录的用户没有密码，故可空 / nullable: Google users have no password
    password_hash = Column(String, nullable=True)
    # API Token 的 SHA-256 哈希（明文只在生成时展示一次，不落库）
    # SHA-256 hash of the API token (plaintext shown once at generation, never stored)
    api_token = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=_now)

    # 权力轴：user（默认）/ admin。与订阅等级（plan）完全独立——管理员权限
    # 不代表任何信号等级，订阅等级也不授予任何后台管理权限。
    # Power axis: user (default) / admin. Fully independent of `plan` — admin
    # rights don't imply any signal tier, and no plan grants admin rights.
    role = Column(String, default="user", nullable=False)
    # 商业轴：FREE（默认）/ PRO。两级各自的定位与权益见
    # services/plans.py 顶部说明。
    # Business axis: FREE (default) / PRO. See the header of
    # services/plans.py for what each tier means and grants.
    plan = Column(String, default="FREE", nullable=False)
    # 订阅到期时间，空 = 永久（内部赠送/内测用户不设到期）。
    # Subscription expiry; null = never expires (comp/beta users typically unset).
    plan_expires_at = Column(DateTime, nullable=True)
    # 内部备注，供管理员留痕（如"KOL 合作赠送"），不展示给用户本人。
    # Internal note for admins (e.g. "KOL partnership grant"); never shown to the user.
    plan_note = Column(String, nullable=True)
    # 免费试用：领取时间（终身一次的凭据，NULL=从未用过）；是否处于试用期
    # （试用领取时置 True，付费转正/到期降级/管理员改动时清 False）。
    # Free trial: claim time (lifetime-once credential; NULL = never used), and
    # whether the current PRO is a trial (set on claim; cleared on paid
    # conversion, expiry downgrade, or any admin plan change).
    trial_used_at = Column(DateTime, nullable=True)
    plan_is_trial = Column(Boolean, default=False, nullable=False)
    # 最近一次带凭证请求的时间，用于计算 DAU；在 get_current_user 里限流更新
    # （同一用户 5 分钟内只写一次库），避免每个请求都触发一次 UPDATE。
    # Last authenticated request time, used to compute DAU; throttled in
    # get_current_user (written at most once per 5 minutes per user) to avoid
    # an UPDATE on every single request.
    last_active_at = Column(DateTime, nullable=True)
    # 该用户最近一次上报的 Bridge 桌面程序版本号（如 "1.3.15"），随
    # POST /api/bridge/poll 上报，用于网页端提示"有新版本 Bridge 可更新"。
    # 空表示还没连过带这个字段的新版 Bridge（或从未连过）。
    # This user's most recently reported Bridge desktop app version (e.g.
    # "1.3.15"), reported via POST /api/bridge/poll, used to power the web
    # app's "a newer Bridge is available" notice. Null means no Bridge build
    # carrying this field has reported in yet (or none ever has).
    bridge_version = Column(String, nullable=True)
    # 会话版本号：写进每个 JWT 的 "tv" 字段，登录时校验必须与当前值一致。
    # 改密码时自增一次，使改密前签发的所有旧 token（包括被盗的）立即失效；
    # 改密的这次请求会拿到一个带新版本号的 token 作为响应，避免用户改完自己
    # 的密码后被自己刚发起的这次操作反手登出。
    # Session/token version: stamped into every JWT's "tv" claim; login
    # requires it to match the current value. Incremented on password change,
    # instantly invalidating every token (including a stolen one) issued
    # before the change; the password-change request itself gets back a
    # freshly stamped token so the user isn't logged out by their own action.
    token_version = Column(Integer, default=0, nullable=False)
    # 该邮箱首次成功通过 Google 验证的时间；null = 从未通过 Google 验证过。
    # 唯一用途：区分"账号预劫持"防护里两种表面相同、实质不同的情况——
    # ① 攻击者抢先用受害者邮箱注册了密码账号，受害者第一次尝试 Google 登录
    #    时，此邮箱的 Google 身份从未被验证过，必须拒绝（见 routers/auth.py
    #    google_login 的说明）；
    # ② 用户本来就是通过 Google 登录创建的账号（此刻即验证成功，见
    #    google_login 里创建分支），后来自己在账户设置里为账号加了一个密码
    #    （见 routers/account.py 的 change_password）——这个邮箱的 Google 身份
    #    早就验证过，用密码登录是他自己的选择，不该反过来把 Google 登录堵死。
    # 没有这个字段时两种情况在"password_hash 是否非空"这一个信号上完全无法
    # 区分，导致②被误杀——这正是 2026-07 报告的"设置密码后再也无法用 Google
    # 登录"的问题根因。
    # When this email first passed Google verification; null = never verified
    # via Google. Sole purpose: disambiguate two situations the account-
    # pre-hijack guard otherwise can't tell apart from "password_hash is set"
    # alone — ① an attacker pre-registered the victim's email with a password
    # before the victim's first Google login ever verifies that email (must
    # stay blocked, see google_login's docstring); ② the account originated
    # from Google login itself (verified at creation, see google_login's
    # create branch) and the user later chose to add a password from their own
    # account settings (see account.py's change_password) — this email's
    # Google identity was already verified, so choosing to also use a password
    # is the user's own choice and must not lock out Google login afterward.
    # Without this field the two are indistinguishable, wrongly blocking ②,
    # which is exactly the "can't use Google login after setting a password"
    # bug reported 2026-07.
    google_linked_at = Column(DateTime, nullable=True)


# 说明：旧的 EABinding（ea_bindings 表，EA 单账号绑定）已随 EA 接入方式移除。
# 生产库中的旧表保留不删，只是不再读写；多账号统一使用 MT5Account。
# Note: the legacy EABinding model (ea_bindings, single-account EA binding) was
# removed together with the EA integrations. The old table is left in place in
# production but no longer read or written; MT5Account is the single source.


class MT5Account(Base):
    """单个 MT5 账号（一个用户可挂多个）。
    A single MT5 account (a user may bind multiple).
    由桥接程序或 EA 上报，用 (user_id, login, server) 唯一标识。
    Reported by the bridge app or EA, identified by (user_id, login, server).
    """
    __tablename__ = "mt5_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", "login", "server", name="uq_user_login_server"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    login = Column(String, nullable=False)
    server = Column(String, nullable=True)
    # 来源：bridge（Python 程序）/ ea（MT5 EA）/ source of the report
    source = Column(String, default="bridge")
    account_name = Column(String, nullable=True)
    account_currency = Column(String, nullable=True)
    balance = Column(Float, nullable=True)
    equity = Column(Float, nullable=True)
    leverage = Column(Integer, nullable=True)
    company = Column(String, nullable=True)
    # 该账号的品种后缀（如 ".sc"）/ symbol suffix for this account
    symbol_suffix = Column(String, nullable=True, default="")
    online = Column(Boolean, default=False)
    last_heartbeat = Column(DateTime, nullable=True)


class Signal(Base):
    """交易信号 / Trading signal."""
    __tablename__ = "signals"
    __table_args__ = (
        # 过期扫描按 (status, expire_at) 查询 / expiry sweep filters on (status, expire_at)
        Index("idx_signals_status_expire", "status", "expire_at"),
        # 行情驱动的胜负判定按 (symbol, result) 查询"该品种下所有未判定信号"，
        # 与 status/expire_at 完全独立——一个信号过期后仍可能继续追踪到胜负。
        # Price-driven resolution looks up "all unresolved signals for a symbol"
        # by (symbol, result); independent of status/expire_at — a signal can
        # keep being tracked toward a result after it's already EXPIRED for
        # trading purposes.
        Index("idx_signals_symbol_result", "symbol", "result"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)  # BUY / SELL
    entry = Column(Float)
    stop_loss = Column(Float)
    take_profit = Column(Float)
    indicator = Column(String)
    # 来源：mock 内置引擎 / tradingview Webhook / source of the signal
    source = Column(String, default="mock")
    # 外部唯一编号（如 TradingView 警报自带的 id），用于去重，可空。
    # External unique id (e.g. from a TradingView alert) for dedup; nullable.
    external_id = Column(String, nullable=True, unique=True, index=True)
    status = Column(String, default="ACTIVE")  # ACTIVE / EXPIRED
    created_at = Column(DateTime, default=_now)
    expire_at = Column(DateTime, nullable=True)

    # 胜负判定：与 status 完全独立的第二条状态线。信号一出现即视为已进场，
    # 不受 10 分钟 status 过期影响，一直追踪到真正碰到止盈/止损，或超过
    # SIGNAL_STALE_DAYS 仍无行情更新（判定为 STALE，数据源可能中断，不计入胜率）。
    # Result: a second status axis, fully independent of `status`. A signal is
    # treated as entered the moment it's created; tracking isn't cut off by the
    # 10-minute `status` expiry — it continues until price actually reaches TP
    # or SL, or until SIGNAL_STALE_DAYS pass with no price update at all (marked
    # STALE — likely a feed gap — and excluded from win-rate stats).
    result = Column(String, default="PENDING")  # PENDING / HIT_TP / HIT_SL / STALE
    resolved_at = Column(DateTime, nullable=True)
    # 价格基线：首次被行情判定逻辑观测到时的该品种 K 线高/低点快照。首次
    # 观测只记录基线、不判定胜负——那根 K 线可能早于信号创建就已经在形成，
    # 其高低点会混入信号创建前的价格波动。此后只有超出基线的新极值才计入
    # 判定，见 services/signal_resolution.py。
    # Price baseline: a snapshot of the symbol's bar high/low the first time
    # win/loss resolution observes this signal. The first observation only
    # records the baseline and never resolves — that bar may have started
    # forming before the signal existed, so its high/low can include
    # pre-signal price action. Only extremes beyond the baseline count from
    # then on; see services/signal_resolution.py.
    baseline_high = Column(Float, nullable=True)
    baseline_low = Column(Float, nullable=True)


class Order(Base):
    """下单指令与回执 / Order command and execution result."""
    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("user_id", "client_order_id", name="uq_user_client_order"),
        # 后台清扫按 status 查询 / the stale-order sweep filters on status
        Index("idx_orders_status", "status"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    signal_id = Column(String, ForeignKey("signals.id"), nullable=True)
    client_order_id = Column(String, nullable=False)
    # 指令类型：ORDER 开仓 / CLOSE 平仓（含部分）/ MODIFY 改 SL·TP
    # command action: ORDER (open) / CLOSE (incl. partial) / MODIFY (SL·TP)
    action = Column(String, default="ORDER")
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)
    volume = Column(Float, nullable=False)
    # 目标持仓 ticket（平仓/改单用）/ target position ticket (close/modify)
    ticket = Column(Integer, nullable=True)
    # 自定义/目标止损止盈（绝对价）/ custom or target SL & TP (absolute price)
    sl = Column(Float, nullable=True)
    tp = Column(Float, nullable=True)
    # 目标 MT5 账号 login（多账号路由用）/ target MT5 login for routing
    mt5_login = Column(String, nullable=True)
    status = Column(String, default="PENDING")  # PENDING / FILLED / REJECTED / FAILED / CANCELLED
    # 是否已下发给 EA（轮询模式用）/ delivered to EA (used by polling mode)
    delivered = Column(Boolean, default=False)
    # 最近一次下发时间，用于超时重发判定 / last delivery time, for ack-timeout re-delivery
    delivered_at = Column(DateTime, nullable=True)
    mt5_ticket = Column(Integer, nullable=True)
    filled_price = Column(Float, nullable=True)
    message = Column(String, nullable=True)
    # 桥接最近一次把该仓位报为"仍持仓"的时间；用于拿 MT5 实时持仓对账个人胜率
    # ——平仓明细可能因桥接离线/手动平仓漏报，仅靠平仓记录会让仓位永远卡在
    # "进行中"。近期没被报为持仓、又没有完整平仓记录的仓位视为已在别处平掉、
    # 不再计入"进行中"（见 services/trade_performance.py）。
    # Last time the bridge reported this position as still open; used to
    # reconcile personal win-rate against MT5's live positions. Close-legs can
    # be missed (bridge offline / manual close), so relying on close records
    # alone strands positions at "进行中" forever. A position not seen open
    # recently and without a complete close record is treated as closed
    # elsewhere and dropped from the open count (see trade_performance.py).
    position_last_seen_open = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class NotificationPref(Base):
    """通知偏好（白名单模式），每个用户一条 / Notification prefs (whitelist), one per user."""
    __tablename__ = "notification_prefs"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    # 是否启用通知 / whether notifications are enabled at all
    enabled = Column(Boolean, default=False)
    # 用户选择开启的指标类别（JSON array of strings）；空(非 null)表示全关闭 / selected indicator categories
    selected_categories = Column(Text, default="[]")
    # 用户选择开启的品种白名单（JSON array of strings），与 selected_categories
    # 按"与"关系联合过滤：一条新信号必须策略类别与品种都命中才推送。列表内容
    # 可以是 "__ALL__" 哨兵值（不限品种，且自动覆盖后续新增品种）或具体品种代码。
    # Selected symbol whitelist (JSON array), ANDed with selected_categories: a
    # new signal only pushes if BOTH its category and its symbol match. Entries
    # can be the "__ALL__" sentinel (matches any symbol, including ones added
    # later) or specific symbol codes.
    selected_symbols = Column(Text, default="[]")
    # 事件类通知白名单（JSON array）：order_filled / order_rejected /
    # auto_manage / bridge_offline。与上面的指标类别是两套独立的白名单——
    # 指标类别只管"新信号推送该不该发"，这个字段管"账户/交易事件该不该推"。
    # Event-notification whitelist (JSON array): order_filled / order_rejected
    # / auto_manage / bridge_offline. A separate whitelist from the indicator
    # categories above — those gate "should a new-signal push fire", this
    # gates "should an account/trading-event push fire".
    event_types = Column(Text, default="[]")


class PushSubscription(Base):
    """Web Push 订阅：每个用户的每个设备一条 / One push subscription per device per user."""
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "endpoint", name="uq_user_endpoint"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    endpoint = Column(String, nullable=False)
    keys_p256dh = Column(String, nullable=False)
    keys_auth = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)


class UserPref(Base):
    """用户通用偏好（跨设备同步），每个用户一条 JSON 文档。
    Generic per-user preferences (cross-device sync), one JSON document per user.
    用于信号面板等界面设置的云端同步 / used to sync UI settings like the signals panel.
    """
    __tablename__ = "user_prefs"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    # 偏好 JSON 文档（按命名空间存放，如 {"signals": {...}}）/ prefs JSON keyed by namespace
    data = Column(Text, default="{}")
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class Trend(Base):
    """多周期趋势快照：每个品种一条，后来的覆盖前面的。
    Multi-timeframe trend snapshot: one row per symbol, latest overwrites previous.
    由 TradingView 指标经 /api/webhook/trend 推送，仅在任一周期翻转时更新。
    Pushed by a TradingView indicator via /api/webhook/trend, only when a TF flips.
    """
    __tablename__ = "trends"

    id = Column(String, primary_key=True, default=_uuid)
    symbol = Column(String, nullable=False, unique=True, index=True)
    # 各周期趋势的 JSON 对象，如 {"M5":"UP","M15":"DOWN",...} / per-timeframe map as JSON
    timeframes = Column(Text, default="{}")
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class ClosedTrade(Base):
    """一笔真实的 MT5 平仓明细（按 MT5 的成交记录，一次平仓/部分平仓一条）。

    由桥接程序上报：先用魔术号码（778899）在 MT5 成交历史里找出"哪些仓位是本
    平台开的"，再按仓位编号收集它们后续所有的平仓成交——不管那次平仓是通过
    网页发出的指令，还是用户直接在 MT5 客户端手动操作的，只要仓位编号对得上
    就会被记录。profit 是 MT5 自己算好的真实盈亏（账户货币），不是本平台估算的。

    A real MT5 close-leg record (one row per fill of a full/partial close,
    straight from MT5's own deal history).

    Reported by the bridge app: it first uses the magic number (778899) to find
    which positions this platform opened, then collects every subsequent
    closing deal for those position ids — regardless of whether the close was
    triggered by a web command or done manually in the MT5 terminal, as long as
    the position id matches. `profit` is MT5's own computed P&L (account
    currency), not an estimate made by this platform.
    """
    __tablename__ = "closed_trades"
    __table_args__ = (
        # 去重：桥接程序可能因重试重复上报同一笔成交 / dedup: the bridge may retry-report the same deal
        UniqueConstraint("user_id", "deal_ticket", name="uq_user_deal_ticket"),
        # 胜率聚合按 (user_id, mt5_login, position_ticket) 分组求和 / win-rate
        # aggregation groups by (user_id, mt5_login, position_ticket)
        Index("idx_closed_trades_position", "user_id", "mt5_login", "position_ticket"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(String, nullable=False)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)  # 原仓位方向 BUY/SELL / the position's original direction
    close_volume = Column(Float, nullable=False)  # 这一笔平仓的手数（可能是部分平仓）/ this leg's volume
    close_price = Column(Float, nullable=False)
    profit = Column(Float, nullable=False)  # MT5 计算的真实盈亏（账户货币）/ MT5's real P&L, account currency
    position_ticket = Column(Integer, nullable=False)  # 仓位编号，同一仓位的多次部分平仓共享 / shared across partial closes
    deal_ticket = Column(Integer, nullable=False)  # MT5 成交编号，用于去重 / MT5 deal ticket, for dedup
    closed_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=_now)


class AutoManageSettings(Base):
    """自动仓位管理设置（PRO 专属），每个用户一条。

    所有阈值以 R 为单位——R = 仓位开仓时的止损距离 |入场价 - 初始止损|。
    开仓时没有止损的仓位无法定义 R，自动管理会跳过它们。

    Auto position-management settings (PRO only), one row per user.
    All thresholds are in R units — R = the position's initial stop distance
    |entry - initial SL|. Positions opened without a stop have no defined R
    and are skipped.
    """
    __tablename__ = "auto_manage_settings"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    # 总开关 / master switch
    enabled = Column(Boolean, default=False, nullable=False)
    # 保本：浮盈达到 trigger R 时把止损移到入场价 / break-even: move SL to entry at trigger R
    be_enabled = Column(Boolean, default=True, nullable=False)
    be_trigger_r = Column(Float, default=1.0, nullable=False)
    # 追踪止损：浮盈达到 trigger R 后，止损跟随现价保持 distance R 的距离
    # trailing stop: once past trigger R, SL follows price at distance R behind
    trail_enabled = Column(Boolean, default=False, nullable=False)
    trail_trigger_r = Column(Float, default=1.5, nullable=False)
    trail_distance_r = Column(Float, default=1.0, nullable=False)
    # 分批止盈：浮盈达到 trigger R 时平掉 fraction 比例的仓位（每仓只执行一次）
    # partial take-profit: close `fraction` of the position at trigger R (once per position)
    ptp_enabled = Column(Boolean, default=False, nullable=False)
    ptp_trigger_r = Column(Float, default=1.0, nullable=False)
    ptp_fraction = Column(Float, default=0.5, nullable=False)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class AutoManagedPosition(Base):
    """自动仓位管理的每仓状态：初始止损距离快照 + 分批止盈是否已执行。

    R 的分母必须用"开仓时"的止损距离——止损被移动后 |入场-当前SL| 会变，
    所以在第一次见到该仓位时就把入场价/初始止损拍下来存档。

    Per-position state for auto management: a snapshot of the initial stop
    distance plus whether the partial take-profit already fired. The R
    denominator must be the stop distance AT OPEN — |entry - current SL|
    changes once the stop is moved — so entry/initial SL are snapshotted the
    first time the position is seen.
    """
    __tablename__ = "auto_managed_positions"
    __table_args__ = (
        UniqueConstraint("user_id", "position_ticket", name="uq_auto_pos_user_ticket"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    position_ticket = Column(Integer, nullable=False)
    mt5_login = Column(String, nullable=True)
    entry = Column(Float, nullable=True)
    initial_sl = Column(Float, nullable=True)  # 0/None = 开仓无止损，无法自动管理 / no SL at open, unmanageable
    risk = Column(Float, nullable=True)  # |entry - initial_sl|；None = 无法定义 R / undefined R
    partial_done = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class DisciplineSnapshot(Base):
    """纪律分每日快照：驱动前端 30 天趋势线。当日分数由后台循环 upsert，
    实时值另由 API 现算——快照只为趋势，不是实时值的缓存。

    Daily discipline-score snapshot, powering the 30-day trend line. Upserted
    by a background loop; the live value is computed on demand by the API —
    snapshots exist for the trend, not as a cache of the live number.
    """
    __tablename__ = "discipline_snapshots"
    __table_args__ = (
        # login 为空字符串表示"全部绑定账号"聚合行 / "" = the all-accounts aggregate row
        UniqueConstraint("user_id", "login", "date", name="uq_discipline_user_login_date"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    login = Column(String, nullable=False, default="")
    date = Column(String, nullable=False)  # UTC 日期 ISO 字符串 "2026-07-17"
    total = Column(Float, nullable=True)   # 当日总分；样本不足无法评分时为 NULL
    dimensions = Column(Text, default="{}")  # 三维度明细 JSON（结构见 discipline.py）
    created_at = Column(DateTime, default=_now)


class PlatformSetting(Base):
    """平台级设置（键值对，值为 JSON 字符串）。

    存放"管理员想在后台改、不想改代码"的运营配置——当前是合作券商锁
    （broker_lock_enabled / broker_patterns / broker_display_name /
    broker_referral_url），未来的同类配置也放这里。读取走
    services/settings_store.py 的进程内缓存，未写入的键回落到代码里的默认值。

    Platform-wide settings (key-value, JSON-encoded values). Holds operational
    config admins want to change from the panel without a deploy — currently
    the partner-broker lock; future knobs of the same kind belong here too.
    Reads go through the in-process cache in services/settings_store.py, and
    missing keys fall back to code defaults.
    """
    __tablename__ = "platform_settings"

    id = Column(String, primary_key=True, default=_uuid)
    key = Column(String, unique=True, nullable=False, index=True)
    value = Column(Text, nullable=False)  # JSON 编码 / JSON-encoded
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class Payment(Base):
    """NOWPayments 支付记录 / NOWPayments payment record.

    每笔用户发起的支付（购买 PRO 套餐），记录对应 NOWPayments 支付 ID、
    应付款项、到账地址、状态等。支付完成时自动将用户升级为 PRO。
    """

    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("nowpayments_payment_id", name="uq_np_payment_id"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    nowpayments_payment_id = Column(String, nullable=False, unique=True, index=True)
    plan = Column(String, nullable=False)  # pro_monthly / pro_yearly
    amount_usd = Column(Float, nullable=False)
    pay_currency = Column(String, nullable=False)  # btc / eth / usdttrc20 ...
    pay_amount = Column(Float, nullable=True)
    pay_address = Column(String, nullable=True)
    status = Column(String, default="NEW")  # NEW / PENDING / PROCESSING / FINISHED / EXPIRED / FAILED
    # NOWPayments 报告的实际到账金额（同 pay_currency 计价）：低于 pay_amount
    # 说明用户少转了（常见于没算准链上手续费）。同步时持续更新，不止终态才写，
    # 让用户在支付窗口还开着的时候就能看到"已收到部分金额"，而不是只有一句
    # "已过期"却不知道钱去哪儿了。
    # Actual amount received, as reported by NOWPayments (same currency as
    # pay_currency): less than pay_amount means the user under-sent (commonly
    # from misjudging the network fee). Updated on every sync, not just at a
    # terminal state, so the user can see "partial amount received" while the
    # payment window is still open, instead of just an "expired" message with
    # no idea where the funds went.
    actually_paid = Column(Float, nullable=True)
    created_at = Column(DateTime, default=_now)
    finished_at = Column(DateTime, nullable=True)


class Candle(Base):
    """K 线历史：EA 推送的、已经走完（收盘）的 K 线长期落库，供策略回测与
    未来更长回看使用；仍在形成中的那根不落库。内存里的 `chart_store` 继续
    单独负责图表的实时读取，两者互不影响、互不依赖。

    Candle history: closed (finished) bars pushed by the EA, persisted
    long-term for strategy backtesting and future lookback; the
    still-forming bar is never written here. The in-memory `chart_store`
    remains solely responsible for the chart's live reads — independent of,
    and unaffected by, this table.
    """
    __tablename__ = "candles"
    __table_args__ = (
        UniqueConstraint("symbol", "interval", "t", name="uq_candle_symbol_interval_t"),
        Index("idx_candle_symbol_interval_t", "symbol", "interval", "t"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    symbol = Column(String, nullable=False)
    interval = Column(String, nullable=False)
    t = Column(Integer, nullable=False)  # K 线开盘时间, epoch 秒 / bar open time, epoch seconds
    o = Column(Float, nullable=False)
    h = Column(Float, nullable=False)
    l = Column(Float, nullable=False)
    c = Column(Float, nullable=False)
    v = Column(Float, default=0)


class UserStrategy(Base):
    """用户自定义策略：从模板选一个、调好参数，对指定品种/周期持续评估。

    User-customized strategy: pick a template, tune its parameters, and it's
    continuously evaluated against a chosen symbol/interval.
    """
    __tablename__ = "user_strategies"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    template = Column(String, nullable=False)  # ma_cross / rsi_reversal / bollinger_reversion
    # 用户自定义名称，留空则前端按模板名兜底展示 / user-given name; falls back to the template label when empty
    name = Column(String, nullable=True)
    symbol = Column(String, nullable=False)
    interval = Column(String, nullable=False)
    params = Column(Text, default="{}")  # 模板专属参数 JSON / template-specific params JSON
    # 止损/止盈方式可独立选择，而不是只有"百分比距离 + R 倍数"一种组合：
    # 止损 method: percent(按入场价百分比距离) / price(固定价格距离，同 EA 报价单位)。
    # 止盈 method: rr(止损距离的倍数，与 auto_manage.py 的 R 值约定一致) / percent / price。
    # SL/TP method is independently selectable rather than one fixed combo:
    # stop_loss method: percent (distance as % of entry) / price (fixed price
    # distance, same unit as the EA's quotes). take_profit method: rr
    # (multiple of the SL distance, consistent with auto_manage.py's R
    # convention) / percent / price.
    stop_loss_method = Column(String, nullable=False, default="percent")
    stop_loss_value = Column(Float, nullable=False, default=1.0)
    take_profit_method = Column(String, nullable=False, default="rr")
    take_profit_value = Column(Float, nullable=False, default=2.0)
    # 一次一单：开着仓时(上一次触发的信号还没等到止损/止盈)不再触发新信号，
    # 关闭则只要入场条件满足就触发,不管前一笔是否还"开着"。回测与实盘评估
    # 都读这个开关,见 strategy_engine.py 的 run_backtest/evaluate_new_candle。
    # One trade at a time: while a position is open (the previous fired
    # signal hasn't hit its SL/TP yet), no new signal fires; when off, any
    # bar meeting the entry condition fires regardless of whether the prior
    # one is still open. Read by both the backtest and the live evaluator —
    # see run_backtest/evaluate_new_candle in strategy_engine.py.
    one_trade_at_a_time = Column(Boolean, nullable=False, default=True)
    enabled = Column(Boolean, default=False)
    # 防止同一根 K 线重复触发信号 / de-dup guard: last bar this strategy fired a signal on
    last_signal_bar_t = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now)


class StrategySignal(Base):
    """用户策略触发的个人信号：只有策略所有者自己能看到，与全站信号表完全
    独立（全站信号表假定"所有人共享同一份"，个人策略信号天然不满足这个前提，
    分开建表避免污染客观胜率/纪律分等既有统计口径）。

    A signal fired by a user's own strategy: visible only to its owner,
    intentionally kept separate from the shared, platform-wide `signals`
    table (which assumes "the same row is shared by everyone" — personal
    strategy signals don't fit that, so a separate table avoids polluting
    the objective-win-rate/discipline-score statistics built on `signals`).
    """
    __tablename__ = "strategy_signals"

    id = Column(String, primary_key=True, default=_uuid)
    strategy_id = Column(String, ForeignKey("user_strategies.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)  # BUY / SELL
    entry = Column(Float, nullable=False)
    stop_loss = Column(Float, nullable=False)
    take_profit = Column(Float, nullable=False)
    bar_t = Column(Integer, nullable=False)  # 触发那根 K 线的时间 / the triggering bar's time
    # 胜负判定：与 signals 表 result 字段同一套口径(PENDING/HIT_TP/HIT_SL)，
    # 由 evaluate_new_candle() 在每根新收盘 K 线到达时顺带判定——不是单独的
    # 后台清扫任务,因为策略信号天然绑定"这个品种/周期有新 K 线才有必要看"。
    # "一次一单"开关就是靠这个字段判断"上一笔是否还开着"。
    # Win/loss resolution, same vocabulary as the signals table's `result`
    # column (PENDING/HIT_TP/HIT_SL). Resolved inline by evaluate_new_candle()
    # whenever a new bar closes — not a separate sweep job, since a strategy
    # signal is naturally tied to "there's a new bar for this symbol/interval
    # worth checking" anyway. The "one trade at a time" gate reads this field
    # to know whether the previous trade is still open.
    result = Column(String, nullable=False, default="PENDING")
    resolved_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)


class AdminAuditLog(Base):
    """管理员操作审计日志：谁在什么时候把哪个用户的哪个字段改成了什么。

    只记录管理后台发起的用户等级/权限变更，不记录一般业务操作。团队不止一人
    管理时，这是唯一能查清"谁改的、改成了什么"的依据。

    Admin action audit log: who changed which field on which user, and when.
    Only covers admin-initiated role/plan changes, not general business
    actions. Once more than one person has admin access, this is the sole
    record of who changed what.
    """
    __tablename__ = "admin_audit_logs"

    id = Column(String, primary_key=True, default=_uuid)
    admin_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    target_user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    field = Column(String, nullable=False)  # role / plan / plan_expires_at / plan_note
    old_value = Column(String, nullable=True)
    new_value = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)
