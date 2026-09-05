"""ORM 数据模型 / ORM data models."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, Column, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import relationship

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

    # 手机号，统一存 E.164（区号+号码，如 +60123456789）。
    # 不拆成「区号」「号码」两列：拆开之后每个消费方都要自己拼，迟早有人拼错
    # （漏加号、区号带前导 0）。前端用两个输入框只是录入方式，落库前合成一个值。
    # 只做格式校验，不做短信验证——号码是「记录」不是「已验证」，别把它当成
    # 可信的身份凭据用（比如拿来做找回密码）。
    # Phone in E.164 (dial code + number). Deliberately one column, not a split
    # dial-code/number pair: every consumer would otherwise re-assemble it and
    # someone eventually gets it wrong. Format-checked only, never SMS-verified —
    # treat it as recorded, not proven, and don't build account recovery on it.
    phone = Column(String, nullable=True)
    # 是否必须提供手机号才能使用。
    #
    # 存在的唯一理由是分清「存量用户」和「新用户」：这次上线要求新注册强制填写，
    # 但已有用户豁免（产品决定）。迁移时把当时库里所有行回填为 False，之后新建的
    # 用户走模型默认值 True。这比「注册时间早于某个日期」可靠——不依赖部署时刻的
    # 时钟，也不会因为补跑迁移而误判。
    #
    # 与 google_linked_at 是同一种取舍（见 core/database.py 那段回填注释）：
    # 新规则只管这次上线之后出现的账号，老用户一个都不被追溯要求。
    #
    # Whether this account must supply a phone before using the app. Exists solely
    # to separate pre-existing users (grandfathered) from new ones: the migration
    # backfills every row present at that moment to False, and rows created later
    # take the model default of True. More reliable than comparing created_at to a
    # launch date — no dependence on deploy-time clocks, and re-running the
    # migration can't misclassify anyone. Same tradeoff as google_linked_at.
    phone_required = Column(Boolean, default=True, nullable=True)

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
    # 注册来源归因：经邀请链接注册时写入该链接的 code，此后永不改动。注册人数
    # 统计按它分组——与 plan_note 里的标记名快照解耦，管理员手改备注不影响统计
    # （见 routers/invite.py 的 apply_invite 与 admin 列表的 GROUP BY）。
    # Signup attribution: the invite link's code, written once at registration
    # and never changed. Registration counts group by this column — decoupled
    # from the label snapshot in plan_note, so admins editing notes can't skew
    # the stats (see apply_invite in routers/invite.py).
    invite_code = Column(String, nullable=True)
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
    nickname = Column(String, nullable=True)            # 2-20 字，展示时默认打码；保留词校验在写入端
    nickname_public = Column(Boolean, nullable=False, default=False)
    leaderboard_opt_out = Column(Boolean, nullable=False, default=False)
    equipped_badge = Column(String, nullable=True)      # 佩戴的勋章 id，只能佩戴已获得的
    # 佩戴的全部勋章（有序，逗号分隔，最多 3 枚），第一枚即上面的默认。两列同写：
    # equipped_badge 是派生值，榜单/比赛/auth 那几条读单枚的路径一行不用改。空串 = 全部卸下。
    # All equipped badges (ordered, comma-separated, max 3); the first is the default
    # above. Written together: equipped_badge is derived, so the leaderboard /
    # competition / auth paths that read a single id stay untouched. Empty string = none.
    equipped_badges = Column(String, nullable=True)


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
    # 券商侧的组名（如 "real\\forex\\standard"）。列名刻意不叫 group：那是
    # PostgreSQL 的保留字，而本项目的迁移走裸 SQL 的 ALTER TABLE，撞上就得处处加引号。
    # 存原始值而不是只存判定结果，有两个用处：① 运维能核对"这个账号到底在哪个组"，
    # ② 前缀规则改了之后可以重新判定，不必等券商那边有任何变化。
    # 目前只有 gateway 通道会写（组名由券商 Manager API 给出）；bridge 通道拿不到组名。
    # The broker-side group name. Deliberately not named `group` — that's a
    # PostgreSQL reserved word and this project's migrations use raw ALTER TABLE.
    # The raw value is kept (not just the verdict) so ops can audit it and so a
    # changed prefix rule can re-classify without waiting on the broker.
    mt5_group = Column(String, nullable=True)
    # 账户类型：0=模拟 1=竞赛 2=实盘，NULL=未知。取值与 MT5 的 ACCOUNT_TRADE_MODE
    # 一致，好让两条通道共用这一列——gateway 侧由组名判定（见 services/account_type.py），
    # bridge 侧由客户端上报 account_info().trade_mode。
    #
    # ⚠ 两条来源的可信度**不对等**：gateway 的组名来自券商、经本平台服务端取得，用户
    # 碰不到；bridge 的值来自用户自己电脑上的程序，理论上可伪造或故意缺省。凡是"对外
    # 代表用户成绩"的统计都应当知道这个差别。
    # Account type (0=demo, 1=contest, 2=real, NULL=unknown), same values as
    # MT5's ACCOUNT_TRADE_MODE so both channels share the column. Gateway derives
    # it from the broker's group name; bridge self-reports it. The two are NOT
    # equally trustworthy — see the note above.
    trade_mode = Column(Integer, nullable=True)
    # 绑定当时券商记录的「上次改密码时间」（Unix 秒），只有 gateway 通道写。
    #
    # **为什么需要**：gateway 绑定只在验证那一刻校验一次主密码，之后读持仓、
    # 下单全部由 manager 代劳，不再经过用户密码。也就是说这条链路上没有任何
    # 可过期的凭证——用户改了密码、账号转手、密码被券商重置，旧绑定照样能代客
    # 下单。这一列是补上撤销能力的唯一依据：每轮资金刷新拿券商侧的当前值来比，
    # 对不上就说明绑定时的那次授权已经作废（见 routers/gateway.py）。
    #
    # NULL 表示**没有信号**，不是「时间为 0」：券商服务器不填这个字段、网关是旧
    # 版本、或这一行是本列上线前就绑好的历史绑定。这三种都不撤销任何东西——
    # 宁可这道闸在某家券商上不生效，也不能因为读不到值就把所有人踢下线。
    #
    # Unix seconds of the account's last password change as recorded by the
    # broker at bind time; gateway channel only. A gateway bind checks the main
    # password exactly once and everything afterwards runs through the manager,
    # so the link holds no expirable credential — a changed password, a sold
    # account or a broker-side reset all leave the old binding fully able to
    # trade. This column is what makes revocation possible. NULL means "no
    # signal" (server doesn't fill it, old gateway, or a pre-existing binding),
    # never "time zero", and revokes nothing.
    pass_change_at = Column(BigInteger, nullable=True)
    # 绑定失效时刻与原因。非 NULL = 这次绑定已撤销：不下单、不轮询、界面上显示
    # 「需重新验证」，用户重新输一次主密码即可恢复（verify 会清空这两列）。
    #
    # 不直接删行：订单与平仓明细都按 (user, login) 关联，删了会让历史战绩失去
    # 归属；用户重新验证后也不必从头再来一次。
    #
    # When the binding was revoked and why. Non-NULL means: no orders, no
    # polling, and the UI asks for re-verification (which clears both columns).
    # The row is kept rather than deleted because orders and closed trades are
    # keyed by (user, login) and dropping it would orphan the user's history.
    revoked_at = Column(DateTime, nullable=True)
    revoked_reason = Column(String, nullable=True)
    # 券商 MT5 服务器墙钟相对 UTC 的偏移（秒，半小时的整数倍），只有 gateway 通道写。
    #
    # Manager API 给的成交时间是服务器本地时间，不是 UTC；平仓腿落库前必须减掉这个
    # 偏移（见 routers/gateway.observe_server_offset）。偏移是从「本平台开仓腿的服务器
    # 时间 − 我们自己 orders.created_at」观测出来的，以前只放在进程内存里：后端一重启
    # 就忘，要等该账号再出现一笔本平台开仓才学得回来，学不回来就按 0 处理——而
    # closed_trades 按 deal_ticket 去重，错的时间一旦入库就永远不会自愈。存到这里之后
    # 重启即可读回；NULL = 从未观测到（不是 0）。
    #
    # Offset of the broker's MT5 server clock from UTC (seconds, half-hour multiple),
    # gateway channel only. Deal times from the Manager API are server-local, so
    # closing legs subtract this before persisting. Previously memory-only: lost on
    # restart, re-learned only when the account next opened a platform position,
    # and treated as 0 until then — while closed_trades dedupes on deal_ticket, so a
    # wrong timestamp never self-corrects. NULL means never observed, not zero.
    server_utc_offset = Column(Integer, nullable=True)
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
    # 成交后的真实仓位号。mt5_ticket 存的是订单号或成交号，与仓位号是不同的编号
    # 体系，不能拿来匹配平仓成交。Gateway 开仓后反查填入；Bridge 侧为空（那边靠
    # 魔术号码判归属，不需要这个）。
    # The real position id after a fill. mt5_ticket holds an order or deal ticket,
    # a different numbering space, so it can't be matched against closing deals.
    # Filled in for gateway opens; stays null for bridge (which attributes by
    # magic number and doesn't need it).
    mt5_position = Column(Integer, nullable=True)
    filled_price = Column(Float, nullable=True)
    message = Column(String, nullable=True)
    trade_mode = Column(Integer, nullable=True)  # 成交时从账号行拷贝的不可变快照；-1=确认无法判定
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
    # auto_manage / bridge_offline / strategy_signal。与上面的指标类别是两套
    # 独立的白名单——指标类别只管"新信号推送该不该发"，这个字段管"账户/交易
    # 事件该不该推"。
    # 语义约定：NULL = 用户从未配置过（读取方按"默认开启事件"处理，但
    # badge_awarded 除外——它默认不推，见 push_dispatch.EVENT_BADGE_AWARDED
    # 在 _parse_event_types 里的排除逻辑），"[]" = 用户明确全部取消。因此新行
    # 默认 NULL 而不是 "[]"——产品要求这些提醒对新用户默认开启，同时保留老
    # 用户明确关掉的选择。下面列出的具体事件名只是举例，可能滞后于
    # push_dispatch.EVENT_TYPES 的实际清单。
    # Event-notification whitelist (JSON array): order_filled / order_rejected
    # / auto_manage / bridge_offline / strategy_signal. A separate whitelist
    # from the indicator categories above — those gate "should a new-signal
    # push fire", this gates "should an account/trading-event push fire".
    # Semantics: NULL = never configured (readers treat it as "default-on
    # events" — except badge_awarded, which defaults off; see the
    # EVENT_BADGE_AWARDED exclusion in push_dispatch._parse_event_types),
    # "[]" = explicitly opted out of everything. New rows therefore default to
    # NULL rather than "[]" — the product wants these alerts on by default
    # while preserving an explicit opt-out. The enumerated event names above
    # are illustrative only and may lag the actual list in
    # push_dispatch.EVENT_TYPES.
    event_types = Column(Text, default=None)
    # 推送时段限制（用户本地时间的 "HH:MM"）。两者都非空才生效；支持跨零点
    # （start > end 视为隔夜时段，如 22:00–07:00）。时区存 IANA 名称（如
    # "Asia/Shanghai"），由前端设备时区上报；缺失/无效时按 UTC 兜底。
    # NULL = 不限制，全天可推。
    # Push time-window (user-local "HH:MM"). Active only when both are set;
    # start > end wraps overnight (e.g. 22:00–07:00). Timezone is an IANA name
    # reported from the device; missing/invalid falls back to UTC. NULL = no
    # restriction, push all day.
    push_window_start = Column(String, nullable=True)
    push_window_end = Column(String, nullable=True)
    push_window_tz = Column(String, nullable=True)


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
        #
        # 键里必须带 mt5_login：MT5 的成交编号只在**单个交易服务器内**唯一，同一
        # 用户在两家券商各绑一个账号时完全可能撞号。原先的 (user_id, deal_ticket)
        # 会把第二个账号那笔真实成交当成"重复上报"静默丢弃，该仓位从此永远补不齐
        # 平仓手数、永远算不出胜负。与 idx_closed_trades_position 的分组键一致。
        # The key must include mt5_login: MT5 deal tickets are only unique within
        # one trade server, so a user with accounts at two brokers can legitimately
        # collide. The old (user_id, deal_ticket) silently dropped the second
        # account's real deal as a duplicate, leaving that position permanently
        # short of its closing volume and never resolvable.
        UniqueConstraint("user_id", "mt5_login", "deal_ticket", name="uq_user_login_deal_ticket"),
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
    # 服务端能否为这条记录背书：该平仓腿的 (账号, 仓位编号) 是否对得上本平台
    # 一笔已成交的开仓订单。
    #
    # 存在的理由是信任边界：这张表的数据由用户自己电脑上的桥接程序上报，凭的是
    # 该用户自己的 API Token。"只收本平台开的仓位"这条规则原本**只跑在客户端**
    # （靠魔术号码筛选），服务端收到什么写什么——也就是说，任何人都能用自己的
    # token 直接 POST 一批凭空捏造的盈利记录进来。gateway 通道一直是做这个核对的
    # （见 routers/gateway.py 的 _save_closed_trades 用 orders.mt5_position 反查），
    # 这一列把同一道核对补给了桥接通道。
    #
    # 核不过的记录**照常入库**（可能是回执丢失、历史数据等正当原因，不能因为
    # 存疑就丢掉用户真实的交易记录），只是打上 False；任何"对外代表用户成绩"
    # 的统计都应当只认 True。NULL = 本列上线前写入的历史行，无从判定。
    #
    # 局限，需如实认知：它能挡住"凭空捏造整个仓位"，但挡不住"给一个真实仓位报
    # 一个假盈亏"——后者需要独立于用户的行情源才能验证，本平台没有。
    #
    # Whether the server can vouch for this leg: does its (login, position id)
    # match a filled opening order this platform actually placed? The data
    # arrives from the user's own machine authenticated by their own API token,
    # and the "only platform-opened positions" rule used to run *client-side*
    # only, so anyone could POST fabricated profits. Unverifiable rows are still
    # stored (a lost fill callback is a legitimate cause) but flagged False; any
    # statistic that represents a user's record to others must require True.
    # NULL = written before this column existed. It stops fabricated positions,
    # not a forged profit on a real one — that would need an independent price
    # source this platform doesn't have.
    verified = Column(Boolean, nullable=True)
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
    # 纯自定义 AST 的策略没有起源模板，因此可空；有值时表示"从哪个预设起步"。
    # A pure-custom-AST strategy has no originating preset, hence nullable; when
    # set, it records which preset the strategy started from.
    template = Column(String, nullable=True)  # ma_trend / rsi_reversal / macd_rsi_combo ...
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
    # 都读这个开关,见 services/strategy/backtest.py 的 run_backtest 与
    # services/strategy/live.py 的 evaluate_new_candle。
    # One trade at a time: while a position is open (the previous fired
    # signal hasn't hit its SL/TP yet), no new signal fires; when off, any
    # bar meeting the entry condition fires regardless of whether the prior
    # one is still open. Read by both the backtest and the live evaluator — see
    # run_backtest in services/strategy/backtest.py and evaluate_new_candle in
    # services/strategy/live.py.
    one_trade_at_a_time = Column(Boolean, nullable=False, default=True)
    # 条件配置（JSON）：{"symbol", "interval", "logic": AND|OR, "conditions": [...]}。
    # 每个条件是 {indicator, usage, params}，做空侧由 usage 的镜像自动推出，不单独
    # 存。模板降级为这个字段的预设值，引擎侧不再有模板概念（见
    # services/strategy/presets.py）。symbol / interval 在这里与外层列各存一份：
    # 外层列供订阅与查询（strategy_watch、索引），这里的副本让 rules 在求值时自
    # 成一体。写入路径保证两者一致，见 routers/strategies.py 的 _resolve_rules。
    # Condition payload (JSON): {"symbol", "interval", "logic": AND|OR,
    # "conditions": [...]}, each condition being {indicator, usage, params}. The
    # short side is derived from each usage's mirror rather than stored. Templates
    # demote to preset values of this column; the engine no longer knows what a
    # template is (see services/strategy/presets.py). symbol/interval live both
    # here and in the columns above: the columns drive subscription and queries
    # (strategy_watch, indexes), while this copy keeps `rules` self-contained at
    # evaluation time. The write path keeps them equal — see _resolve_rules in
    # routers/strategies.py.
    rules = Column(Text, nullable=True)
    # 超时平仓：持仓超过 N 根 K 线仍未触及 SL/TP 则按当根收盘价平仓，记为
    # TIMEOUT。None = 不启用。回测与实盘同口径。
    # Timeout exit: after N bars without an SL/TP touch, close at that bar's
    # close and record TIMEOUT. None disables it. Same semantics in backtest
    # and live.
    exit_timeout_bars = Column(Integer, nullable=True)
    # 交易时段过滤：JSON {"startHour": int, "endHour": int}，UTC+8 小时区间，
    # 左闭右开。None = 不限制。跨零点由 startHour > endHour 表达。
    # Session filter: JSON {"startHour", "endHour"} in UTC+8, half-open. None
    # means no restriction; startHour > endHour expresses a window over midnight.
    session_filter = Column(Text, nullable=True)
    # 每日信号上限与时间冷却（分钟）。与既有的"同一根 K 线不重复"并存，不互相
    # 替代——前者按自然日计数，后者按分钟计时，各挡一类过度触发。
    # Daily signal cap and cooldown in minutes. Both coexist with the existing
    # "never twice on one bar" guard rather than replacing it — one counts per
    # calendar day, the other measures elapsed minutes.
    daily_signal_cap = Column(Integer, nullable=True)
    cooldown_minutes = Column(Integer, nullable=True)
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
    __table_args__ = (
        Index("idx_strategy_signals_strategy_result", "strategy_id", "result"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    strategy_id = Column(String, ForeignKey("user_strategies.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)  # BUY / SELL
    entry = Column(Float, nullable=False)
    stop_loss = Column(Float, nullable=False)
    take_profit = Column(Float, nullable=False)
    bar_t = Column(Integer, nullable=False)  # 触发那根 K 线的时间 / the triggering bar's time
    # 触发该信号的周期。多值化后同一策略可产生不同周期的信号，判定与超时计数
    # 都需要知道具体是哪一个。
    # The interval that fired this signal. After multi-interval support the same
    # strategy can fire on several, and both resolution and timeout counting
    # need to know which.
    interval = Column(String, nullable=True)
    # 价格基线：与平台信号 (Signal 表) 同名同义。首次观测只记录基线不判定，
    # 此后只有超出基线的新极值才计入命中——避免把信号出现之前的波动记成命中。
    # 详见 services/strategy/resolution.py。
    # Price baseline, same meaning as on the platform Signal table: the first
    # observation only records it, and only later extremes beyond it count as a
    # hit — so price action from before the signal existed can't be recorded as
    # one. See services/strategy/resolution.py.
    baseline_high = Column(Float, nullable=True)
    baseline_low = Column(Float, nullable=True)
    # 自触发以来经过的收盘 K 线数，每次判定递增；达到策略的 exit_timeout_bars
    # 时按当根收盘价平仓并记为 TIMEOUT。
    # Closed bars elapsed since firing, incremented on each resolution pass;
    # at the strategy's exit_timeout_bars it closes at that bar's close as
    # TIMEOUT.
    bars_held = Column(Integer, nullable=False, default=0)
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
    # 允许值：PENDING / HIT_TP / HIT_SL / TIMEOUT / STALE。
    # TIMEOUT 计入绩效（按平仓价的实际盈亏），STALE 不计入（数据源中断的兜底）。
    # Allowed: PENDING / HIT_TP / HIT_SL / TIMEOUT / STALE. TIMEOUT counts
    # toward performance (real P&L at the close price); STALE does not (it's the
    # feed-outage safety net).
    result = Column(String, nullable=False, default="PENDING")
    resolved_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=_now)


class StrategyWatch(Base):
    """策略盯盘三元组 (策略, 品种, 周期)：多品种多周期展开成行，让实时评估仍能
    用一次索引查询取候选。

    不用"取全部 enabled 策略再在应用层过滤 JSON 数组"：那样候选集随平台启用
    策略总数增长，而每根新收盘 K 线都要评估一次（6 周期 × N 品种），在 2 核
    单进程的生产环境上不可接受。

    A (strategy, symbol, interval) watch triple: the multi-symbol/interval
    cartesian product flattened into rows so live evaluation still fetches its
    candidates with a single indexed query.

    The alternative — load every enabled strategy and filter the JSON arrays in
    Python — grows the candidate set with the platform's total enabled strategy
    count, and evaluation runs on every closed bar (6 intervals x N symbols),
    which a 2-core single-process deployment can't absorb.
    """
    __tablename__ = "strategy_watch"
    __table_args__ = (
        UniqueConstraint("strategy_id", "symbol", "interval", name="uq_strategy_watch_triple"),
        Index("idx_strategy_watch_symbol_interval", "symbol", "interval"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    strategy_id = Column(String, ForeignKey("user_strategies.id"), nullable=False, index=True)
    symbol = Column(String, nullable=False)
    interval = Column(String, nullable=False)


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


class PageViewStat(Base):
    """页面访问统计：按「页面 × 小时」预聚合，本表**不记录是哪个用户**。

    刻意不存 user_id：后台只需要回答"哪些页面最常被打开、平均看多久"，
    这不需要个人身份。存了 user_id 就变成可下钻到个人的行为轨迹，性质从
    产品度量变成用户监控，也让表随「用户数 × 页面数」膨胀。按小时分桶后
    表体积只随「页面数 × 小时」增长（12 个静态路由，一天最多 288 行），
    多久都不用清理。

    访问**人数**不在本表，见 PageVisitorDay——那张表只为去重而存在，
    同样不保留任何时刻与时长信息。次数与人数分两张表而不是合并成一张，
    正是为了让本表保持"无身份"这个性质：合并后每行都会带上 user_id，
    连"某人某小时看了某页多久"都能读出来。

    time_bucket 是截断到整小时的 UTC 时间。累加而非插明细：同一小时同一页
    的第 N 次访问只更新这一行，因此写放大恒定，不会因为用户多就把库写爆。

    total_seconds 存的是停留秒数总和，平均值由 total_seconds / views 在查询
    时算出——存总和而不是存平均，才能在跨桶合并时正确加权（先平均再平均是
    错的）。

    Page-view stats, pre-aggregated per (path, hour), with NO user identity.
    Deliberately no user_id: the admin view only needs "which pages get opened
    most, and how long people stay", which requires no personal identity.
    Storing user_id would turn this into per-person behavioural tracking rather
    than a product metric, and would grow the table by users × pages. Bucketed
    hourly, size grows only with pages × hours (12 static routes, at most 288
    rows/day), so it never needs pruning.

    time_bucket is a UTC timestamp truncated to the hour. Rows accumulate
    instead of storing raw events: the Nth visit to the same page in the same
    hour just updates this row, so write amplification stays constant no matter
    how many users there are.

    total_seconds holds the SUM of dwell seconds; the average is derived as
    total_seconds / views at query time — storing the sum rather than the
    average is what makes merging buckets correctly weighted (averaging
    averages is wrong).
    """
    __tablename__ = "page_view_stats"
    __table_args__ = (
        # 累加的前提：(path, time_bucket) 唯一，靠它做 upsert 定位
        # Accumulation relies on (path, time_bucket) being unique for upserts
        UniqueConstraint("path", "time_bucket", name="uq_page_view_path_bucket"),
        # 后台查的是"最近 N 天"，按时间桶范围扫
        # The admin view queries a recent window, scanned by bucket range
        Index("idx_page_view_bucket", "time_bucket"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    path = Column(String, nullable=False)  # 前端路由 pathname，如 /dashboard
    time_bucket = Column(DateTime, nullable=False)  # 截断到整小时的 UTC 时间
    views = Column(Integer, default=0, nullable=False)
    total_seconds = Column(Float, default=0.0, nullable=False)


class PageVisitorDay(Base):
    """页面日活去重标记：「某用户某天访问过某页」，一天一页一人**只有一行**。

    存在的唯一目的是让 COUNT(DISTINCT) 能算出访问人数——这是 PageViewStat
    的纯计数模型无法回答的问题（10 次访问是 1 个人还是 10 个人，聚合完就
    永远分不出来了）。

    **刻意只存到"天"这个粒度，且不存任何时长或时刻**。这是隐私与功能之间
    的取舍点：知道"周二有 8 个人看过图表页"是产品数据，知道"张三周二下午
    3 点看了图表页 12 分钟"是行为监控。省掉小时与时长后，本表能回答前者、
    无法回答后者，而这正是后台需要的全部。

    与 PageViewStat 的分工：本表只管人数，次数与停留时长仍走那张无身份的
    表。所以任何"每人平均停留多久"之类的下钻都做不到，是设计使然。

    体积：随「活跃用户数 × 其访问过的页面数 × 天数」增长，不像纯聚合表那样
    有硬上界，因此配了 RETENTION_DAYS 定期清理（见 services/page_stats.py）。

    Per-day unique-visitor markers: "user U opened page P on day D", exactly one
    row per (page, day, user).

    Its only purpose is to make COUNT(DISTINCT) possible for visitor counts — a
    question PageViewStat's pure counters cannot answer (once aggregated, 10
    views are indistinguishable between 1 person and 10).

    Deliberately stored only at DAY granularity, with no dwell time and no
    timestamp. That is the privacy/utility trade-off: "8 people opened the chart
    page on Tuesday" is a product metric; "Alice spent 12 minutes on the chart
    page at 3pm Tuesday" is behavioural surveillance. Dropping the hour and the
    duration means this table can answer the former and not the latter, which is
    all the admin view needs.

    Division of labour with PageViewStat: this table only supplies visitor
    counts; view counts and dwell time stay in that identity-free table. Any
    per-person dwell drill-down is therefore impossible by construction.

    Size grows with active users × pages they visited × days, so unlike a pure
    aggregate it has no hard ceiling — hence RETENTION_DAYS pruning (see
    services/page_stats.py).
    """
    __tablename__ = "page_visitor_days"
    __table_args__ = (
        # 去重靠这条约束本身实现：重复上报撞唯一约束后忽略即可
        # Dedup is enforced by this constraint: repeat reports hit it and are ignored
        UniqueConstraint("path", "day", "user_id", name="uq_page_visitor_day"),
        # 按天范围扫 + 按天分组，都走这个索引
        # Both the range scan and the group-by run on this index
        Index("idx_page_visitor_day", "day"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    path = Column(String, nullable=False)
    day = Column(Date, nullable=False)  # UTC 日期 / UTC calendar date
    # 不加外键：用户注销后这行留着也无妨（它只是个去重标记，不含任何个人信息），
    # 反而避免删用户时被外键挡住。
    # No FK: leaving the row after a user is deleted is harmless (it is a dedup
    # marker holding no personal data) and avoids blocking user deletion.
    user_id = Column(String, nullable=False)


class Ticket(Base):
    """工单：用户提交的客服请求。按 category 分类、priority 设优先级，
    状态 open → in_progress → closed（closed 后用户可重开）。
    Support ticket: a user-submitted help request, categorized and
    prioritised, flowing open → in_progress → closed (reopenable by user).
    """
    __tablename__ = "tickets"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String, nullable=False)
    category = Column(String, nullable=False)  # account / payment / technical / feature
    priority = Column(String, nullable=False, default="normal")  # low / normal / urgent
    status = Column(String, nullable=False, default="open")  # open / in_progress / closed
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)

    user = relationship("User", backref="tickets")
    replies = relationship("TicketReply", backref="ticket", order_by="TicketReply.created_at")


class TicketReply(Base):
    """工单回复：一条工单下的一组对话，作者可以是提交者或管理员。
    A reply in a ticket thread; author can be the submitter or an admin.
    """
    __tablename__ = "ticket_replies"

    id = Column(String, primary_key=True, default=_uuid)
    ticket_id = Column(String, ForeignKey("tickets.id"), nullable=False, index=True)
    author_id = Column(String, ForeignKey("users.id"), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_now)

    author = relationship("User", backref="ticket_replies")


class InviteLink(Base):
    """邀请链接：管理员生成的带标记推广链接。code 进 URL（?ref=code），label 是
    管理员起的标记名；用户经链接注册时 label 快照进 users.plan_note、code 写进
    users.invite_code 做永久归因。行永不删除——删除会释放唯一 code，将来重新生成
    同码会把老用户错误归因；下线合作用 is_active 停用。
    Admin-generated promo link. `code` goes into the URL (?ref=code); at
    registration the label is snapshotted into users.plan_note and the code
    into users.invite_code for permanent attribution. Rows are never deleted —
    that would free the unique code for regeneration and misattribute old
    users; retire a link by flipping is_active instead.
    """
    __tablename__ = "invite_links"

    id = Column(String, primary_key=True, default=_uuid)
    code = Column(String, unique=True, nullable=False, index=True)
    label = Column(String, nullable=False)
    # 点击计数：软指标（限流兜底但防不了刷量，跨设备点击也不计）；注册数才是硬数。
    # Soft metric — rate-limited but not abuse-proof, and cross-device clicks
    # are invisible; registrations are the hard number.
    clicks = Column(Integer, nullable=False, default=0)
    is_active = Column(Boolean, nullable=False, default=True)
    # 经此链接注册是否自动开通 PRO 免费试用。默认关——上线当天不能让存量合作
    # 链接突然开始发放会员。天数取全局 trial_days，不做每条链接单独配置；全局
    # trial_enabled 是总闸，它关着时本开关一律不生效（见 invite.py 的
    # _trial_grant_days，那是唯一的判定处）。
    # nullable=True 是为存量行留的：补列后它们是 NULL，声明 NOT NULL 会与库里
    # 的实际状态不符（同 User.phone_required 的取舍）。迁移会把它们回填成
    # False，读取处再一律 bool() 兜底。
    # Whether registering through this link auto-grants the PRO free trial.
    # Defaults off. Duration always comes from the global trial_days; the global
    # trial_enabled switch is the master gate (see _trial_grant_days in
    # invite.py, the single place that decides). nullable=True mirrors
    # User.phone_required: pre-existing rows are NULL after the column is added,
    # so NOT NULL would contradict the actual database state. The migration
    # backfills them to False and every read wraps in bool().
    grants_trial = Column(Boolean, default=False, nullable=True)
    created_at = Column(DateTime, default=_now)


class UserTask(Base):
    """升级条件完成记录。等级由本表派生（连续完整完成的组数），不单独存等级列。"""
    __tablename__ = "user_tasks"
    __table_args__ = (UniqueConstraint("user_id", "task_id", name="uq_user_task"),)
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    task_id = Column(String, nullable=False)
    completed_at = Column(DateTime, default=_now)


class UserBadge(Base):
    """勋章授予记录。发出不收回（内测期除外，见设计 §11 发布策略）。"""
    __tablename__ = "user_badges"
    __table_args__ = (UniqueConstraint("user_id", "badge_id", name="uq_user_badge"),)
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    badge_id = Column(String, nullable=False)
    awarded_at = Column(DateTime, default=_now)


class UserActiveDay(Base):
    """活跃日标记，「三日之约」数据源。写入点在 deps._touch_last_active。"""
    __tablename__ = "user_active_days"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_user_active_day"),)
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    day = Column(String, nullable=False)  # UTC ISO 日期 "2026-09-02"


class PeriodBaseline(Base):
    """收益率榜分母基线（设计 §1.5）：按账户各拍各的，周期内冻结。"""
    __tablename__ = "period_baselines"
    __table_args__ = (
        UniqueConstraint("user_id", "mt5_login", "period_key", name="uq_baseline_acct_period"),
    )
    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(String, nullable=False)
    period_key = Column(String, nullable=False)   # 2026-W36 / 2026-09 / comp:<id>
    baseline = Column(Float, nullable=False)      # 拍照时该账户 MT5Account.balance
    taken_at = Column(DateTime, default=_now)     # 分子只计此刻之后的平仓（防双计）
    adjust = Column(Float, nullable=False, default=0.0)  # 期内入金并入分母；出金不减
    created_at = Column(DateTime, default=_now)


class LeaderboardSnapshot(Base):
    """榜单快照（设计 §1.6）：一行 = 一个账户；一人多账户 = 多行多名次（设计意图）。"""
    __tablename__ = "leaderboard_snapshots"
    __table_args__ = (
        UniqueConstraint("board", "period_key", "user_id", "mt5_login",
                         name="uq_board_period_acct"),
        Index("idx_snapshot_board_period_rank", "board", "period_key", "rank"),
    )
    id = Column(String, primary_key=True, default=_uuid)
    board = Column(String, nullable=False)        # return_pct / win_rate
    period_key = Column(String, nullable=False)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(String, nullable=False)
    rank = Column(Integer, nullable=False)
    score = Column(Float, nullable=False)         # 小数：0.124 = 12.4%
    sample = Column(Integer, nullable=True)       # 期内已判定整仓数
    computed_at = Column(DateTime, default=_now)


class Competition(Base):
    """比赛 = 后台可配置的限时榜单模板（设计 §1.7）。行永不删除。"""
    __tablename__ = "competitions"
    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    # 参赛账户类型：real = 只收实盘，demo = 只收模拟/赛区账户。一场比赛只收一类，
    # 不混着算——两类账户的本金与风险完全不可比，混在一张榜上没有意义。
    # Which accounts may enter: real = live accounts only, demo = demo/contest only.
    # One competition takes one kind; mixing them on a single board is meaningless
    # because the capital and risk behind the two aren't comparable.
    track = Column(String, nullable=False, default="real")      # real / demo
    # 本场比赛专属的入榜门槛，留空则回落到全局设置（管理端「游戏化」页签那两个）。
    # min_trades 一个值同时管两种 metric——比赛只用其中一种，分成两列没有意义。
    # Per-competition entry gates; NULL falls back to the global settings (the two
    # on the admin Gamification tab). One min_trades covers either metric, since a
    # competition only ever uses one of them.
    min_baseline_usd = Column(Float, nullable=True)
    min_trades = Column(Integer, nullable=True)
    metric = Column(String, nullable=False, default="return_pct")  # return_pct / win_rate
    enrollment = Column(String, nullable=False, default="signup")  # signup / auto
    reg_opens_at = Column(DateTime, nullable=True)
    reg_closes_at = Column(DateTime, nullable=True)
    starts_at = Column(DateTime, nullable=False)
    ends_at = Column(DateTime, nullable=False)
    status = Column(String, nullable=False, default="draft")    # draft→upcoming→running→ended→settled 只进不退
    prize_note = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)


class CompetitionParticipant(Base):
    """参赛条目 = 一个账户（设计 §1.8；基线统一存 period_baselines，见计划约束）。"""
    __tablename__ = "competition_participants"
    __table_args__ = (
        UniqueConstraint("competition_id", "mt5_login", name="uq_comp_login"),
    )
    id = Column(String, primary_key=True, default=_uuid)
    competition_id = Column(String, ForeignKey("competitions.id"), nullable=False, index=True)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(String, nullable=False)
    registered_at = Column(DateTime, default=_now)
    scoring_from = Column(DateTime, nullable=True)   # 计分起点 = max(开赛, 报名, 基线拍照)
    final_score = Column(Float, nullable=True)       # 终审写死
    final_rank = Column(Integer, nullable=True)
    disqualified = Column(Boolean, nullable=False, default=False)
    disqualify_reason = Column(String, nullable=True)
