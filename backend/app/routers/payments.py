"""NOWPayments 支付路由 / Payment API routes.

前端调用创建支付、查询状态、获取可用币种。
NOWPayments 的 IPN 回调也走这个路由（无需用户认证）。
"""

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import AdminAuditLog, Payment, User
from app.services.deps import get_current_user
from app.services.nowpayments import (
    create_payment as np_create,
    get_currencies as np_currencies,
    get_payment_status as np_status,
    verify_ipn_signature,
)
from app.core.config import settings
from app.services.notification_feed import create_notification, notify_ws
from app.services.plans import PLAN_DAYS, refund_revocation, trial_grant_days
from app.services.settings_store import get_pricing_settings, get_trial_settings

logger = logging.getLogger("prismx.payments")

router = APIRouter(prefix="/payments", tags=["payments"])

# ═══ 定价 / Pricing ═══
# PLAN_DAYS 搬去了 services/plans.py：代理端的「付费保护」也要按它算这笔钱买到的
# 窗口（routers/invite._has_live_paid_plan），而从 router import router 是
# services/pagination.py 顶部那段说明要消灭的东西。这里保留名字，调用点不动。
# PLAN_DAYS moved to services/plans.py — the agent-side paid guard needs it too,
# and importing it across routers is what services/pagination.py's note is about.

# 币种列表进程内缓存：这份列表几乎不变，之前每次调用都不带登录校验、也不
# 缓存地直接转发给 NOWPayments——任何人（不用登录）反复刷这个接口就能把
# 第三方调用成本转嫁到我们身上、拖慢真实用户的响应。加登录校验 + 短 TTL
# 缓存后，同一分钟内的重复请求都不再打到 NOWPayments。
# In-process cache for the currency list: it almost never changes, but this
# endpoint used to require no login and forward to NOWPayments on every call
# — anyone (no auth needed) could hammer it to run up our third-party call
# cost and slow down real users. Login + a short TTL cache mean repeated
# calls within the same window never reach NOWPayments again.
_CURRENCY_CACHE_TTL_SECONDS = 300
_currency_cache: tuple[float, list[str]] | None = None


def _resolve_pricing(db: Session) -> dict:
    """读取数据库定价（带缓存），计算实际支付价格（含促销折扣）。

    Read DB pricing (cached), compute actual pay price including active sale.
    返回 / returns: { monthly: float, yearly: float, sale: dict | None }
    """
    p = get_pricing_settings(db)
    monthly = float(p["pro_monthly_price"])
    yearly = float(p["pro_yearly_price"])
    sale = None
    if p.get("sale_enabled") and p.get("sale_percent", 0) > 0:
        pct = int(p["sale_percent"])
        sale = {
            "percent": pct,
            "badge": str(p.get("sale_badge", "")),
            "end_at": str(p.get("sale_end_at") or ""),
            "monthly": round(monthly * (1 - pct / 100), 2),
            "yearly": round(yearly * (1 - pct / 100), 2),
        }
    return {"monthly": monthly, "yearly": yearly, "sale": sale}


# ═══ 请求体 / Request schemas ═══
class CreatePaymentRequest(BaseModel):
    # plan 用 Literal 而不是 str：值域本来就只有两个，写进类型里让 FastAPI 在解析
    # 阶段就挡掉别的值（顺带出现在 OpenAPI 里），下面 `body.plan not in PLAN_DAYS`
    # 那道判断照旧留着——它防的是 PLAN_DAYS 与这里将来不同步。
    # Literal rather than str: the value set is two items, so FastAPI rejects
    # anything else before the handler runs. The PLAN_DAYS check below stays as a
    # guard against the two drifting apart.
    plan: Literal["pro_monthly", "pro_yearly"]
    # 长度必须卡住：这个字符串会原样进入发给 NOWPayments 的请求体，并原样写进
    # payments.pay_currency 列。真实币种代码不超过十几个字符，没有上限等于允许
    # 把任意长的串转发给第三方、并落进一张会长期保留的表。
    # The cap is load-bearing: this string is forwarded verbatim to NOWPayments
    # and stored verbatim in payments.pay_currency. Real ticker codes are a dozen
    # characters at most; without a bound this relays arbitrary-length strings to
    # a third party and persists them in a table we keep forever.
    pay_currency: str = Field(min_length=1, max_length=32)  # e.g. usdttrc20


# ═══ 端点 / Endpoints ═══

@router.get("/plans")
def get_plans(db: Session = Depends(get_db)):
    """返回所有可用套餐与价格（含促销折扣）/ List available plans with prices & active sale."""
    pricing = _resolve_pricing(db)
    sale = pricing["sale"]
    monthly = sale["monthly"] if sale else pricing["monthly"]
    yearly = sale["yearly"] if sale else pricing["yearly"]
    monthly_original = pricing["monthly"]
    yearly_original = pricing["yearly"]

    # 年付省多少由**当前定价**算出来，不写死。以前这里是 `"save_20"` 字面量：
    # 管理员把年付调成不便宜（甚至比月付 ×12 更贵，put_pricing 刻意允许这件事）
    # 之后，前端仍然照着标签说"省 20%"——一个由后台设置就能造出来的虚假宣传。
    # 不省钱时不给标签，让前端什么都不显示，而不是显示一个"省 0%"。
    # The yearly saving is computed from live pricing rather than hard-coded. It
    # used to be the literal "save_20", so an admin making the yearly plan no
    # cheaper (or dearer — put_pricing deliberately allows that) left the
    # frontend advertising a 20% saving that didn't exist. No saving, no tag.
    yearly_tag = None
    if not sale and monthly > 0 and yearly < monthly * 12:
        saved_percent = int(round((1 - yearly / (monthly * 12)) * 100))
        if saved_percent > 0:
            yearly_tag = f"save_{saved_percent}"

    plans = [
        {
            "id": "pro_monthly",
            "name": "PRO Monthly",
            "price_usd": monthly,
            "original_price_usd": monthly_original if sale else None,
            "days": 30,
        },
        {
            "id": "pro_yearly",
            "name": "PRO Yearly",
            "price_usd": yearly,
            "original_price_usd": yearly_original if sale else None,
            "days": 365,
            "tag": yearly_tag,
        },
    ]
    # 公开试用信息：只有「开关 + 天数」两个营销事实，不含任何用户数据。
    # 落地页（未登录）靠它决定要不要亮出试用标识；资格判定（是否用过、当前
    # 等级）仍归上面需要登录的 /trial 与 /trial/claim。不新开端点：落地页的
    # 定价区本来就在调这个接口取价格。
    # Public trial facts: just the switch and the day count, no user data. The
    # logged-out landing page uses this to decide whether to show the trial
    # highlight; eligibility stays with the authenticated /trial endpoints.
    trial = get_trial_settings(db)
    return {
        "plans": plans,
        "sale": sale,
        "trial": {"enabled": bool(trial["trial_enabled"]), "days": int(trial["trial_days"])},
    }


