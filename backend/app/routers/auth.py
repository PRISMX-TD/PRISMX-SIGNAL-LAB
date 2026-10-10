"""认证路由：注册与登录 / Auth router: register & login."""
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import (
    clear_failed_logins,
    is_login_locked,
    limiter,
    login_source,
    record_failed_login,
    remember_login_source,
)
from app.core.security import (
    create_access_token,
    generate_api_token,
    hash_api_token,
    hash_password,
    invalidate_bridge_token_cache,
    rotate_api_token,
    verify_google_id_token,
    verify_password,
)
from app.models import AdminAuditLog, User
from app.routers.invite import apply_invite, pick_ref
from app.schemas import (
    AuthRequest,
    AuthResponse,
    ForgotPasswordRequest,
    GoogleAuthRequest,
    MessageOut,
    RegisterRequest,
    ResetPasswordRequest,
    UserOut,
    VerifyEmailRequest,
)
from app.services import activity_log, email_verification
from app.services.deps import get_current_user
from app.services.email_domains import canonical_email_taken, is_disposable_email
from app.services.password_reset import (
    consume_token,
    issue_token,
    send_reset_email,
    too_many_recent_requests,
)
from app.services.phone import compose_phone
from app.services.pending_competition import pending_competition

logger = logging.getLogger("prismx.auth")

router = APIRouter(prefix="/auth", tags=["auth"])

# 登录时邮箱不存在（或是没有密码的 Google 账号）也照样跑一次 bcrypt：否则「查无此人」
# 立刻返回、「密码错」要多等一次 bcrypt（约 200ms），光看响应时间就能枚举出哪些邮箱
# 注册过。启动时算一次，用一个谁也不知道的随机串，永远不会校验通过。
# When the account doesn't exist (or is a password-less Google account) login
# still runs one bcrypt check, or "no such user" returns instantly while "wrong
# password" pays ~200ms of bcrypt — an enumeration oracle by latency alone.
# Computed once at import from a random secret nobody knows; it never matches.
_DUMMY_PASSWORD_HASH = hash_password(generate_api_token())


def _queue_login_event(
    background: BackgroundTasks | None,
    db: Session,
    user_id: str,
    method: str,
    new_source: bool | None,
) -> None:
    """登录成功后排一条操作日志 user.login，**响应发出去之后**才写（设计 §4.2）。

    登录本来一条写库语句都没有，不能为了记日志让它多一次提交、多等一次 Redis：限流计数
    （每人每小时最多 LOGIN_EVENTS_PER_HOUR 条）和那条 INSERT 都放进 BackgroundTasks，由
    _record_login_event 在自己的短事务里做。这里只取请求会话绑的那个引擎——后台任务跑的
    时候请求会话不保证还开着（get_db 的收尾可能已经关了它），引擎一直在；生产上它就是
    database.engine，测试里是那个一次性的库。
    background 为 None（脚本 / 测试直接调用路由函数）就不记。只在成功分支调用：失败的
    登录一律不记（老板 10-09 定的，也免得撞库时把它变成一个写放大器）。

    Queue one user.login activity row, written only after the response is sent
    (design §4.2). Login issues no DB writes today and must not gain a commit or
    a Redis wait for the sake of the log, so both the hourly quota check and the
    INSERT run in a background task (_record_login_event) on its own short
    transaction. Only the request session's engine is captured — the session may
    already be closed by get_db's teardown when the task runs, the engine never
    is; in production it is database.engine, in tests the throwaway one. No background (a script or test
    calling the route function directly) means no row. Called on success only:
    failed logins are never logged (owner's call, 10-09, and it keeps credential
    stuffing from turning into write amplification).
    """
    if background is None:
        return
    try:
        bind = db.get_bind()
    except Exception:  # noqa: BLE001
        logger.warning("登录日志取不到数据库连接，本次不记 / login event skipped: no bind", exc_info=True)
        return
    background.add_task(_record_login_event, bind, user_id, method, new_source)


