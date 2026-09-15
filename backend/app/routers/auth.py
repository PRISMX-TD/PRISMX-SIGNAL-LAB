"""认证路由：注册与登录 / Auth router: register & login."""
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import clear_failed_logins, is_login_locked, limiter, record_failed_login
from app.core.security import (
    create_access_token,
    generate_api_token,
    hash_api_token,
    hash_password,
    verify_google_id_token,
    verify_password,
)
from app.models import AdminAuditLog, User
from app.routers.invite import apply_invite
from app.schemas import (
    AuthRequest,
    AuthResponse,
    ForgotPasswordRequest,
    GoogleAuthRequest,
    MessageOut,
    RegisterRequest,
    ResetPasswordRequest,
    UserOut,
)
from app.services.email_domains import is_disposable_email
from app.services.password_reset import consume_token, issue_token, send_reset_email
from app.services.phone import compose_phone

router = APIRouter(prefix="/auth", tags=["auth"])


def _user_out(user: User) -> UserOut:
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
    )


@router.post("/register", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_REGISTER)
def register(request: Request, req: RegisterRequest, db: Session = Depends(get_db)):
    """注册新用户 / Register a new user."""
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
    if existing:
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
    # 邀请链接归因：只对新建用户生效，乱填/停用的 ref 静默忽略。链接开了「送
    # 试用」且全局试用总闸也开着时，apply_invite 会顺手把 PRO 试用发掉并返回
    # 天数（见 invite.py 的 _trial_grant_days）。
    # Invite attribution: new users only; bad/disabled refs are ignored. When
    # the link grants a trial and the global gate is open, apply_invite also
    # grants PRO and returns the day count.
    granted_days = apply_invite(db, user, req.ref)
    db.add(user)
    if granted_days:
        # 必须先 flush：User.id 是 flush 时才生成的 Python 侧默认值，而
        # AdminAuditLog.target_user_id 是指向 users.id 的 NOT NULL 外键——在
        # flush 之前拿 user.id 会写出一条 null 外键，Postgres 上直接违约、注册
        # 请求 500。flush 不结束事务，下面仍是同一次 commit。
        # Flush first: User.id is a Python-side default generated at flush, and
        # target_user_id is a NOT NULL FK to users.id — taken any earlier it is
        # null, which violates the constraint on Postgres and 500s the whole
        # registration. flush does not end the transaction; the commit below is
        # still the same one.
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

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))


@router.post("/google", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_GOOGLE)
def google_login(request: Request, req: GoogleAuthRequest, db: Session = Depends(get_db)):
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
        )
        # 邀请链接归因：仅创建分支。对已存在用户应用会覆盖管理员手写备注、
        # 伪造注册来源——老用户带着 localStorage 里的 ref 来登录是常态。
        # Invite attribution on the create branch ONLY. Applying it to an
        # existing user would clobber the admin's note and fabricate
        # attribution — returning users often still carry a stored ref.
        granted_days = apply_invite(db, user, req.ref)
        db.add(user)
        if granted_days:
            # 这个 flush 不是多余的：道理和上面 register() 里那段完整注释一样——
            # User.id 要 flush 才生成，AdminAuditLog.target_user_id 是 NOT NULL
            # 外键，提前拿会写出 null 外键，Postgres 上违约、整个注册 500。别看
            # 它紧挨着下面的 commit() 就当成重复删掉。
            # This flush is load-bearing for the same reason as the full comment
            # in register() above: User.id is only generated at flush, and
            # target_user_id is a NOT NULL FK — taken early it is null and
            # violates the constraint on Postgres, 500ing the whole registration.
            # Don't read it as redundant with the commit() two lines down and
            # delete it.
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

    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))


@router.post("/login", response_model=AuthResponse)
@limiter.limit(settings.RATE_LIMIT_LOGIN)
def login(request: Request, req: AuthRequest, db: Session = Depends(get_db)):
    """用户登录 / User login."""
    email = req.email.lower()
    if is_login_locked(email):
        # 单个账号在短时间内失败次数过多：即使攻击者轮换 IP 绕过按 IP 限流，
        # 也无法继续对这一个账号撞库。
        # Too many failed attempts for this one account recently: blocks
        # credential-stuffing against a single account even if the attacker
        # rotates IPs to dodge the per-IP limiter above.
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试 / Too many login attempts, please try again later")

    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(req.password, user.password_hash):
        record_failed_login(email)
        raise HTTPException(status_code=401, detail="邮箱或密码错误 / Invalid email or password")

    clear_failed_logins(email)
    token = create_access_token(user.id, user.token_version)
    return AuthResponse(token=token, user=_user_out(user))


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
    user = db.query(User).filter(User.email == email).first()
    if user is not None:
        raw = issue_token(db, user, requested_ip=request.client.host if request.client else None)
        db.commit()
        # 明文令牌只传给发信函数，不进日志、不进响应。
        background.add_task(send_reset_email, user.email, raw)
    return MessageOut(message=_FORGOT_REPLY)


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

    顺手清掉这个邮箱的登录失败计数：被撞库锁了 15 分钟的人来重置密码，改完还
    登不进去会以为没改成功。

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
    db.commit()
    clear_failed_logins(user.email)
    return MessageOut(message="密码已重置，请用新密码登录 / Password updated — please sign in with it")