@router.get("/currencies")
async def get_payment_currencies(_user: User = Depends(get_current_user)):
    """获取 NOWPayments 支持的可用币种列表（登录必需，短 TTL 缓存）。
    List available payment currencies (login required, short-TTL cached)."""
    global _currency_cache
    now = time.monotonic()
    if _currency_cache is not None and now - _currency_cache[0] < _CURRENCY_CACHE_TTL_SECONDS:
        return {"currencies": _currency_cache[1]}
    try:
        currencies = await np_currencies()
    except Exception:
        # 异常明细只进日志：第三方异常文本会带上请求 URL、密钥前缀、依赖版本一类
        # 内部信息，回给客户端等于免费给出一份内部结构说明。
        # Details go to the log only: third-party exception text carries request
        # URLs, key prefixes and library versions — handing that to the client is
        # a free description of our internals.
        logger.exception("NOWPayments 币种列表获取失败 / failed to fetch currencies")
        raise HTTPException(
            status_code=502,
            detail="支付服务暂时不可用，请稍后重试 / payment service temporarily unavailable",
        )
    _currency_cache = (now, currencies)
    return {"currencies": currencies}


# ═══ 免费试用 / Free trial ═══

@router.get("/trial")
def get_trial_status(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户能否领取免费试用 / whether the current user may claim a free trial.

    资格三条件同时满足：① 管理后台开关为开；② 从未用过试用；③ 当前等级是 FREE。
    Eligible only if all three hold: ① the admin switch is on; ② never claimed
    before; ③ the current plan is FREE.
    """
    trial = get_trial_settings(db)
    enabled = bool(trial["trial_enabled"])
    eligible = enabled and user.trial_used_at is None and user.plan == "FREE"
    return {
        "enabled": enabled,
        "days": int(trial["trial_days"]),
        "eligible": eligible,
        "usedAt": user.trial_used_at.isoformat() if user.trial_used_at else None,
    }


@router.post("/trial/claim")
def claim_trial(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """领取免费试用：立即升级为 PRO，到期由既有的会员到期机制自动降回 FREE。

    Claim the free trial: upgrades to PRO immediately; the existing membership
    expiry mechanism (services/plan_expiry.py) auto-downgrades back to FREE.

    用条件 UPDATE 原子抢占资格（而不是先读后写），防止同一用户并发点两次都
    成功——思路与 payments._sync_payment_status 抢占 FINISHED 状态完全一致。
    Claims eligibility via a conditional UPDATE (not read-then-write) so two
    concurrent clicks from the same user can't both succeed — same approach as
    the FINISHED-state claim in _sync_payment_status.
    """
    # 「此刻能发几天」与注册送试用那条路共用同一处判定（services/plans）：总闸关着
    # 和天数被手改成 0 都归在一起答 None。原先这里只看总闸、天数照单全收，
    # trial_days=0 时会写出一个"现在就到期"的 PRO，同时把 trial_used_at 盖上——
    # 用户唯一一次试用就这么没了，而且不可逆。详见 plans.trial_grant_days。
    # The day count comes from the same decision point as the invite-time grant
    # (services/plans): switch off and a hand-edited 0 both answer None. This
    # endpoint used to check only the switch and take the number on faith, which
    # stamped trial_used_at on a membership that expired instantly — irreversible.
    days = trial_grant_days(db)
    if days is None:
        raise HTTPException(status_code=400, detail="试用功能未开放 / Free trial is not available")

    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=days)

    claimed = (
        db.query(User)
        .filter(User.id == user.id, User.trial_used_at.is_(None), User.plan == "FREE")
        .update(
            {
                "plan": "PRO",
                "plan_expires_at": expires,
                "trial_used_at": now,
                "plan_is_trial": True,
            },
            synchronize_session=False,
        )
    )
    if not claimed:
        db.rollback()
        fresh = db.query(User).filter(User.id == user.id).first()
        if fresh and fresh.trial_used_at is not None:
            raise HTTPException(status_code=409, detail="试用已被使用 / Trial already used")
        raise HTTPException(status_code=409, detail="当前等级无需试用 / Current plan does not need a trial")

    # 审计留痕：沿用"无管理员操作者时用户自身占位"的仓库约定
    # （见 services/plan_expiry.py 的 field="plan:auto_expire" 同款写法）。
    db.add(
        AdminAuditLog(
            admin_user_id=user.id,
            target_user_id=user.id,
            field="plan:trial_claim",
            old_value="FREE",
            new_value=f"PRO({days}d)",
        )
    )
    db.commit()
    return {"ok": True, "planExpiresAt": expires.isoformat(), "days": days}


@router.post("/create")
@limiter.limit(settings.RATE_LIMIT_PAYMENT)
async def create_payment_order(
    body: CreatePaymentRequest,
    request: Request,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """创建支付订单 / Create a payment order.

    Plan must be one of: pro_monthly, pro_yearly.
    Returns the pay_address and pay_amount for the user to send funds to.
    """
    if body.plan not in PLAN_DAYS:
        raise HTTPException(status_code=400, detail=f"Invalid plan: {body.plan}")

    # 只接受 USDT（多链）/ accept USDT only (any chain)
    if not body.pay_currency.lower().startswith("usdt"):
        raise HTTPException(status_code=400, detail="Only USDT is accepted")

    # 不限期 PRO（内测/赠送，plan_expires_at 为空）不许下单。入账那一段本来就对这
    # 类用户什么都不做——付款不能把「永久」改成有期限，见 _sync_payment_status 里
    # 那个 `pass` 分支——结果就是钱收了、权益一点没变、页面上也没有任何提示。
    # 拦在下单这一步，是这条链路上唯一能在收钱**之前**说话的地方。
    # Permanent PRO (comp grant, null expiry) cannot open an order. Crediting
    # already does nothing for these users — a payment must not turn "never
    # expires" into a deadline (see the `pass` branch in _sync_payment_status) —
    # so the money would arrive, change nothing, and say nothing. Order creation
    # is the only point on this path that can speak before the funds move.
    if _user.plan == "PRO" and _user.plan_expires_at is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "你的会员已是不限期，无需付费续费 / "
                "Your membership never expires; there is nothing to renew"
            ),
        )

    # 未完成支付订单数量上限：限流之外的第二道闸，防止在库里堆积大量悬而未决
    # 的支付记录，也避免每次进付款页都新开一笔。达到上限时提示用户先完成或
    # 等待现有订单过期。/ Cap unfinished payments as a second gate beyond the
    # rate limit — keeps stale pending rows from piling up and stops a fresh
    # payment being opened on every visit to the pay page.
    open_count = (
        db.query(Payment)
        .filter(
            Payment.user_id == _user.id,
            Payment.status.in_(("NEW", "PENDING", "PROCESSING")),
        )
        .count()
    )
    if open_count >= settings.MAX_OPEN_PAYMENTS_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=(
                "有未完成的支付订单，请先完成或等待其过期后再创建新的 / "
                "You have unfinished payments; complete or let them expire before creating a new one"
            ),
        )

    days = PLAN_DAYS[body.plan]
    pricing = _resolve_pricing(db)
    sale = pricing.get("sale")
    if sale:
        price_usd = sale["monthly"] if days == 30 else sale["yearly"]
    else:
        price_usd = pricing["monthly"] if days == 30 else pricing["yearly"]

    # 生成内部订单号 / internal order ID for tracking
    order_id = f"prismx_{_user.id}_{uuid.uuid4().hex[:8]}"

    # IPN 回调 URL / callback URL for NOWPayments to POST back
    ipn_url = f"{settings.SITE_BASE_URL}/api/payments/webhook"

    # 以 USDT 计价（price_currency 与 pay_currency 同币种），避免美元→USDT 换算产生
    # 的小数尾巴，让客户看到的应付金额与套餐价格整齐对齐。USDT≈USD，价格数值不变。
    # Price directly in USDT (price_currency == pay_currency) so there's no USD→USDT
    # conversion tail — the amount shown matches the plan price exactly. USDT≈USD.
    pay_currency = body.pay_currency.lower()
    try:
        np_result = await np_create(
            price_amount=price_usd,
            price_currency=pay_currency,
            pay_currency=pay_currency,
            order_id=order_id,
            order_description=f"PRISMX PRO - {days} days",
            ipn_callback_url=ipn_url,
            is_fixed_rate=True,
            is_fee_paid_by_user=False,
        )
    except Exception:
        # 明细只进日志，不回客户端（理由同 /currencies）。
        # Details to the log, not to the client (same reasoning as /currencies).
        logger.exception("NOWPayments 创建订单失败: user=%s order=%s", _user.id, order_id)
        raise HTTPException(
            status_code=502,
            detail="支付订单创建失败，请稍后重试 / could not create the payment, please try again",
        )

    payment_id = np_result.get("payment_id")
    if not payment_id:
        logger.error("NOWPayments 未返回 payment_id: user=%s order=%s", _user.id, order_id)
        raise HTTPException(
            status_code=502,
            detail="支付订单创建失败，请稍后重试 / could not create the payment, please try again",
        )

    # 存入本地数据库 / persist to local DB
    record = Payment(
        user_id=_user.id,
        nowpayments_payment_id=str(payment_id),
        plan=body.plan,
        amount_usd=price_usd,
        pay_currency=pay_currency,
        pay_amount=float(np_result.get("pay_amount", 0)),
        pay_address=np_result.get("pay_address", ""),
        status="PENDING",
    )
    db.add(record)
    db.commit()

    return {
        "id": record.id,
        "payment_id": record.nowpayments_payment_id,
        "pay_address": record.pay_address,
        "pay_amount": record.pay_amount,
        "pay_currency": record.pay_currency,
        "amount_usd": record.amount_usd,
        "plan": record.plan,
        "status": record.status,
        "created_at": record.created_at.isoformat(),
        # NOWPayments 返回的支付有效期，用于前端倒计时 / payment validity window for the countdown
        "valid_until": np_result.get("valid_until") or np_result.get("expiration_estimate_date"),
    }


def _load_own_payment(db: Session, payment_id: str, user_id: str):
    """按 NOWPayments 支付号取本人的订单。同步查询，供线程池调用。
    Load the caller's own payment by NOWPayments id; blocking, for the threadpool."""
    return (
        db.query(Payment)
        .filter(
            Payment.nowpayments_payment_id == payment_id,
            Payment.user_id == user_id,
        )
        .first()
    )


def _serialize_payment(record: Payment) -> dict:
    """把订单序列化成响应体。**必须在线程池里调用。**

    看着像纯内存操作，其实不是：_sync_payment_status 里的 db.commit() 会让
    expire_on_commit 把这个实例的所有属性置为过期，下面每一次属性读取都可能
    触发一条 refresh SELECT。放在事件循环上就是一条隐藏的阻塞查询。

    Looks like pure attribute access but isn't: db.commit() inside
    _sync_payment_status expires this instance, so each read below can trigger a
    refresh SELECT. On the event loop that would be a hidden blocking query.
    """
    return {
        "id": record.id,
        "payment_id": record.nowpayments_payment_id,
        "pay_address": record.pay_address,
        "pay_amount": record.pay_amount,
        "pay_currency": record.pay_currency,
        "amount_usd": record.amount_usd,
        "plan": record.plan,
        "status": record.status,
        # 实际到账金额：低于 pay_amount 说明用户少转了。让前端能提示"已收到
        # 部分金额"，而不是只有一句"已过期"却不知道钱去哪儿了。
        # Actual amount received: less than pay_amount means the user
        # under-sent. Lets the frontend show "partial amount received"
        # instead of just "expired" with no idea where the funds went.
        "actually_paid": record.actually_paid,
        "finished_at": record.finished_at.isoformat() if record.finished_at else None,
        "created_at": record.created_at.isoformat(),
    }


@router.get("/status/{payment_id}")
async def get_payment_status_local(
    payment_id: str,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询支付状态（本地记录 + NOWPayments 做兜底同步）。

    Get payment status from local DB, synced with NOWPayments as fallback.

    三段同步 DB 工作全部走线程池。这个端点在支付窗口打开期间由前端每 5 秒轮询
    一次，每个在途用户都在轮，留在事件循环上会持续挤占所有人的实时推送。
    中间那次 await np_status 是既有的外部网络调用，位置与拆分方式都保持原样，
    并发窗口与改造前完全一致。

    All three blocking DB steps go through the thread pool. The frontend polls
    this every 5s per in-flight payment, so leaving it on the loop steals time
    from everyone's realtime pushes. The await on np_status in the middle is the
    pre-existing outbound call; its position is unchanged, so the concurrency
    window is exactly what it was before.
    """
    record = await run_in_threadpool(_load_own_payment, db, payment_id, _user.id)

    if not record:
        raise HTTPException(status_code=404, detail="Payment not found")

    # 若本地不是终态，从 NOWPayments 拉最新状态同步 / sync from NP if not terminal
    if record.status in ("PENDING", "NEW", "PROCESSING"):
        try:
            np_data = await np_status(payment_id)
            np_status_val = np_data.get("payment_status", "").lower()
            # 同步整段仍在一个 try 里：DB 抖动时照旧退回本地缓存返回 200，
            # 而不是变成 500。这是既有对外行为，不能借着搬迁悄悄改掉。
            # The sync stays inside the same try: a DB hiccup still falls back to
            # the cached record with a 200 rather than becoming a 500. That's
            # existing behaviour and must not change under cover of this move.
            await run_in_threadpool(_sync_payment_status, db, record, np_status_val, np_data)
        except Exception:
            # 行为不变（照旧回落到本地缓存并返回 200），但不再静默：这是前端每 5 秒
            # 轮询一次的路径，NOWPayments 长期不可用时用户看到的只是订单状态一直不
            # 更新，服务端却一条记录都没有——没有日志就没人会发现。
            # Behaviour unchanged (still falls back to the cached record with a
            # 200) but no longer silent: the frontend polls this every 5s, so a
            # prolonged NOWPayments outage merely looks like a payment that never
            # updates, with nothing recorded server-side to notice it by.
            logger.warning(
                "NOWPayments 状态同步失败，回落本地缓存: payment=%s", payment_id, exc_info=True
            )

    return await run_in_threadpool(_serialize_payment, record)


@router.post("/webhook")
async def ipn_webhook(request: Request, db: Session = Depends(get_db)):
    """NOWPayments IPN 回调 — 支付成功时自动升级用户。

    IPN webhook from NOWPayments — auto-upgrade user on successful payment.
    无需 JWT 认证，用 HMAC-SHA512 签名验证。
    No JWT auth; secured via HMAC-SHA512 signature verification.
    """
    # 读原始 body
    body_bytes = await request.body()
    body_str = body_bytes.decode("utf-8")

    # 验证签名 / verify signature
    sig = request.headers.get("x-nowpayments-sig", "")
    if not verify_ipn_signature(body_str, sig):
        raise HTTPException(status_code=401, detail="Invalid signature")

    # 解析回调数据
    try:
        import json

        data = json.loads(body_str)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    payment_status = data.get("payment_status", "").lower()
    np_payment_id = str(data.get("payment_id", ""))

    if not np_payment_id:
        raise HTTPException(status_code=400, detail="Missing payment_id")

    found = await run_in_threadpool(
        _webhook_sync_work, db, np_payment_id, payment_status, data
    )
    if not found:
        # 可能是 Sandbox 测试手动触发的、没有对应本地记录；静默返回 ok
        return {"ok": True, "note": "no local record for this payment_id"}
    return {"ok": True}


def _webhook_sync_work(
    db: Session, np_payment_id: str, payment_status: str, data: dict
) -> bool:
    """查订单 + 同步状态。返回是否找到了本地记录。

    **查询与同步必须在同一次线程池跳转里完成，不能拆成两次。**

    _sync_payment_status 的两道防线都建立在"手里这个 record 的状态是刚读出来的"
    之上：FINISHED 抢占靠条件 UPDATE（status != 'FINISHED'），防回退靠 `record.status
    != "FINISHED"` 这个内存判断。拆成两次跳转会在中间插入一个事件循环让出点，另一
    个并发请求（前端每 5 秒一次的 /status 轮询）可以在此期间把这笔支付推成 FINISHED
    并给用户加时长；本请求回来后手里仍是那份陈旧快照，防回退判断会误以为它还不是
    终态，于是把 FINISHED 覆写成 EXPIRED 之类——下一拍轮询再看到 finished，条件
    UPDATE 又能抢占成功，**同一笔支付给用户续期两次**。

    今天这段 load→sync 之间一个 await 都没有，对其它请求是原子的；合并成一次跳转
    就是把这份原子性原样搬进线程池，而不是在钱路径上新开一个竞态窗口。

    Look up the payment and sync its status. Returns whether a local record existed.

    **The lookup and the sync must happen in ONE thread-pool hop.** Both safeguards
    in _sync_payment_status assume the record's status was just read: the FINISHED
    transition is claimed by a conditional UPDATE, and the anti-regression check is
    an in-memory comparison. Splitting this into two hops inserts an event-loop
    yield point where a concurrent /status poll can flip the payment to FINISHED and
    credit the user; this request would then resume holding a stale snapshot, decide
    the payment is not terminal, and overwrite FINISHED with e.g. EXPIRED — after
    which the next poll's conditional UPDATE claims it again and **credits the same
    payment twice**. Today there is no await between load and sync, so it is atomic
    with respect to other requests; one hop preserves exactly that.
    """
    record = (
        db.query(Payment)
        .filter(Payment.nowpayments_payment_id == np_payment_id)
        .first()
    )
    if not record:
        return False

    _sync_payment_status(db, record, payment_status, data)
    return True


# ═══ 支付状态机 / payment state machine ═══
#
# 终态：到达之后不再被任何**非终态**覆盖。
#
# 以前只有 FINISHED 受保护，其余状态可以互相覆盖，于是一条迟到/乱序的 waiting
# 回调能把 EXPIRED 或 FAILED 改回 PROCESSING——而 PROCESSING 计入
# MAX_OPEN_PAYMENTS_PER_USER，用户会被一笔早就过期的订单挡住，再也创建不了新订单，
# 且没有任何一处解释得了原因（那笔订单在他自己的页面上显示的是"已过期"）。
#
# FINISHED_MISMATCH 也在里面：它表示"NOWPayments 说付完了，但金额/币种对不上"，
# 是需要人工看一眼的终局，同样不该被后续的 waiting 抹掉。它**不是** FINISHED，
# 所以抢占入账的那条条件 UPDATE（status != 'FINISHED'）仍然能在后续真的对上账时
# 接手——补款后才对上的场景不会因为这个状态被永久锁死。
#
# Terminal states: never overwritten by a non-terminal one. Only FINISHED used to
# be protected, so a late out-of-order "waiting" callback could flip EXPIRED or
# FAILED back to PROCESSING — which counts toward MAX_OPEN_PAYMENTS_PER_USER and
# silently locks the user out of creating new orders, with nothing anywhere to
# explain it. FINISHED_MISMATCH joins them: "they say it's paid but the numbers
# disagree" is a state for a human to look at. It is deliberately NOT FINISHED,
# so the conditional claim below can still take over if a later callback does
# reconcile.
#
# REFUNDED 是「已经入账、事后被退款、权益已按退款收回」的终局。它必须与 FAILED
# 分开：FAILED 表示钱从来没到过，而 REFUNDED 表示钱到过、权益发过、又收回了——
# routers/invite._has_live_paid_plan 正是靠 `status == "FINISHED"` 判断「他现在的
# 权益是花钱买的」，把这一行留在 FINISHED 上会让一笔退掉的钱继续替用户挡住代理
# 的降级操作。同时它是终态：退款之后再来一条迟到的 waiting/finished 回调，既不能
# 把它拉回 PROCESSING 占住下单名额，也不能让它重新走一遍入账。
#
# REFUNDED is the end state for "credited, later refunded, entitlement clawed
# back". It is deliberately not FAILED: FAILED means the money never arrived,
# REFUNDED means it arrived, bought something, and was taken back. Keeping the
# row at FINISHED would let refunded money keep satisfying
# invite._has_live_paid_plan's `status == "FINISHED"` paid-customer guard. Being
# terminal also stops a late waiting/finished callback from reviving the row into
# an open-payment slot or running it through crediting a second time.
STATUS_FINISHED_MISMATCH = "FINISHED_MISMATCH"
STATUS_REFUNDED = "REFUNDED"
_TERMINAL_STATUSES = frozenset(
    {"FINISHED", "EXPIRED", "FAILED", STATUS_FINISHED_MISMATCH, STATUS_REFUNDED}
)

# 站内通知的类别名。前端按 `notifFeed.<kind>` 取标题文案，本次没有改 frontend/，
# 所以铃铛面板里这条的标题会先渲染成裸 key——与 notification_feed.py 里
# KIND_AGENT_PLAN_CHANGE 当时的处境一样，text 里已经把事情说清楚了，补上
# en.json / zh.json 的 `notifFeed.plan_refund` 之前它只是看着像 bug。
# Notification kind. The frontend renders the title from `notifFeed.<kind>`; this
# change doesn't touch frontend/, so the bell shows a bare key until
# `notifFeed.plan_refund` lands in en.json / zh.json — same situation
# KIND_AGENT_PLAN_CHANGE was in. The text body already carries the substance.
NOTIFY_KIND_PLAN_REFUND = "plan_refund"

# 金额比较的相对容差。两边都是浮点、且中途经过 JSON 与第三方的十进制格式化，
# 严格相等会把正常的 199.0 vs 199.00000000000003 判成对不上账。
# Relative tolerance for amount comparison: both sides are floats that have been
# through JSON and a third party's decimal formatting, so exact equality would
# flag a perfectly normal 199.0 vs 199.00000000000003 as a mismatch.
_AMOUNT_TOLERANCE = 1e-6


def _as_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _close_enough(a: float, b: float) -> bool:
    return abs(a - b) <= max(abs(a), abs(b)) * _AMOUNT_TOLERANCE + 1e-9


def _finished_mismatch_reason(record: Payment, np_data: dict) -> str | None:
    """入账前核对金额与币种；对得上返回 None，对不上返回一句说明。

    **为什么要核对**：入账这件事此前完全建立在 `payment_status == "finished"`
    这一个字符串上——本地存着的应付金额、币种、实付金额一个都没参与判断。
    NOWPayments 自己只在全额到账时才置 finished，所以这不是一个当下可利用的
    漏洞，而是防御纵深缺的一层：签名密钥一旦泄露、sandbox 配置一旦误上生产
    （config.py 已有启动闸门兜底）、或者对方将来改了 finished 的语义，缺这一层
    就等于零成本白送 PRO，而且事后只能靠人工对账才可能发现。

    缺字段不算不一致：NOWPayments 不同版本的回调载荷字段不完全一样，把"没给这个
    字段"当成对不上账会让所有正常支付都卡住——那是把防御纵深变成拒绝服务。

    Reconcile amounts and currency before crediting; None means "matches".
    Crediting used to rest entirely on one status string, with the stored
    amount, currency and received amount taking no part. NOWPayments only
    reports finished on full payment, so this is depth rather than a live hole —
    but without it a leaked IPN key, a sandbox config reaching production (the
    startup gate backstops that) or a change in their semantics hands out PRO for
    free, discoverable only by manual reconciliation. Absent fields are not
    treated as mismatches: payload shapes vary by API version, and failing closed
    on a missing key would stall every legitimate payment.
    """
    np_currency = np_data.get("pay_currency")
    if isinstance(np_currency, str) and np_currency and record.pay_currency:
        if np_currency.strip().lower() != record.pay_currency.strip().lower():
            return f"pay_currency {np_currency!r} != {record.pay_currency!r}"

    price = _as_float(np_data.get("price_amount"))
    if price is not None and record.amount_usd is not None:
        if not _close_enough(price, float(record.amount_usd)):
            return f"price_amount {price} != amount_usd {record.amount_usd}"

    paid = _as_float(np_data.get("actually_paid"))
    expected = _as_float(record.pay_amount)
    if paid is not None and expected:
        # 少付才算问题，多付不算：链上手续费算法差异会让用户多转一点点。
        # Under-payment only; over-payment is normal (on-chain fee rounding).
        if paid < expected * (1 - _AMOUNT_TOLERANCE):
            return f"actually_paid {paid} < pay_amount {expected}"
    return None


def _payment_audit(db: Session, record: Payment, field: str, old_value, new_value) -> None:
    """支付链路上的审计行。

    AdminAuditLog.target_user_id 是指向 users.id 的非空外键，而这些事件没有管理员
    操作者，所以沿用仓库里"没有管理员时用用户自身占位"的约定（同
    services/plan_expiry.py 的 plan:auto_expire、payments.claim_trial 的
    plan:trial_claim）。field 带 `payment:` / `plan:` 前缀区分来源。

    An audit row for the payment path. There is no admin actor, so the user
    stands in for both columns per the repo's existing convention; the field
    prefix says where it came from.
    """
    db.add(
        AdminAuditLog(
            admin_user_id=record.user_id,
            target_user_id=record.user_id,
            field=field,
            old_value=None if old_value is None else str(old_value),
            new_value=None if new_value is None else str(new_value),
        )
    )


def _as_utc(value: datetime | None) -> datetime | None:
    """把库里取出来的 naive 时间当 UTC 看待（同 plans.is_plan_expired 的约定）。
    Read a naive timestamp from the DB as UTC (same convention as is_plan_expired)."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _other_payments_entitlement_floor(db: Session, record: Payment) -> datetime | None:
    """这个用户**除这一笔之外**的已完成付款，单独就能保证的最晚到期时间。

    公式与 routers/invite._has_live_paid_plan 完全一致（finished_at + 套餐天数）：
    那边回答的是「这个人手里有没有一笔还在窗口里的付款」，这边回答的是「把这笔
    退款扣完之后，还有哪笔付款的窗口不许被扣穿」——同一个「这笔钱买到的窗口」。

    为什么需要它：减天数的前提是「这笔的天数还留在当前到期时间里」。用户会员断档
    之后又付了一笔时，后一笔是从付款时刻重新起算的，当前到期时间里根本没有这笔被
    退款的天数，再减一次就是从后一笔身上扣。用这个下限一夹，断档重付的情况下一天
    都扣不掉，正是我们要的保守方向。

    只看 FINISHED：PROCESSING 的钱还没到账，EXPIRED/FAILED/REFUNDED 的不该给窗口。
    record 本身在调用前已经被抢占改成 REFUNDED，不会被这个查询选中；仍显式排掉它
    的 id，是为了不让这段逻辑的正确性依赖调用顺序。

    The latest expiry this user's *other* finished payments guarantee on their
    own — same finished_at + plan-days formula as invite._has_live_paid_plan.
    Subtracting this payment's days assumes those days are still inside the
    current expiry; after a lapse-and-rebuy they aren't, and subtracting would
    come out of the newer payment. This floor makes that case revoke nothing.
    FINISHED only, and this record's own id is excluded explicitly so the result
    doesn't depend on the caller having already flipped it to REFUNDED.
    """
    rows = (
        db.query(Payment.plan, Payment.finished_at)
        .filter(
            Payment.user_id == record.user_id,
            Payment.status == "FINISHED",
            Payment.id != record.id,
        )
        .all()
    )
    floor: datetime | None = None
    for plan, finished_at in rows:
        if finished_at is None:
            continue
        ends = finished_at if finished_at.tzinfo else finished_at.replace(tzinfo=timezone.utc)
        ends = ends + timedelta(days=PLAN_DAYS.get(plan, 30))
        if floor is None or ends > floor:
            floor = ends
    return floor


def _revoke_refunded_entitlement(db: Session, record: Payment) -> None:
    """退款到得比我们想的晚：本地已经按 FINISHED 给过时长了，把这笔给出的权益收回。

    2026-09-19 的审计修复当时只做了一半——只 logger.error + 写审计行、不自动降级，
    理由是「属产品决策」。负责人已决定要做自动降级，所以这里补上，但保留了那两条
    人工可见的痕迹：**自动降级不等于不需要人看**（部分退款、运营谈好的例外、对方
    误操作都长这个样子，只有人能分辨）。

    收回的口径见 services/plans.refund_revocation：减掉这笔买的天数、并以「别的已
    完成付款单独保证的窗口」为下限，而不是简单地设成 FREE。原则是宁可少扣——
    误扣一个正常付费用户的权益，比晚几天收回一个退款用户的权益严重得多。

    A refund arriving after we already credited the time: take back what this
    payment gave. The 2026-09-19 audit fix deliberately stopped at "log it and
    let a human decide"; the product decision is now to downgrade automatically.
    Both human-visible traces stay — automatic does not mean unattended, since a
    partial refund, an agreed exception and the provider's own mistake all look
    exactly like this and only a person can tell them apart.

    How much is taken back lives in plans.refund_revocation: subtract the days
    this payment bought, floored by what other finished payments guarantee on
    their own, rather than resetting to FREE. Under-revoking is the safe side.
    """
    now = datetime.now(timezone.utc)
    logger.error(
        "NOWPayments 报告退款，本地已入账，正在自动收回该笔权益（请人工复核是否为部分退款）: "
        "payment=%s user=%s plan=%s actually_paid=%s / refund reported after the "
        "payment was credited; revoking its entitlement automatically, review by hand",
        record.nowpayments_payment_id,
        record.user_id,
        record.plan,
        record.actually_paid,
    )

    # 原子抢占，同入账那一段：只有把 FINISHED 改成 REFUNDED 的这一方去动用户权益。
    # IPN 回调与前端 /status 轮询可能同时送来同一条 refunded，没有这道抢占就会
    # 把同一笔的天数扣两次——扣错方向的双重执行比双重入账更难被发现（用户只会
    # 觉得"我的会员怎么少了"）。
    # Atomic claim, mirroring the crediting path: only the session that flips
    # FINISHED → REFUNDED touches the entitlement. The IPN callback and the
    # frontend's 5s /status poll can deliver the same refund at once, and a
    # double revoke is even harder to notice than a double credit.
    claimed = (
        db.query(Payment)
        .filter(Payment.id == record.id, Payment.status == "FINISHED")
        .update({"status": STATUS_REFUNDED}, synchronize_session=False)
    )
    if not claimed:
        db.commit()
        db.refresh(record)
        return

    # 支付层的痕迹（沿用既有 field 名，管理端/人工按它查退款）。
    # The payment-level trace keeps its existing field name.
    _payment_audit(
        db, record, "payment:refund_after_finished", "FINISHED", STATUS_REFUNDED
    )

    # 锁住用户行：同一用户的另一笔支付可能正在入账，两边都在改 plan_expires_at。
    # Lock the user row: another payment of the same user may be crediting right
    # now, and both sides write plan_expires_at.
    user = db.query(User).filter(User.id == record.user_id).with_for_update().first()
    notify_user_id: str | None = None
    if user is not None:
        old_plan, old_expiry = user.plan, user.plan_expires_at
        skip, new_plan, new_expiry = refund_revocation(
            plan=user.plan,
            plan_expires_at=user.plan_expires_at,
            plan_is_trial=bool(user.plan_is_trial),
            days=PLAN_DAYS.get(record.plan, 30),
            entitlement_floor=_other_payments_entitlement_floor(db, record),
            now=now,
        )
        if skip is not None:
            # 一个字段都没动也要留痕：「为什么这笔退款没有收回任何权益」是人工
            # 复核时第一个要问的问题，不写下来就只能靠重算当时的状态去猜。
            # Even a no-op is recorded: "why did this refund take nothing back"
            # is the first question a reviewer asks, and without the row the only
            # way to answer it is to reconstruct the state at the time.
            _payment_audit(
                db, record, "plan:refund_skipped", f"{old_plan}({old_expiry})", skip
            )
        elif (new_plan, new_expiry) == (old_plan, _as_utc(old_expiry)):
            # 比较前先把旧值当 UTC 归一：库里取出来的是 naive，判定函数返回的是
            # aware，直接比会永远判成"变了"，于是断档重付那种「一天都没扣」的情况
            # 也会写审计行 + 发通知——用户收到一条"你的会员被收回了"，而权益其实
            # 一点没动，比不通知更糟。
            # Normalise before comparing: the stored value is naive and the
            # predicate returns aware, so a raw comparison always reads as
            # "changed" and the lapse-and-rebuy case (which revokes nothing) would
            # still tell the user their membership was taken away.
            # 下限把这笔的天数全挡住了（断档重付）：权益没变，就不该留一条"变了"
            # 的审计行，也不该去打扰用户。同 plan:payment 那边的处理。
            # The floor absorbed the whole subtraction (lapse-and-rebuy): nothing
            # changed, so neither an audit row nor a notification is warranted —
            # same rule as the plan:payment row.
            _payment_audit(
                db, record, "plan:refund_skipped", f"{old_plan}({old_expiry})",
                "skip:covered_by_other_payment",
            )
        else:
            user.plan = new_plan
            user.plan_expires_at = new_expiry
            if new_plan == "FREE":
                # 与 plan_expiry.downgrade_if_expired 保持一致：降回 FREE 时顺手
                # 清掉试用标记（非试用用户本来就是 False，无条件清是安全的）。
                # Same as plan_expiry.downgrade_if_expired: clear the trial flag
                # on the way back to FREE (already False for non-trial users).
                user.plan_is_trial = False
            _payment_audit(
                db,
                record,
                "plan:refund",
                f"{old_plan}({old_expiry})",
                f"{new_plan}({new_expiry})",
            )
            # 站内通知：权益被收回是用户会立刻察觉的事（信号变延迟、下不了单），
            # 没有任何说明的话他只会当成故障来报工单。通知随本次事务一起落盘
            # （create_notification 只 add+flush，不 commit），写失败不该让降级回滚。
            # In-app notice: losing entitlement is immediately visible (signals go
            # delayed, ordering stops), and with no explanation the user files a
            # bug report. The row rides this transaction; a failure here must not
            # roll the downgrade back.
            try:
                create_notification(
                    db,
                    user.id,
                    NOTIFY_KIND_PLAN_REFUND,
                    text=(
                        "订单已退款，该笔购买的会员时长已收回 / "
                        "Your payment was refunded; the membership days it bought were removed"
                    ),
                    link="/upgrade",
                    ref_id=record.id,
                )
                notify_user_id = user.id
            except Exception:  # noqa: BLE001
                logger.warning(
                    "退款降级的站内通知写入失败（降级本身已生效）: payment=%s user=%s / "
                    "in-app notice failed, the downgrade itself stands",
                    record.nowpayments_payment_id,
                    record.user_id,
                    exc_info=True,
                )

    db.commit()
    db.refresh(record)
    # WS 只在落盘之后发：面板收到信号会立刻回来拉 /notifications/feed，提前发就
    # 可能拉到一个还没提交的空列表。notify_ws 自己吞异常。
    # The WS ping goes out only after the commit — the bell refetches the feed the
    # moment it arrives, and a premature ping would read an uncommitted list.
    if notify_user_id:
        notify_ws(notify_user_id)


def _sync_payment_status(db: Session, record: Payment, np_status_val: str, np_data: dict):
    """同步 NOWPayments 的回调/查询状态到本地 Payment 表，支付完成时升级/续期用户。

    Sync NOWPayments callback/query status to local Payment record.
    On "finished", upgrade the user to PRO or extend an existing PRO.

    IPN webhook 与前端轮询可能并发同步同一笔支付：FINISHED 转换用条件 UPDATE
    原子抢占，只有抢到的一方给用户加时长，杜绝双重续期。
    The IPN webhook and the frontend poll may sync the same payment concurrently;
    the FINISHED transition is claimed via a conditional UPDATE so only one side
    credits the time — never both.
    """
    new_status = np_status_val.upper()
    if np_status_val in ("waiting", "confirming", "sending"):
        new_status = "PROCESSING"
    elif np_status_val == "finished":
        new_status = "FINISHED"
    elif np_status_val == "partially_paid":
        new_status = "PROCESSING"  # 不完全支付保持处理中
    elif np_status_val in ("expired",):
        new_status = "EXPIRED"
    elif np_status_val in ("failed", "refunded"):
        new_status = "FAILED"

    # 实际到账金额：不管是否终态都更新，让用户在支付窗口还开着、甚至已经
    # 过期/失败之后都能看到"收到了多少"，而不是钱看起来凭空消失。单独track
    # 是否真的变化了：状态本身没变化时（如仍处于 PROCESSING）下面的分支不会
    # 触发 commit，这个金额的更新就得靠它自己补一次 commit，否则悄悄丢失。
    # Actual amount received: updated regardless of terminal state, so the
    # user can see "how much arrived" whether the window is still open or the
    # payment has already expired/failed — instead of the funds appearing to
    # vanish. Tracked separately: when the status itself doesn't change (e.g.
    # still PROCESSING), the branches below never commit, so this needs its
    # own commit or the amount update is silently lost.
    actually_paid_changed = False
    actually_paid = np_data.get("actually_paid")
    if actually_paid is not None:
        try:
            parsed = float(actually_paid)
            if record.actually_paid != parsed:
                record.actually_paid = parsed
                actually_paid_changed = True
        except (TypeError, ValueError):
            pass

    # 退款到得比我们想的晚：本地已经按 FINISHED 给过时长了 → 自动收回这笔给出的
    # 权益（口径与理由见 _revoke_refunded_entitlement / plans.refund_revocation）。
    # 必须挡在下面整段之前：走到下面 new_status 会是 FAILED，既覆盖不了终态
    # FINISHED，也不会有人去动用户的会员，退款就白退了。
    # 这个判断只在 FINISHED 上成立，所以收回之后状态变成 REFUNDED，重复的 refunded
    # 回调不会再进来扣第二次。
    # A refund arriving after we credited the time → revoke what this payment
    # gave. It must short-circuit ahead of the block below, where "refunded" maps
    # to FAILED, fails to overwrite the terminal FINISHED, and nobody ever looks
    # at the membership. The condition only holds while the row is FINISHED, so
    # the flip to REFUNDED makes repeat callbacks no-ops rather than double debits.
    if np_status_val == "refunded" and record.status == "FINISHED":
        _revoke_refunded_entitlement(db, record)
        return

    if new_status == "FINISHED":
        now = datetime.now(timezone.utc)
        # 入账前先对账。对不上就落 FINISHED_MISMATCH 并**不给时长**：钱的事宁可
        # 停在这里等人看，也不能因为一个状态字符串就发出权益。
        # Reconcile before crediting. On a mismatch the row lands in
        # FINISHED_MISMATCH with nothing credited: on the money path, stopping
        # for a human beats handing out entitlement on the strength of a string.
        mismatch = _finished_mismatch_reason(record, np_data)
        if mismatch is not None:
            logger.error(
                "NOWPayments 报告完成但金额/币种对不上，未入账: payment=%s user=%s %s / "
                "finished with mismatched amounts, not credited",
                record.nowpayments_payment_id,
                record.user_id,
                mismatch,
            )
            claimed_mismatch = (
                db.query(Payment)
                .filter(
                    Payment.id == record.id,
                    Payment.status.notin_(("FINISHED", STATUS_FINISHED_MISMATCH)),
                )
                .update(
                    {"status": STATUS_FINISHED_MISMATCH, "finished_at": now},
                    synchronize_session=False,
                )
            )
            if claimed_mismatch:
                _payment_audit(
                    db, record, "payment:finished_mismatch", record.status, mismatch
                )
            db.commit()
            db.refresh(record)
            return

        # 原子抢占：只有把状态从非 FINISHED 改成 FINISHED 的这一方负责加时长
        # Atomic claim: only the session that flips status to FINISHED credits time
        claimed = (
            db.query(Payment)
            .filter(Payment.id == record.id, Payment.status != "FINISHED")
            .update({"status": "FINISHED", "finished_at": now}, synchronize_session=False)
        )
        if claimed:
            # 锁住用户行，防止同一用户两笔支付同时完成时互相覆盖到期时间
            # Lock the user row so two payments finishing at once can't clobber
            # each other's expiry (SQLite ignores FOR UPDATE — fine for tests)
            user = (
                db.query(User)
                .filter(User.id == record.user_id)
                .with_for_update()
                .first()
            )
            if user:
                old_plan, old_expiry = user.plan, user.plan_expires_at
                was_trial = user.plan_is_trial
                if was_trial:
                    # 试用期内付费转正：付费时长从付款时刻起算，不叠加试用剩余
                    # 天数——否则"先领试用再付费"会比直接付费多得天数，试用就
                    # 变成人人必薅的漏洞。清空到期时间让下面的 base 退回 now。
                    # was_trial 记在清空之前，避免下面的"永久 PRO"判断把刚清空
                    # 出的 None 误认成赠送的永久 PRO 而跳过计费。
                    # Paid conversion during a trial starts from "now", discarding
                    # the trial's remaining days — otherwise claiming a trial
                    # before paying would always yield extra days, turning the
                    # trial into a mandatory exploit. Clearing the expiry makes
                    # `base` fall back to now below. was_trial is captured before
                    # clearing so the "permanent PRO" check below doesn't mistake
                    # the freshly-cleared None for a comp grant and skip billing.
                    user.plan_is_trial = False
                    user.plan_expires_at = None

                if user.plan == "PRO" and user.plan_expires_at is None and not was_trial:
                    # 永久 PRO（内测/赠送，无到期时间）：付款不能把「永久」改成有期限
                    # Permanent PRO (comp grant, no expiry): a payment must not
                    # replace "never expires" with a deadline — leave it untouched.
                    pass
                else:
                    # 续费从「现有到期时间」与「现在」的较晚者起算，提前续费不损失
                    # 剩余天数；新购或已过期则从现在起算。
                    # Renewals extend from the later of the current expiry and now,
                    # so paying early never loses days; fresh or lapsed starts now.
                    days = PLAN_DAYS.get(record.plan, 30)
                    base = now
                    current = user.plan_expires_at
                    if user.plan == "PRO" and current is not None:
                        if current.tzinfo is None:
                            current = current.replace(tzinfo=timezone.utc)
                        if current > base:
                            base = current
                    user.plan = "PRO"
                    user.plan_expires_at = base + timedelta(days=days)
                # 付费导致的等级变化写审计行。试用领取（plan:trial_claim）、注册送
                # （plan:invite_trial）、自动到期（plan:auto_expire）、管理员与代理
                # 改动都各有一条，唯独"付了钱升上去"这一条没有——于是"这个人的 PRO
                # 是怎么来的"在审计链上正好缺付费这一段，而那恰恰是最需要查的一段。
                # 永久 PRO 那条分支什么都没改，old == new，log 不出来也不该 log。
                # The paid upgrade gets an audit row like every other plan change
                # (trial claim, invite trial, auto-expiry, admin and agent edits).
                # Paid was the one link missing from "how did this user get PRO",
                # which is the link most worth auditing. The comp-grant branch
                # changes nothing, so old == new and nothing is written.
                if (user.plan, user.plan_expires_at) != (old_plan, old_expiry):
                    _payment_audit(
                        db,
                        record,
                        "plan:payment",
                        f"{old_plan}({old_expiry})",
                        f"{user.plan}({user.plan_expires_at})",
                    )
        db.commit()
        # 让调用方拿到抢占后的最新字段（status/finished_at）
        # Reload so callers see the claimed values (status/finished_at)
        db.refresh(record)
    elif record.status not in _TERMINAL_STATUSES and record.status != new_status:
        # 终态不可回退（见 _TERMINAL_STATUSES）：乱序迟到的旧回调既不能把 FINISHED
        # 改回 PROCESSING，也不能把 EXPIRED/FAILED 改回 PROCESSING 把用户的
        # MAX_OPEN_PAYMENTS_PER_USER 名额永久占住。
        # Terminal states never regress (see _TERMINAL_STATUSES): a late callback
        # can neither un-finish a payment nor revive an EXPIRED/FAILED one into
        # PROCESSING, where it would permanently occupy an open-payment slot.
        record.status = new_status
        db.commit()
    elif actually_paid_changed:
        # 状态本身没变化（如仍是 PROCESSING），但到账金额有新数据——单独提交，
        # 否则用户少转后再多补一笔，这次追加的金额永远不会落库。
        # Status itself is unchanged (e.g. still PROCESSING) but the received
        # amount has fresh data — commit it on its own, or a top-up sent after
        # an initial under-payment would never get persisted.
        db.commit()