def _record_login_event(bind, user_id: str, method: str, new_source: bool | None) -> None:
    """后台任务：过了每小时上限才写那一行（activity_log.record_after_commit，自己一个短事务）。
    两个调用都自己吞异常，外面这层 try 是兜底——后台任务抛出来会在服务端日志里刷一条 ERROR。
    Background task: write the row if the hourly quota allows it, via
    record_after_commit's own short transaction. Both calls swallow their errors;
    the outer try is a backstop, since an exception escaping a background task
    logs an ERROR server-side."""
    try:
        if not activity_log.login_event_allowed(user_id):
            return
        activity_log.record_after_commit(
            activity_log.USER_LOGIN,
            user_id=user_id,
            actor_type=activity_log.ACTOR_USER,
            actor_id=user_id,
            data={"method": method, "new_source": new_source},
            bind=bind,
        )
    except Exception:  # noqa: BLE001
        logger.warning("登录日志写入失败，已跳过 / login event failed", exc_info=True)


def _user_out(user: User, db: Session | None = None) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        role=user.role,
        plan=user.plan,
        phone=user.phone,
        # 必填标记为真、且还没填 —— 两个条件都要，否则已经填过的用户
        # 每次登录都会被再拦一次。
        # Both conditions: required *and* still missing, or users who
        # already filled it in would be gated again on every login.
        needsPhone=bool(user.phone_required) and not user.phone,
        needsNickname=not (user.nickname or "").strip(),
        emailVerified=user.email_verified_at is not None,
        # 要 db 才查；不带 db 的旧调用拿到 null。/ Needs db; legacy callers get null.
        pendingCompetition=pending_competition(db, user) if db is not None else None,
    )


