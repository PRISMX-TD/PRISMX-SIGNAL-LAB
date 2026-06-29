# PRISMX Signal Lab 运维手册

> 最后更新: 2026-06-30 | 维护者: PRISMX-TD
> 架构设计见《技术架构文档》第1节；功能需求见《产品需求文档》。

---

## 一、线上环境速查

| 项目 | 地址 / 实例 |
|------|-----------|
| 前端 | 正式域名 `https://prismxsignallab.com`(根域 → www，Vercel)；`prismx-signal-lab.vercel.app` 仍可用(备用) |
| 后端 API | `https://api.prismxsignallab.com`(VPS: 43.134.110.47, Ubuntu 24.04, 2核4G) |
| 数据库 | Supabase PostgreSQL 17.6, Session pooler: `postgres.efnnpyrauoxwpqjeqqvk@aws-1-ap-northeast-1.pooler.supabase.com:5432` |
| GitHub | `PRISMX-TD/PRISMX-SIGNAL-LAB`(公开仓库) |
| 域名 DNS | Namecheap, `api` A → 43.134.110.47(已配)；根域 `@` A → 216.198.79.1(Vercel)；`www` CNAME → cname.vercel-dns.com(已配) |

## 二、VPS 后端

### 2.1 systemd 服务

配置文件 `/etc/systemd/system/prismx.service`(用户 `ubuntu`,监听 `127.0.0.1:8000`,崩溃自动重启)。

```bash
sudo systemctl status prismx   # 查看状态
sudo systemctl restart prismx  # 重启(代码更新后必须)
sudo journalctl -u prismx -f   # 实时日志
```

### 2.2 环境变量(.env)

位置 `/home/ubuntu/PRISMX-SIGNAL-LAB/backend/.env`(**不入 Git**):

```
ENV=production
JWT_SECRET=<python3 -c "import secrets; print(secrets.token_urlsafe(48))" 生成>
DATABASE_URL=postgresql://postgres.efnnpyrauoxwpqjeqqvk:<密码>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres
```

> **重要(安全)**:生产必须设 `ENV=production`。此时若 `JWT_SECRET` 仍为默认弱密钥，后端会直接拒绝启动，防止 token 被伪造。
> 可选限流覆盖:`RATE_LIMIT_LOGIN`(默认 `10/minute`)、`RATE_LIMIT_REGISTER`(默认 `5/minute`)。
> 如需放行额外的精确预览域名,设 `CORS_ORIGINS`(逗号分隔);已不再用通配正则放行所有 `*.vercel.app`。

密码含 `#` → 写 `%23`；`@ : / ? & %` 同理需 URL 转义。

### 2.3 代码更新流程

```bash
su - ubuntu
cd ~/PRISMX-SIGNAL-LAB && git pull
cd backend && source .venv/bin/activate && pip install -r requirements.txt  # 如有新依赖
sudo systemctl restart prismx
sleep 3 && curl -s https://api.prismxsignallab.com/  # 验证
```

### 2.4 Nginx 与防火墙

站点 `/etc/nginx/sites-available/prismx`(certbot 已自动配 SSL + HTTP→HTTPS 重定向 + WebSocket 升级头)。

双层防火墙:腾讯云安全组(TCP 22/80/443, `0.0.0.0/0`) + ufw(OpenSSH + Nginx Full)。

## 三、前端 Vercel

### 3.1 项目配置

- Framework: Vite | Root: `frontend` | Build: `npm run build`(`tsc -b && vite build`) | Output: `dist`
- 环境变量:**`VITE_API_BASE`** = `https://api.prismxsignallab.com`

### 3.2 更新流程

推 GitHub → Vercel 自动构建部署。无需手动操作。

## 四、Bridge 打包与分发

### 4.1 打包命令

```bash
python -m pip install pyinstaller psutil MetaTrader5 "numpy<2"
python -m PyInstaller --clean --noconsole --onefile \
    --name PRISMX-Bridge --collect-all MetaTrader5 --collect-all numpy bridge_app.py
```

产物 `dist/PRISMX-Bridge.exe`(约 33MB)。注意 `--collect-all` 和 `numpy<2` **缺一不可**,否则 MT5 import 失败。

### 4.2 用户使用

打开 exe → 填 API Token(网站获取)→ 点连接。后端地址已内置。必须本机已登录 MT5(`terminal64.exe`)。

## 五、踩坑记录

