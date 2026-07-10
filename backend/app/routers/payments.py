"""NOWPayments 支付路由 / Payment API routes.

前端调用创建支付、查询状态、获取可用币种。
NOWPayments 的 IPN 回调也走这个路由（无需用户认证）。
"""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import Payment, User
from app.services.deps import get_current_user
from app.services.nowpayments import (
    create_payment as np_create,
    get_currencies as np_currencies,
    get_payment_status as np_status,
    verify_ipn_signature,
)
from app.core.config import settings
from app.services.settings_store import get_pricing_settings

router = APIRouter(prefix="/payments", tags=["payments"])

# ═══ 定价 / Pricing ═══
PLAN_DAYS: dict[str, int] = {"pro_monthly": 30, "pro_yearly": 365}


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
    plan: str  # pro_monthly / pro_yearly
    pay_currency: str  # e.g. btc, eth, usdttrc20


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
            "tag": "save_20" if not sale else None,
        },
    ]
    return {"plans": plans, "sale": sale}


@router.get("/currencies")
async def get_payment_currencies():
    """获取 NOWPayments 支持的可用币种列表 / List available payment currencies."""
    try:
        currencies = await np_currencies()
        return {"currencies": currencies}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NOWPayments error: {e}")


@router.post("/create")
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
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"NOWPayments create payment failed: {e}")

    payment_id = np_result.get("payment_id")
    if not payment_id:
        raise HTTPException(status_code=502, detail="NOWPayments did not return a payment_id")

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


@router.get("/status/{payment_id}")
async def get_payment_status_local(
    payment_id: str,
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询支付状态（本地记录 + NOWPayments 做兜底同步）。

    Get payment status from local DB, synced with NOWPayments as fallback.
    """
    record = db.query(Payment).filter(
        Payment.nowpayments_payment_id == payment_id,
        Payment.user_id == _user.id,
    ).first()

    if not record:
        raise HTTPException(status_code=404, detail="Payment not found")

    # 若本地不是终态，从 NOWPayments 拉最新状态同步 / sync from NP if not terminal
    if record.status in ("PENDING", "NEW", "PROCESSING"):
        try:
            np_data = await np_status(payment_id)
            np_status_val = np_data.get("payment_status", "").lower()
            _sync_payment_status(db, record, np_status_val, np_data)
        except Exception:
            pass  # NP 不可用时返回本地缓存 / return local cache if NP is down

    return {
        "id": record.id,
        "payment_id": record.nowpayments_payment_id,
        "pay_address": record.pay_address,
        "pay_amount": record.pay_amount,
        "pay_currency": record.pay_currency,
        "amount_usd": record.amount_usd,
        "plan": record.plan,
        "status": record.status,
        "finished_at": record.finished_at.isoformat() if record.finished_at else None,
        "created_at": record.created_at.isoformat(),
    }


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

    # 查本地订单
    record = db.query(Payment).filter(
        Payment.nowpayments_payment_id == np_payment_id
    ).first()

    if not record:
        # 可能是 Sandbox 测试手动触发的、没有对应本地记录；静默返回 ok
        return {"ok": True, "note": "no local record for this payment_id"}

    _sync_payment_status(db, record, payment_status, data)
    return {"ok": True}


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

    if new_status == "FINISHED":
        now = datetime.now(timezone.utc)
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
                if user.plan == "PRO" and user.plan_expires_at is None:
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
        db.commit()
        # 让调用方拿到抢占后的最新字段（status/finished_at）
        # Reload so callers see the claimed values (status/finished_at)
        db.refresh(record)
    elif record.status != "FINISHED" and record.status != new_status:
        # FINISHED 是终态：乱序迟到的旧回调不允许把它改回 PROCESSING 等
        # FINISHED is terminal — a late out-of-order callback must not regress it
        record.status = new_status
        db.commit()
