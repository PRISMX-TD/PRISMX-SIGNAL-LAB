# PRISMX Bridge（Windows 桥接程序）

一个本地桌面程序：扫描本机所有正在运行的 MT5 终端，用 API Token 连上网页后端，
把多个账号上报到网页，并执行网页下发的下单指令。**无需安装 EA。**

## 它能做什么
- 自动扫描本机所有正在运行的 `terminal64.exe`（分开安装的多个 MT5 也能识别）
- 每个终端读取其已登录账号（名称、券商、余额、净值、杠杆）上报到网页
- 网页下单时按所选账号路由到对应终端执行
- 自动把信号的 SL/TP 按比例换算到券商真实市价，并夹紧最小止损距离（避免 Invalid stops）

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

## 打包成 exe
```powershell
pip install pyinstaller
pyinstaller --noconsole --onefile --name PRISMX-Bridge bridge_app.py
```
生成的 `dist/PRISMX-Bridge.exe` 双击即用。

## 文件说明
- `bridge_app.py`：GUI + 协调器 + 后端轮询（主进程）
- `mt5_worker.py`：连接单个 MT5 终端的 worker（每个终端一个子进程）