| # | 问题 | 原因 | 修复 | 影响文件 |
|---|------|------|------|---------|
| 1 | Vercel 构建 `TS2339: Property 'env' does not exist on type 'ImportMeta'` | 缺少 Vite 类型声明 | 创建 `vite-env.d.ts`(含 `/// <reference types="vite/client" />`) | `vite-env.d.ts` |
| 2 | 注册时报 CORS `No 'Access-Control-Allow-Origin' header` | 后端未放行 `*.vercel.app` | 加 `CORS_ORIGIN_REGEX = r"https://.*\.vercel\.app"` + VPS 重启 | `config.py`, `main.py` |
| 3 | Supabase `Network is unreachable`(IPv6) | 直连地址只解析 IPv6,腾讯云无 IPv6 | 改用 Session pooler(`aws-1-...pooler.supabase.com`),走 IPv4 | `.env` |
| 4 | HTTPS 连接超时(`curl -v` 卡在 443) | 腾讯云安全组只放了 80,没放 443 | 安全组加 TCP 443,来源 `0.0.0.0/0` | — |
| 5 | Bridge numpy 报错 `numpy._core.multiarray failed to import` | numpy 2.x 与 MetaTrader5 不兼容 | `numpy<2` + PyInstaller `--collect-all numpy` 重新打包 | `bridge_app.py`(打包参数) |
| 6 | Bridge 点连接后打开 MT4,卡死 | `scan_terminals` 匹配了 `terminal.exe`(MT4),MT5 库误连 | 只匹配 `terminal64.exe`(MT5) + `initialize` 加 `timeout=10000` | `bridge_app.py`, `mt5_worker.py` |
| 7 | VPS 操作掉进 root 用户,找不到代码 | root 家目录是 `/root`,代码在 `/home/ubuntu` | `su - ubuntu` 切回 | — |

## 六、安全加固(2026-06-30)

对全项目做了一轮安全升级，重点防注入式攻击与认证爆破。已确认无 SQL 注入(全程 ORM 参数化)、无 XSS(React 自动转义)、无命令注入(无 eval/subprocess)。本轮加固项:

| 级别 | 加固内容 | 影响文件 |
|------|---------|---------|
| P0 | 登录/注册按 IP 限流(slowapi),防在线密码爆破 | `core/rate_limit.py`, `main.py`, `routers/auth.py` |
| P0 | JWT 生产判定改用 `ENV=production`,默认弱密钥在生产拒绝启动 | `core/config.py` |
| P1 | 输入校验:password≥8、symbol/login/suffix 白名单、side 枚举、volume 范围 | `schemas.py`, `routers/bridge.py`, `routers/ea_poll.py` |
| P1 | close/modify 补账号归属校验,修复 IDOR 缺口 | `routers/orders.py` |
| P1 | 前端 WS 鉴权 token 移出 URL query,改首帧 AUTH 消息(避免被代理日志泄露) | `routers/ws.py`, `frontend/src/store/useClientSocket.ts` |
| P1 | 收紧 CORS,去掉放行所有 `*.vercel.app` 的通配正则 | `core/config.py`, `main.py` |
| P1 | Bridge 校验后端下发指令(字段白名单+范围),单条 try/except 隔离,畸形指令不中断整批 | `bridge/mt5_worker.py`, `bridge/bridge_app.py` |
| P2 | API Token 用 `secrets.compare_digest` 常量时间比较;注册去用户枚举;JWT 有效期 7 天→1 天 | `core/security.py`, `routers/auth.py`, `core/config.py` |

部署注意:`requirements.txt` 新增 `slowapi`,VPS `git pull` 后需 `pip install -r requirements.txt` 再重启;`.env` 需新增 `ENV=production`(见 2.2)。

## 七、待办

- [x] 配正式域名 `prismxsignallab.com` → Vercel(Namecheap 删 URL Redirect，根域 A → 216.198.79.1、`www` CNAME → cname.vercel-dns.com；CORS 已含正式域名；SSL 已签发，`https://prismxsignallab.com` 已验证可访问)
- [ ] Bridge.exe 下载分发(33MB,放网站下载入口)
- [ ] EA 两个版本在 MT5 实测(WebSocket + HTTP 轮询)
- [ ] 数据库备份策略
- [ ] 后续:多用户性能测试、信号策略优化

## 八、接手指南

1. 确认仓库最新 commit、`curl https://api.prismxsignallab.com/` 可通、前端可注册
2. 改后端 → 推 GitHub → VPS `git pull` + `sudo systemctl restart prismx`
3. 改前端 → 推 GitHub → Vercel 自动部署
4. 改 Bridge → 推 GitHub + 本机重新打包 exe + 分发
5. 完整架构/API/数据模型见《技术架构文档》
