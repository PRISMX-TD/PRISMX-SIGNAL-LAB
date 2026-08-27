"""API Token 路由：网页端查看/重置连接 MT5 所用的专属 Token。
API token router: view/reset the per-user token used to connect MT5.

历史上本路由还承载 EA 的账号登记、后缀与在线状态端点，这几个已经移除：交易
账号现在有两条接入通道，PRISMX Bridge（/api/bridge/*，用户机上的桌面程序）与
券商直连网关（/api/gateway/*），按 mt5_accounts.source 区分。

注意别把上面那句读成「EA 已经不用了」：被移除的只是**账号登记**这一块。行情
推送的 EA 通道仍在跑，而且是全站唯一的喂价来源——K 线与报价都由
PRISMX_MarketFeed.mq5 推到 /api/feed/*（见 routers/chart.py），多周期趋势推到
/api/webhook/trend。停掉它，图表、策略求值与信号胜负判定会一起断粮。

This router historically also served the EA's account registration, suffix and
status endpoints; those are gone. Trading accounts now arrive through two
channels — the PRISMX Bridge (/api/bridge/*, a desktop app on the user's
machine) and the direct broker gateway (/api/gateway/*) — told apart by
mt5_accounts.source.

Do not read that as "the EA is no longer used": only account registration was
removed. The EA's market-data channel is still running and is the sole price
feed for the whole platform — PRISMX_MarketFeed.mq5 pushes candles and quotes to
/api/feed/* (see routers/chart.py) and multi-timeframe trends to
/api/webhook/trend. Stop it and charts, strategy evaluation and signal
resolution all lose their input at once.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import generate_api_token, hash_api_token
from app.models import MT5Account, User
from app.routers.bridge import invalidate_auth_cache_for_hash
from app.schemas import EATokenOut
from app.services.deps import get_current_user

router = APIRouter(prefix="/ea", tags=["ea"])


def _primary_login(db: Session, user_id: str) -> str | None:
    """取第一个已上报账号作为展示用主账号 / first reported account for display."""
    acc = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user_id)
        .order_by(MT5Account.login.asc())
        .first()
    )
    return acc.login if acc else None


@router.get("/token", response_model=EATokenOut)
def get_token(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """获取主账号信息；Token 以哈希存储无法回显（仅生成时显示一次）。
    Get the primary account; the token is stored hashed and cannot be
    displayed again (shown only once at generation)."""
    return EATokenOut(apiToken=None, boundAccount=_primary_login(db, user.id))


@router.post("/token/reset", response_model=EATokenOut)
def reset_token(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """重置 API Token（旧 Token 立即失效）。明文仅在本响应中出现一次，
    数据库只存哈希。/ Reset the API token (old one invalidated). The plaintext
    appears only in this response; the DB keeps just the hash."""
    # 旧 Token 的哈希（即当前落库值）：改库后主动清掉桥接鉴权缓存里对应的条目，
    # 否则旧 Token 还能在缓存 TTL（约 10 秒）内继续通过鉴权——重置本就是为了
    # 封掉一个可能已泄露的 Token，这个窗口必须归零。
    # The old token's hash (the current stored value): after rotating it, drop the
    # matching entry from the bridge auth cache, or the old token would still pass
    # auth for up to the cache TTL (~10s). Reset exists to kill a possibly-leaked
    # token, so that window must be zero.
    old_hash = user.api_token
    raw = generate_api_token()
    user.api_token = hash_api_token(raw)
    db.commit()
    invalidate_auth_cache_for_hash(old_hash)
    return EATokenOut(apiToken=raw, boundAccount=_primary_login(db, user.id))
