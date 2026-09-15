"""刷新打包的一次性邮箱域名快照，并做一次误伤体检。

用法 / Usage
------------
    cd backend
    python -m scripts.update_disposable_domains            # 只看差异，不写文件
    python -m scripts.update_disposable_domains --write    # 确认无误后再写

为什么要有"只看差异"这一步
--------------------------
上游列表的内容不由我们控制，而这个文件直接决定谁注册不进来。各家一次性邮箱
列表把正规邮箱误列进去是真实发生过的事，国内那批名字不像邮箱的（yeah.net、
188.com、21cn.com、tom.com、sina.cn、wo.cn）尤其容易中招。所以默认不写，先
把三样东西打印出来给人看：

  1. **与内置放行表的冲突** —— 上游把我们明确要放行的域名列进来了。运行时
     放行前置短路会保护用户（见 services/email_domains.py），但出现冲突说明
     上游这一版的判断有问题，值得先看一眼再决定要不要用。
  2. 新增了哪些、删掉了哪些（只印数量和前若干条，几千条全印没人看）
  3. 被丢弃的非法条目——尤其是**不含点的裸 TLD**：快照里混进一个 "com" 会
     按父域匹配挡掉全世界，这个脚本必须拦住它。

Refreshes the vendored disposable-domain snapshot. Defaults to a dry run because
this file decides who can register: it first prints conflicts with the built-in
allowlist (upstream lists have historically mislabelled legitimate mailboxes,
especially the Chinese ones), the added/removed counts, and any rejected entries
— bare TLDs above all, since one "com" in the snapshot would block everyone via
parent-domain matching. Pass --write once the diff looks right.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # noqa: E402

from app.services.email_domains import ALLOW_DOMAINS, _DATA_PATH, normalize_domain  # noqa: E402

UPSTREAM = (
    "https://raw.githubusercontent.com/disposable-email-domains/"
    "disposable-email-domains/main/disposable_email_blocklist.conf"
)

_HEADER = """# 一次性邮箱域名快照 / disposable-email domain snapshot
#
# 这是打包进仓库的**数据文件**，不是配置：注册路径读它，永远不联网拉取。
# 更新方式：python -m scripts.update_disposable_domains --write
# 手改也行，一行一个域名，# 开头是注释。
#
# 注意：这里**不需要**、也不应该出现任何正规邮箱域名。放行由
# services/email_domains.py 的 ALLOW_DOMAINS 前置短路负责，就算这个文件里
# 混进了 163.com，运行时也伤不到人——但那说明上游列表有问题，应该修这里。
#
# This is a vendored data file, not config: the registration path reads it and
# never fetches over the network. One domain per line; # starts a comment.
#
# 上游 / upstream: {upstream}
"""


def _read_current() -> set[str]:
    try:
        with open(_DATA_PATH, encoding="utf-8") as f:
            return {
                line.strip().lower()
                for line in f
                if line.strip() and not line.startswith("#")
            }
    except OSError:
        return set()


def main() -> int:
    write = "--write" in sys.argv

    print(f"拉取 / fetching {UPSTREAM}")
    resp = requests.get(UPSTREAM, timeout=30)
    resp.raise_for_status()

    fetched: set[str] = set()
    rejected: list[str] = []
    for line in resp.text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        d = normalize_domain(raw)
        if not d:
            # 不含点的裸 TLD 会在这里被 normalize_domain 判成非法，正是我们要拦的。
            rejected.append(raw)
            continue
        fetched.add(d)

    if not fetched:
        print("上游返回空列表，中止 / upstream returned nothing, aborting")
        return 1

    current = _read_current()
    added = sorted(fetched - current)
    removed = sorted(current - fetched)
    conflicts = sorted(d for d in fetched if d in ALLOW_DOMAINS)

    print(f"\n上游 {len(fetched)} 条；本地 {len(current)} 条")
    print(f"新增 {len(added)} 条，移除 {len(removed)} 条")

    if rejected:
        print(f"\n!! 丢弃 {len(rejected)} 条非法条目（裸 TLD / 带空格 / 没有点）:")
        for d in rejected[:20]:
            print(f"   {d}")

    if conflicts:
        print(f"\n!! 与内置放行表冲突 {len(conflicts)} 条 —— 上游把这些正规邮箱列成了一次性邮箱:")
        for d in conflicts:
            print(f"   {d}")
        print("   运行时放行短路会保护用户，但请确认上游这一版是否可信。")
    else:
        print("\n√ 与内置放行表无冲突（国内主流邮箱一个都没被上游列进来）")

    if added:
        print(f"\n新增前 20 条 / first 20 added:")
        for d in added[:20]:
            print(f"   + {d}")
    if removed:
        print(f"\n移除前 20 条 / first 20 removed:")
        for d in removed[:20]:
            print(f"   - {d}")

    if not write:
        print("\n（未写入。确认无误后加 --write）")
        return 0

    # 冲突项不写进快照：运行时放行本来就赢，留在文件里只会让下次有人读这个
    # 文件时以为我们真的在拦 qq.com。
    # Conflicting entries are dropped from the snapshot — allow wins at runtime
    # anyway, and keeping them would mislead the next person reading the file.
    final = sorted(fetched - ALLOW_DOMAINS)
    with open(_DATA_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(_HEADER.format(upstream=UPSTREAM))
        for d in final:
            f.write(d + "\n")
    print(f"\n已写入 {len(final)} 条 -> {_DATA_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
