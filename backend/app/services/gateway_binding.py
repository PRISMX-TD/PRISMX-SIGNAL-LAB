"""Gateway 绑定的有效性：什么时候一次绑定的授权算作废，以及作废之后怎么表现。

**这个模块存在的原因。** Gateway 通道与 bridge 通道有一个根本差别：bridge 是用户
自己的电脑登录 MT5 后上报，凭证在用户手里；gateway 是本平台用 manager 身份直接
操作券商，用户的密码只在绑定那一刻校验一次（`UserPasswordCheck`），之后读持仓、
读资金、下单全部由 manager 代劳，**再也不经过用户密码**。

也就是说这条链路上没有任何会过期的凭证。用户改了主密码、账号转手给了别人、
密码被券商重置——平台侧一律零感知，那条旧绑定照样能代客下单。这不是「会话没
及时失效」，是链路上压根没有会话这回事。

**补法。** MT5 Manager API 的 `IMTUser::LastPassChange()` 给出券商记录的「上次
改密码时间」。绑定时把它记进 `mt5_accounts.pass_change_at`，之后每轮资金刷新
（15 秒）拿当前值来比：对不上，说明用户当初验证的那个密码已经不是账号现在的
密码，这次绑定的授权随之作废。

**为什么不是 `PasswordHash`，也不是密码变更事件。** 两条更精确的路都走不通，
测过文档：`IMTUser::PasswordHash` 从 Manager API 调用时永远返回空串（只在
Server API 可用）；`IMTUserSink::OnUserChangePassword` 带密码类型参数、能分清
主密码与投资者密码，但同样标注 "only used in the MetaTrader 5 Server API"，
那是要在券商服务器上装插件才有的东西。`LastPassChange` 是 Manager API 这一侧
唯一拿得到的信号，代价是它只有一个时间戳、分不清改的是哪一种密码。

**两条刻意的「不撤销」。** 读不到信号时一律放行，不撤销：
  1. 券商服务器不填 `LastPassChange`（返回 0）——这道闸在该券商上就是不生效；
  2. 本机制上线前就存在的绑定（`pass_change_at IS NULL`）——首次读到值时补记
     一个基线，此后的改动才会被撤销，不追溯。
两条都是同一个取舍：让闸门在拿不到证据时失效，好过因为读不到值把所有人踢下线。
第 1 条会在绑定时打一条 warning，免得这个能力静默缺失。

Whether a gateway binding is still authorised. Unlike the bridge channel, a
gateway bind checks the user's password exactly once and everything afterwards
runs through the manager — the link holds no expirable credential, so a changed
password, a transferred account or a broker-side reset all left the old binding
fully able to trade. `IMTUser::LastPassChange()` is the only revocation signal
reachable from the Manager API (`PasswordHash` returns an empty string there and
the password-change sink is Server-API only), so it is recorded at bind time and
compared on every funds refresh. Missing signals never revoke: see above.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import or_

from app.models import MT5Account

logger = logging.getLogger("prismx.gateway.binding")

# 撤销原因。存进 mt5_accounts.revoked_reason，前端据此选提示文案。
# Revocation reasons, stored in mt5_accounts.revoked_reason; the frontend picks
# its wording from this value.
REASON_PASSWORD_CHANGED = "password_changed"
# 用户自己在界面上"删除/解绑"了这个账号。**不是真删行**：orders / closed_trades
# 都按 (user, login) 关联，删了行历史战绩就失去归属，个人胜率与已平仓明细会
# 凭空消失，重绑才回来。行留着、打上这个标记：列表不显示、不能下单、不进
# 榜、不算账户数；桥接再次上报或 gateway 重新验证时自动复活。两条通道共用这
# 一个标记，bridge 行也会有 revoked_at，但 is_revoked() 对 bridge 仍恒 False
# ——"需重新验证"那套语义只属于 gateway，删除是另一件事。
# The user removed the account from the UI. Not a hard delete: orders and
# closed_trades are keyed by (user, login), so dropping the row orphans the
# history and the user's win rate silently vanishes until they re-bind. The row
# stays with this marker: hidden from lists, not orderable, not eligible for
# boards, not counted toward the plan limit; revived when the bridge reports it
# again or the gateway re-verifies. Shared by both channels — a bridge row gets
# revoked_at too, but is_revoked() stays False for bridge rows: the
# "re-verify" semantics belong to the gateway, removal is a different thing.
REASON_USER_REMOVED = "user_removed"


def is_removed(row) -> bool:
    """用户是否已在界面上删除/解绑了这个账号（软删）。"""
    return getattr(row, "revoked_reason", None) == REASON_USER_REMOVED


def not_removed():
    """SQLAlchemy 过滤条件：排除软删的行。查"当前有效账号"的地方都应带上它。
    Filter clause excluding soft-removed rows; every "current accounts" query takes it."""
    return or_(MT5Account.revoked_reason.is_(None),
               MT5Account.revoked_reason != REASON_USER_REMOVED)


def mark_removed(db, row) -> None:
    """软删：打标记、置离线，提交。"""
    row.revoked_at = datetime.now(timezone.utc)
    row.revoked_reason = REASON_USER_REMOVED
    row.online = False
    db.commit()


def restore_removed(row) -> bool:
    """账号重新出现（桥接再次上报 / gateway 重新验证）：清掉软删标记。
    返回是否真的复活了一行。不提交，由调用方与其它字段一起提交。"""
    if not is_removed(row):
        return False
    row.revoked_at = None
    row.revoked_reason = None
    return True


def is_revoked(row) -> bool:
    """这条绑定是否已被撤销。

    对 bridge 账号恒为 False：那条通道的凭证在用户自己手里，桥接程序登不上
    MT5 就没有心跳，账号自然掉线，不需要也不应该套用这套标记。
    Always False for bridge accounts: their credential lives on the user's own
    machine, so a changed password simply stops the heartbeat.
    """
    if getattr(row, "source", None) != "gateway":
        return False
    return getattr(row, "revoked_at", None) is not None


def password_changed(recorded: int | None, observed: int | None) -> bool:
    """券商侧的改密时间是否已经偏离绑定时记下的值。

    两侧任一为空（0 / None）都返回 False —— 那是「没有信号」，不是「时间为 0」。
    把 0 当成真实时间去比，结果是每个账号一绑上就被立刻撤销。

    用 `!=` 而不是 `>`：变小同样说明这不再是当初验证过的那条账号记录（券商回滚
    了备份、或这个 login 被重新分配给了别人），没有理由只认变大的方向。

    Whether the broker's password-change time has diverged from what was recorded
    at bind time. Either side being empty means "no signal", never "time zero".
    Compared with `!=` rather than `>`: a decrease equally means this is no longer
    the account record that was verified.
    """
    if not recorded or not observed:
        return False
    return int(observed) != int(recorded)


def revoke(db, row, reason: str) -> bool:
    """把一条绑定标记为已撤销并落库。已经是撤销状态时不重复写，返回 False。

    刻意**不删行**：订单与平仓明细都按 (user_id, login) 关联，删掉这行会让用户
    的历史战绩失去归属；而且重新验证是唯一的恢复路径，保留行才能让它就地复活。
    Deliberately keeps the row: orders and closed trades are keyed by
    (user_id, login), so deleting it would orphan the user's history, and
    re-verification revives this same row.
    """
    if row.revoked_at is not None:
        return False
    row.revoked_at = datetime.now(timezone.utc)
    row.revoked_reason = reason
    db.commit()
    logger.warning(
        "Gateway 绑定已撤销: user=%s login=%s reason=%s —— 该账号已停止下单与轮询，"
        "需用户重新验证主密码",
        row.user_id, row.login, reason,
    )
    return True


def enforce(db, row, observed: int | None, on_revoke=None) -> bool:
    """拿券商刚返回的改密时间校验一条绑定。返回「这条绑定还有效吗」。

    这是整套机制唯一的判定入口，轮询与手动刷新都走它。抽出来不是为了少写几行：
    两个调用点各写一遍的话，将来只改其中一处，就会出现「刷新能用、轮询会撤销」
    这种自相矛盾的状态，而且哪一边说了算取决于用户点没点刷新按钮。

    `on_revoke` 只在**这一次**真的完成撤销时才回调（重复撤销不回调），用来发
    通知——放在回调里而不是写死在这儿，是因为这个模块不该知道推送这回事。

    The single decision point for the whole mechanism; both the poller and the
    manual refresh call it. Extracted not to save lines but because two copies
    would eventually diverge into "refresh works, polling revokes", with the
    winner depending on whether the user clicked a button. `on_revoke` fires only
    on the transition, so a notification isn't repeated every tick.
    """
    if password_changed(row.pass_change_at, observed):
        if revoke(db, row, REASON_PASSWORD_CHANGED) and on_revoke is not None:
            on_revoke()
        return False
    record_baseline(db, row, observed or 0)
    return True


def record_baseline(db, row, observed: int) -> bool:
    """为还没有基线的绑定补记一次改密时间，之后的改动才会被撤销。返回是否写入。

    只在 `pass_change_at IS NULL` 时写。这些是本机制上线前绑好的行：它们的密码
    在没有任何校验的年代有没有被改过，我们无从得知，所以补记的这个值只是**从
    现在起**的基线，不代表「这条绑定的密码从没变过」。不做追溯，是因为追溯的
    唯一实现方式是把存量用户一次性全部踢下线，代价大于收益。

    Seed a baseline for bindings created before this mechanism existed, so that
    changes from now on are caught. Not retroactive: whether those passwords were
    already changed is unknowable, and the only way to be safe about it would be
    to revoke every existing binding at once.
    """
    if row.pass_change_at is not None or not observed:
        return False
    row.pass_change_at = int(observed)
    db.commit()
    logger.info(
        "Gateway 绑定补记改密时间基线: user=%s login=%s at=%s（此前的改动不追溯）",
        row.user_id, row.login, observed,
    )
    return True
