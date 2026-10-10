"""本机压测库造数：N 个用户，各带一个网关 MT5 账号；JWT 用本机 JWT_SECRET 直接签。
Seed the LOCAL load-test database (never production): N users, each with one
gateway-channel MT5 account, JWTs minted with the local JWT_SECRET.

Run with the same env as the local backend (DATABASE_URL, JWT_SECRET, PYTHONPATH=backend):
    python seed_local.py --n 1000 --out creds-local.json
"""
import argparse
import json
import os
import secrets
import sys

from app.core.config import settings  # noqa: E402

assert "127.0.0.1" in settings.DATABASE_URL or "localhost" in settings.DATABASE_URL, \
    "refusing to seed a non-local database"

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.core.security import create_access_token, hash_api_token, hash_password  # noqa: E402
from app.models import MT5Account, User  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--n", type=int, default=1000)
ap.add_argument("--out", required=True)
a = ap.parse_args()

init_db()
seed = secrets.token_hex(16)
pw_hash = hash_password("local-loadtest-pw")
db = SessionLocal()
users = []
for i in range(1, a.n + 1):
    email = f"loadtest-{i:04d}@local.test"
    u = db.query(User).filter(User.email == email).first()
    if u is None:
        u = User(email=email, email_canonical=email, password_hash=pw_hash,
                 api_token=hash_api_token(f"lt-{seed}-{i}"), leaderboard_opt_out=True,
                 phone_required=False)
        db.add(u)
        db.flush()
        db.add(MT5Account(user_id=u.id, login=str(70000000 + i), server="MakeCapital-Live",
                          source="gateway", account_name="LOADTEST", account_currency="USD",
                          balance=10000.0, equity=10000.0, margin=0.0, leverage=100, trade_mode=0))
    else:
        u.api_token = hash_api_token(f"lt-{seed}-{i}")
    users.append({"i": i, "email": email, "jwt": create_access_token(u.id, u.token_version or 0),
                  "login": str(70000000 + i)})
    if i % 200 == 0:
        db.commit()
db.commit()
json.dump({"password": "local-loadtest-pw", "token_seed": seed, "users": users}, open(a.out, "w"))
print("seeded", len(users))
