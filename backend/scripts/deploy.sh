#!/usr/bin/env bash
# PRISMX 后端部署脚本 —— 在 VPS 上以 ubuntu 用户运行。
#
# 正常由 GitHub Actions（.github/workflows/deploy-backend.yml）通过 SSH 触发；
# 也可以登上 VPS 手动跑：  su - ubuntu -c 'bash ~/PRISMX-SIGNAL-LAB/backend/scripts/deploy.sh'
#
# 流程：fetch → 只允许 fast-forward 合并（本地有改动会直接失败，不会悄悄覆盖）
#       → requirements.txt 变了才 pip install → systemctl restart prismx
#       → 轮询健康检查；超时则回滚到上一个 commit 并再重启。
#
# 依赖 VPS 上两处一次性配置（见运维手册 2.2）：
#   1) ubuntu 对下面两条命令免密 sudo：
#        /usr/bin/systemctl restart prismx
#        /usr/bin/journalctl -u prismx -n 60 --no-pager
#   2) 仓库在 /home/ubuntu/PRISMX-SIGNAL-LAB，venv 在 backend/.venv
#
# ---------------------------------------------------------------------------
# 这个脚本记着三件事（都在 $STATE_DIR 下），因为 git 工作区本身答不了它们：
#
#   1) last-good-commit —— 上一次**健康检查真的通过**的 commit。
#      不能拿 HEAD 判断「要不要部署」：装依赖失败会让脚本在「代码已 ff 到新
#      commit、服务还跑着旧代码」的状态下退出，下一次重跑时 HEAD 已经等于
#      origin/main，于是打印「已是最新，无需部署」并 exit 0——服务里跑的仍是
#      旧代码，脚本和 Actions 却都报绿。只有这个文件能区分「装好了」和「ff 过了」。
#
#   2) failed-commits —— 部署失败并已回滚的 commit。
#      回滚只动 VPS 的工作区，origin/main 仍指着那个坏 commit；下一次触发
#      （另一个人推一次、或 workflow_dispatch）会再 ff 到同一个坏 commit、
#      再失败、再回滚，每一轮都伴随两次 systemctl restart。而重启 = 下单中断。
#      记下来，第二次直接拒绝，把人推向「修好再推一个新 commit」。
#
#   3) db-snapshots/ —— 重启前的数据库快照（有 pg_dump 时）。
#      迁移跑在应用启动时、是单向的、且含 DROP TABLE；回滚代码并不会回滚 schema。
#
# 可调环境变量：
#   PRISMX_HEALTH_DB_URL       额外的健康检查地址，要求它也回 200（用来验证数据库
#                              真的连得上；默认的 "/" 只证明进程绑上了端口）
#   PRISMX_ALLOW_SCHEMA_ROLLBACK=1
#                              允许在 schema_rev 已经变化的情况下自动回滚代码
#   PRISMX_SKIP_DB_SNAPSHOT=1  跳过 pg_dump 快照
#   PRISMX_FORCE=1             无视 failed-commits 的记忆，强行重试同一个 commit
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${PRISMX_REPO_DIR:-$HOME/PRISMX-SIGNAL-LAB}"
BRANCH="${PRISMX_BRANCH:-main}"
SERVICE="${PRISMX_SERVICE:-prismx}"
HEALTH_URL="${PRISMX_HEALTH_URL:-http://127.0.0.1:8000/}"
HEALTH_TIMEOUT="${PRISMX_HEALTH_TIMEOUT:-60}"   # 秒；服务启动约 1-2 秒，留足余量
PIP="$REPO/backend/.venv/bin/pip"

STATE_DIR="${PRISMX_DEPLOY_STATE:-$HOME/.prismx-deploy}"
LAST_GOOD_FILE="$STATE_DIR/last-good-commit"
FAILED_FILE="$STATE_DIR/failed-commits"
SNAPSHOT_DIR="$STATE_DIR/db-snapshots"
DB_SNAPSHOT=""

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "❌ $*"; exit 1; }

[ "$(id -un)" != root ] || die "请以 ubuntu 用户运行，不要用 root（会把文件属主改坏）"
[ -d "$REPO/.git" ] || die "找不到仓库：$REPO"
[ -x "$PIP" ] || die "找不到 venv：$PIP"

mkdir -p "$STATE_DIR"

# ---------- 数据库相关的只读辅助 ----------
# 都是「尽力而为」：读不到就降级并说清楚，绝不因为读不到数据库信息而中断部署。

