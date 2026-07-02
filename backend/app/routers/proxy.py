"""代理路由：Myfxbook 社区情绪抓取 / Proxy route: Myfxbook sentiment scraper"""
import asyncio

import requests
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

router = APIRouter(tags=["proxy"])

MYFXBOOK_URL = "https://www.myfxbook.com/community/outlook"


@router.get("/proxy/myfxbook", response_class=PlainTextResponse)
async def myfxbook_sentiment():
    """抓取 Myfxbook 社区情绪页面原始 HTML / fetch raw HTML of Myfxbook sentiment page"""
    resp = await asyncio.to_thread(
        requests.get,
        MYFXBOOK_URL,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.text
