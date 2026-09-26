#!/bin/sh
# 香港边缘节点的 Let's Encrypt 证书：DNS-01 验证（经腾讯云 DNSPod API，子用户 hk-edge-cert，
# 只有 QcloudDNSPodFullAccess）。HTTP-01 用不了：LE 从海外验证，境外线路解析到的是
# Vercel / 新加坡，不是这台。lego 5 的 run 同时管首次申请与续期（没到期就什么都不做）。
# --dns.resolvers：本机用的腾讯内网 DNS 曾缓存旧的 Namecheap NS 很久（2026-09-25 从 Namecheap
# 迁到 DNSPod 时），lego 会去问旧 NS、一直等不到记录。用公共解析器找权威服务器。
# 别用 kill 打断它：残留的 _acme-challenge TXT 不会被清，下次同账号拿到同一个 token 时
# DNSPod 报「记录已经存在」直接失败。
# 密钥在 /root/.tencent-dns.env（600，root），本脚本不打印它。
set -eu
export TENCENTCLOUD_PROPAGATION_TIMEOUT=600
export TENCENTCLOUD_POLLING_INTERVAL=10

# 两张证书：主域名一张、备用域名 pmxsl.com 单独一张（不合签，见 prismx-edge.conf 里的说明）。
# 不用 exec：要跑两次。前一张失败也照跑后一张，最后按任一失败返回非零，让 systemd 记下失败。
issue() {
  name=$1; shift
  /usr/local/bin/lego run \
    --accept-tos --email edge@prismxsignallab.com \
    --path /etc/lego --env-file /root/.tencent-dns.env \
    --cert.name "$name" --key-type EC256 \
    --dns tencentcloud \
    --dns.resolvers 8.8.8.8:53 --dns.resolvers 119.29.29.29:53 \
    "$@" \
    --deploy-hook "systemctl reload nginx"
}

rc=0
issue prismx-edge -d api.prismxsignallab.com -d prismxsignallab.com -d www.prismxsignallab.com || rc=1
issue pmxsl-edge -d api.pmxsl.com -d pmxsl.com -d www.pmxsl.com || rc=1
exit $rc
