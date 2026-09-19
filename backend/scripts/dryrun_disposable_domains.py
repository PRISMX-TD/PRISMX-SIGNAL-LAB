"""上线前体检：拿现有用户跑一遍一次性邮箱判定，看会命中谁。

用法 / Usage
------------
    cd backend
    DATABASE_URL=postgresql://...  python -m scripts.dryrun_disposable_domains

只读，不改任何数据。做两件事：

  1. **误伤体检** —— 按域名分组打印所有会被判定为一次性邮箱的存量账号，附上
     各自的 plan 和注册时间。名单里如果出现明显是真人的域名（尤其是国内的、
     或者带付费用户的），说明快照或判定有问题，别急着上线。
  2. **规模摸底** —— 一次性邮箱在存量里到底占多少，决定这件事值不值得做，
     也是"存量要不要清理"的判断依据。

这个脚本存在的理由：闸门只拦新注册，存量用户按产品决定全部豁免（他们不再走
注册接口，所以豁免是天然的、不需要标记列）。但"豁免"不等于"不用看"——存量
里有多少一次性邮箱、集中在哪些域名，直接说明新规则上线后会挡掉多少人。

Read-only pre-launch check: runs the live gate against every existing user and
groups the hits by domain, with plan and signup date. The gate only ever blocks
new registrations (existing users are grandfathered automatically, since they
never hit the register endpoint again), but this is how you find out whether the
snapshot would have false-positived real people — and how big the problem is.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database import SessionLocal  # noqa: E402
from app.models import User  # noqa: E402
from app.services.gamification.identity import mask_name  # noqa: E402
from app.services.email_domains import domain_of, is_disposable_email  # noqa: E402


def _masked_email(email: str | None) -> str:
    """打码的邮箱：本地部分只留首尾（`identity.mask_name`，与榜单展示同一把尺），
    域名原样——这个脚本的重点本来就是域名。

    为什么要打码：这是只读体检，由运维手动跑，但 stdout 常常被重定向进日志或贴进
    工单，完整邮箱就这么散出去了。判断「这个域名是不是误伤」看的是域名和人数，
    不需要看清具体是谁；真要核对到人，直接查库。
    Masked email: the local part keeps only its first and last character (via
    identity.mask_name, the same ruler the boards use), the domain is untouched
    since the domain is what this script is about. The output of this read-only
    check routinely gets redirected into a log or pasted into a ticket, and
    deciding whether a domain is a false positive needs the domain and the count,
    not the identity. Look the person up in the database if you truly need one.
    """
    local, _, domain = (email or "").partition("@")
    return f"{mask_name(local)}@{domain}" if domain else mask_name(local)


def main() -> int:
    db = SessionLocal()
    try:
        users = db.query(User).all()
        total = len(users)
        if not total:
            print("库里没有用户 / no users in this database")
            return 0

        hits: dict[str, list[User]] = defaultdict(list)
        all_domains: dict[str, int] = defaultdict(int)
        for u in users:
            d = domain_of(u.email or "")
            all_domains[d] += 1
            if is_disposable_email(db, u.email or ""):
                hits[d].append(u)

        hit_users = sum(len(v) for v in hits.values())
        print(f"存量用户 {total} 人，{len(all_domains)} 个域名")
        print(f"会被判定为一次性邮箱：{hit_users} 人（{hit_users / total * 100:.1f}%），{len(hits)} 个域名\n")

        if hits:
            print("命中明细（按人数降序）/ hits by domain:")
            for d, us in sorted(hits.items(), key=lambda kv: -len(kv[1])):
                paid = sum(1 for u in us if (u.plan or "FREE") != "FREE")
                flag = "  <-- 含付费用户，务必人工确认" if paid else ""
                print(f"  {d}: {len(us)} 人，其中付费 {paid} 人{flag}")
                for u in us[:5]:
                    created = u.created_at.strftime("%Y-%m-%d") if u.created_at else "?"
                    print(f"      {_masked_email(u.email)}  plan={u.plan}  注册于 {created}")
                if len(us) > 5:
                    print(f"      ... 另有 {len(us) - 5} 人")
            print()

        print("存量域名分布前 30 / top 30 domains overall:")
        for d, n in sorted(all_domains.items(), key=lambda kv: -kv[1])[:30]:
            mark = "  [会被拦]" if d in hits else ""
            print(f"  {d}: {n}{mark}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
