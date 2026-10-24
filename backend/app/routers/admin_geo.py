"""管理后台：用户分布、登录 IP、同 IP 账户（rev 48）。只给管理员；同 IP 只做提醒。
Admin-only: user geo distribution, login IPs and same-IP accounts (rev 48)."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.services import geo_distribution
from app.services.deps import require_admin
from app.services.ip_geo import normalize_ip

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/geo-distribution")
def geo_distribution_endpoint(
    scope: Literal["all", "7d", "30d"] = Query("all"),
    db: Session = Depends(get_db),
):
    return geo_distribution.distribution(db, scope)


@router.get("/users/{user_id}/ips")
def user_ips_endpoint(user_id: str, db: Session = Depends(get_db)):
    return geo_distribution.user_ips(db, user_id)


@router.get("/ips/{ip}/users")
def ip_users_endpoint(ip: str, db: Session = Depends(get_db)):
    canonical = normalize_ip(ip)
    if canonical is None:
        raise HTTPException(status_code=400, detail="IP 格式不对 / Invalid IP")
    return geo_distribution.ip_users(db, canonical)
