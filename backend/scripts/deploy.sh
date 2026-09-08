#!/usr/bin/env bash
# PRISMX 后端部署脚本 —— 在 VPS 上以 ubuntu 用户运行。
#
# 正常由 GitHub Actions（.github/workflows/deploy-backend.yml）通过 SSH 触发；
# 也可以登上 VPS 手动跑：  su - ubuntu -c 'bash ~/PRISMX-SIGNAL-LAB/backend/scripts/deploy.sh'
#
# 流程：fetch → 只允许 fast-forward 合并（本地有改动会直接失败，不会悄悄覆盖）
#       → requirements.txt 变了才 pip install → systemctl restart prismx
#       → 轮询 http://127.0.0.1:8000/ 直到健康；超时则回滚到上一个 commit 并再重启。
#
# 依赖 VPS 上两处一次性配置（见运维手册 2.2）：
#   1) ubuntu 对下面两条命令免密 sudo：
#        /usr/bin/systemctl restart prismx
#        /usr/bin/journalctl -u prismx -n 60 --no-pager
#   2) 仓库在 /home/ubuntu/PRISMX-SIGNAL-LAB，venv 在 backend/.venv
set -euo pipefail

REPO="${PRISMX_REPO_DIR:-$HOME/PRISMX-SIGNAL-LAB}"
BRANCH="${PRISMX_BRANCH:-main}"
SERVICE="${PRISMX_SERVICE:-prismx}"
HEALTH_URL="${PRISMX_HEALTH_URL:-http://127.0.0.1:8000/}"
HEALTH_TIMEOUT="${PRISMX_HEALTH_TIMEOUT:-60}"   # 秒；服务启动约 1-2 秒，留足余量
PIP="$REPO/backend/.venv/bin/pip"

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "❌ $*"; exit 1; }

[ "$(id -un)" != root ] || die "请以 ubuntu 用户运行，不要用 root（会把文件属主改坏）"
[ -d "$REPO/.git" ] || die "找不到仓库：$REPO"
[ -x "$PIP" ] || die "找不到 venv：$PIP"

cd "$REPO"
git fetch -q origin "$BRANCH"

old=$(git rev-parse HEAD)
new=$(git rev-parse "origin/$BRANCH")

if [ "$old" = "$new" ]; then
  log "已是最新（${old:0:7}），无需部署"
  exit 0
fi

log "更新 ${old:0:7} → ${new:0:7}"
git log --oneline --no-decorate "$old..$new" | sed 's/^/    /'

if ! git merge -q --ff-only "origin/$BRANCH"; then
  die "无法 fast-forward：VPS 本地有未提交改动或分叉。登上 VPS 检查 'git status'，处理后再推。"
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

if requirements_changed "$old" "$new"; then install_deps; fi
restart_service

if wait_healthy; then
  log "✅ 部署完成：${new:0:7} 已在线"
  exit 0
fi

# ---------- 健康检查失败：回滚 ----------
log "健康检查 ${HEALTH_TIMEOUT}s 内未通过，最近日志："
sudo -n /usr/bin/journalctl -u "$SERVICE" -n 60 --no-pager 2>/dev/null | sed 's/^/    /' || true

log "回滚到 ${old:0:7}"
git reset -q --hard "$old"
if requirements_changed "$old" "$new"; then install_deps; fi
restart_service

if wait_healthy; then
  die "新版本 ${new:0:7} 启动失败，已回滚到 ${old:0:7}（服务恢复）。请看上面的日志修复后再推。"
else
  die "回滚后服务仍不健康！请立刻登上 VPS：journalctl -u $SERVICE -f"
fi
