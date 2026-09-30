"""发信：Resend 的 HTTP API。

**这里的每一条失败路径都必须是"记日志然后返回 False"，绝不抛。** 调用方是注册
/ 找回密码这类用户正在等响应的路径，发信商超时、限流、改了返回格式、DNS 抽风
——任何一种都不该让用户看到 500。发不出去的后果是"没收到邮件"，把异常放出去的
后果是"整个功能挂掉"，后者严重得多。

**不引入 SDK。** Resend 官方有 Python 包，但这个项目的部署是服务器上 git pull +
重启，加一个 pip 依赖会让某次部署在装包那步静默起不来。它的 API 就是一个 POST，
用仓库里已有的 httpx 直接发即可。

**收件地址不进日志。** 出错时只记域名和状态码：日志会被聚合、被转发、被贴进
工单，而一份"谁在什么时候申请了找回密码"的名单本身就是敏感信息。

Outbound email via Resend's HTTP API. Every failure path here logs and returns
False rather than raising: callers are user-facing request paths, and a provider
hiccup must degrade to "no email arrived", never to a 500. No SDK dependency —
the deploy flow is git pull + restart, and the API is a single POST. Recipient
addresses are never logged; a list of who requested a reset is itself sensitive.
"""
import logging
from dataclasses import dataclass

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.mailer")

_ENDPOINT = "https://api.resend.com/emails"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def mail_configured() -> bool:
    """发信通道是否可用。配置缺失不是错误，是"这套环境不发信"。"""
    return bool(settings.RESEND_API_KEY and settings.MAIL_FROM)


@dataclass(frozen=True)
class SendResult:
    """一次发信的结果。群发要分得清「这封信本身不行」与「现在发不了、待会再试」。

    - ok：发信商已接收。
    - status：发信商回的 HTTP 状态码；网络异常 / 没配置时为 None。
    - retryable：值得原样重发——限流（429）、发信商 5xx、网络超时。
    - config_error：发信商拒绝的是**我们的配置**（401 / 403：密钥无效、发信域名
      没验证）。这种错每封信都会一样错，群发应当整体暂停，而不是把全部收件人
      一个个标成失败。
    - quota：发信额度用完了——`"daily"` / `"monthly"`，否则 None。Resend 对额度
      用完和普通限流都回 429，只能靠响应体里的 `name`（`daily_quota_exceeded` /
      `monthly_quota_exceeded` / `rate_limit_exceeded`）分开。额度用完时**不算可
      重试**：原样重发只会再被拒，群发应当整体暂停等额度恢复。

    Outcome of one send. Bulk sending must tell "this message is bad" apart
    from "not now, retry later", from "our provider config is broken" (401 /
    403), and from "the sending quota is used up" (a 429 whose body names
    daily_ / monthly_quota_exceeded) — the last two fail identically for every
    recipient and should pause the whole run instead of burning through the list.
    """

    ok: bool
    status: int | None = None
    retryable: bool = False
    config_error: bool = False
    quota: str | None = None


# Resend 429 响应体里的 name → 额度种类 / 429 body name → quota kind
_QUOTA_ERRORS = {"daily_quota_exceeded": "daily", "monthly_quota_exceeded": "monthly"}


def _quota_kind(resp: httpx.Response) -> str | None:
    """429 是不是「额度用完」。响应体读不出来就当普通限流（照旧可重试）。"""
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001 —— 响应体不是 JSON 就不是额度错误
        return None
    name = body.get("name") if isinstance(body, dict) else None
    return _QUOTA_ERRORS.get(name) if isinstance(name, str) else None


def deliver(
    to: str,
    subject: str,
    html: str,
    text: str,
    headers: dict[str, str] | None = None,
) -> SendResult:
    """发一封信并返回细分结果。与 send_email 同样**绝不抛异常**。

    headers 用于群发的 List-Unsubscribe 之类邮件头；找回密码不需要。
    Send one message and report a detailed result; never raises. `headers` carries
    extras such as List-Unsubscribe for broadcasts.
    """
    if not mail_configured():
        logger.warning("mailer: RESEND_API_KEY 未配置，跳过发信 / not configured, skipping")
        return SendResult(ok=False)

    payload: dict = {
        "from": f"{settings.MAIL_FROM_NAME} <{settings.MAIL_FROM}>",
        "to": [to],
        "subject": subject,
        "html": html,
        "text": text,
    }
    if headers:
        payload["headers"] = headers
    domain = to.rpartition("@")[2] or "?"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(
                _ENDPOINT,
                headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
                json=payload,
            )
        status = resp.status_code
        if status >= 400:
            quota = _quota_kind(resp) if status == 429 else None
            # 只记域名，不记完整地址 —— 见模块说明。
            logger.error("mailer: 发信失败 domain=%s status=%s%s", domain, status,
                         f" quota={quota}" if quota else "")
            return SendResult(
                ok=False,
                status=status,
                retryable=(status == 429 and quota is None) or status >= 500,
                config_error=status in (401, 403),
                quota=quota,
            )
        return SendResult(ok=True, status=status)
    except Exception as exc:  # noqa: BLE001 —— 故意兜住一切，见模块说明
        logger.error("mailer: 发信异常 domain=%s err=%s", domain, type(exc).__name__)
        return SendResult(ok=False, retryable=True)


def send_email(to: str, subject: str, html: str, text: str) -> bool:
    """发一封信。成功返回 True；任何失败都返回 False 且不抛异常。

    同时带 html 与 text 两份正文不是可有可无：只发 HTML 的信在多数反垃圾评分
    里会被扣分，而国内邮箱服务商对境外发信源本来就严，能少扣一分是一分。
    """
    return deliver(to, subject, html, text).ok