find_database_url() {
  if [ -n "${DATABASE_URL:-}" ]; then
    printf '%s' "$DATABASE_URL"
    return 0
  fi
  local f v
  for f in "$REPO/backend/.env" "$REPO/.env"; do
    [ -f "$f" ] || continue
    v=$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$f" | tail -n 1)
    v=${v%$'\r'}
    v=${v%\"}; v=${v#\"}
    v=${v%\'}; v=${v#\'}
    if [ -n "$v" ]; then
      printf '%s' "$v"
      return 0
    fi
  done
  return 1
}

# SQLAlchemy 写法是 postgresql+psycopg://…，libpq 不认那个 +driver 后缀。
pg_url() {
  printf '%s' "$1" | sed -E 's#^postgres(ql)?\+[A-Za-z0-9_]+://#postgresql://#'
}

# 读库里记的迁移版本号（backend/app/core/database.py 的 schema_rev）。
# 读不到就回非零，调用方按"未知"处理。
read_schema_rev() {
  local url raw
  url=$(find_database_url) || return 1
  case "$url" in postgres*) ;; *) return 1 ;; esac
  command -v psql >/dev/null 2>&1 || return 1
  raw=$(psql "$(pg_url "$url")" -At -w \
        -c "SELECT value FROM platform_settings WHERE key = 'schema_rev'" 2>/dev/null) || return 1
  [ -n "$raw" ] || return 1
  printf '%s' "$raw" | tr -d '"'
}