@router.post("/register", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_REGISTER)
def register(
    request: Request,
    req: RegisterRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """注册新用户，并发一封邮箱验证信 / Register a new user and send the
    verification email."""
    email = req.email.lower()

    # 先校验手机号再查邮箱：号码不合法是用户当场能改的输入错误，应该明确
    # 告诉他哪里不对。放在邮箱重复检查之后的话，一个手机号填错的新用户会
    # 先撞上那句为防邮箱枚举而刻意含糊的「无法完成注册」，完全无从下手。
    # Validate the phone first: a malformed number is a fixable input error and
    # deserves a specific message. Checked after the email-exists branch, a user
    # with a typo'd number would instead hit the deliberately vague
    # "unable to register" (worded that way to prevent email enumeration) and
    # have no idea what to correct.
    phone = compose_phone(req.phoneCountry, req.phone)
    if not phone:
        raise HTTPException(
            status_code=422,
            detail="手机号格式不正确，请检查区号与号码 / Invalid phone number — check the dial code and number",
        )
    # 一次性邮箱（temp mail）拦在这里，和上面手机号校验同一个道理：这是用户
    # 当场能改的输入问题，得给一句说得明白的话。放到下面邮箱重复检查之后的话，
    # 用一次性邮箱的人会先撞上那句为防枚举而刻意含糊的「无法完成注册」，完全
    # 不知道该换个邮箱。
    #
    # 只拦新注册，存量用户一个不动——他们不再走这个接口（登录不查），所以
    # "存量豁免"不需要任何标记列或迁移，是这条路径天然的结果。Google 登录那条
    # 路也不查：一次性邮箱域名本来就注册不出 Google 账号，那边多一道判定只会
    # 徒增误伤面。
    #
    # Disposable addresses are rejected here, for the same reason the phone check
    # sits above the duplicate-email lookup: it's a fixable input problem and
    # deserves a clear message, not the deliberately vague anti-enumeration one.
    # New registrations only — existing users never hit this endpoint again, so
    # grandfathering them needs no flag column and no migration. The Google path
    # is deliberately not gated: you can't create a Google account on a
    # disposable domain anyway, so a check there would only add false positives.
    if is_disposable_email(db, email):
        raise HTTPException(
            status_code=400,
            detail="请使用常用邮箱注册，暂不支持一次性邮箱 / Disposable email addresses aren't supported — please use a regular mailbox",
        )
    existing = db.query(User).filter(User.email == email).first()
    # 规范邮箱撞上已有账号（a.b@gmail.com ≈ ab+x@gmail.com）同样拒绝，并且回**同一句话**：
    # 别名注册不出第二个账号，也就白嫖不到第二次试用（见 email_domains.canonical_email）。
    # 这条路本身由 RATE_LIMIT_REGISTER 按 IP 限流——「已注册」的回答是产品要的，但不能
    # 被当成不限次的枚举器。
    # A canonical-email collision (a.b@gmail.com ≈ ab+x@gmail.com) is refused with
    # the SAME message, so aliases can't open a second account (or a second trial).
    # The endpoint is IP-rate-limited by RATE_LIMIT_REGISTER, so this answer can't
    # be farmed as an unlimited enumeration oracle.
    if existing or canonical_email_taken(db, email):
        # 统一非区分性错误，避免邮箱枚举 / generic error to avoid email enumeration
        raise HTTPException(status_code=400, detail="无法完成注册 / Unable to register")

    user = User(
        email=email,
        phone=phone,
        password_hash=hash_password(req.password),
        # 只存哈希；用户首次连接 MT5 时在绑定页生成可见 token / store the hash
        # only; the user generates a visible token on the Bind page
        api_token=hash_api_token(generate_api_token()),
    )
    # 邀请链接归因：只对新建用户生效，乱填/停用的 ref 静默忽略。**这里只归因、
    # 不发试用**：邮箱还没验证，链接送的 PRO 试用等用户点了验证链接再补发（见
    # invite.grant_deferred_invite_trial）——否则随手填个不存在的邮箱就能白领试用。
    # Invite attribution only; bad/disabled refs are ignored. The link's PRO
    # trial is held back until the address is verified (see
    # invite.grant_deferred_invite_trial) — otherwise any made-up address would
    # collect a free trial.
    # 新前端上报最近几个 ref（refs），老 App 包只有 ref；pick_ref 按「30 天内代理
    # 优先」选一个，选了谁不回传。/ New clients send recent refs, old app builds
    # only `ref`; pick_ref applies agent-first and the choice is never echoed.
    apply_invite(db, user, pick_ref(db, req.refs or ([req.ref] if req.ref else [])), grant_trial=False)
    db.add(user)
    # flush 拿到 user.id 再签验证令牌（令牌行有指向 users.id 的外键）；仍是同一次
    # commit。/ Flush for user.id before issuing the token (FK); same commit.
    db.flush()
    raw = email_verification.issue_token(db, user)
    # 注册那封也计入每小时上限，免得注册完立刻连点「重新发送」多出一封。
    # The sign-up mail counts toward the hourly cap too.
    email_verification.too_many_recent_sends(user.id)
    db.commit()
    db.refresh(user)
    # 后台发信：发信商往返几百毫秒，不该让注册按钮转着等；发失败也只是"没收到"，
    # 用户登录后能在提示条里重新发送。明文令牌只交给发信函数。
    # Sent in the background so the sign-up button doesn't wait on the provider;
    # a failure only means "no mail yet" and the banner offers a resend.
    background.add_task(email_verification.send_verification_email, user.email, raw)

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user, db))


