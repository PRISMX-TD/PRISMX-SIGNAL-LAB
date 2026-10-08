"""运维脚本：按新规则复查存量昵称，并（可选）重建 users.nickname_key。

背景 / Background
-----------------
2026-10-08 起昵称多了几条规矩（设计 §1.17）：不许网址 / @账号 / 6 位以上连续数字
（nickname_forbidden），保留词检查改在去掉不可见字符之后做（nickname_reserved），
nickname_key 也开始剥掉 Unicode 控制符与格式符（Cc/Cf，零宽字符、双向覆盖）。
这些规则只在写入端生效——存量昵称没有被重新校验过，库里的 nickname_key 也还是
旧函数算的，含不可见字符的老昵称在重名判定上会漏。公开比赛页默认按昵称展示新参赛者，
所以打开 competitions_public_enabled 之前先跑一遍。

默认只读：列出不合新规则的昵称与 nickname_key 过时的行，不写库。
加 --rebuild-keys 才写：只更新 nickname_key 与新算法不一致、且改了不会撞唯一索引的行；
会撞的逐条打印出来交给人处理（改昵称），不动。昵称本身永远不改。

Re-checks stored nicknames against the 2026-10-08 rules and optionally rebuilds
users.nickname_key. Read-only by default. With --rebuild-keys it updates
nickname_key only where it differs from nickname_key() and no uniqueness
conflict arises; conflicts are printed for a human to resolve. Nicknames
themselves are never changed.

用法 / Usage
------------
从 backend/ 目录运行：

    python -m scripts.scan_nicknames                  # 只读预演
    python -m scripts.scan_nicknames --rebuild-keys   # 重建过时的 nickname_key
"""

from __future__ import annotations

import argparse
import sys

from app.services.gamification.identity import (
    nickname_forbidden, nickname_key, nickname_reserved, strip_invisible)


def nickname_issues(nickname: str | None, stored_key: str | None) -> list[str]:
    """一个昵称在新规则下的问题标签（纯函数，可单测）：
    forbidden（网址/@/长数字）、reserved（保留词）、invisible（含不可见字符）、
    key_stale（库里的 nickname_key 与新算法不一致）。没设昵称 → []。
    Issue tags for one nickname under the new rules; [] when unset."""
    if not nickname:
        return []
    issues = []
    if nickname_forbidden(nickname):
        issues.append("forbidden")
    if nickname_reserved(nickname):
        issues.append("reserved")
    if strip_invisible(nickname) != nickname:
        issues.append("invisible")
    if stored_key != nickname_key(nickname):
        issues.append("key_stale")
    return issues


def plan_key_rebuild(rows: list[tuple[str, str | None, str | None]]
                     ) -> tuple[dict[str, str], list[tuple[str, str, str]]]:
    """rows = [(user_id, nickname, stored_key)]。返回 (要写的 {user_id: 新 key}, 冲突列表
    [(user_id, 新 key, 原因)])。保守判冲突：新 key 等于**任何别人**库里现有的 key（哪怕那人
    也要改——逐行 UPDATE 时唯一索引是立即检查的），或几个人的新 key 撞在一起，都不写。
    新 key 为空（昵称全是不可见字符）也不写。冲突的行保留旧 key。
    Plans the nickname_key rebuild. Conservative: a new key equal to any other
    user's current key (even one that is itself changing — the unique index is
    checked per UPDATE) or shared by several rows is a conflict; an empty new
    key is never written. Conflicting rows keep their old key."""
    held = {stored: uid for uid, _nick, stored in rows if stored}
    stale: dict[str, str] = {}
    conflicts: list[tuple[str, str, str]] = []
    for uid, nick, stored in rows:
        if not nick:
            continue
        new = nickname_key(nick)
        if new == stored:
            continue
        if not new:
            conflicts.append((uid, new, "empty"))
        elif held.get(new, uid) != uid:
            conflicts.append((uid, new, f"taken by {held[new]}"))
        else:
            stale[uid] = new
    wanted: dict[str, list[str]] = {}
    for uid, new in stale.items():
        wanted.setdefault(new, []).append(uid)
    for new, uids in wanted.items():
        if len(uids) > 1:
            for u in uids:
                del stale[u]
                conflicts.append((u, new, "same new key as " + ",".join(x for x in uids if x != u)))
    return stale, conflicts


def main() -> int:
    parser = argparse.ArgumentParser(description="按新规则复查存量昵称 / re-check stored nicknames")
    parser.add_argument(
        "--rebuild-keys", action="store_true",
        help="更新过时且不冲突的 nickname_key；不加只读 / write stale non-conflicting keys",
    )
    args = parser.parse_args()

    from app.core.database import SessionLocal
    from app.models import User

    db = SessionLocal()
    try:
        rows = [(u.id, u.nickname, u.nickname_key)
                for u in db.query(User.id, User.nickname, User.nickname_key)
                           .filter(User.nickname.isnot(None)).all()]
        print(f"有昵称的用户 {len(rows)} 个")

        flagged = 0
        for uid, nick, stored in rows:
            issues = nickname_issues(nick, stored)
            if issues:
                flagged += 1
                print(f"  {uid}  {nick!r}  key={stored!r}  → {','.join(issues)}")
        print(f"有问题的昵称 {flagged} 个（forbidden / reserved 需人工处理，脚本不改昵称）")

        updates, conflicts = plan_key_rebuild(rows)
        print(f"\nnickname_key 可安全重建 {len(updates)} 个，冲突 {len(conflicts)} 个")
        for uid, new, why in conflicts:
            print(f"  冲突 {uid}  新 key={new!r}  {why}")

        if not args.rebuild_keys:
            print("\n只读预演，未写库。加 --rebuild-keys 重建可安全更新的 nickname_key。")
            return 0
        if not updates:
            print("没有要写的。")
            return 0
        for uid, new in updates.items():
            db.query(User).filter(User.id == uid).update(
                {User.nickname_key: new}, synchronize_session=False)
        db.commit()
        print(f"已更新 {len(updates)} 个 nickname_key。")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
