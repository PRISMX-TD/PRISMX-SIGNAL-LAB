"""NOWPayments API 封装 / NOWPayments API wrapper.

调用 NOWPayments 的支付、查询、币种等接口。
所有请求通过 httpx HTTP 调用，无需第三方 SDK。
"""

import hashlib
import hmac
import json
from typing import Any

import httpx

from app.core.config import settings

# Sandbox 用不同域名 / Sandbox uses a different host
_NP_BASE = (
    "https://api-sandbox.nowpayments.io"
    if settings.NOWPAYMENTS_SANDBOX
    else "https://api.nowpayments.io"
)


def _headers() -> dict:
    return {"x-api-key": settings.NOWPAYMENTS_API_KEY, "Content-Type": "application/json"}


async def create_payment(
    price_amount: float,
    price_currency: str,
    pay_currency: str | None = None,
    order_id: str | None = None,
    order_description: str | None = None,
    ipn_callback_url: str | None = None,
    is_fixed_rate: bool = True,
    is_fee_paid_by_user: bool = False,
) -> dict:
    """创建一笔支付，返回 pay_address / pay_amount / payment_id 等。

    POST /v1/payment
    官方文档: https://documenter.getpostman.com/view/7907941/2s93JusNJt#74c91a83
    """
    body: dict[str, Any] = {
        "price_amount": price_amount,
        "price_currency": price_currency.lower(),
        "is_fixed_rate": is_fixed_rate,
        "is_fee_paid_by_user": is_fee_paid_by_user,
    }
    if pay_currency:
        body["pay_currency"] = pay_currency.lower()
    if order_id:
        body["order_id"] = order_id
    if order_description:
        body["order_description"] = order_description
    if ipn_callback_url:
        body["ipn_callback_url"] = ipn_callback_url

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{_NP_BASE}/v1/payment", json=body, headers=_headers())
        r.raise_for_status()
        return r.json()


async def get_payment_status(payment_id: str) -> dict:
    """查询支付状态。GET /v1/payment/{payment_id}"""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_NP_BASE}/v1/payment/{payment_id}", headers=_headers()
        )
        r.raise_for_status()
        return r.json()


async def get_payments(limit: int = 50, page: int = 1) -> dict:
    """分页获取支付列表。GET /v1/payment"""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_NP_BASE}/v1/payment",
            params={"limit": limit, "page": page},
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


async def get_currencies() -> list[str]:
    """获取可用币种列表。GET /v1/currencies"""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{_NP_BASE}/v1/currencies", headers=_headers())
        r.raise_for_status()
        data = r.json()
        return data.get("currencies", [])


async def get_estimate(amount: float, currency_from: str, currency_to: str) -> dict:
    """估算法币 → 币的兑换金额。GET /v1/estimate"""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_NP_BASE}/v1/estimate",
            params={
                "amount": amount,
                "currency_from": currency_from.lower(),
                "currency_to": currency_to.lower(),
            },
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


async def get_min_amount(currency_from: str, currency_to: str) -> dict:
    """查最小支付金额。GET /v1/min-amount"""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_NP_BASE}/v1/min-amount",
            params={
                "currency_from": currency_from.lower(),
                "currency_to": currency_to.lower(),
            },
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


def verify_ipn_signature(body_json: str, signature: str) -> bool:
    """验证 IPN 回调签名：对 JSON body 按 key 排序后做 HMAC-SHA512。

    官方 Python 示例见: https://documenter.getpostman.com/view/7907941/2s93JusNJt
    """
    if not settings.NOWPAYMENTS_IPN_SECRET:
        return False

    # 解析 JSON → 按 key 递归排序 → 序列化回去
    # Parse JSON → sort keys recursively → re-serialize
    try:
        data = json.loads(body_json)
    except json.JSONDecodeError:
        return False

    sorted_body = json.dumps(data, separators=(",", ":"), sort_keys=True)
    digest = hmac.new(
        settings.NOWPAYMENTS_IPN_SECRET.encode(),
        sorted_body.encode(),
        hashlib.sha512,
    ).hexdigest()

    return hmac.compare_digest(digest, signature)
