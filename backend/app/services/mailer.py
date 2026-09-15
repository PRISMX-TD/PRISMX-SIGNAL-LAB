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

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.mailer")

_ENDPOINT = "https://api.resend.com/emails"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def mail_configured() -> bool:
    """发信通道是否可用。配置缺失不是错误，是"这套环境不发信"。"""
    return bool(settings.RESEND_API_KEY and settings.MAIL_FROM)


def send_email(to: str, subject: str, html: str, text: str) -> bool:
    """发一封信。成功返回 True；任何失败都返回 False 且不抛异常。

    同时带 html 与 text 两份正文不是可有可无：只发 HTML 的信在多数反垃圾评分
    里会被扣分，而国内邮箱服务商对境外发信源本来就严，能少扣一分是一分。
    """
    if not mail_configured():
        logger.warning("mailer: RESEND_API_KEY 未配置，跳过发信 / not configured, skipping")
        return False

    payload = {
        "from": f"{settings.MAIL_FROM_NAME} <{settings.MAIL_FROM}>",
        "to": [to],
        "subject": subject,
        "html": html,
        "text": text,
    }
    domain = to.rpartition("@")[2] or "?"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(
                _ENDPOINT,
                headers={"Authorization": f"Bearer {settings.RESEND_API_KEY}"},
                json=payload,
            )
        if resp.status_code >= 400:
            # 只记域名，不记完整地址 —— 见模块说明。
            logger.error("mailer: 发信失败 domain=%s status=%s", domain, resp.status_code)
            return False
        return True
    except Exception as exc:  # noqa: BLE001 —— 故意兜住一切，见模块说明
        logger.error("mailer: 发信异常 domain=%s err=%s", domain, type(exc).__name__)
        return False
