#!/bin/sh
# 香港边缘节点 IP 证书（2026-11-11，Let's Encrypt shortlived，约 6 天）：HTTP-01 经 nginx 的
# webroot /var/www/acme（prismx-edge.conf 里 80 端口 default_server 提供）。
# 域名证书走 DNS-01（prismx-cert.sh）是因为 LE 从海外解析域名拿到的是 Vercel / 新加坡；
# IP 没有解析这一层，LE 直接连这台的 80 端口，HTTP-01 就能用。
# lego 5 的 run 同时管首次申请与续期（短期证书过半寿命才续）；续了才 reload nginx。
# 别用 kill 打断它。由 prismx-ip-cert.timer 每 12 小时调用。
# HK edge IP certificate (Let's Encrypt shortlived, ~6 days) via HTTP-01 webroot.
set -eu
exec /usr/local/bin/lego run \
  --accept-tos --email edge@prismxsignallab.com \
  --path /etc/lego \
  --cert.name hk-ip --key-type EC256 \
  --profile shortlived \
  --http --http.webroot /var/www/acme \
  -d 124.156.167.169 \
  --deploy-hook "systemctl reload nginx"