@router.post("/google", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_GOOGLE)
def google_login(
    request: Request,
    req: GoogleAuthRequest,
    # 默认 None 只为直接调用路由函数的测试 / 脚本；FastAPI 照样注入（按类型认）。
    # The None default only serves direct calls; FastAPI injects it by type.
    background: BackgroundTasks = None,
    db: Session = Depends(get_db),
):
    """Google 登录：校验 ID Token，按邮箱找到或创建用户后签发 JWT。
    Google sign-in: verify ID token, find-or-create user by email, then issue a JWT.
    """
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google 登录未启用 / Google login is not enabled")

    info = verify_google_id_token(req.credential)
    if not info:
        raise HTTPException(status_code=401, detail="Google 凭证无效 / Invalid Google credential")

    email = info["email"].lower()
    user = db.query(User).filter(User.email == email).first()
    # 这次是不是新建的账号：新建 = 注册（操作日志从 users.created_at 读出「注册」），不再
    # 另记一条「登录」，否则每个 Google 新用户在页面上都是「注册 + 登录」两行。
    # Whether this call created the account: a sign-up is read from users.created_at
    # by the activity log, so it is not also logged as a login (two lines per new
    # Google user otherwise).
    created = user is None
    if user is None:
        # 首次用 Google 登录：创建无密码用户，同时记下这个邮箱的 Google 身份
        # 已在此刻验证过——后面即便这个用户自己在账户设置里加了密码，这个
        # 时间戳也不会被清空，Google 登录会一直放行（见下面 elif 分支与
        # User.google_linked_at 的说明）。
        # First-time Google login: create a password-less user, and record
        # that this email's Google identity is verified as of right now — even
        # if the user later adds a password from their own account settings,
        # this timestamp is never cleared, so Google login keeps working (see
        # the elif branch below and User.google_linked_at's comment).
        user = User(
            email=email,
            password_hash=None,
            api_token=hash_api_token(generate_api_token()),
            google_linked_at=datetime.now(timezone.utc),
            # Google 已经替我们验证过这个邮箱 / Google already verified the address
            email_verified_at=datetime.now(timezone.utc),
        )
        # 邀请链接归因：仅创建分支。对已存在用户应用会覆盖管理员手写备注、
        # 伪造注册来源——老用户带着 localStorage 里的 ref 来登录是常态。
        # Invite attribution on the create branch ONLY. Applying it to an
        # existing user would clobber the admin's note and fabricate
        # attribution — returning users often still carry a stored ref.
        granted_days = apply_invite(db, user, pick_ref(db, req.refs or ([req.ref] if req.ref else [])))
        db.add(user)
        if granted_days:
            # 这个 flush 不是多余的：User.id 是 flush 时才生成的 Python 侧默认值，
            # 而 AdminAuditLog.target_user_id 是指向 users.id 的 NOT NULL 外键——
            # 提前拿会写出 null 外键，Postgres 上违约、整个注册 500。flush 不结束
            # 事务，下面仍是同一次 commit。别看它紧挨着 commit() 就当成重复删掉。
            # This flush is load-bearing: User.id is a Python-side default only
            # generated at flush, and target_user_id is a NOT NULL FK to users.id
            # — taken early it is null and violates the constraint on Postgres,
            # 500ing the whole registration. flush doesn't end the transaction;
            # the commit below is still the same one. Don't read it as redundant
            # with the commit() two lines down and delete it.
            db.flush()
            db.add(AdminAuditLog(
                admin_user_id=user.id,
                target_user_id=user.id,
                field="plan:invite_trial",
                old_value="FREE",
                new_value=f"PRO({granted_days}d)",
            ))
        db.commit()
        db.refresh(user)
    elif user.password_hash is not None and user.google_linked_at is None:
        # 有密码、且这个邮箱的 Google 身份从未验证过：不能自动登入，否则任何
        # 人都可以提前用受害者邮箱注册密码账号，等受害者第一次用 Google 登录
        # 时被悄悄接入攻击者控制的账号（账号预劫持）。
        #
        # 只看"是否有密码"不够——账号本来就是靠 Google 登录创建的用户，后来
        # 自己在账户设置里加了一个密码（见 account.py 的 change_password），
        # 这个邮箱其实早就验证过，此时 google_linked_at 非空，不会走进这个
        # 分支，Google 登录照常放行。两种"有密码"的账号表面相同、实质不同，
        # 靠这个字段才分得清（详见 User 模型该列的说明）。
        #
        # This email has a password AND this email's Google identity has never
        # been verified: refuse to auto sign-in here. Otherwise an attacker
        # could pre-register the victim's email with a password of their own
        # choosing, then silently take over the account the moment the real
        # owner first tries Google sign-in (a classic account pre-hijack).
        #
        # "Has a password" alone isn't enough to decide this — an account that
        # originated from Google login and later had a password added by its
        # own owner (see account.py's change_password) has google_linked_at
        # already set, so it never reaches this branch and Google login keeps
        # working normally. The two "has a password" cases look identical but
        # aren't; this field is what tells them apart (see the column's
        # comment on the User model).
        raise HTTPException(
            status_code=409,
            detail=(
                "该邮箱已注册密码账号，请使用密码登录 / "
                "This email already has a password-protected account. Please log in with your password."
            ),
        )

    if not created:
        # Google 这条路不维护「常用来源」名单（那是密码登录的锁定用的），说不出是不是新
        # 来源，new_source 记 None 而不是猜一个 False。
        # The Google path keeps no familiar-source list (that serves the password
        # lockout), so new_source is None — unknown — rather than a guessed False.
        _queue_login_event(background, db, user.id, "google", None)
    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user, db))


