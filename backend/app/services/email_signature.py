"""每封邮件底部的品牌签名栏：logo + 官方社群 + 官网 + 官方邮箱。

社群链接直接读管理后台「官方社交主页」那份设置（settings_store.get_social_settings），
填了哪个平台就出哪个，没填的不出——与网站页脚同一条规则，不会留一个点不开的图标。

**图片只是锦上添花。** logo 与图标是放在网站 /email/ 下的 PNG（邮件客户端不认 SVG），
部分客户端默认屏蔽外链图片；签名栏的底色、文字和链接全部是 HTML，图片被挡时仍然
看得懂、点得开。每张图都写死 width/height，屏蔽时不会塌版。

**读不到设置也照常发信。** 签名栏是装饰，绝不能因为它让验证码、重置密码这类信发不出去：
读库出错就只是不显示社群那一行。

Brand signature banner appended to every outgoing email: logo, official
community links, website and contact address. Community links come straight
from the admin "official social links" setting — only filled platforms are
shown. Images (PNG under the site's /email/ path) are decorative: background,
text and links are all HTML so the banner still reads when images are blocked,
and every <img> has fixed dimensions. A settings read failure only drops the
community row; it never stops a message from being sent.
"""
from __future__ import annotations

import html as html_lib
import logging
from urllib.parse import urlsplit

from app.core.config import settings
from app.core.database import SessionLocal
from app.services.settings_store import get_social_settings

logger = logging.getLogger("prismx.email_signature")

_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"

# (设置键, 图标文件名, 显示名)，顺序即展示顺序 / (setting key, icon file, label), in display order
_SOCIALS = (
    ("facebook_url", "facebook", "Facebook"),
    ("instagram_url", "instagram", "Instagram"),
    ("x_url", "x", "X"),
    ("discord_url", "discord", "Discord"),
    ("telegram_url", "telegram", "Telegram"),
)


def _esc(s: str) -> str:
    return html_lib.escape(s, quote=True)


def _asset(name: str) -> str:
    return f"{(settings.PUBLIC_WEB_URL or '').rstrip('/')}/email/{name}.png"


def _social_links(db) -> list[tuple[str, str, str]]:
    """[(图标名, 显示名, 地址)]；读设置失败返回空列表。"""
    try:
        if db is not None:
            s = get_social_settings(db)
        else:
            with SessionLocal() as own:
                s = get_social_settings(own)
    except Exception:  # noqa: BLE001 —— 签名栏是装饰，读不到就不显示社群
        logger.warning("email signature: social settings unavailable", exc_info=True)
        return []
    return [(icon, label, s[key]) for key, icon, label in _SOCIALS if s.get(key)]


def render(db=None) -> tuple[str, str]:
    """返回 (html, text) 两段签名。db 为空时自己开一个会话读设置（命中缓存时不查库）。
    Return the (html, text) signature; opens its own session when db is None."""
    socials = _social_links(db)
    site = (settings.PUBLIC_WEB_URL or "").rstrip("/")
    site_label = urlsplit(site).netloc or site
    if site_label and not site_label.startswith("www."):
        site_label = f"www.{site_label}"
    contact = (settings.OFFICIAL_CONTACT_EMAIL or "").strip()

    link_style = "color:#e9ddff;text-decoration:none"
    social_html = ""
    if socials:
        items = "".join(
            f'<a href="{_esc(url)}" target="_blank" style="display:inline-block;margin:0 9px 10px;{link_style};font-size:15px;line-height:28px;white-space:nowrap">'
            f'<img src="{_esc(_asset(icon))}" width="28" height="28" alt="" style="display:inline-block;vertical-align:middle;border:0;margin-right:8px">'
            f'<span style="vertical-align:middle">{_esc(label)}</span></a>'
            for icon, label, url in socials
        )
        social_html = f'<div style="margin:0 0 4px">{items}</div>'

    contact_bits = []
    if site:
        contact_bits.append(f'<a href="{_esc(site)}" target="_blank" style="{link_style}">{_esc(site_label)}</a>')
    if contact:
        contact_bits.append(f'<a href="mailto:{_esc(contact)}" style="{link_style}">{_esc(contact)}</a>')
    contact_html = (
        '<div style="font-size:13px;line-height:22px;color:#c8b8e8">'
        + "".join(f'<span style="display:inline-block;margin:0 11px 4px">{b}</span>' for b in contact_bits)
        + "</div>"
    )

    logo = (
        f'<a href="{_esc(site)}" target="_blank" style="text-decoration:none">'
        f'<img src="{_esc(_asset("logo"))}" width="207" height="71" alt="信号实验室 SIGNAL LAB" '
        f'style="display:block;border:0;color:#e9ddff;font-size:18px;font-weight:700"></a>'
    )
    html = (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0614" '
        'style="margin:28px 0 0;border-collapse:separate;border-radius:12px;background-color:#0b0614;'
        'background-image:linear-gradient(90deg,#000000 0%,#110820 55%,#1d0d33 100%)">'
        '<tr><td align="center" style="padding:20px 16px 6px">'
        '<div style="display:inline-block;vertical-align:middle;width:207px;margin:0 16px 12px;text-align:left">'
        f"{logo}</div>"
        '<div style="display:inline-block;vertical-align:middle;max-width:400px;margin:0 16px 12px;text-align:center;'
        f'font-family:{_FONT}">{social_html}{contact_html}</div>'
        "</td></tr>"
        '<tr><td style="padding:0 20px 14px"><div style="height:1px;line-height:1px;font-size:1px;background-color:#3b1f63">&nbsp;</div></td></tr>'
        "</table>"
    )

    lines = ["PRISMX Signal Lab · 信号实验室"]
    lines += [f"{label}: {url}" for _, label, url in socials]
    if site:
        lines.append(site_label)
    if contact:
        lines.append(contact)
    return html, "\n".join(lines)
