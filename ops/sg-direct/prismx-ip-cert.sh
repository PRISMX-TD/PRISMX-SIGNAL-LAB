#!/bin/sh
# 新加坡源站 IP 证书（Let's Encrypt shortlived，约 6 天）：HTTP-01 经 nginx 的 webroot
# /var/www/acme（prismx-ip 站点的 80 端口 default_server 提供）。lego 5 的 run 同时管首次申请
# 与续期（短期证书过半寿命才续，没到就什么都不做）；续了才 reload nginx。
# 别用 kill 打断它。由 prismx-ip-cert.timer 每 12 小时调用。
# SG origin IP certificate (Let's Encrypt shortlived, ~6 days) via HTTP-01 webroot.
set -eu
exec /usr/local/bin/lego run \
  --accept-tos --email edge@prismxsignallab.com \
  --path /etc/lego \
  --cert.name sg-ip --key-type EC256 \
  --profile shortlived \
  --http --http.webroot /var/www/acme \
  -d 43.134.110.47 \
  --deploy-hook "systemctl reload nginx"