@router.post("/login", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_LOGIN)
def login(
    request: Request,
    req: AuthRequest,
    # 默认 None 的理由同 google_login / None default for direct calls, as in google_login
    background: BackgroundTasks = None,
    db: Session = Depends(get_db),
):
    """用户登录 / User login."""
    email = req.email.lower()
    # 锁定按「账号 + 来源」算，不是只按账号——只按账号的话，知道你邮箱的人从他
    # 自己的网络连错几次就能把你锁在门外（完整取舍见 core/rate_limit.py 的说明）。
    # Lockout is keyed by (account, source), not by account alone: keyed by
    # account, anyone who knows your address can lock you out from their own
    # network. Full rationale in core/rate_limit.py.
    source = login_source(request)
    if is_login_locked(email, source):
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试 / Too many login attempts, please try again later")

    user = db.query(User).filter(User.email == email).first()
    if user is None or not user.password_hash:
        # 没这个人 / 没密码：对着假哈希白跑一次 bcrypt，让耗时与「密码错」一致。
        # No such user / no password: burn one bcrypt on the dummy hash so the
        # timing matches a wrong password.
        verify_password(req.password, _DUMMY_PASSWORD_HASH)
        ok = False
    else:
        ok = verify_password(req.password, user.password_hash)
    if not ok:
        record_failed_login(email, source)
        raise HTTPException(status_code=401, detail="邮箱或密码错误 / Invalid email or password")

    clear_failed_logins(email, source)
    # 登录成功即认下这个来源：之后本人从这里再登录，走的是宽松得多的那条阈值，
    # 攻击者从别处怎么试都动不到它。/ A successful login marks this source as
    # familiar, so the owner's later attempts from here ride the loose threshold
    # and nothing an attacker does elsewhere can touch it.
    new_source = remember_login_source(email, source)
    # 操作日志：响应发出之后才写，这次请求本身不多一条语句（见 _queue_login_event）。
    # Activity log, written after the response; this request gains no statement.
    _queue_login_event(background, db, user.id, "password", new_source)
    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user, db))


# ---------- 找回密码 / password reset ----------

# 无论邮箱存不存在都返回这一句。措辞刻意说"如果这个邮箱已注册"——既不确认也不
# 否认，用户看得懂该去收信，攻击者读不出这个邮箱在不在库里。
# Returned regardless of whether the address exists. The wording confirms
# nothing either way while still telling a real user to go check their inbox.
_FORGOT_REPLY = (
    "如果这个邮箱已注册，我们已经把重置链接发过去了，请查收（含垃圾邮件箱）。 / "
    "If that email is registered, we've sent a reset link — check your inbox and spam folder."
)


