"""邀请链接的试用判定与邮箱验证后的补发试用。

原来写在 routers/invite.py，邮箱验证（services/email_verification）通过时要补发试用，只能反过来
import 路由层（2026-11-18 审计）。查链接、算天数、补发三件事搬到这里，routers/invite 用同名别名
继续调用，判定仍然只有一处。

Invite-link trial decisions and the trial granted once an email is verified. Moved out of
routers/invite.py so email verification no longer imports the router layer (2026-11-18
audit); the router keeps its old names as aliases, so there is still one decision point.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import AdminAuditLog, InviteLink, User
from app.services.email_domains import alias_trial_used
from app.services.plans import trial_grant_days

def normalize_code(code: str) -> str:
    """查库前统一去空白转小写。

    routers/invite 的 _CODE_ALPHABET 全小写，大写字母永远不可能是真码，所以这个归一是无损的。
    不做的话：二维码/短链/印刷物料链路上任何一段做过大小写归一（有的工具会），
    或者有人照着单子手抄时抄成大写，SQLite 与 Postgres 的比较都是大小写敏感的，
    于是一个字不差也查不到。而打点端一律 204、坏 ref 又从不拦注册，归因丢了
    没有任何一处会报警——只会表现为"这条链接的数据莫名其妙是零"。

    Normalize before lookup. routers/invite._CODE_ALPHABET is lowercase-only, so an uppercase
    character can never be part of a real code and folding case is lossless.
    Without it, a code that passed through any case-normalizing QR / short-link
    / print pipeline — or was retyped by hand — matches nothing, because the
    comparison is case-sensitive on both SQLite and Postgres. And since the
    click endpoint always returns 204 and a bad ref never blocks signup, the
    lost attribution raises no signal anywhere: it just looks like a link that
    inexplicably scored zero.
    """
    return code.strip().lower()


def active_link(db: Session, code: str) -> InviteLink | None:
    """按码查一条活跃链接；不存在或已停用返回 None。

    apply_invite 与 offer_days 共用本函数，保证两边看到的"这个码是否可用"
    永远是同一次查询逻辑，不会因为以后加过期时间、点击上限之类的条件时
    只改了一边而分叉。record_click 不用它——它是条件原子 UPDATE，不是读，
    这是故意的（见 record_click 自己的注释）。

    Shared active-link lookup for apply_invite and offer_days, so both sides
    agree on what "usable" means and can't silently diverge if a future
    condition (expiry, click cap) lands on only one of them. record_click does
    NOT use this — it is a conditional atomic UPDATE, not a read, deliberately
    (see record_click's own comment).
    """
    return (
        db.query(InviteLink)
        .filter(
            InviteLink.code == normalize_code(code),
            InviteLink.is_active.is_(True),
            # 软删会同时置 is_active=False；这里再挡一次，防止有人把停用开关拨回来。
            # Soft delete also clears is_active; filtered again in case it is flipped back.
            InviteLink.deleted_at.is_(None),
        )
        .first()
    )


def link_trial_days(db: Session, link: InviteLink) -> int | None:
    """这条链接此刻能发几天试用；不发返回 None。

    两个开关在这一处、也只在这一处合流：链接自己的 grants_trial，和全局的
    trial_enabled 总闸。发放路径（apply_invite）与公开查询端点（offer）共用本
    函数，因此落地页/注册页承诺的与后端实际发放的不可能分叉——这正是把判定
    抽出来而不是两边各写一遍的理由，别把它内联回去。

    天数取全局 trial_days：链接不单独配置天数（YAGNI，见设计文档第 8 节）。

    How many trial days this link grants right now, or None. The per-link
    switch and the global master gate meet here and nowhere else. The granting
    path and the public offer endpoint share this function, so what the landing
    and signup pages promise can never diverge from what the backend actually
    grants — that is the whole reason it is factored out; do not inline it.
    """
    if not bool(link.grants_trial):
        return None
    # 全局那一半（总闸 + 天数非正当成不发）在 services/plans.trial_grant_days，
    # 与「登录后自己领」那条路共用同一处判定——见那个函数的说明。本函数只再叠上
    # 链接自己的开关。
    # The global half (master switch + non-positive day count) lives in
    # services/plans.trial_grant_days, shared with the self-claim path; this
    # function only adds the per-link switch on top.
    return trial_grant_days(db)


def grant_deferred_invite_trial(db: Session, user: User) -> int | None:
    """邮箱验证通过时，补发注册那一刻因为「还没验证」而扣下的邀请试用。

    判定在**验证这一刻**重新做：链接得还是活跃的、还开着送试用、全局总闸也开着
    （_trial_grant_days，与注册当场发放同一处判定）。注册后链接被停用或关了送
    试用，那就不发——落地页承诺的是「此刻注册送」，不是一张永久兑换券。

    用条件原子 UPDATE 抢占资格（同 payments.claim_trial）：用户可能在两台设备上
    同时点开验证链接，也可能先自己去领了试用，两条路都不能发出第二份。只改库、
    写审计，不 commit——调用方（验证 / 重置密码）在同一个事务里提交。

    Grants the invite trial a password sign-up was denied at registration for
    being unverified. Re-evaluated now via _trial_grant_days, the same decision
    the at-signup grant uses: a link disabled or switched off since then grants
    nothing. A conditional atomic UPDATE (as in payments.claim_trial) keeps two
    simultaneous clicks, or a self-claim that got there first, from granting
    twice. Does not commit; the caller does, in the same transaction.
    """
    if not user.invite_code:
        return None
    link = active_link(db, user.invite_code)
    if link is None:
        return None
    days = link_trial_days(db, link)
    if days is None:
        return None
    # 试用每个收件箱一次（同 payments.claim_trial，见 email_domains.alias_trial_used）。
    # One trial per mailbox, as in payments.claim_trial.
    if alias_trial_used(db, user.email, exclude_user_id=user.id):
        return None
    now = datetime.now(timezone.utc)
    claimed = (
        db.query(User)
        .filter(User.id == user.id, User.trial_used_at.is_(None), User.plan == "FREE")
        .update(
            {
                "plan": "PRO",
                "plan_expires_at": now + timedelta(days=days),
                "trial_used_at": now,
                "plan_is_trial": True,
            },
            synchronize_session=False,
        )
    )
    if not claimed:
        return None
    db.add(AdminAuditLog(
        admin_user_id=user.id,
        target_user_id=user.id,
        field="plan:invite_trial",
        old_value="FREE",
        new_value=f"PRO({days}d)",
    ))
    return days
