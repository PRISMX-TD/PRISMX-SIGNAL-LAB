# PRISMX Bridge（Windows 桥接程序）

一个本地桌面程序：扫描本机所有正在运行的 MT5 终端，用 API Token 连上网页后端，
把多个账号上报到网页，并执行网页下发的下单指令。**无需安装 EA。**

> 定位说明：这是交易执行的**两条通道之一**。另一条是 `gateway/`（服务端直连券商 Manager API），
> 合作券商的客户走那条路可以完全不装本程序。本程序面向**任意券商**的用户，仍是通用方案。
> 两条通道在网页上功能对等，后端按 `MT5Account.source` 字段（`bridge` / `gateway`）区分。

> 本文件是 `.gitignore` 里 `*.md` 规则的显式例外（`!bridge/README.md`，2026-09-21 起入库）：
> `bridge_app.py` 顶部的注释把「发版签名」流程指向这里，而那条链路做错一次，全部存量用户
> 会退回手动下载。文中不含任何密钥。

## 它能做什么
- 自动扫描本机所有正在运行的 `terminal64.exe`（分开安装的多个 MT5 也能识别；**显式排除 MT4 的 `terminal.exe`**，它会让扫描卡死）
- 每个终端读取其已登录账号（名称、券商、余额、净值、杠杆）上报到网页
- 网页下单时按所选账号路由到对应终端执行；支持下单 / 平仓（含部分平仓）/ 改止损止盈
- 自动把信号的 SL/TP 按比例换算到券商真实市价，并夹紧最小止损距离（避免 Invalid stops）
- 上报按账户区分的报价（含券商真实合约规格）与真实平仓明细
- 挂单：网页图表页下的限价 / 止损单会真的挂进 MT5，挂单列表随状态一起上报，网页上可撤销
- 最小化到系统托盘、可设开机自启（仅打包态）、有 Token 时启动即自动连接
- 一键自更新：检测到 GitHub Release 有新版且**验签通过**时提示一键更新（见「发版签名」）

## 几条不要改坏的语义
- **只碰本平台开的仓**：下单打魔术号 `778899`，平仓 / 改单前先校验魔术号，不符直接拒绝；持仓上报同样按魔术号过滤。用户在 MT5 里自己开的仓，本程序一概不碰、也不上报。
- **幂等**：每条指令的 `clientOrderId` 与结果缓存在本地 24 小时并**落盘**，重发同一指令只重报缓存的结果，**绝不重复下单**。缓存写盘失败现在会记 warning（以前静默）——写不进去意味着重启后可能重复下单，必须能查到。
- **API Token 只以 Windows DPAPI 密文落盘**（`~/.prismx_bridge.json` 的 `token_enc`）。**加密失败绝不退回明文**——只保存后端地址并提示用户下次重输。
- **平仓明细的查询时间必须用服务器时间**（由最新报价的 tick 时间推算），不能用本地时钟。曾因此差过 5 小时、连续 6 个版本没修对。
- **改单缺哪一侧就保留哪一侧**：MODIFY 指令没带的 SL/TP 保留仓位现值，只有显式传 0 才是清除（`mt5_worker._modify_position`）。网关侧 2026-09-21 起同一语义。
- **挂单挂出去了 ≠ 成交了**：PENDING 指令成功回的是 `status="PLACED"`，不是 `FILLED`。混用会让一张可能永远不触发的挂单被后端当成一笔完成的交易记进胜率、勋章与竞赛。挂单的止损止盈按**触发价**夹最小距离，不是按现价（`_clamp_pending_stops`）——按现价夹会把止损拖到贴着市价，触发那一刻就被打掉。
- **滑点按品种精度折算**（`_deviation_points`），开仓与平仓同一套；写死的 point 数在黄金上只值几毛钱，行情一快就是一串 REQUOTE。
- 后端地址**固定为生产地址**，不读用户输入。

## 前提
- **仅支持 Windows**（`MetaTrader5` 包限制）
- MT5 终端需**已经打开并登录**，且开启「算法交易」按钮
- 想要多账号 = 自己**多开几个 MT5 终端**，分别登录不同账号