# 重启前留一份数据库快照。迁移跑在应用启动时、单向、且含 DROP TABLE——
# 回滚代码救不了 schema，只有这份快照能。失败不阻断部署，但会明说没有快照。
snapshot_db() {
  if [ "${PRISMX_SKIP_DB_SNAPSHOT:-0}" = "1" ]; then
    log "已按 PRISMX_SKIP_DB_SNAPSHOT=1 跳过数据库快照"
    return 0
  fi
  local url out
  url=$(find_database_url) || { log "⚠ 读不到 DATABASE_URL，本次没有数据库快照"; return 0; }
  case "$url" in postgres*) ;; *) log "⚠ 非 Postgres，跳过数据库快照"; return 0 ;; esac
  command -v pg_dump >/dev/null 2>&1 || { log "⚠ 没装 pg_dump，本次没有数据库快照"; return 0; }

  mkdir -p "$SNAPSHOT_DIR"
  out="$SNAPSHOT_DIR/pre-${new:0:7}-$(date +%Y%m%d-%H%M%S).dump"

  if pg_dump -Fc -f "$out" "$(pg_url "$url")" 2>/dev/null; then
    DB_SNAPSHOT="$out"
    log "数据库快照：$out"
    # 只留最近 5 份，别把磁盘吃满
    ls -1t "$SNAPSHOT_DIR"/*.dump 2>/dev/null | tail -n +6 | xargs -r rm -f
  else
    rm -f "$out"
    log "⚠ pg_dump 失败，本次没有数据库快照（不阻断部署）"
  fi
}

# ---------- 取版本 ----------
cd "$REPO"
git fetch -q origin "$BRANCH"

old=$(git rev-parse HEAD)
new=$(git rev-parse "origin/$BRANCH")
last_good=$(cat "$LAST_GOOD_FILE" 2>/dev/null || true)

# 这个 commit 上次部署失败过并被回滚：再来一遍只会得到同样的结果，外加两次
# systemctl restart（= 两次下单中断）。拦在这里，逼人推一个新 commit。
if [ "${PRISMX_FORCE:-0}" != "1" ] && [ -f "$FAILED_FILE" ] && grep -qxF "$new" "$FAILED_FILE"; then
  log "commit ${new:0:7} 之前部署失败过并已回滚，这次拒绝再试。"
  log "  · 修好问题后推一个新 commit；"
  log "  · 确实要重试同一个 commit：PRISMX_FORCE=1 再跑一次，"
  log "    或从 $FAILED_FILE 里删掉这一行。"
  die "拒绝重复部署已知失败的 commit ${new:0:7}"
fi

if [ "$old" = "$new" ]; then
  if [ "$last_good" = "$new" ]; then
    log "已是最新（${old:0:7}），且上次部署已验证健康，无需部署"
    exit 0
  fi
  # 工作区已经是新代码，却没有「这个 commit 部署成功过」的记录：上一次多半是在
  # 装依赖那一步挂了（ff 已完成、restart 没执行）。旧实现在这里 exit 0，服务
  # 里跑着旧代码而 Actions 报绿——正是那个静默的"部署成功但根本没上线"。
  log "工作区已在 ${new:0:7}，但没有部署成功的记录（上次可能中断在装依赖）；继续走完部署"
else
  log "更新 ${old:0:7} → ${new:0:7}"
  git log --oneline --no-decorate "$old..$new" | sed 's/^/    /'

  if ! git merge -q --ff-only "origin/$BRANCH"; then
    die "无法 fast-forward：VPS 本地有未提交改动或分叉。登上 VPS 检查 'git status'，处理后再推。"
  fi
fi

requirements_changed() { ! git diff --quiet "$1" "$2" -- backend/requirements.txt; }

install_deps() {
  log "requirements.txt 有变化，安装依赖"
  "$PIP" install -q -r backend/requirements.txt
}

wait_healthy() {
  local i
  for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
      # 默认的 "/" 只证明进程绑上了端口，不证明数据库连得上、迁移没被吞掉。
      # 配了 PRISMX_HEALTH_DB_URL 就必须它也通过，才算真的健康。
      if [ -n "${PRISMX_HEALTH_DB_URL:-}" ]; then
        curl -fsS -m 5 "$PRISMX_HEALTH_DB_URL" >/dev/null 2>&1 || { sleep 1; continue; }
      fi
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_service() {
  log "重启 $SERVICE"
  sudo -n /usr/bin/systemctl restart "$SERVICE" \
    || die "systemctl restart 失败（免密 sudo 没配好？见运维手册 2.2）"
}

# ---------- 装依赖 ----------
# 装依赖失败绝不能就这么退出：工作区已经 ff 到新代码了，下次重跑会被当成
# 「已是最新」。把工作区退回旧 commit，让状态和"服务里跑的东西"重新对上。
if requirements_changed "$old" "$new"; then
  if ! install_deps; then
    log "装依赖失败，把工作区退回 ${old:0:7}，保持与正在运行的服务一致"
    git reset -q --hard "$old" || log "⚠ 回退工作区也失败了，请手工检查 git status"
    die "pip install 失败，本次没有上线任何东西（服务仍在 ${old:0:7}）。修好后重推。"
  fi
fi

# ---------- 重启前：记下 schema 版本 + 留快照 ----------
schema_before=$(read_schema_rev || true)
log "部署前 schema_rev：${schema_before:-未知（读不到数据库，见下）}"
snapshot_db

restart_service

if wait_healthy; then
  log "✅ 部署完成：${new:0:7} 已在线"
  printf '%s\n' "$new" > "$LAST_GOOD_FILE"
  exit 0
fi

# ---------- 健康检查失败：回滚 ----------
log "健康检查 ${HEALTH_TIMEOUT}s 内未通过，最近日志："
sudo -n /usr/bin/journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | sed 's/^/    /' || true

# 这个 commit 从此进黑名单，下次触发直接被拦下（见文件头第 2 条）。
printf '%s\n' "$new" >> "$FAILED_FILE"

schema_after=$(read_schema_rev || true)
log "schema_rev：部署前 ${schema_before:-未知} → 现在 ${schema_after:-未知}"

# 迁移跑在应用启动时（database.py 的 _migrate_columns，注释里写明"在 uvicorn 绑端口
# 之前"），是单向的，重建表那条路径含 ALTER TABLE ... RENAME 与 DROP TABLE。
# 也就是说：新版本已经把 schema 改掉了，只回滚代码 = 旧代码跑在新 schema 上。
if [ -n "$schema_before" ] && [ -n "$schema_after" ] && [ "$schema_before" != "$schema_after" ]; then
  if [ "${PRISMX_ALLOW_SCHEMA_ROLLBACK:-0}" != "1" ]; then
    log ""
    log "🛑 这次部署已经把数据库 schema 从 $schema_before 迁到了 $schema_after，"
    log "   而迁移是单向的（只有 ADD COLUMN 与表重建，没有 downgrade）。"
    log "   只回滚代码会让旧代码跑在新 schema 上，因此**不自动回滚**，等你明确确认。"
    log ""
    log "   数据库快照：${DB_SNAPSHOT:-本次没有（pg_dump 不可用或被跳过）}"
    if [ -n "$DB_SNAPSHOT" ]; then
      log "   恢复库：pg_restore --clean --if-exists -d \"\$DATABASE_URL\" '$DB_SNAPSHOT'"
    fi
    log ""
    log "   确认旧代码能在新 schema 上跑（或已经恢复了库）之后，执行："
    log "     PRISMX_ALLOW_SCHEMA_ROLLBACK=1 bash $REPO/backend/scripts/deploy.sh"
    log "   要先把服务弄起来看日志：sudo systemctl restart $SERVICE；journalctl -u $SERVICE -f"
    die "新版本 ${new:0:7} 启动失败，且 schema 已变化（$schema_before → $schema_after），已停在此处等人工确认"
  fi
  log "已按 PRISMX_ALLOW_SCHEMA_ROLLBACK=1 继续回滚（schema $schema_before → $schema_after 不会被回退）"
elif [ -z "$schema_before" ] || [ -z "$schema_after" ]; then
  log "⚠ 读不到 schema_rev（没装 psql / 找不到 DATABASE_URL / 不是 Postgres），"
  log "  无法判断这次是否动过 schema。仍然继续回滚以尽快恢复服务，但请自行核对。"
fi

log "回滚到 ${old:0:7}"
git reset -q --hard "$old"

# 回滚路径里装依赖失败不能中断回滚：这里本来就是在救火，一次 pip 网络抖动
# 不该把服务永久留在不健康的新版本上。restart 必须执行。
if requirements_changed "$old" "$new"; then
  install_deps || log "⚠ 回滚时装依赖失败，仍继续重启（依赖可能仍是新版的，注意核对）"
fi

restart_service

if wait_healthy; then
  die "新版本 ${new:0:7} 启动失败，已回滚到 ${old:0:7}（服务恢复）。请看上面的日志修复后再推。
该 commit 已记入 $FAILED_FILE，再次推同一个 commit 会被直接拒绝。"
else
  die "回滚后服务仍不健康！请立刻登上 VPS：journalctl -u $SERVICE -f"
fi
