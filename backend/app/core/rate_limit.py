"""限流器：基于 slowapi，按客户端 IP 维度限速。
Rate limiter: slowapi-based, keyed by client IP.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

# 默认内存存储，单实例部署足够；多实例可通过 storage_uri 指向 Redis。
# In-memory storage by default (fine for a single instance); point storage_uri
# to Redis for multi-instance deployments.
limiter = Limiter(key_func=get_remote_address)