## 运行（开发）
```powershell
pip install -r requirements.txt
python bridge_app.py
```
打开后第一步：粘贴网页「绑定」页里的 API Token，点「连接」。

测试：`python -m pytest tests`（`tests/conftest.py` 负责把本目录加进 `sys.path`，新测试文件不用再抄）。
`tests/test_update_verification.py` 覆盖自更新验签链路，改这一块前后都要跑。

## 打包成 exe
统一用 `PRISMX-Bridge.spec` 打包（**onefile + 关闭 UPX**，降低 Windows Defender / 第三方杀软误报）：
```powershell
pip install pyinstaller
pyinstaller --clean --noconfirm PRISMX-Bridge.spec
```
产出 `dist/PRISMX-Bridge-Setup.exe`（单文件，双击即用），文件名必须与 GitHub Release 资产名、
`bridge_app.BRIDGE_ASSET_FILENAME`、网页下载页 `DownloadPage.tsx` 的 `BRIDGE_FILENAME` 三处一致。

> 注意：spec 里 `upx=False`，不要改回 `--onefile` 的裸命令或开启 UPX，否则误报率会升高。
> spec **自 2026-09-20 起入库**且手工维护（`hiddenimports` 里有 pystray/PIL 的运行时后端与
> `cryptography` 的 ed25519 扩展）——不要用 pyinstaller 重新生成一份来替换它，漏掉的依赖不报错，
> 只会让「一键更新」悄悄退回手动下载。

## 发布新版本
1. 改 `bridge_app.py` 里的 `APP_VERSION`（版本号的**唯一来源**；**改了回执协议的字段必须升版本**，见常量旁的注释）；
2. 按上面命令重新打包；
3. **签名**：`python release_sign.py`（见下一节），得到 `dist/SHA256SUMS` 与 `dist/SHA256SUMS.sig`；
4. 在仓库 `PRISMX-TD/PRISMX-SIGNAL-LAB` 建一个新 Release（tag 如 `v1.4.2`），上传**三个**资产，名字一个都不能改：
   `PRISMX-Bridge-Setup.exe`、`SHA256SUMS`、`SHA256SUMS.sig`。少了后两个，已装的桥接会认为「这次没签名」，只提示手动下载。

前端下载页版本号由后端 `bridge_version_check.py` 抓 `releases/latest` 动态提供，无需手动同步；
网页下载按钮走 `releases/latest`，无需改下载链接代码。桥接只接受 GitHub 的下载域名
（`UPDATE_ALLOWED_HOSTS`），别把资产放到别处再改 Release 说明里的链接。

发完在一台装着旧版的机器上等最多 10 分钟（`UPDATE_CHECK_INTERVAL`），看提示条是否出现「一键更新」。

> 未签名程序在开启「智能应用控制(SAC)」的 Windows 上仍会被拦——彻底解决需代码签名或上架 Microsoft Store。本 spec 只降低杀软误报，不解决签名问题。这里的「发版签名」是自更新的来源校验，与 Windows 代码签名是两回事。

## 发版签名

自更新是整条链路上**唯一**一处「把远端二进制装到用户机器上并执行」的地方，而那台机器正登录着
用户真实的 MT5 账号。校验顺序：先取 Release 里的 `SHA256SUMS` + `SHA256SUMS.sig` 验签（证明清单出自
发布者），再下载 exe 比对哈希（证明拿到的字节就是清单认的那份）。任何一步失败都**不会**替换自身，
退回「请手动下载」。所以：**没签名 = 没有一键更新**，不是「跳过校验」。

