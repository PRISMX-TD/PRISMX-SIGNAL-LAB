"""站点公开配置路由：不需要登录就能读的那部分平台设置。

目前只有官方社交主页地址。单开一个路由而不是挂在 payments/announcements 下：
社交链接既不是商业条款也不是公告内容，而落地页（未登录）和登录后的页脚都要
读它——挂在任何一个业务路由里都会让"为什么客服页要调支付接口"这种问题长期
存在。后续再有同类的公开配置（对外邮箱、App 下载地址之类）也放这里。

Public site config: the slice of platform settings readable without a login.

Today that is only the official social links. Its own router rather than a
corner of payments/announcements: social links are neither commercial terms
nor announcement content, and both the logged-out landing page and the
post-login footer need them. Future public config of the same kind (a contact
address, app download links) belongs here too.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services.settings_store import get_social_settings

router = APIRouter(prefix="/site", tags=["site"])


@router.get("/social", response_model=dict)
def get_social_links(db: Session = Depends(get_db)):
    """官方社交主页地址；没填的平台整个键都不返回。

    只返回填了的键，前端就不用在每个渲染点重复写"空字符串要跳过"——少一个
    容易漏的判断。读取侧已经把非 http(s) 的值过滤成空（见 settings_store），
    所以这里返回的每个值都能直接当 href 用。

    Official social links; platforms left unset are omitted entirely rather
    than returned as empty strings, so no render site has to repeat the
    skip-if-empty check. Non-http(s) values are already filtered out on read
    (see settings_store), so every value here is safe to use as an href.
    """
    s = get_social_settings(db)
    mapping = {
        "facebook": s["facebook_url"],
        "instagram": s["instagram_url"],
        "x": s["x_url"],
        "discord": s["discord_url"],
        "telegram": s["telegram_url"],
    }
    return {k: v for k, v in mapping.items() if v}