@router.post("/forgot-password", response_model=MessageOut)
@limiter.limit(settings.RATE_LIMIT_PASSWORD_RESET)
def forgot_password(
    request: Request,
    req: ForgotPasswordRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """申请重置密码链接。

    **永远返回同一句话、同一个状态码**，不论这个邮箱在不在库里——否则这个匿名
    端点就成了一个免费的"这个邮箱是不是你们用户"查询器。注册那边也是同一口径
    （见 register() 里那句刻意含糊的「无法完成注册」）。

    发信放进 BackgroundTasks，不是为了快，是为了**让两种情况的响应时间一样**。
    同步发信的话，邮箱存在时要等发信商往返几百毫秒、不存在时立刻返回——响应体
    再怎么一致，这个时间差本身就把答案说出去了。

    没有密码的 Google 用户照样能走这条路，走完等于给账号设置了一个密码。挡住
    他们没有意义：能收这个邮箱的人本来就能用它登录 Google，挡住只是让真用户在
    "Google 登不上了"的时候彻底没有退路。

    Always the same body and status, whatever the address — otherwise this
    anonymous endpoint answers "is this person a user of yours". The send runs in
    a background task so both cases take the same wall-clock time: a synchronous
    send would leak the answer through latency no matter how identical the body
    is. Google-only accounts are deliberately eligible; whoever receives that
    mailbox could sign in with Google anyway, so refusing them only removes the
    fallback for a real user locked out of Google.
    """
    email = req.email.lower()
    # 按邮箱的频次上限（见 password_reset.too_many_recent_requests）。上面那个
    # 装饰器是按 IP 的，换 IP 就绕过去了，对"持续骚扰某一个邮箱"完全无效。
    #
    # **超限也返回同一句话、同一个状态码**，不能回 429：这个端点的全部安全性建立
    # 在"响应不随邮箱是否存在而变"上，而一旦超限回 429、未超限回 200，攻击者只要
    # 对一个邮箱连发四次就能从状态码差异里读出计数在不在动——那正好又是一个存在性
    # 探针（计数只对存在的邮箱递增就更糟，所以计数对谁都递增，见下面的位置）。
    # 计数放在查库**之前**，正是为了让不存在的邮箱与存在的邮箱走完全相同的路径。
    #
    # Per-email cap; the decorator above is per IP and a rotated IP walks around
    # it. Over-limit deliberately returns the same body and status as a normal
    # request rather than a 429: this endpoint's entire safety rests on the
    # response not varying with the address, and a distinguishable 429 would hand
    # back an existence oracle through the counter's behaviour. The count is
    # taken before the lookup so both cases take the identical path.
    over_limit = too_many_recent_requests(email)
    if not over_limit:
        # 查库、签令牌、提交、发信、记操作日志**全部**挪进后台任务（响应发出之后才跑）：
        # 请求本身对存在 / 不存在的邮箱执行完全相同的语句（一条都没有），耗时不再带出
        # 答案。以前查库 + DELETE/INSERT + commit 留在请求里，存在的那一支多好几次数据库
        # 往返，响应时间本身就是一个存在性探针。只取请求会话绑的引擎（理由同
        # _queue_login_event）。
        # Lookup, token issue, commit, mail and activity row all run in the
        # background task after the response, so the request itself does exactly
        # the same (no) DB work for known and unknown addresses. The lookup and the
        # DELETE/INSERT/commit used to sit in the request, giving the known branch
        # several extra round trips — a latency oracle. Only the session's engine
        # is captured (see _queue_login_event).
        try:
            bind = db.get_bind()
        except Exception:  # noqa: BLE001
            logger.warning("找回密码取不到数据库连接 / forgot-password: no bind", exc_info=True)
            bind = None
        if bind is not None:
            background.add_task(
                _process_forgot_request, bind, email,
                request.client.host if request.client else None,
            )
    return MessageOut(message=_FORGOT_REPLY)


def _process_forgot_request(bind, email: str, requested_ip: str | None) -> None:
    """后台任务：查这个邮箱 → 签令牌并提交 → 发信 → 记 user.password_reset_requested。

    自己开一个短会话（请求会话此时可能已关）。邮箱不存在就什么都不做。每一步都自己吞
    异常——后台任务抛出来只会在服务端日志里刷一条 ERROR，用户那边早就拿到了统一回复。
    send_reset_email 按本模块的名字取（测试会替换它）。
    Background task: look the address up, issue + commit a token, send the mail,
    then log user.password_reset_requested. Uses its own short session (the
    request's may be closed by now); an unknown address does nothing. Errors are
    swallowed — the caller already got the uniform reply."""
    try:
        with Session(bind=bind) as db:
            user = db.query(User).filter(User.email == email).first()
            if user is None:
                return
            user_id, to_email = user.id, user.email
            raw = issue_token(db, user, requested_ip=requested_ip)
            db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("找回密码签发令牌失败 / forgot-password token issue failed", exc_info=True)
        return
    # 明文令牌只传给发信函数，不进日志。/ The plaintext only goes to the mailer.
    try:
        send_reset_email(to_email, raw)
    except Exception:  # noqa: BLE001
        logger.warning("找回密码发信失败 / forgot-password mail failed", exc_info=True)
    _record_reset_requested(bind, user_id)


def _record_reset_requested(bind, user_id: str) -> None:
    """后台任务：record_after_commit 自己一个短事务写那一行。actor_type 要显式给 user——
    record_after_commit 默认是 system。外面这层 try 是兜底（它本身不抛）。
    Background task: one row in record_after_commit's own short transaction.
    actor_type must be passed as user (record_after_commit defaults to system); the
    outer try is a backstop, it never raises itself."""
    try:
        activity_log.record_after_commit(
            activity_log.USER_PASSWORD_RESET_REQUESTED,
            user_id=user_id,
            actor_type=activity_log.ACTOR_USER,
            actor_id=user_id,
            bind=bind,
        )
    except Exception:  # noqa: BLE001
        logger.warning("找回密码日志写入失败，已跳过 / reset-request event failed", exc_info=True)


@router.post("/reset-password", response_model=MessageOut)
@limiter.limit(settings.RATE_LIMIT_PASSWORD_RESET)
def reset_password(request: Request, req: ResetPasswordRequest, db: Session = Depends(get_db)):
    """用邮件里的令牌设置新密码。

    **不自动登录。** 改完让用户自己去登录页用新密码登一次——邮件链接是会被转发、
    被留在浏览器历史、被公司邮件网关预抓取的东西，凭它直接签发一个会话等于把
    "点开链接"和"拿到账号"划等号。多登一次的代价很小。

    改完把 token_version 加一，与 account.py 的 change_password 同一处理：申请
    找回密码的场景里，"别人可能正拿着我的旧 token"是主要担心的事之一，只改密码
    不动版本号的话那些会话会继续有效。

    顺手清掉这个邮箱在**当前来源**上的登录失败计数：被锁了几分钟的人来重置密码，
    改完还登不进去会以为没改成功。

    Deliberately does not sign the user in: reset links get forwarded, sit in
    browser history, and are pre-fetched by corporate mail gateways, so turning
    one into a live session equates "opened the link" with "owns the account".
    Bumps token_version exactly like change_password — in a reset flow "someone
    may be holding my old token" is one of the main worries, and changing the
    password alone would leave those sessions live. Also clears the failed-login
    lockout, or someone who reset *because* they were locked out still can't log in.
    """
    user = consume_token(db, req.token)
    if user is None:
        # 不区分"没见过这个令牌""已经用过""过期了"——三种情况对合法用户的下一步
        # 完全一样（重新申请一封），而区分开来只会告诉攻击者他猜的令牌存不存在。
        raise HTTPException(
            status_code=400,
            detail="链接无效或已过期，请重新申请 / This link is invalid or has expired — please request a new one",
        )

    user.password_hash = hash_password(req.password)
    user.token_version = (user.token_version or 0) + 1
    # 桥接 API Token 一起换掉（同 /ea/token/reset）：找回密码的前提是「账号可能被人拿着」，
    # 只废 JWT 不换 Token，拿着 Token 的人照样能经 Bridge 下单。新 Token 用户之后到绑定页
    # 重新生成。旧哈希在 commit 之后清出桥接鉴权缓存。
    # Rotate the bridge API token too (as /ea/token/reset does): a reset assumes
    # someone else may hold the account, and the token is a second key that can
    # trade. The user generates a new one from the Bind page; the old hash is
    # dropped from the bridge auth cache after the commit.
    old_api_hash = rotate_api_token(user)
    # 操作日志，随下面这次 commit 一起提交；令牌无效的那一支（上面 400）不记。
    # Activity row, committed below; the invalid-token branch (400 above) logs nothing.
    activity_log.log_event(db, activity_log.USER_PASSWORD_RESET, user_id=user.id, actor_id=user.id)
    # 用重置邮件里的链接改了密码，等于证明了这个邮箱归他——顺手算作验证通过，
    # 省得他再去点一封验证信。/ Completing a reset proves mailbox ownership, so
    # it counts as verification too. method='reset' 让它在操作日志里记成「重置密码时
    # 顺带验证」；本来已验证的不会再记（mark_verified 早返回）。/ Logged as verified
    # via reset; an already-verified account logs nothing (early return).
    email_verification.mark_verified(db, user, method=email_verification.METHOD_RESET)
    db.commit()
    invalidate_bridge_token_cache(old_api_hash)
    # 只清「这个账号 + 发起重置的这个来源」那一条计数：锁定本来就是按来源分开算
    # 的，被锁住的正是用户此刻所在的这个来源（他就是在这里试错才被锁的），清它
    # 就够。从别的网络重置则不影响那边——那边也没有人被锁。
    # Clears the counter for this account *on the source doing the reset*: the
    # lockout is per source to begin with, and the locked one is the source the
    # user is sitting on right now (it is where they mistyped). A reset from
    # another network leaves that network alone, where nothing is locked either.
    clear_failed_logins(user.email, login_source(request))
    return MessageOut(message="密码已重置，请用新密码登录 / Password updated — please sign in with it")


# ---------- 邮箱验证 / email verification ----------


@router.post("/verify-email", response_model=MessageOut)
@limiter.limit(settings.RATE_LIMIT_VERIFY_EMAIL)
def verify_email(request: Request, req: VerifyEmailRequest, db: Session = Depends(get_db)):
    """点验证邮件里的链接。不要求登录、也不登录——理由同 reset_password：链接会
    被转发、被邮件网关预抓取，凭它签发会话等于「点开链接」=「拿到账号」。

    幂等：同一个链接点两次都返回成功（见 email_verification.consume_token）。
    Clicking the verification link. Neither requires nor creates a session, for
    the same reason as reset_password. Idempotent.
    """
    user = email_verification.consume_token(db, req.token)
    if user is None:
        raise HTTPException(
            status_code=400,
            detail="验证链接无效或已过期，请登录后重新发送 / This verification link is invalid or has expired — sign in and resend it",
        )
    db.commit()
    return MessageOut(message="邮箱已验证 / Email verified")


@router.post("/verify-email/resend", response_model=MessageOut)
@limiter.limit(settings.RATE_LIMIT_PASSWORD_RESET)
def resend_verification(
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """重新发送验证邮件（需登录，只发给自己的注册邮箱）。

    与找回密码不同，这里是登录态、收件人就是调用者自己，不存在邮箱枚举问题，所以
    超限可以明确回 429 告诉用户等一等。
    Resend the verification mail to the caller's own address. Unlike the reset
    endpoint this is authenticated and self-addressed, so there is no
    enumeration concern and over-limit can honestly answer 429.
    """
    if user.email_verified_at is not None:
        return MessageOut(message="邮箱已验证 / Email already verified")
    if email_verification.too_many_recent_sends(user.id):
        raise HTTPException(
            status_code=429,
            detail="发送太频繁了，请稍后再试（也看看垃圾邮件箱） / Too many emails sent — try again later (and check your spam folder)",
        )
    raw = email_verification.issue_token(db, user)
    db.commit()
    background.add_task(email_verification.send_verification_email, user.email, raw)
    return MessageOut(message="验证邮件已发送 / Verification email sent")