| 东西 | 在哪 | 作用 |
|---|---|---|
| 发布私钥 `bridge-release-private.pem` | **只在发布者手上**，本机 `C:\prismx-release-keys\`（不在任何仓库；需另行离线备份） | 给每个版本的哈希清单签名 |
| 发布公钥 `UPDATE_PUBLIC_KEY_B64` | 硬编码在 `bridge_app.py` | 用户机器上的桥接用它验签 |
| `release_sign.py` | 本目录，入库 | 一条命令出 `SHA256SUMS` + `SHA256SUMS.sig`，并用代码里的公钥反验一次 |

```powershell
python release_sign.py                                    # 私钥在默认位置
python release_sign.py --key D:\keys\bridge-release-private.pem
```

脚本做三件事：算 exe 的 SHA-256 写成 `dist\SHA256SUMS`（sha256sum 标准格式，两个空格）；用私钥对
`SHA256SUMS` 的**原始字节**做 Ed25519 签名，base64 单行写成 `dist\SHA256SUMS.sig`；最后用
`bridge_app.py` 里的公钥反过来验一次——私钥与代码里的公钥不配对时当场报错，而不是等用户机器上
全部静默退回手动下载。

手工等价（排障用）：
```python
from cryptography.hazmat.primitives import serialization
key = serialization.load_pem_private_key(open(r"C:\prismx-release-keys\bridge-release-private.pem", "rb").read(), None)
sig = key.sign(open("dist/SHA256SUMS", "rb").read())   # 签原始字节，不是十六进制字符串
```

### 换钥（⚠️ 最容易出事的一步）

**已经装在用户机器上的旧版本只认旧公钥。** 直接换掉 `UPDATE_PUBLIC_KEY_B64` 并用新私钥签，存量用户
会**全部**验签失败、退回手动下载，且没有任何报错提示。安全做法是两步走：先发一版代码里公钥已换成
新的、但仍用**旧私钥**签名的版本；等存量升上来，下一版再改用新私钥签。

私钥丢失 = 再也签不出老版本认的清单 = 全部存量只能手动下载。私钥要有离线备份，且备份不能和源码放在一起。

### 常见问题
- **打包后一键更新消失、只剩手动下载**：多半是 `cryptography` 没打进去。它在 `bridge_app._load_update_public_key()`
  里惰性 import，漏了不报错、只是自更新被禁用。检查 spec 的 `hiddenimports`，别重新生成 spec。
- **`SHA256SUMS signature verification failed`**：清单被改过（多了 BOM、换行被改成 CRLF、编辑器加了尾空格）
  或签的不是原始字节。用 `release_sign.py` 重出，不要手编。

## 文件说明
- `bridge_app.py`：GUI + 协调器 + 后端轮询（主进程）。状态循环 1.5 秒一拍，顺序是
  **持仓 → 变化的报价 → 平仓明细 → 回执**；指令另起一条长轮询线程（`_command_loop`），
  落库即取、立刻执行，不再排在整轮之后。
- `mt5_worker.py`：MT5 终端操作。**同一进程内**用 `mt5.initialize(path=...)`
  逐个附着各终端、串行轮询——不是每个终端一个子进程（PyInstaller onefile
  打包下子进程起不来，改成了单进程）。单终端场景保持附着不重连。
- `PRISMX-Bridge.spec`：PyInstaller 打包配置（onefile / 无 UPX），**入库、手工维护**（见上）。
- `release_sign.py`：发版签名脚本（见上）。
- `tests/`：`python -m pytest tests`。覆盖本地配置的加密语义、执行三态（FILLED / REJECTED / FAILED）、
  重发指令的二次确认、自更新验签。

## 本地文件（都在用户主目录）
| 文件 | 内容 |
|---|---|
| `~/.prismx_bridge.json` | 后端地址（明文）+ `token_enc`（DPAPI 密文） |
| `~/.prismx_bridge.log` | 运行日志，512KB × 4 份轮转。用户目录建不了时退到系统临时目录的 `prismx_bridge.log` |
| `~/.prismx_bridge_executed.json` | 幂等缓存（24 小时 TTL） |
| `~/.prismx_bridge_reports.json` | 未回报的执行结果队列 |
| `~/.prismx_bridge_trades.json` | 未上报的平仓明细队列 |
| `~/.prismx_selftest.txt` | `--selftest` 的输出 |
