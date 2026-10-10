"""登录测试账号、把 JWT 存回 creds.json（登录接口每 IP 10 次/分钟，所以慢慢来）。
Log the load-test users in and store their JWTs back into creds.json. The login
route allows 10/min per IP, so this paces itself and can run for an hour.

    python harvest.py --creds creds.json --base https://api.prismxsignallab.com [--interval 6.5] [--only-odd|--only-even]

--only-odd / --only-even 让两台机器（两个出口 IP）分头登录同一份名单。
"""
import argparse
import json
import os
import time
import urllib.error
import urllib.request


def save(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=0)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--interval", type=float, default=6.5)
    ap.add_argument("--only-odd", action="store_true")
    ap.add_argument("--only-even", action="store_true")
    ap.add_argument("--out", help="write tokens here instead of back into --creds (for a second machine)")
    a = ap.parse_args()
    data = json.load(open(a.creds))
    out_path = a.out or a.creds
    for u in data["users"]:
        if u.get("jwt"):
            continue
        if a.only_odd and u["i"] % 2 == 0 or a.only_even and u["i"] % 2 == 1:
            continue
        body = json.dumps({"email": u["email"], "password": data["password"]}).encode()
        while True:
            req = urllib.request.Request(a.base + "/api/auth/login", data=body,
                                         headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    u["jwt"] = json.loads(r.read())["token"]
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(30)
                    continue
                print("login failed", u["i"], e.code, e.read()[:200], flush=True)
                break
            except Exception as e:  # network blip
                print("login error", u["i"], repr(e), flush=True)
                time.sleep(10)
        save(out_path, data)
        done = sum(1 for x in data["users"] if x.get("jwt"))
        print(time.strftime("%H:%M:%S"), "user", u["i"], "ok; total with token:", done, flush=True)
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
