#!/usr/bin/env bash
# 安装 / 更新 PRISMX 后端看门狗。在 SG 服务器上、仓库目录里执行：
#   sudo bash ops/watchdog/sg/install.sh
# 可以反复执行：会覆盖脚本和服务文件，但不会覆盖已有的 /etc/prismx-watchdog.env。
#
# 卸载：
#   sudo systemctl disable --now prismx-watchdog
#   sudo rm /etc/systemd/system/prismx-watchdog.service && sudo systemctl daemon-reload
#   sudo rm -r /opt/prismx-watchdog      （配置 /etc/prismx-watchdog.env、口令 /etc/prismx-watchdog.operators 按需删除）
#   nginx 里 include snippets/prismx-ops.conf 那一行删掉并 reload
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

echo ">> 自检：跑一遍单元测试"
# 不写 __pycache__：以 root 在 ubuntu 的仓库里留下 root 属主的文件，以后 git 操作会碰到权限问题
(cd "$HERE" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest test_prismx_watchdog test_prismx_ops 2>&1 | tail -3)

echo ">> 安装脚本到 /opt/prismx-watchdog（属主 root）"
install -d -m 755 -o root -g root /opt/prismx-watchdog
install -m 755 -o root -g root "$HERE/prismx_watchdog.py" /opt/prismx-watchdog/prismx_watchdog.py
install -m 644 -o root -g root "$HERE/prismx_ops.py" /opt/prismx-watchdog/prismx_ops.py

if [ -f /etc/prismx-watchdog.env ]; then
  echo ">> /etc/prismx-watchdog.env 已存在，保留不动"
else
  echo ">> 生成 /etc/prismx-watchdog.env（通知默认关闭）"
  install -m 600 -o root -g root "$HERE/prismx-watchdog.env.example" /etc/prismx-watchdog.env
fi

# 老配置文件里没有运维接口的共享密钥：补一把（与 VPS 看门狗的 OpsSharedSecret 必须一致）。
if ! grep -q '^OPS_SHARED_SECRET=.\+' /etc/prismx-watchdog.env; then
  SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  sed -i '/^OPS_SHARED_SECRET=/d' /etc/prismx-watchdog.env
  printf '\n# 运维接口：与 VPS 看门狗 watchdog.ini 的 OpsSharedSecret 必须一样\nOPS_SHARED_SECRET=%s\n' "$SECRET" >> /etc/prismx-watchdog.env
  echo ">> 已生成 SG/VPS 共用签名密钥（写进了 /etc/prismx-watchdog.env 的 OPS_SHARED_SECRET）"
fi

echo ">> 安装 nginx 转发片段到 /etc/nginx/snippets/prismx-ops.conf"
install -d -m 755 /etc/nginx/snippets
install -m 644 -o root -g root "$HERE/nginx-ops.conf" /etc/nginx/snippets/prismx-ops.conf
if ! grep -rqs 'snippets/prismx-ops.conf' /etc/nginx/sites-enabled /etc/nginx/conf.d; then
  echo "   !! nginx 还没引用它：在 api 域名的 server { } 里加一行"
  echo "        include snippets/prismx-ops.conf;"
  echo "      然后 sudo nginx -t && sudo systemctl reload nginx"
fi

echo ">> 安装 systemd 服务"
install -m 644 -o root -g root "$HERE/prismx-watchdog.service" /etc/systemd/system/prismx-watchdog.service
systemctl daemon-reload

echo ">> 试查一轮（只打印，不重启、不发通知）"
python3 /opt/prismx-watchdog/prismx_watchdog.py --config /etc/prismx-watchdog.env --once

echo ">> 启动并设为开机自启"
systemctl enable --now prismx-watchdog
systemctl restart prismx-watchdog
sleep 2
systemctl --no-pager status prismx-watchdog | head -5
echo
echo "完成。实时日志：journalctl -u prismx-watchdog -f"
echo "给人发运维口令：sudo python3 /opt/prismx-watchdog/prismx_watchdog.py --config /etc/prismx-watchdog.env --add-operator 名字"
